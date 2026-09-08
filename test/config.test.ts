// @ts-nocheck
import assert from "node:assert/strict";
import test from "node:test";

import {
	buildModelsUrl,
	flagFromArgv,
	getRefreshIntervalMs,
	getRequestTimeoutMs,
	normalizeBaseOrigin,
	readCredentialBaseOrigin,
	readFlagConfig,
	resolveEffectiveConfig,
	toApiBase,
	tryNormalizeBaseOrigin,
} from "../src/config.ts";
import type { BifrostRuntime } from "../src/runtime.ts";

function makeRuntime(
	env: Record<string, string | undefined> = {},
): BifrostRuntime {
	return {
		env,
		fetch: async () => {
			throw new Error("unexpected fetch");
		},
		now: () => 0,
	};
}

test("normalizes Bifrost origins and API bases", () => {
	assert.equal(
		normalizeBaseOrigin("https://proxy.example.com/v1/"),
		"https://proxy.example.com",
	);
	assert.equal(
		normalizeBaseOrigin(" https://proxy.example.com/custom/path/ "),
		"https://proxy.example.com/custom/path",
	);
	assert.equal(
		toApiBase("https://proxy.example.com/v1"),
		"https://proxy.example.com/v1",
	);
});

test("returns undefined for blank or invalid optional origins", () => {
	assert.equal(tryNormalizeBaseOrigin(undefined), undefined);
	assert.equal(tryNormalizeBaseOrigin("   "), undefined);
	assert.equal(tryNormalizeBaseOrigin("not a url"), undefined);
});

test("reads normalized base origin only from api-key credentials", () => {
	assert.equal(
		readCredentialBaseOrigin({
			type: "api_key",
			env: { BIFROST_BASE_URL: "https://gateway.example/v1/" },
		}),
		"https://gateway.example",
	);
	assert.equal(
		readCredentialBaseOrigin({
			type: "oauth",
			env: { BIFROST_BASE_URL: "https://gateway.example" },
		}),
		undefined,
	);
});

test("builds the authenticated /models URL from the configured origin", () => {
	assert.equal(
		buildModelsUrl("https://bifrost.example/v1", undefined).toString(),
		"https://bifrost.example/v1/models?page_size=200",
	);
	assert.equal(
		buildModelsUrl("https://bifrost.example", "next-token").toString(),
		"https://bifrost.example/v1/models?page_size=200&page_token=next-token",
	);
});

test("falls back for invalid refresh intervals", () => {
	assert.equal(getRefreshIntervalMs(makeRuntime()), 15 * 60 * 1000);
	assert.equal(
		getRefreshIntervalMs(makeRuntime({ BIFROST_REFRESH_INTERVAL_MS: "nope" })),
		15 * 60 * 1000,
	);
});

test("falls back for invalid request timeouts", () => {
	assert.equal(getRequestTimeoutMs(makeRuntime()), 8_000);
	assert.equal(
		getRequestTimeoutMs(makeRuntime({ BIFROST_REQUEST_TIMEOUT_MS: "0" })),
		8_000,
	);
	assert.equal(
		getRequestTimeoutMs(makeRuntime({ BIFROST_REQUEST_TIMEOUT_MS: "abc" })),
		8_000,
	);
});

test("strips endpoint suffixes before the /v1 prefix", () => {
	assert.equal(
		normalizeBaseOrigin("https://proxy.example.com/v1/models"),
		"https://proxy.example.com",
	);
	assert.equal(
		normalizeBaseOrigin("https://proxy.example.com/v1/chat/completions/"),
		"https://proxy.example.com",
	);
	assert.equal(
		normalizeBaseOrigin("https://proxy.example.com/v1/responses"),
		"https://proxy.example.com",
	);
	assert.equal(
		normalizeBaseOrigin("https://proxy.example.com/models"),
		"https://proxy.example.com",
	);
	// A mere prefix match is not a suffix: /v10 stays intact.
	assert.equal(
		normalizeBaseOrigin("https://proxy.example.com/v10"),
		"https://proxy.example.com/v10",
	);
});

test("reads CLI flags in both --name value and --name=value forms", () => {
	assert.equal(
		flagFromArgv("bifrost-base-url", ["--bifrost-base-url", "https://a.example"]),
		"https://a.example",
	);
	assert.equal(
		flagFromArgv("bifrost-base-url", ["--bifrost-base-url=https://b.example"]),
		"https://b.example",
	);
	assert.equal(flagFromArgv("bifrost-base-url", ["--other", "x"]), undefined);
	assert.equal(flagFromArgv("bifrost-base-url", []), undefined);
	// A value starting with -- is the next flag, i.e. no value.
	assert.equal(
		flagFromArgv("bifrost-base-url", ["--bifrost-base-url", "--bifrost-api-key"]),
		undefined,
	);
	assert.equal(
		flagFromArgv("bifrost-base-url", ["--bifrost-base-url="]),
		undefined,
	);
	assert.equal(
		flagFromArgv("bifrost-base-url", ["--bifrost-base-url"]),
		undefined,
	);
});

test("prefers pi.getFlag() over raw argv and normalizes the URL", () => {
	assert.deepEqual(
		readFlagConfig({
			getFlag: (name) =>
				name === "bifrost-base-url" ? "https://flag.example/v1/models " : undefined,
			argv: [
				"--bifrost-base-url=https://argv.example",
				"--bifrost-api-key=argv-key",
			],
		}),
		{ baseOrigin: "https://flag.example", apiKey: "argv-key" },
	);
	assert.deepEqual(
		readFlagConfig({
			argv: ["--bifrost-api-key", "argv-key"],
		}),
		{ baseOrigin: undefined, apiKey: "argv-key" },
	);
	assert.deepEqual(readFlagConfig({}), {
		baseOrigin: undefined,
		apiKey: undefined,
	});
});

test("resolves stored credential > flags > env with provenance", () => {
	assert.deepEqual(
		resolveEffectiveConfig({
			credential: {
				type: "api_key",
				key: "stored-key",
				env: { BIFROST_BASE_URL: "https://stored.example" },
			},
			flags: { baseOrigin: "https://flag.example", apiKey: "flag-key" },
			env: { BIFROST_BASE_URL: "https://env.example", BIFROST_API_KEY: "env-key" },
		}),
		{
			baseOrigin: "https://stored.example",
			apiKey: "stored-key",
			baseSource: "stored",
			keySource: "stored",
		},
	);
	// Stored key without a stored URL still wins for the key when flags own the URL.
	assert.deepEqual(
		resolveEffectiveConfig({
			credential: { type: "api_key", key: "stored-key" },
			flags: { baseOrigin: "https://flag.example", apiKey: "flag-key" },
		}),
		{
			baseOrigin: "https://flag.example",
			apiKey: "stored-key",
			baseSource: "flag",
			keySource: "stored",
		},
	);
	assert.deepEqual(
		resolveEffectiveConfig({
			flags: { baseOrigin: "https://flag.example", apiKey: "flag-key" },
			env: { BIFROST_BASE_URL: "https://env.example", BIFROST_API_KEY: "env-key" },
		}),
		{
			baseOrigin: "https://flag.example",
			apiKey: "flag-key",
			baseSource: "flag",
			keySource: "flag",
		},
	);
	assert.deepEqual(
		resolveEffectiveConfig({
			env: { BIFROST_BASE_URL: "https://env.example", BIFROST_API_KEY: "env-key" },
		}),
		{
			baseOrigin: "https://env.example",
			apiKey: "env-key",
			baseSource: "env",
			keySource: "env",
		},
	);
});

test("owns-config guard keeps ambient keys away from a stored URL", () => {
	// Stored URL without a stored key: no ambient key may leak in.
	assert.equal(
		resolveEffectiveConfig({
			credential: {
				type: "api_key",
				env: { BIFROST_BASE_URL: "https://stored.example" },
			},
			flags: { apiKey: "flag-key" },
			env: { BIFROST_API_KEY: "env-key" },
		}),
		undefined,
	);
	// Non-api-key credentials contribute neither URL nor key.
	assert.equal(
		resolveEffectiveConfig({
			credential: {
				type: "oauth",
				key: "k",
				env: { BIFROST_BASE_URL: "https://x.example" },
			},
			env: { BIFROST_API_KEY: "env-key" },
		}),
		undefined,
	);
	assert.equal(resolveEffectiveConfig({}), undefined);
	assert.equal(
		resolveEffectiveConfig({ env: { BIFROST_API_KEY: "env-key" } }),
		undefined,
	);
});
