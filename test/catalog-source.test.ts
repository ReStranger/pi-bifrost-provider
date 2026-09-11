// @ts-nocheck
import assert from "node:assert/strict";
import test from "node:test";

import {
	fetchAuthenticatedCatalog,
	fetchDatasheetCatalog,
	shouldFallbackToDatasheet,
} from "../src/catalog-source.ts";
import {
	canonicalDatasheetId,
	datasheetCandidateScore,
	preferredDatasheetProvider,
} from "../src/model-mapping.ts";
import type { BifrostRuntime } from "../src/runtime.ts";

function makeRuntime(fetchImpl: typeof fetch): BifrostRuntime {
	return {
		env: {},
		fetch: fetchImpl,
		now: () => 0,
	};
}

function apisForId(
	models: readonly { id: string; api: string }[],
	id: string,
): string[] {
	return models.filter((model) => model.id === id).map((model) => model.api);
}

test("extracts canonical datasheet IDs and rejects aliases", () => {
	assert.equal(
		canonicalDatasheetId("openai/gpt-4o-mini", {
			base_model: "openai.gpt-4o-mini",
		}),
		"gpt-4o-mini",
	);
	assert.equal(
		canonicalDatasheetId("anthropic/claude-3-5-sonnet", {
			base_model: "anthropic.claude-3-5-sonnet",
		}),
		"claude-3-5-sonnet",
	);
	assert.equal(
		canonicalDatasheetId("provider/@alias", { base_model: "@alias" }),
		undefined,
	);
});

test("prefers the expected provider when scoring datasheet candidates", () => {
	assert.equal(preferredDatasheetProvider("gpt-4o-mini"), "openai");

	const preferredScore = datasheetCandidateScore(
		"openai/gpt-4o-mini",
		{
			provider: "openai",
			base_model: "gpt-4o-mini",
			supported_endpoints: ["/v1/chat/completions"],
			mode: "chat",
		},
		"gpt-4o-mini",
		"openai-completions",
	);
	const fallbackScore = datasheetCandidateScore(
		"other/gpt-4o-mini",
		{
			provider: "other",
			base_model: "gpt-4o-mini",
			mode: "chat",
		},
		"gpt-4o-mini",
		"openai-completions",
	);

	assert.ok(preferredScore < fallbackScore);
});

test("dedupes datasheet entries by the best score", async () => {
	const runtime = makeRuntime(
		async () =>
			new Response(
				JSON.stringify({
					"other/gpt-4o-mini": {
						provider: "other",
						base_model: "gpt-4o-mini",
						mode: "chat",
						max_input_tokens: 1_000,
						max_output_tokens: 100,
						input_cost_per_token: "0.000003",
						output_cost_per_token: "0.000004",
					},
					"openai/gpt-4o-mini": {
						provider: "openai",
						base_model: "gpt-4o-mini",
						supported_endpoints: ["/v1/chat/completions"],
						mode: "chat",
						max_input_tokens: 128_000,
						max_output_tokens: 16_384,
						input_cost_per_token: "0.00000015",
						output_cost_per_token: "0.0000006",
					},
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
	);

	const models = await fetchDatasheetCatalog(
		new AbortController().signal,
		runtime,
	);

	assert.equal(models.length, 1);
	assert.equal(models[0]?.id, "gpt-4o-mini");
	assert.equal(models[0]?.cost.input, 0.15);
	assert.equal(models[0]?.contextWindow, 128_000);
	assert.equal(models[0]?.api, "openai-completions");
});

test("uses explicit live markers without datasheet enrichment when metadata is present", async () => {
	let calls = 0;
	const runtime = makeRuntime(async () => {
		calls += 1;
		return new Response(
			JSON.stringify({
				data: [
					{ id: "response-model", mode: "responses" },
					{
						id: "chat-model",
						supported_endpoints: ["/v1/chat/completions"],
					},
					{
						id: "dual-model",
						supported_methods: ["chat.completions", "responses"],
					},
				],
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	});

	const models = await fetchAuthenticatedCatalog(
		"secret",
		"https://bifrost.example",
		new AbortController().signal,
		runtime,
	);

	assert.equal(calls, 1);
	assert.deepEqual(apisForId(models, "response-model"), ["openai-responses"]);
	assert.deepEqual(apisForId(models, "chat-model"), ["openai-completions"]);
	assert.deepEqual(apisForId(models, "dual-model"), [
		"openai-responses",
		"openai-completions",
	]);
});

test("enriches unclassified live models from datasheet and defaults unknown models to chat", async () => {
	let calls = 0;
	const runtime = makeRuntime(async () => {
		calls += 1;
		if (calls === 1) {
			return new Response(
				JSON.stringify({
					data: [
						{ id: "openai/gpt-5-mini" },
						{ id: "provider/claude-sonnet" },
						{ id: "provider/dual-api" },
						{ id: "provider/unknown" },
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}

		return new Response(
			JSON.stringify({
				"openai/gpt-5-mini": {
					provider: "openai",
					base_model: "openai.gpt-5-mini",
					mode: "responses",
					max_input_tokens: 1_050_000,
					max_output_tokens: 128_000,
					input_cost_per_token: "0.0000025",
					output_cost_per_token: "0.000015",
					supported_modalities: ["text", "image"],
					supports_reasoning: true,
					supports_none_reasoning_effort: true,
					supports_minimal_reasoning_effort: true,
					supports_xhigh_reasoning_effort: true,
					default_reasoning_effort: "none",
				},
				"anthropic/claude-sonnet": {
					provider: "anthropic",
					base_model: "anthropic.claude-sonnet",
					mode: "chat",
					max_input_tokens: 200_000,
					max_output_tokens: 8_192,
				},
				"openai/dual-api": {
					provider: "openai",
					base_model: "dual-api",
					supported_endpoints: ["/v1/responses", "/v1/chat/completions"],
					max_input_tokens: 128_000,
					max_output_tokens: 16_384,
				},
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	});

	const models = await fetchAuthenticatedCatalog(
		"secret",
		"https://bifrost.example",
		new AbortController().signal,
		runtime,
	);

	assert.equal(calls, 2);
	assert.deepEqual(apisForId(models, "openai/gpt-5-mini"), ["openai-responses"]);
	const enrichedResponses = models.find(
		(model) =>
			model.id === "openai/gpt-5-mini" && model.api === "openai-responses",
	);
	assert.equal(enrichedResponses?.reasoning, true);
	assert.deepEqual(enrichedResponses?.thinkingLevelMap, {
		off: "none",
		minimal: "minimal",
		xhigh: "xhigh",
	});
	assert.deepEqual(enrichedResponses?.input, ["text", "image"]);
	assert.equal(enrichedResponses?.contextWindow, 1_050_000);
	assert.equal(enrichedResponses?.maxTokens, 128_000);
	assert.equal(enrichedResponses?.cost.input, 2.5);
	assert.equal(enrichedResponses?.cost.output, 15);
	assert.deepEqual(apisForId(models, "provider/claude-sonnet"), [
		"openai-completions",
	]);
	assert.deepEqual(apisForId(models, "provider/dual-api"), [
		"openai-responses",
		"openai-completions",
	]);
	assert.deepEqual(apisForId(models, "provider/unknown"), [
		"openai-completions",
	]);
});

test("explicit live metadata overrides conflicting datasheet capabilities", async () => {
	let calls = 0;
	const runtime = makeRuntime(async () => {
		calls += 1;
		if (calls === 1) {
			return new Response(
				JSON.stringify({
					data: [
						{ id: "explicit", supported_methods: ["responses"] },
						{ id: "shadow" },
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}

		return new Response(
			JSON.stringify({
				explicit: {
					mode: "chat",
					max_input_tokens: 128_000,
					max_output_tokens: 16_384,
				},
				shadow: {
					mode: "chat",
					max_input_tokens: 128_000,
					max_output_tokens: 16_384,
				},
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	});

	const models = await fetchAuthenticatedCatalog(
		"secret",
		"https://bifrost.example",
		new AbortController().signal,
		runtime,
	);

	assert.equal(calls, 2);
	assert.deepEqual(apisForId(models, "explicit"), ["openai-responses"]);
	assert.deepEqual(apisForId(models, "shadow"), ["openai-completions"]);
});

test("datasheet enrichment failures keep unclassified live models chat-only", async () => {
	let calls = 0;
	const runtime = makeRuntime(async () => {
		calls += 1;
		if (calls === 1) {
			return new Response(JSON.stringify({ data: [{ id: "mystery-model" }] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		throw new Error("timeout contacting datasheet");
	});

	const models = await fetchAuthenticatedCatalog(
		"secret",
		"https://bifrost.example",
		new AbortController().signal,
		runtime,
	);

	assert.equal(calls, 2);
	assert.deepEqual(apisForId(models, "mystery-model"), ["openai-completions"]);
});

test("rejects malformed /models payloads", async () => {
	const runtime = makeRuntime(
		async () =>
			new Response(JSON.stringify({ data: {} }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
	);

	await assert.rejects(
		() =>
			fetchAuthenticatedCatalog(
				"secret",
				"https://bifrost.example",
				new AbortController().signal,
				runtime,
			),
		/Bifrost \/models returned an invalid payload: data must be an array/,
	);
});

test("rejects malformed datasheet payloads", async () => {
	const runtime = makeRuntime(
		async () =>
			new Response(
				JSON.stringify({
					"openai/gpt-4o-mini": 1,
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
	);

	await assert.rejects(
		() => fetchDatasheetCatalog(new AbortController().signal, runtime),
		/Bifrost datasheet returned an invalid payload: entry "openai\/gpt-4o-mini" must be an object/,
	);
});

test("falls back to datasheet only for transport-like failures", () => {
	assert.equal(shouldFallbackToDatasheet(new Error("fetch failed")), true);
	assert.equal(shouldFallbackToDatasheet(new Error("ETIMEDOUT")), true);
	assert.equal(
		shouldFallbackToDatasheet(
			new Error("Bifrost model refresh failed (500): boom"),
		),
		false,
	);
	assert.equal(
		shouldFallbackToDatasheet(
			new Error(
				"Bifrost /models returned an invalid payload: data must be an array",
			),
		),
		false,
	);
});
