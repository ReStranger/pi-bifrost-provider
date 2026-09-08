// @ts-nocheck
import assert from "node:assert/strict";
import test from "node:test";

import bifrostProvider from "../index.ts";
import { setPendingCatalog } from "../src/refresh-models.ts";
import type { BifrostRuntime } from "../src/runtime.ts";

function makePi(flags: Record<string, string | undefined> = {}) {
	const registeredFlags: Array<{ name: string; options: unknown }> = [];
	const registeredProviders: Array<any> = [];
	return {
		registeredFlags,
		registeredProviders,
		pi: {
			registerFlag(name: string, options: unknown) {
				registeredFlags.push({ name, options });
			},
			getFlag(name: string) {
				return flags[name];
			},
			registerProvider(provider: unknown) {
				registeredProviders.push(provider);
			},
		},
	};
}

function makeRuntime(
	options: {
		env?: Record<string, string | undefined>;
		fetch?: typeof fetch;
	} = {},
): BifrostRuntime {
	return {
		env: options.env ?? {},
		fetch:
			options.fetch ??
			(async () => {
				throw new Error("fetch must not be called without config");
			}),
		now: () => 9_000,
	};
}

function catalogResponse() {
	return new Response(
		JSON.stringify({
			data: [
				{
					id: "startup-chat",
					supported_methods: ["chat.completions"],
				},
			],
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

test("registers flags and providers without discovery when unconfigured", async () => {
	const { registeredFlags, registeredProviders, pi } = makePi();
	const warnings: string[] = [];

	await bifrostProvider(pi, {
		runtime: makeRuntime(),
		warn: (message) => warnings.push(message),
	});

	assert.deepEqual(
		registeredFlags.map((flag) => flag.name),
		["bifrost-base-url", "bifrost-api-key"],
	);
	assert.deepEqual(
		registeredProviders.map((provider: any) => provider.id),
		["bifrost-responses", "bifrost-completions"],
	);
	assert.deepEqual(warnings, []);
});

test("failed startup discovery warns and still registers providers", async () => {
	const { registeredProviders, pi } = makePi();
	const warnings: string[] = [];
	let fetchCalls = 0;

	await bifrostProvider(pi, {
		runtime: makeRuntime({
			env: {
				BIFROST_BASE_URL: "https://down.example",
				BIFROST_API_KEY: "secret",
			},
			fetch: async () => {
				fetchCalls += 1;
				throw new Error("gateway is down");
			},
		}),
		warn: (message) => warnings.push(message),
	});

	assert.equal(fetchCalls, 1);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /startup model discovery failed/);
	assert.match(warnings[0], /gateway is down/);
	assert.deepEqual(
		registeredProviders.map((provider: any) => provider.id),
		["bifrost-responses", "bifrost-completions"],
	);
});

test("successful startup discovery preloads the offline refresh path", async () => {
	const { registeredProviders, pi } = makePi();
	const warnings: string[] = [];

	try {
		await bifrostProvider(pi, {
			runtime: makeRuntime({
				env: {
					BIFROST_BASE_URL: "https://startup.example",
					BIFROST_API_KEY: "secret",
				},
				fetch: async () => catalogResponse(),
			}),
			warn: (message) => warnings.push(message),
		});
		assert.deepEqual(warnings, []);

		const completions = registeredProviders.find(
			(provider: any) => provider.id === "bifrost-completions",
		);
		const outcome: { persist?: unknown } = {};
		await completions.refreshModels({
			credential: undefined,
			stored: undefined,
			allowNetwork: false,
			force: false,
			signal: new AbortController().signal,
			publish: async (publication: { update?: () => void; persist?: unknown }) => {
				publication.update?.();
				outcome.persist = publication.persist;
				return true;
			},
		});
		assert.deepEqual(
			completions.getModels().map((model: any) => model.id),
			["startup-chat"],
		);
		assert.ok(outcome.persist);
	} finally {
		setPendingCatalog(undefined);
	}
});

test("startup discovery prefers CLI flags over env", async () => {
	const { registeredProviders, pi } = makePi({
		"bifrost-base-url": "https://flag.example",
	});
	const seenUrls: string[] = [];

	try {
		await bifrostProvider(pi, {
			runtime: makeRuntime({
				env: {
					BIFROST_BASE_URL: "https://env.example",
					BIFROST_API_KEY: "secret",
				},
				fetch: (async (url: any) => {
					seenUrls.push(String(url));
					return catalogResponse();
				}) as typeof fetch,
			}),
			warn: () => {},
		});
		assert.ok(
			seenUrls.length > 0 &&
				seenUrls.every((url) => url.startsWith("https://flag.example/")),
		);
		assert.equal(registeredProviders.length, 2);
	} finally {
		setPendingCatalog(undefined);
	}
});
