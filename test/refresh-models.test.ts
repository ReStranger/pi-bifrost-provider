// @ts-nocheck
import assert from "node:assert/strict";
import test from "node:test";

import { toApiBase } from "../src/config.ts";
import {
	refreshBifrostModels,
	restorePersistedModels,
} from "../src/refresh-models.ts";
import type { BifrostRuntime } from "../src/runtime.ts";
import {
	BIFROST_BASE_URL_ENV,
	type PersistedCatalogEntry,
	type PiModel,
	type ProviderApi,
	type RefreshContext,
} from "../src/types.ts";

function makeModel(api: ProviderApi, id = `${api}-model`): PiModel {
	return {
		id,
		name: id,
		api,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
	};
}

function makeStoredCatalog(
	api: ProviderApi,
	id: string,
	baseOrigin: string,
): PersistedCatalogEntry {
	return {
		models: [
			{
				...makeModel(api, id),
				provider: "legacy-provider",
				baseUrl: toApiBase(baseOrigin),
			},
		],
		checkedAt: 0,
		baseUrl: baseOrigin,
	};
}

function makeRuntime(
	options: {
		env?: Record<string, string | undefined>;
		now?: number;
		fetch?: typeof fetch;
	} = {},
): BifrostRuntime {
	return {
		env: options.env ?? {},
		fetch:
			options.fetch ??
			(async () => {
				throw new Error("unexpected fetch");
			}),
		now: () => options.now ?? 1_000,
	};
}

function makeContext(overrides: Partial<RefreshContext> = {}): RefreshContext {
	return {
		stored: undefined,
		credential: {
			type: "api_key",
			key: "secret",
			env: {
				[BIFROST_BASE_URL_ENV]: "https://credential.example",
			},
		},
		allowNetwork: true,
		force: false,
		signal: new AbortController().signal,
		...overrides,
	};
}

test("offline refresh returns restored models", async () => {
	const result = await refreshBifrostModels(
		makeRuntime(),
		makeContext({
			allowNetwork: false,
			credential: undefined,
			stored: makeStoredCatalog(
				"openai-completions",
				"restored",
				"https://stored.example",
			),
		}),
	);

	assert.deepEqual(result.models, [
		{
			...makeModel("openai-completions", "restored"),
			provider: "bifrost",
			baseUrl: "https://stored.example/v1",
		},
	]);
	assert.equal(result.persist, undefined);
});

test("stored catalogs are endpoint-scoped by base URL", () => {
	const restored = restorePersistedModels(
		"bifrost",
		makeStoredCatalog("openai-completions", "restored", "https://stored.example"),
		"https://other.example",
	);
	assert.equal(restored, undefined);
});

test("stored empty catalogs restore as empty arrays", () => {
	const restored = restorePersistedModels(
		"bifrost",
		{
			models: [],
			checkedAt: 0,
			baseUrl: "https://stored.example",
		},
		"https://stored.example",
	);
	assert.deepEqual(restored, []);
});

test("missing configured base URL returns restored models without network", async () => {
	let calls = 0;
	const result = await refreshBifrostModels(
		makeRuntime({
			fetch: async () => {
				calls += 1;
				throw new Error("network should not be called");
			},
		}),
		makeContext({
			credential: { type: "api_key", key: "secret" },
			stored: makeStoredCatalog(
				"openai-completions",
				"restored",
				"https://stored.example",
			),
		}),
	);

	assert.deepEqual(
		result.models?.map((model) => model.id),
		["restored"],
	);
	assert.equal(calls, 0);
});

test("fresh stored models respect TTL and skip the network", async () => {
	let calls = 0;
	const result = await refreshBifrostModels(
		makeRuntime({
			env: { BIFROST_REFRESH_INTERVAL_MS: "1000" },
			now: 1_000,
			fetch: async () => {
				calls += 1;
				throw new Error("network should not be called");
			},
		}),
		makeContext({
			stored: {
				...makeStoredCatalog(
					"openai-completions",
					"restored",
					"https://credential.example",
				),
				checkedAt: 500,
			},
		}),
	);

	assert.deepEqual(
		result.models?.map((model) => model.id),
		["restored"],
	);
	assert.equal(calls, 0);
});

test("successful refresh uses the credential base URL and preserves catalog shape", async () => {
	let fetchedUrl = "";
	const result = await refreshBifrostModels(
		makeRuntime({
			now: 4_321,
			fetch: async (url) => {
				fetchedUrl = String(url);
				return new Response(
					JSON.stringify({
						data: [
							{
								id: "chat-only",
								normalized_name: "Chat Only",
								supported_methods: ["chat.completions"],
							},
						],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			},
		}),
		makeContext({
			force: true,
			credential: {
				type: "api_key",
				key: "secret",
				env: {
					[BIFROST_BASE_URL_ENV]: "https://credential.example/v1/",
				},
			},
		}),
	);

	assert.equal(fetchedUrl, "https://credential.example/v1/models?page_size=200");
	assert.deepEqual(
		result.models?.map((model) => ({
			id: model.id,
			provider: model.provider,
			baseUrl: model.baseUrl,
		})),
		[
			{
				id: "chat-only",
				provider: "bifrost",
				baseUrl: "https://credential.example/v1",
			},
		],
	);
	assert.deepEqual(result.persist, {
		models: result.models ?? [],
		checkedAt: 4_321,
		baseUrl: "https://credential.example",
	});
});

test("successful refresh publishes a single-API catalog", async () => {
	const result = await refreshBifrostModels(
		makeRuntime({
			now: 5_555,
			fetch: async () =>
				new Response(
					JSON.stringify({
						data: [
							{
								id: "chat-only",
								supported_methods: ["chat.completions"],
							},
							{
								id: "dual-model",
								supported_methods: ["chat.completions", "responses"],
							},
						],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
		}),
		makeContext({ force: true }),
	);

	assert.deepEqual(
		result.models?.map((model) => ({ id: model.id, api: model.api })),
		[
			{ id: "chat-only", api: "openai-completions" },
			{ id: "dual-model", api: "openai-responses" },
		],
	);
	assert.deepEqual(result.persist, {
		models: result.models ?? [],
		checkedAt: 5_555,
		baseUrl: "https://credential.example",
	});
});

test("successful live refresh with no explicit markers still uses datasheet enrichment", async () => {
	let calls = 0;
	const result = await refreshBifrostModels(
		makeRuntime({
			now: 6_666,
			fetch: async () => {
				calls += 1;
				if (calls === 1) {
					return new Response(
						JSON.stringify({ data: [{ id: "openai/gpt-4.1-mini" }] }),
						{ status: 200, headers: { "content-type": "application/json" } },
					);
				}
				return new Response(
					JSON.stringify({
						"openai/gpt-4.1-mini": {
							provider: "openai",
							base_model: "openai.gpt-4.1-mini",
							mode: "responses",
							max_input_tokens: 128_000,
							max_output_tokens: 16_384,
							supports_reasoning: true,
							supports_none_reasoning_effort: true,
							supports_minimal_reasoning_effort: true,
							default_reasoning_effort: "none",
						},
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			},
		}),
		makeContext({ force: true }),
	);

	assert.equal(calls, 2);
	assert.deepEqual(
		result.models?.map((model) => ({ id: model.id, api: model.api })),
		[{ id: "openai/gpt-4.1-mini", api: "openai-responses" }],
	);
	assert.equal(result.models?.[0]?.reasoning, true);
	assert.deepEqual(result.models?.[0]?.thinkingLevelMap, {
		off: "none",
		minimal: "minimal",
	});
	assert.deepEqual(result.persist, {
		models: result.models ?? [],
		checkedAt: 6_666,
		baseUrl: "https://credential.example",
	});
});

test("datasheet enrichment failures fall back to chat-only instead of failing refresh", async () => {
	let calls = 0;
	const result = await refreshBifrostModels(
		makeRuntime({
			now: 6_777,
			fetch: async () => {
				calls += 1;
				if (calls === 1) {
					return new Response(JSON.stringify({ data: [{ id: "mystery-model" }] }), {
						status: 200,
						headers: { "content-type": "application/json" },
					});
				}
				throw new Error("timeout contacting datasheet");
			},
		}),
		makeContext({ force: true }),
	);

	assert.equal(calls, 2);
	assert.deepEqual(
		result.models?.map((model) => ({ id: model.id, provider: model.provider })),
		[{ id: "mystery-model", provider: "bifrost" }],
	);
	assert.deepEqual(result.persist, {
		models: result.models ?? [],
		checkedAt: 6_777,
		baseUrl: "https://credential.example",
	});
});

test("timeouts without restored models return undefined", async () => {
	let calls = 0;
	const result = await refreshBifrostModels(
		makeRuntime({
			fetch: async () => {
				calls += 1;
				throw new Error(
					calls === 1
						? "timeout contacting /models"
						: "timeout contacting datasheet",
				);
			},
		}),
		makeContext({ force: true }),
	);

	assert.equal(result.models, undefined);
	assert.equal(calls, 2);
});

test("HTTP failures from /models do not trigger datasheet fallback", async () => {
	let calls = 0;

	await assert.rejects(
		() =>
			refreshBifrostModels(
				makeRuntime({
					fetch: async () => {
						calls += 1;
						return new Response("boom", { status: 502 });
					},
				}),
				makeContext({ force: true }),
			),
		/Bifrost model refresh failed \(502\): boom/,
	);
	assert.equal(calls, 1);
});

test("transport failures fall back to the datasheet catalog", async () => {
	let calls = 0;
	const result = await refreshBifrostModels(
		makeRuntime({
			now: 7_777,
			fetch: async () => {
				calls += 1;
				if (calls === 1) {
					throw new Error("fetch failed");
				}
				return new Response(
					JSON.stringify({
						"openai/gpt-4o-mini": {
							provider: "openai",
							base_model: "gpt-4o-mini",
							supported_endpoints: ["/v1/chat/completions"],
							max_input_tokens: 128_000,
							max_output_tokens: 16_384,
						},
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			},
		}),
		makeContext({ force: true }),
	);

	assert.deepEqual(
		result.models?.map((model) => model.id),
		["gpt-4o-mini"],
	);
	assert.equal(result.persist?.checkedAt, 7_777);
	assert.equal(calls, 2);
});

test("pending login catalog wins over the offline path with persist", async () => {
	const { setPendingCatalog } = await import("../src/refresh-models.ts");
	const pending = [
		makeModel("openai-completions", "fresh-chat"),
		makeModel("openai-responses", "fresh-responses"),
	];
	try {
		setPendingCatalog({ models: pending, baseOrigin: "https://login.example" });
		const result = await refreshBifrostModels(
			makeRuntime({ now: 7_000 }),
			makeContext({ allowNetwork: false, credential: undefined }),
		);
		assert.deepEqual(result.models, [
			{
				...makeModel("openai-completions", "fresh-chat"),
				provider: "bifrost",
				baseUrl: "https://login.example/v1",
			},
			{
				...makeModel("openai-responses", "fresh-responses"),
				provider: "bifrost",
				baseUrl: "https://login.example/v1",
			},
		]);
		assert.deepEqual(result.persist, {
			models: result.models,
			checkedAt: 7_000,
			baseUrl: "https://login.example",
		});
	} finally {
		setPendingCatalog(undefined);
	}
});

test("pending catalog is consumed once", async () => {
	const { setPendingCatalog } = await import("../src/refresh-models.ts");
	const pending = [
		makeModel("openai-completions", "fresh-chat"),
		makeModel("openai-responses", "fresh-responses"),
	];
	try {
		setPendingCatalog({ models: pending, baseOrigin: "https://login.example" });
		const offline = makeContext({ allowNetwork: false, credential: undefined });
		const first = await refreshBifrostModels(makeRuntime(), offline);
		assert.deepEqual(
			first.models?.map((model) => model.id),
			["fresh-chat", "fresh-responses"],
		);
		// A second refresh finds nothing pending anymore.
		const second = await refreshBifrostModels(makeRuntime(), offline);
		assert.equal(second.models, undefined);
		assert.equal(second.persist, undefined);
	} finally {
		setPendingCatalog(undefined);
	}
});
