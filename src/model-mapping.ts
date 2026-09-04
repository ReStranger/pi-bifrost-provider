import type {
	BifrostModel,
	BifrostReasoning,
	CatalogApi,
	DatasheetEntry,
	PiModel,
} from "./types.ts";

const CATALOG_API_ORDER = [
	"openai-responses",
	"openai-completions",
] as const satisfies readonly CatalogApi[];

function orderedApis(apis: ReadonlySet<CatalogApi>): CatalogApi[] {
	return CATALOG_API_ORDER.filter((api) => apis.has(api));
}

function normalizeCanonicalModelId(
	candidate: string | undefined,
): string | undefined {
	if (!candidate || candidate.startsWith("@")) return undefined;
	const normalized = candidate
		.replace(/^openai\./u, "")
		.replace(/^anthropic\./u, "")
		.trim()
		.toLowerCase();
	return normalized && !normalized.startsWith("@") && !normalized.includes("/")
		? normalized
		: undefined;
}

export function asNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "string") return undefined;
	const parsed = Number.parseFloat(value.trim());
	return Number.isFinite(parsed) ? parsed : undefined;
}

export function perMillion(value: unknown): number {
	return (asNumber(value) ?? 0) * 1_000_000;
}

export function lowerCaseEntries(
	values: readonly string[] | undefined,
): string[] {
	return (values ?? []).map((entry) => entry.toLowerCase());
}

export function hasImageInput(model: BifrostModel): boolean {
	return lowerCaseEntries(model.architecture?.input_modalities).includes(
		"image",
	);
}

export function datasheetHasImageInput(entry: DatasheetEntry): boolean {
	if (entry.supports_vision) return true;
	return lowerCaseEntries(entry.supported_modalities).includes("image");
}

export function supportsReasoning(model: BifrostModel): boolean {
	if (model.reasoning) return true;
	const params = lowerCaseEntries(model.supported_parameters);
	if (params.some((entry) => entry.includes("reason"))) return true;
	if (params.some((entry) => entry.includes("thinking"))) return true;
	return perMillion(model.pricing?.internal_reasoning) > 0;
}

export function apisFromBifrostModel(model: BifrostModel): CatalogApi[] {
	const methods = lowerCaseEntries(model.supported_methods);
	const endpoints = lowerCaseEntries(model.supported_endpoints);
	const mode = model.mode?.trim().toLowerCase();
	const apis = new Set<CatalogApi>();
	if (
		methods.some((entry) => entry.includes("response")) ||
		endpoints.some((endpoint) => endpoint.includes("/responses")) ||
		mode === "responses"
	) {
		apis.add("openai-responses");
	}
	if (
		methods.some((entry) => entry.includes("chat")) ||
		endpoints.some((endpoint) => endpoint.includes("/chat/completions")) ||
		mode === "chat"
	) {
		apis.add("openai-completions");
	}
	return orderedApis(apis);
}

export function apisFromDatasheetEntry(entry: DatasheetEntry): CatalogApi[] {
	const endpoints = lowerCaseEntries(entry.supported_endpoints);
	const apis = new Set<CatalogApi>();
	if (endpoints.some((endpoint) => endpoint.includes("/responses"))) {
		apis.add("openai-responses");
	}
	if (endpoints.some((endpoint) => endpoint.includes("/chat/completions"))) {
		apis.add("openai-completions");
	}
	if (apis.size > 0) return orderedApis(apis);

	const mode = entry.mode?.trim().toLowerCase();
	if (mode === "responses") return ["openai-responses"];
	if (mode === "chat") return ["openai-completions"];
	return [];
}

export function buildThinkingLevelMap(
	reasoning: BifrostReasoning | undefined,
): PiModel["thinkingLevelMap"] {
	if (!reasoning) return undefined;

	const map: NonNullable<PiModel["thinkingLevelMap"]> = {};
	let changed = false;

	if (reasoning.mandatory) {
		map.off = null;
		changed = true;
	}

	const supported = new Set(lowerCaseEntries(reasoning.supported_efforts));
	if (supported.size > 0) {
		for (const level of ["minimal", "low", "medium", "high"] as const) {
			map[level] = supported.has(level) ? level : null;
			changed = true;
		}

		if (supported.has("xhigh")) {
			map.xhigh = "xhigh";
			changed = true;
		} else if (supported.has("max")) {
			map.xhigh = "max";
			changed = true;
		}

		if (supported.has("max")) {
			map.max = "max";
			changed = true;
		}
	}

	return changed ? map : undefined;
}

export function buildDatasheetThinkingLevelMap(
	entry: DatasheetEntry | undefined,
): PiModel["thinkingLevelMap"] {
	if (!entry?.supports_reasoning) return undefined;

	const supportsEfforts = {
		off: entry.supports_none_reasoning_effort === true ? "none" : undefined,
		minimal:
			entry.supports_minimal_reasoning_effort === true ? "minimal" : undefined,
		low: entry.supports_low_reasoning_effort === true ? "low" : undefined,
		medium:
			entry.supports_medium_reasoning_effort === true ? "medium" : undefined,
		high: entry.supports_high_reasoning_effort === true ? "high" : undefined,
		xhigh: entry.supports_xhigh_reasoning_effort === true ? "xhigh" : undefined,
		max: entry.supports_max_reasoning_effort === true ? "max" : undefined,
	} as const;
	const hasExplicitSupport = Object.values(supportsEfforts).some(
		(value) => value !== undefined,
	);
	const map: NonNullable<PiModel["thinkingLevelMap"]> = {};
	let changed = false;

	if (hasExplicitSupport) {
		map.off = supportsEfforts.off ?? null;
		map.minimal = supportsEfforts.minimal ?? null;
		map.low = supportsEfforts.low ?? null;
		map.medium = supportsEfforts.medium ?? null;
		map.high = supportsEfforts.high ?? null;
		map.xhigh = supportsEfforts.xhigh ?? null;
		map.max = supportsEfforts.max ?? null;
		changed = true;
	}

	const defaultEffort = entry.default_reasoning_effort?.trim().toLowerCase();
	if (defaultEffort === "none") {
		map.off = "none";
		changed = true;
	} else if (defaultEffort === "minimal") {
		map.minimal = "minimal";
		changed = true;
	} else if (defaultEffort === "low") {
		map.low = "low";
		changed = true;
	} else if (defaultEffort === "medium") {
		map.medium = "medium";
		changed = true;
	} else if (defaultEffort === "high") {
		map.high = "high";
		changed = true;
	} else if (defaultEffort === "xhigh") {
		map.xhigh = "xhigh";
		changed = true;
	} else if (defaultEffort === "max") {
		map.max = "max";
		changed = true;
	}

	return changed ? map : undefined;
}

function compatForApi(api: CatalogApi): PiModel["compat"] | undefined {
	if (api === "openai-completions") {
		return { maxTokensField: "max_tokens" };
	}
	return undefined;
}

export function resolveApisForBifrostModel(
	model: BifrostModel,
	datasheetCapabilities?: ReadonlyMap<string, readonly CatalogApi[]>,
): CatalogApi[] {
	const liveApis = apisFromBifrostModel(model);
	if (liveApis.length > 0) return liveApis;

	const canonicalId = canonicalLiveModelId(model.id);
	const datasheetApis = canonicalId
		? datasheetCapabilities?.get(canonicalId)
		: undefined;
	if (datasheetApis && datasheetApis.length > 0) {
		return [...datasheetApis];
	}

	return ["openai-completions"];
}

export function toPiModels(
	model: BifrostModel,
	apis: readonly CatalogApi[] = apisFromBifrostModel(model),
	datasheetEntry?: DatasheetEntry,
): PiModel[] {
	if (!model.id?.trim()) return [];

	const liveReasoning = supportsReasoning(model);
	const reasoning = liveReasoning || datasheetEntry?.supports_reasoning === true;
	const thinkingLevelMap =
		buildThinkingLevelMap(model.reasoning) ??
		buildDatasheetThinkingLevelMap(datasheetEntry);
	const liveHasImageInput = hasImageInput(model);
	const input: PiModel["input"] =
		liveHasImageInput || datasheetHasImageInput(datasheetEntry ?? {})
			? ["text", "image"]
			: ["text"];
	const shared: Omit<PiModel, "api" | "compat"> = {
		id: model.id,
		name: model.normalized_name || model.name || model.id,
		reasoning,
		input,
		cost: {
			input: perMillion(
				model.pricing?.prompt ?? datasheetEntry?.input_cost_per_token,
			),
			output: perMillion(
				model.pricing?.completion ?? datasheetEntry?.output_cost_per_token,
			),
			cacheRead: perMillion(
				model.pricing?.input_cache_read ??
					datasheetEntry?.cache_read_input_token_cost,
			),
			cacheWrite: perMillion(
				model.pricing?.input_cache_write ??
					datasheetEntry?.cache_creation_input_token_cost,
			),
		},
		contextWindow:
			model.context_length ??
			model.max_input_tokens ??
			model.top_provider?.context_length ??
			datasheetEntry?.max_input_tokens ??
			datasheetEntry?.max_tokens ??
			128_000,
		maxTokens:
			model.max_output_tokens ??
			model.top_provider?.max_completion_tokens ??
			model.per_request_limits?.completion_tokens ??
			datasheetEntry?.max_output_tokens ??
			datasheetEntry?.max_tokens ??
			16_384,
	};
	if (thinkingLevelMap) shared.thinkingLevelMap = thinkingLevelMap;

	return apis.map((api) => {
		const compat = compatForApi(api);
		return compat ? { ...shared, api, compat } : { ...shared, api };
	});
}

export function canonicalLiveModelId(id: string): string | undefined {
	return normalizeCanonicalModelId(id.split("/").at(-1)?.trim());
}

export function canonicalDatasheetId(
	key: string,
	entry: DatasheetEntry,
): string | undefined {
	const baseModel = entry.base_model?.trim();
	const keyTail = key.split("/").at(-1)?.trim();
	const candidate =
		(baseModel && !baseModel.startsWith("@") ? baseModel : keyTail) || undefined;
	return normalizeCanonicalModelId(candidate);
}

export function preferredDatasheetProvider(id: string): string | undefined {
	if (
		id.startsWith("gpt-") ||
		id.startsWith("o1") ||
		id.startsWith("o3") ||
		id.startsWith("o4")
	) {
		return "openai";
	}
	if (id.startsWith("claude")) return "anthropic";
	if (id.startsWith("gemini")) return "google";
	if (id.startsWith("deepseek")) return "deepseek";
	if (id.startsWith("glm")) return "zai";
	if (id.startsWith("qwen")) return "qwen";
	return undefined;
}

export function datasheetCandidateScore(
	key: string,
	entry: DatasheetEntry,
	id: string,
	api: CatalogApi,
): number {
	let score = 0;
	const lowerKey = key.toLowerCase();
	const preferredProvider = preferredDatasheetProvider(id);
	const endpoints = lowerCaseEntries(entry.supported_endpoints);

	if (lowerKey === id) score -= 100;
	if (lowerKey.endsWith(`/${id}`)) score -= 40;
	if (entry.base_model?.trim().toLowerCase() === id) score -= 30;
	if (preferredProvider && entry.provider === preferredProvider) score -= 15;
	if (endpoints.length > 0) score -= 10;
	if (api === "openai-responses" && entry.mode?.toLowerCase() === "responses") {
		score -= 10;
	}
	if (api === "openai-completions" && entry.mode?.toLowerCase() === "chat") {
		score -= 10;
	}
	if (/\d{4}-\d{2}-\d{2}|\d{8}|-\d{4,}/u.test(lowerKey) && lowerKey !== id) {
		score += 5;
	}
	score += (lowerKey.match(/\//gu)?.length ?? 0) * 5;
	score += Math.min(lowerKey.length / 100, 5);
	return score;
}

export function toPiModelFromDatasheet(
	id: string,
	entry: DatasheetEntry,
	api: CatalogApi,
): PiModel | undefined {
	const contextWindow = entry.max_input_tokens ?? entry.max_tokens;
	const maxTokens = entry.max_output_tokens ?? entry.max_tokens ?? contextWindow;
	if (!contextWindow || !maxTokens) return undefined;

	const model: PiModel = {
		id,
		name: id,
		api,
		reasoning: entry.supports_reasoning === true,
		input: datasheetHasImageInput(entry) ? ["text", "image"] : ["text"],
		cost: {
			input: perMillion(entry.input_cost_per_token),
			output: perMillion(entry.output_cost_per_token),
			cacheRead: perMillion(entry.cache_read_input_token_cost),
			cacheWrite: perMillion(entry.cache_creation_input_token_cost),
		},
		contextWindow,
		maxTokens,
	};
	const thinkingLevelMap = buildDatasheetThinkingLevelMap(entry);
	if (thinkingLevelMap) model.thinkingLevelMap = thinkingLevelMap;
	const compat = compatForApi(api);
	if (compat) model.compat = compat;
	return model;
}

export function filterModelsForApi<T extends PiModel>(
	models: readonly T[] | undefined,
	api: CatalogApi,
): T[] | undefined {
	if (!models) return undefined;
	return models.filter((model): model is T => model.api === api);
}
