// @ts-nocheck
import assert from "node:assert/strict";
import test from "node:test";

import {
	createBifrostApiKeyAuth,
	loginBifrost,
	resolveBifrostAuth,
} from "../src/auth.ts";
import { BIFROST_API_KEY_ENV, BIFROST_BASE_URL_ENV } from "../src/types.ts";

function makeAbortSignal(): AbortSignal {
	return new AbortController().signal;
}

function makeContext(env: Record<string, string | undefined>) {
	return {
		env: async (name: string) => env[name],
		fileExists: async () => false,
	};
}

test("resolves stored key and stored base URL", async () => {
	const result = await resolveBifrostAuth({
		ctx: makeContext({}),
		credential: {
			type: "api_key",
			key: " stored-secret ",
			env: {
				[BIFROST_BASE_URL_ENV]: "https://gateway.example/v1/",
			},
		},
		signal: makeAbortSignal(),
	});

	assert.deepEqual(result, {
		auth: {
			apiKey: "stored-secret",
			baseUrl: "https://gateway.example/v1",
		},
		env: {
			[BIFROST_BASE_URL_ENV]: "https://gateway.example",
		},
		source: "stored credential",
	});
});

test("merges stored key with ambient base URL", async () => {
	const storedKey = await resolveBifrostAuth({
		ctx: makeContext({ [BIFROST_BASE_URL_ENV]: "https://env.example/v1" }),
		credential: {
			type: "api_key",
			key: "stored-key",
		},
		signal: makeAbortSignal(),
	});
	assert.equal(storedKey?.auth.apiKey, "stored-key");
	assert.equal(storedKey?.auth.baseUrl, "https://env.example/v1");
	assert.equal(storedKey?.source, "stored credential");
});

test("owns-config guard: a stored URL never absorbs ambient keys", async () => {
	// A stale env key for a different gateway must not leak into the stored
	// URL (e.g. after the URL was changed via /login).
	assert.equal(
		await resolveBifrostAuth({
			ctx: makeContext({ [BIFROST_API_KEY_ENV]: "env-key" }),
			credential: {
				type: "api_key",
				env: {
					[BIFROST_BASE_URL_ENV]: "https://stored.example/",
				},
			},
			signal: makeAbortSignal(),
		}),
		undefined,
	);
	assert.equal(
		await resolveBifrostAuth({
			ctx: makeContext({}),
			credential: {
				type: "api_key",
				env: {
					[BIFROST_BASE_URL_ENV]: "https://stored.example/",
				},
			},
			flags: { apiKey: "flag-key" },
			signal: makeAbortSignal(),
		}),
		undefined,
	);
});

test("CLI flags fill gaps below the stored credential", async () => {
	const flagBase = await resolveBifrostAuth({
		ctx: makeContext({ [BIFROST_API_KEY_ENV]: "env-key" }),
		flags: { baseOrigin: "https://flag.example" },
		signal: makeAbortSignal(),
	});
	assert.equal(flagBase?.auth.apiKey, "env-key");
	assert.equal(flagBase?.auth.baseUrl, "https://flag.example/v1");
	assert.equal(flagBase?.source, "CLI flag");

	const flagKey = await resolveBifrostAuth({
		ctx: makeContext({ [BIFROST_BASE_URL_ENV]: "https://env.example" }),
		flags: { apiKey: "flag-key" },
		signal: makeAbortSignal(),
	});
	assert.equal(flagKey?.auth.apiKey, "flag-key");
	assert.equal(flagKey?.source, "CLI flag");

	const storedKeyWithFlagBase = await resolveBifrostAuth({
		ctx: makeContext({}),
		credential: { type: "api_key", key: "stored-key" },
		flags: { baseOrigin: "https://flag.example" },
		signal: makeAbortSignal(),
	});
	assert.equal(storedKeyWithFlagBase?.auth.apiKey, "stored-key");
	assert.equal(storedKeyWithFlagBase?.auth.baseUrl, "https://flag.example/v1");
	assert.equal(storedKeyWithFlagBase?.source, "stored credential");
});

test("returns undefined when either the key or URL is missing", async () => {
	assert.equal(
		await resolveBifrostAuth({
			ctx: makeContext({ [BIFROST_BASE_URL_ENV]: "https://gateway.example" }),
			signal: makeAbortSignal(),
		}),
		undefined,
	);
	assert.equal(
		await resolveBifrostAuth({
			ctx: makeContext({ [BIFROST_API_KEY_ENV]: "secret" }),
			signal: makeAbortSignal(),
		}),
		undefined,
	);
});

test("api-key auth exposes interactive login", () => {
	const auth = createBifrostApiKeyAuth();
	assert.equal(typeof auth.login, "function");
});

function makeRuntime(fetchImpl: typeof fetch) {
	return {
		env: {},
		fetch: fetchImpl,
		now: () => 0,
	};
}

function modelsPayload() {
	return new Response(
		JSON.stringify({
			data: [
				{
					id: "chat-model",
					supported_methods: ["chat.completions"],
				},
			],
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

function makeInteraction(answers: string[]) {
	const notifications: Array<{ type: string; message: string }> = [];
	const prompts: unknown[] = [];
	return {
		notifications,
		prompts,
		signal: makeAbortSignal(),
		notify: (event: { type: string; message: string }) => {
			notifications.push(event);
		},
		prompt: async (prompt: unknown) => {
			prompts.push(prompt);
			const answer = answers.shift();
			if (answer === undefined) throw new Error("no more prompt answers");
			return answer;
		},
	};
}

test("login prompts for URL and key, validates, and returns a credential", async () => {
	const seen: Array<{ url: unknown; authorization: string | null }> = [];
	const runtime = makeRuntime((async (url: unknown, init?: RequestInit) => {
		seen.push({
			url,
			// @ts-expect-error Headers constructed from the mock init
			authorization: new Headers(init?.headers).get("authorization"),
		});
		return modelsPayload();
	}) as typeof fetch);
	const interaction = makeInteraction([
		"https://gateway.example/v1/",
		"login-secret",
	]);
	let authenticated: unknown;
	const auth = createBifrostApiKeyAuth({
		runtime,
		onAuthenticated: (catalog) => {
			authenticated = catalog;
		},
	});

	const credential = await auth.login!(interaction);

	assert.deepEqual(credential, {
		type: "api_key",
		key: "login-secret",
		env: {
			[BIFROST_BASE_URL_ENV]: "https://gateway.example",
		},
	});
	// Discovery hits the normalized origin with a Bearer key.
	assert.equal(seen.length, 1);
	assert.match(String(seen[0]?.url), /^https:\/\/gateway\.example\/v1\/models/);
	assert.equal(seen[0]?.authorization, "Bearer login-secret");
	// Progress + info notifications, and the validated catalog is reported.
	assert.ok(
		interaction.notifications.some((entry) => entry.type === "progress"),
	);
	assert.ok(interaction.notifications.some((entry) => entry.type === "info"));
	assert.equal(
		(authenticated as { baseOrigin: string }).baseOrigin,
		"https://gateway.example",
	);
	assert.deepEqual(
		(authenticated as { models: Array<{ id: string }> }).models.map(
			(model) => model.id,
		),
		["chat-model"],
	);

	// Resolve after login serves the stored base URL.
	const resolved = await resolveBifrostAuth({
		ctx: makeContext({}),
		credential,
		signal: makeAbortSignal(),
	});
	assert.equal(resolved?.auth.baseUrl, "https://gateway.example/v1");
	assert.equal(resolved?.source, "stored credential");
});

test("login rejects an invalid URL before any network call", async () => {
	let calls = 0;
	const runtime = makeRuntime((async () => {
		calls++;
		return modelsPayload();
	}) as typeof fetch);
	const interaction = makeInteraction(["not a url"]);

	await assert.rejects(
		() => loginBifrost(interaction, { runtime }),
		/Invalid Bifrost base URL/,
	);
	assert.equal(calls, 0);
});

test("login rejects an empty API key without contacting the gateway", async () => {
	let calls = 0;
	const runtime = makeRuntime((async () => {
		calls++;
		return modelsPayload();
	}) as typeof fetch);
	const interaction = makeInteraction(["https://gateway.example", "   "]);

	await assert.rejects(
		() => loginBifrost(interaction, { runtime }),
		/Bifrost API key is required/,
	);
	assert.equal(calls, 0);
});

test("login surfaces gateway failures instead of storing a dead credential", async () => {
	const runtime = makeRuntime(
		(async () => new Response("forbidden", { status: 403 })) as typeof fetch,
	);
	const interaction = makeInteraction(["https://gateway.example", "bad-secret"]);

	await assert.rejects(
		() => loginBifrost(interaction, { runtime }),
		/Bifrost model refresh failed \(403\): forbidden/,
	);
});
