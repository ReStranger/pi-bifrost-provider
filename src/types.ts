import type { ModelsStoreEntry } from "@earendil-works/pi-ai";

export const BIFROST_API_KEY_ENV = "BIFROST_API_KEY";
export const BIFROST_BASE_URL_ENV = "BIFROST_BASE_URL";
export const DEFAULT_REFRESH_INTERVAL_MS = 15 * 60 * 1000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 8_000;
export const DATASHEET_URL = "https://getbifrost.ai/datasheet";

export const PROVIDERS = [
	{
		id: "bifrost-responses",
		name: "Bifrost (Responses)",
		api: "openai-responses",
	},
	{
		id: "bifrost-completions",
		name: "Bifrost (Completions)",
		api: "openai-completions",
	},
] as const;

export type ProviderApi = (typeof PROVIDERS)[number]["api"];
export type ProviderVariant = (typeof PROVIDERS)[number];

export type CatalogApi = "openai-completions" | "openai-responses";

export type ThinkingLevel =
	| "off"
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "xhigh"
	| "max";

export type BifrostPricing = {
	prompt?: string | number;
	completion?: string | number;
	input_cache_read?: string | number;
	input_cache_write?: string | number;
	internal_reasoning?: string | number;
};

export type BifrostReasoning = {
	mandatory?: boolean;
	default_enabled?: boolean;
	supported_efforts?: string[];
	default_effort?: string;
};

export type BifrostArchitecture = {
	input_modalities?: string[];
	output_modalities?: string[];
};

export type BifrostModel = {
	id: string;
	name?: string;
	normalized_name?: string;
	context_length?: number;
	max_input_tokens?: number;
	max_output_tokens?: number;
	top_provider?: {
		context_length?: number;
		max_completion_tokens?: number;
	};
	per_request_limits?: {
		prompt_tokens?: number;
		completion_tokens?: number;
	};
	pricing?: BifrostPricing;
	reasoning?: BifrostReasoning;
	architecture?: BifrostArchitecture;
	supported_parameters?: string[];
	supported_methods?: string[];
	supported_endpoints?: string[];
	mode?: string;
	description?: string;
};

export type BifrostListModelsResponse = {
	data?: BifrostModel[];
	next_page_token?: string;
};

export type DatasheetEntry = {
	mode?: string;
	provider?: string;
	base_model?: string;
	max_input_tokens?: number;
	max_output_tokens?: number;
	max_tokens?: number;
	input_cost_per_token?: string | number;
	output_cost_per_token?: string | number;
	cache_creation_input_token_cost?: string | number;
	cache_read_input_token_cost?: string | number;
	supported_endpoints?: string[];
	supported_modalities?: string[];
	supports_vision?: boolean;
	supports_reasoning?: boolean;
	supports_none_reasoning_effort?: boolean;
	supports_minimal_reasoning_effort?: boolean;
	supports_low_reasoning_effort?: boolean;
	supports_medium_reasoning_effort?: boolean;
	supports_high_reasoning_effort?: boolean;
	supports_xhigh_reasoning_effort?: boolean;
	supports_max_reasoning_effort?: boolean;
	default_reasoning_effort?: string;
};

export type DatasheetResponse = Record<string, DatasheetEntry>;

export type DatasheetCapabilityIndex = Map<string, CatalogApi[]>;

export type PiModel = {
	id: string;
	name: string;
	api: CatalogApi;
	reasoning: boolean;
	thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
	input: Array<"text" | "image">;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
	contextWindow: number;
	maxTokens: number;
	compat?: {
		maxTokensField?: "max_completion_tokens" | "max_tokens";
	};
};

export type RegisteredPiModel = PiModel & {
	provider: string;
	baseUrl: string;
};

export type PersistedPiModel = RegisteredPiModel;

export type PersistedCatalogEntry = Omit<ModelsStoreEntry, "models"> & {
	models: readonly PersistedPiModel[];
	baseUrl?: string;
};

export type RefreshContext = {
	stored?: PersistedCatalogEntry;
	credential?: {
		type: "api_key" | "oauth";
		key?: string;
		env?: Record<string, string | undefined>;
	};
	allowNetwork: boolean;
	force?: boolean;
	signal: AbortSignal;
};
