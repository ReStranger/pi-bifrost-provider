import {
	getRefreshIntervalMs,
	readCredentialBaseOrigin,
	toApiBase,
	tryNormalizeBaseOrigin,
} from "./config.ts";
import { fetchCatalog, shouldFallbackToDatasheet } from "./catalog-source.ts";
import { asNumber, filterModelsForApi } from "./model-mapping.ts";
import type { BifrostRuntime } from "./runtime.ts";
import type {
	PersistedCatalogEntry,
	PersistedPiModel,
	PiModel,
	ProviderApi,
	RefreshContext,
	RegisteredPiModel,
} from "./types.ts";

export type RefreshOutcome = {
	models?: RegisteredPiModel[];
	persist?: PersistedCatalogEntry;
};

export function registerModels(
	models: readonly PiModel[] | readonly PersistedPiModel[] | undefined,
	providerId: string,
	baseOrigin: string,
): RegisteredPiModel[] | undefined {
	if (!models) return undefined;
	const baseUrl = toApiBase(baseOrigin);
	return models.map((model) => ({
		...model,
		provider: providerId,
		baseUrl,
	}));
}

function storedCatalogBaseOrigin(
	stored: PersistedCatalogEntry | undefined,
	models: readonly PersistedPiModel[] | undefined,
): string | undefined {
	return (
		tryNormalizeBaseOrigin(stored?.baseUrl) ??
		tryNormalizeBaseOrigin(models?.[0]?.baseUrl)
	);
}

export function restorePersistedModels(
	providerId: string,
	api: ProviderApi,
	stored: PersistedCatalogEntry | undefined,
	configuredBaseOrigin: string | undefined,
): RegisteredPiModel[] | undefined {
	const filtered = filterModelsForApi<PersistedPiModel>(stored?.models, api);
	if (filtered === undefined) return undefined;

	const persistedBaseOrigin = storedCatalogBaseOrigin(stored, filtered);
	if (configuredBaseOrigin) {
		if (!persistedBaseOrigin || persistedBaseOrigin !== configuredBaseOrigin) {
			return undefined;
		}
		return registerModels(filtered, providerId, configuredBaseOrigin);
	}

	if (!persistedBaseOrigin) return undefined;
	return registerModels(filtered, providerId, persistedBaseOrigin);
}

export async function refreshVariantModels(
	providerId: string,
	api: ProviderApi,
	runtime: BifrostRuntime,
	context: RefreshContext,
): Promise<RefreshOutcome> {
	const configuredBaseOrigin = readCredentialBaseOrigin(context.credential);
	const restored = restorePersistedModels(
		providerId,
		api,
		context.stored,
		configuredBaseOrigin,
	);
	if (!context.allowNetwork || context.signal.aborted) {
		return { models: restored };
	}
	if (
		context.credential?.type !== "api_key" ||
		!context.credential.key ||
		!configuredBaseOrigin
	) {
		return { models: restored };
	}

	const checkedAt = asNumber(context.stored?.checkedAt) ?? 0;
	const refreshIntervalMs = getRefreshIntervalMs(runtime);
	if (
		restored !== undefined &&
		!context.force &&
		refreshIntervalMs > 0 &&
		runtime.now() - checkedAt < refreshIntervalMs
	) {
		return { models: restored };
	}

	try {
		const allModels = await fetchCatalog(
			context.credential.key,
			configuredBaseOrigin,
			context.signal,
			runtime,
		);
		const filtered = filterModelsForApi(allModels, api) ?? [];
		const refreshed =
			registerModels(filtered, providerId, configuredBaseOrigin) ?? [];
		return {
			models: refreshed,
			persist: {
				models: refreshed,
				checkedAt: runtime.now(),
				baseUrl: configuredBaseOrigin,
			},
		};
	} catch (error) {
		if (restored !== undefined) return { models: restored };
		if (
			error instanceof Error &&
			(/timeout/i.test(error.message) || shouldFallbackToDatasheet(error))
		) {
			return { models: undefined };
		}
		throw error;
	}
}
