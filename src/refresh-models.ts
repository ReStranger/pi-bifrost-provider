import {
	getRefreshIntervalMs,
	resolveEffectiveConfig,
	toApiBase,
	tryNormalizeBaseOrigin,
} from "./config.ts";
import type { BifrostFlagConfig } from "./config.ts";
import { fetchCatalog, shouldFallbackToDatasheet } from "./catalog-source.ts";
import { asNumber } from "./model-mapping.ts";
import type { BifrostRuntime } from "./runtime.ts";
import type {
	PersistedCatalogEntry,
	PersistedPiModel,
	PiModel,
	RefreshContext,
	RegisteredPiModel,
} from "./types.ts";
import { BIFROST_PROVIDER_ID } from "./types.ts";

export type RefreshOutcome = {
	models?: RegisteredPiModel[];
	persist?: PersistedCatalogEntry;
};

export type PendingCatalog = {
	models: PiModel[];
	baseOrigin: string;
};

// Catalog freshly authenticated via /login (or startup discovery). The next
// refresh publishes it via persist + update — even offline — so a
// just-configured gateway is usable immediately and survives restarts.
// Consumption is one-shot: a single provider refresh takes it.
let pendingCatalog: PendingCatalog | undefined;

export function setPendingCatalog(catalog: PendingCatalog | undefined): void {
	pendingCatalog = catalog;
}

function takePendingCatalog(): PendingCatalog | undefined {
	const catalog = pendingCatalog;
	pendingCatalog = undefined;
	return catalog;
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
	stored: PersistedCatalogEntry | undefined,
	configuredBaseOrigin: string | undefined,
): RegisteredPiModel[] | undefined {
	const persisted = stored?.models;
	if (persisted === undefined) return undefined;

	const persistedBaseOrigin = storedCatalogBaseOrigin(stored, persisted);
	if (configuredBaseOrigin) {
		if (!persistedBaseOrigin || persistedBaseOrigin !== configuredBaseOrigin) {
			return undefined;
		}
		return registerModels(persisted, providerId, configuredBaseOrigin);
	}

	if (!persistedBaseOrigin) return undefined;
	return registerModels(persisted, providerId, persistedBaseOrigin);
}

export async function refreshBifrostModels(
	runtime: BifrostRuntime,
	context: RefreshContext,
	flags?: BifrostFlagConfig,
): Promise<RefreshOutcome> {
	const providerId = BIFROST_PROVIDER_ID;
	// A freshly authenticated catalog wins over everything else, including
	// the offline path below: /login must be usable immediately.
	const pending = takePendingCatalog();
	if (pending) {
		const published =
			registerModels(pending.models, providerId, pending.baseOrigin) ?? [];
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
		const refreshed =
			registerModels(allModels, providerId, effective.baseOrigin) ?? [];
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
