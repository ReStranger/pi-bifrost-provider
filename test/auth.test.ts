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

test("merges stored key with ambient base URL and vice versa", async () => {
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

	const storedUrl = await resolveBifrostAuth({
		ctx: makeContext({ [BIFROST_API_KEY_ENV]: "env-key" }),
		credential: {
			type: "api_key",
			env: {
				[BIFROST_BASE_URL_ENV]: "https://stored.example/",
			},
		},
		signal: makeAbortSignal(),
	});
	assert.equal(storedUrl?.auth.apiKey, "env-key");
	assert.equal(storedUrl?.auth.baseUrl, "https://stored.example/v1");
	assert.equal(storedUrl?.source, "stored credential");
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

test("ambient auth does not expose interactive login", () => {
	const auth = createBifrostApiKeyAuth();
	assert.equal(auth.login, undefined);
});

test("legacy login helper is disabled and points callers to env config", async () => {
	await assert.rejects(
		() =>
			loginBifrost({
				signal: makeAbortSignal(),
				notify: () => {},
				prompt: async () => {
					throw new Error("prompt should not be called");
				},
			}),
		/Bifrost login is not supported; configure BIFROST_API_KEY and BIFROST_BASE_URL/,
	);
});
