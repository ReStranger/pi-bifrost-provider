import {
	getRefreshIntervalMs,
	resolveEffectiveConfig,
	toApiBase,
	tryNormalizeBaseOrigin,
} from "./config.ts";
import type { BifrostFlagConfig } from "./config.ts";
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

export type PendingCatalog = {
	models: PiModel[];
	baseOrigin: string;
};

// Catalog freshly authenticated via /login (or startup discovery). The next
// refresh of each provider variant publishes it via persist + update — even
// offline — so a just-configured gateway is usable immediately and survives
// restarts. Consumption is tracked per provider id because the two variants
// refresh independently.
let pendingCatalog: PendingCatalog | undefined;
const pendingConsumedBy = new Set<string>();

export function setPendingCatalog(catalog: PendingCatalog | undefined): void {
	pendingCatalog = catalog;
	pendingConsumedBy.clear();
}

function takePendingCatalog(providerId: string): PendingCatalog | undefined {
	if (!pendingCatalog || pendingConsumedBy.has(providerId)) return undefined;
	pendingConsumedBy.add(providerId);
	return pendingCatalog;
}

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
	flags?: BifrostFlagConfig,
): Promise<RefreshOutcome> {
	// A freshly authenticated catalog wins over everything else, including
	// the offline path below: /login must be usable immediately.
	const pending = takePendingCatalog(providerId);
	if (pending) {
		const published =
			registerModels(
				filterModelsForApi(pending.models, api) ?? [],
				providerId,
				pending.baseOrigin,
			) ?? [];
		return {
			models: published,
			persist: {
				models: published,
				checkedAt: runtime.now(),
				baseUrl: pending.baseOrigin,
			},
		};
	}

	// Same precedence as request-time auth: stored credential > flags > env.
	// The owns-config guard inside resolveEffectiveConfig keeps a stale
	// ambient key away from a stored URL and vice versa.
	const effective = resolveEffectiveConfig({
		credential: context.credential,
		flags,
		env: runtime.env,
	});
	const configuredBaseOrigin = effective?.baseOrigin;
	const restored = restorePersistedModels(
		providerId,
		api,
		context.stored,
		configuredBaseOrigin,
	);
	if (!context.allowNetwork || context.signal.aborted) {
		return { models: restored };
	}
	if (!effective) {
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
			effective.apiKey,
			effective.baseOrigin,
			context.signal,
			runtime,
		);
		const filtered = filterModelsForApi(allModels, api) ?? [];
		const refreshed =
			registerModels(filtered, providerId, effective.baseOrigin) ?? [];
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
