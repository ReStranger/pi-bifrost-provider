// @ts-nocheck
import assert from "node:assert/strict";
import test from "node:test";

import {
	buildModelsUrl,
	getRefreshIntervalMs,
	getRequestTimeoutMs,
	normalizeBaseOrigin,
	readCredentialBaseOrigin,
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
