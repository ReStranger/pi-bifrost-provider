// @ts-nocheck
import assert from "node:assert/strict";
import test from "node:test";

import {
	apisFromBifrostModel,
	apisFromDatasheetEntry,
	buildDatasheetThinkingLevelMap,
	buildThinkingLevelMap,
	canonicalLiveModelId,
	datasheetHasImageInput,
	hasImageInput,
	perMillion,
	positiveInteger,
	resolveApisForBifrostModel,
	supportsReasoning,
	toPiModelFromDatasheet,
	toPiModels,
} from "../src/model-mapping.ts";

test("positiveInteger skips unknown limits and floors floats", () => {
	assert.equal(positiveInteger(undefined, 0, -5, Number.NaN), undefined);
	assert.equal(positiveInteger(0, 8_192), 8_192);
	assert.equal(positiveInteger(16_384.9), 16_384);
	assert.equal(positiveInteger(), undefined);
});

test("context window sums input+output tokens when no explicit length", () => {
	const [model] = toPiModels(
		{
			id: "summed",
			max_input_tokens: 100_000,
			max_output_tokens: 28_000,
			supported_methods: ["chat.completions"],
		},
		["openai-completions"],
	);
	assert.equal(model?.contextWindow, 128_000);
});

test("maxTokens never exceeds the context window", () => {
	const [model] = toPiModels(
		{
			id: "capped",
			context_length: 8_192,
			max_output_tokens: 32_768,
			supported_methods: ["chat.completions"],
		},
		["openai-completions"],
	);
	assert.equal(model?.contextWindow, 8_192);
	assert.equal(model?.maxTokens, 8_192);
});

test("zero and negative upstream limits fall back to defaults", () => {
	const [model] = toPiModels(
		{
			id: "broken-limits",
			context_length: 0,
			max_output_tokens: -100,
			per_request_limits: { prompt_tokens: 0, completion_tokens: -1 },
			supported_methods: ["chat.completions"],
		},
		["openai-completions"],
	);
	assert.equal(model?.contextWindow, 128_000);
	assert.equal(model?.maxTokens, 16_384);
});

test("prices assume per-token sources and scale to per-million", () => {
	// Per-token input: "0.000003"/token == $3 per million tokens.
	assert.equal(perMillion("0.000003"), 3);
	assert.equal(perMillion(0.000003), 3);
	// Contract: a bare `3` is read as 3M$/1M (3_000_000), NOT as $3/M.
	// Per-million inputs are outside the contract and intentionally unsupported.
	assert.equal(perMillion(3), 3_000_000);

	const [model] = toPiModels(
		{
			id: "priced",
			pricing: { prompt: "0.000003", completion: "0.000012" },
			supported_methods: ["chat.completions"],
		},
		["openai-completions"],
	);
	assert.equal(model?.cost.input, 3);
	assert.equal(model?.cost.output, 12);
	// No explicit cache pricing: cache falls back to the input price.
	assert.equal(model?.cost.cacheRead, 3);
	assert.equal(model?.cost.cacheWrite, 3);

	const [explicit] = toPiModels(
		{
			id: "cached",
			pricing: {
				prompt: "0.000003",
				input_cache_read: "0.0000003",
				input_cache_write: "0.00000375",
			},
			supported_methods: ["chat.completions"],
		},
		["openai-completions"],
	);
	assert.equal(explicit?.cost.cacheRead, 0.3);
	assert.equal(explicit?.cost.cacheWrite, 3.75);
});

test("detects reasoning from multiple Bifrost signals", () => {
	assert.equal(supportsReasoning({ id: "a", reasoning: {} }), true);
	assert.equal(
		supportsReasoning({ id: "b", supported_parameters: ["reasoning_effort"] }),
		true,
	);
	assert.equal(
		supportsReasoning({ id: "c", pricing: { internal_reasoning: "0.000001" } }),
		true,
	);
	assert.equal(supportsReasoning({ id: "d" }), false);
});

test("detects image input for Bifrost models and datasheet entries", () => {
	assert.equal(
		hasImageInput({
			id: "vision",
			architecture: { input_modalities: ["image"] },
		}),
		true,
	);
	assert.equal(datasheetHasImageInput({ supports_vision: true }), true);
	assert.equal(
		datasheetHasImageInput({ supported_modalities: ["text", "image"] }),
		true,
	);
	assert.equal(
		datasheetHasImageInput({ supported_modalities: ["text"] }),
		false,
	);
});

test("detects provider APIs only from explicit chat and responses markers", () => {
	assert.deepEqual(
		apisFromBifrostModel({
			id: "dual",
			supported_methods: ["chat.completions", "responses"],
		}),
		["openai-responses", "openai-completions"],
	);
	assert.deepEqual(
		apisFromBifrostModel({
			id: "chat-endpoint",
			supported_endpoints: ["/v1/chat/completions"],
		}),
		["openai-completions"],
	);
	assert.deepEqual(
		apisFromBifrostModel({
			id: "responses-mode",
			mode: "responses",
		}),
		["openai-responses"],
	);
	assert.deepEqual(
		apisFromBifrostModel({
			id: "legacy",
			supported_methods: ["completions"],
		}),
		[],
	);
	assert.deepEqual(apisFromBifrostModel({ id: "default" }), []);

	assert.deepEqual(
		apisFromDatasheetEntry({
			supported_endpoints: ["/v1/chat/completions", "/v1/responses"],
		}),
		["openai-responses", "openai-completions"],
	);
	assert.deepEqual(
		apisFromDatasheetEntry({
			supported_endpoints: ["/v1/completions"],
		}),
		[],
	);
	assert.deepEqual(apisFromDatasheetEntry({ mode: "chat" }), [
		"openai-completions",
	]);
});

test("builds a thinking level map with null gaps", () => {
	assert.deepEqual(
		buildThinkingLevelMap({ mandatory: true, supported_efforts: ["low", "max"] }),
		{
			off: null,
			minimal: null,
			low: "low",
			medium: null,
			high: null,
			xhigh: "max",
			max: "max",
		},
	);
});

test("builds datasheet thinking maps from supported effort flags", () => {
	assert.deepEqual(
		buildDatasheetThinkingLevelMap({
			supports_reasoning: true,
			supports_none_reasoning_effort: true,
			supports_minimal_reasoning_effort: true,
			supports_xhigh_reasoning_effort: true,
			default_reasoning_effort: "none",
		}),
		{
			off: "none",
			minimal: "minimal",
			low: null,
			medium: null,
			high: null,
			xhigh: "xhigh",
			max: null,
		},
	);
});

test("canonicalizes live ids and resolves live/datasheet/fallback APIs", () => {
	assert.equal(canonicalLiveModelId("openai/gpt-4o-mini"), "gpt-4o-mini");
	assert.equal(
		canonicalLiveModelId("anthropic.claude-3-5-sonnet"),
		"claude-3-5-sonnet",
	);
	assert.equal(canonicalLiveModelId("provider/@alias"), undefined);
	assert.deepEqual(
		resolveApisForBifrostModel(
			{ id: "openai/gpt-4.1-mini" },
			new Map([["gpt-4.1-mini", ["openai-responses"]]]),
		),
		["openai-responses"],
	);
	assert.deepEqual(
		resolveApisForBifrostModel(
			{ id: "conflict", supported_methods: ["chat.completions"] },
			new Map([["conflict", ["openai-responses"]]]),
		),
		["openai-completions"],
	);
	assert.deepEqual(resolveApisForBifrostModel({ id: "unknown" }), [
		"openai-completions",
	]);
});

test("maps live models with explicit or resolved APIs into Pi models", () => {
	const single = toPiModels({
		id: "chat-only",
		normalized_name: "Chat Only",
		context_length: 10_000,
		max_output_tokens: 2_000,
		supported_methods: ["chat.completions"],
	});
	assert.deepEqual(
		single.map((model) => model.api),
		["openai-completions"],
	);
	assert.equal(single[0]?.name, "Chat Only");
	assert.equal(single[0]?.contextWindow, 10_000);
	assert.equal(single[0]?.maxTokens, 2_000);
	assert.deepEqual(single[0]?.compat, {
		supportsDeveloperRole: true,
		supportsReasoningEffort: false,
		supportsUsageInStreaming: true,
		supportsStrictMode: true,
		maxTokensField: "max_tokens",
	});

	const ambiguous = toPiModels({
		id: "ambiguous",
		name: "Ambiguous",
		supported_methods: ["completions"],
	});
	assert.deepEqual(ambiguous, []);

	const enriched = toPiModels(
		{
			id: "weegam/gpt-5.4",
			name: "Enriched",
		},
		["openai-responses"],
		{
			supports_reasoning: true,
			supports_none_reasoning_effort: true,
			supports_minimal_reasoning_effort: true,
			supports_xhigh_reasoning_effort: true,
			default_reasoning_effort: "none",
			supported_modalities: ["text", "image"],
			max_input_tokens: 1_050_000,
			max_output_tokens: 128_000,
			input_cost_per_token: "0.0000025",
			output_cost_per_token: "0.000015",
		},
	);
	assert.deepEqual(
		enriched.map((model) => ({ id: model.id, api: model.api })),
		[{ id: "weegam/gpt-5.4", api: "openai-responses" }],
	);
	assert.equal(enriched[0]?.reasoning, true);
	assert.deepEqual(enriched[0]?.thinkingLevelMap, {
		off: "none",
		minimal: "minimal",
		low: null,
		medium: null,
		high: null,
		xhigh: "xhigh",
		max: null,
	});
	assert.deepEqual(enriched[0]?.input, ["text", "image"]);
	assert.equal(enriched[0]?.contextWindow, 1_050_000);
	assert.equal(enriched[0]?.maxTokens, 128_000);
	assert.equal(enriched[0]?.cost.input, 2.5);
	assert.equal(enriched[0]?.cost.output, 15);

	const liveWins = toPiModels(
		{
			id: "live-first",
			context_length: 8_192,
			max_output_tokens: 2_048,
			pricing: { prompt: "0.000003" },
			reasoning: { supported_efforts: ["medium"] },
		},
		["openai-completions"],
		{
			supports_reasoning: true,
			supports_none_reasoning_effort: true,
			supports_xhigh_reasoning_effort: true,
			max_input_tokens: 128_000,
			max_output_tokens: 16_384,
			input_cost_per_token: "0.000001",
		},
	);
	assert.equal(liveWins[0]?.contextWindow, 8_192);
	assert.equal(liveWins[0]?.maxTokens, 2_048);
	assert.equal(liveWins[0]?.cost.input, 3);
	assert.deepEqual(liveWins[0]?.thinkingLevelMap, {
		minimal: null,
		low: null,
		medium: "medium",
		high: null,
	});

	const dual = toPiModels({
		id: "dual-api",
		name: "Dual API",
		supported_methods: ["chat.completions", "responses"],
		reasoning: { supported_efforts: ["medium"] },
		architecture: { input_modalities: ["text", "image"] },
	});
	assert.deepEqual(
		dual.map((model) => model.api),
		["openai-responses", "openai-completions"],
	);
	assert.deepEqual(dual[0]?.input, ["text", "image"]);
	assert.equal(dual[0]?.reasoning, true);
	assert.deepEqual(dual[0]?.compat, {
		supportsDeveloperRole: true,
		supportsStrictMode: true,
	});
	assert.deepEqual(dual[1]?.compat, {
		supportsDeveloperRole: true,
		supportsReasoningEffort: true,
		supportsUsageInStreaming: true,
		supportsStrictMode: true,
		maxTokensField: "max_tokens",
	});
});

test("applies datasheet compat and reasoning metadata", () => {
	const chat = toPiModelFromDatasheet(
		"gpt-4o-mini",
		{
			max_input_tokens: 128_000,
			max_output_tokens: 16_384,
			supported_endpoints: ["/v1/chat/completions"],
		},
		"openai-completions",
	);
	assert.deepEqual(chat?.compat, {
		supportsDeveloperRole: true,
		supportsReasoningEffort: false,
		supportsUsageInStreaming: true,
		supportsStrictMode: true,
		maxTokensField: "max_tokens",
	});

	const responses = toPiModelFromDatasheet(
		"gpt-5.4",
		{
			max_input_tokens: 1_050_000,
			max_output_tokens: 128_000,
			supported_endpoints: ["/v1/responses"],
			supports_reasoning: true,
			supports_none_reasoning_effort: true,
			supports_minimal_reasoning_effort: true,
			supports_xhigh_reasoning_effort: true,
			default_reasoning_effort: "none",
		},
		"openai-responses",
	);
	assert.deepEqual(responses?.compat, {
		supportsDeveloperRole: true,
		supportsStrictMode: true,
	});
	assert.deepEqual(responses?.thinkingLevelMap, {
		off: "none",
		minimal: "minimal",
		low: null,
		medium: null,
		high: null,
		xhigh: "xhigh",
		max: null,
	});
});
