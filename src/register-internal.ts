import {
	createProvider,
	type Model,
	type Provider,
	type RefreshModelsContext,
} from "@earendil-works/pi-ai";
import {
	openAICompletionsApi,
	openAIResponsesApi,
} from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBifrostApiKeyAuth } from "./auth.ts";
import type { BifrostFlagConfig } from "./config.ts";
import { refreshVariantModels, setPendingCatalog } from "./refresh-models.ts";
import { liveRuntime } from "./runtime.ts";
import { PROVIDERS } from "./types.ts";
import type {
	PersistedCatalogEntry,
	ProviderApi,
	ProviderVariant,
	RefreshContext as BifrostRefreshContext,
} from "./types.ts";
import type { BifrostRuntime } from "./runtime.ts";

function providerApi(api: ProviderApi) {
	if (api === "openai-completions") return openAICompletionsApi();
	return openAIResponsesApi();
}

export type BifrostProviderOptions = {
	flags?: BifrostFlagConfig;
};

function createBifrostProvider(
	variant: ProviderVariant,
	runtime: BifrostRuntime,
	options?: BifrostProviderOptions,
): Provider<ProviderApi> {
	let models: readonly Model<ProviderApi>[] = [];
	const provider = createProvider<ProviderApi>({
		id: variant.id,
		name: variant.name,
		auth: {
			apiKey: createBifrostApiKeyAuth({
				runtime,
				flags: options?.flags,
				onAuthenticated: ({ baseOrigin, models }) =>
					setPendingCatalog({ models, baseOrigin }),
			}),
		},
		models: [],
		api: providerApi(variant.api),
	});

	return {
		...provider,
		getModels: () => models,
		refreshModels: async (context: RefreshModelsContext) => {
			const outcome = await refreshVariantModels(
				variant.id,
				variant.api,
				runtime,
				{
					stored: context.stored as PersistedCatalogEntry | undefined,
					credential: context.credential as BifrostRefreshContext["credential"],
					allowNetwork: context.allowNetwork,
					force: context.force,
					signal: context.signal,
				},
				options?.flags,
			);
			if (context.signal.aborted) return;
			const publication = {
				update: () => {
					models = (outcome.models ?? []) as readonly Model<ProviderApi>[];
				},
			};
			if (outcome.persist !== undefined) {
				await context.publish({ ...publication, persist: outcome.persist });
				return;
			}
			await context.publish(publication);
		},
	};
}

// NOTE: getModels is intentionally overridden with a reassigning closure
// instead of mutating the array created by createProvider (e.g. via splice).
// pi reads the catalog through this getter, so replacing the reference is
// safe here and keeps refresh publication a single assignment.
export function registerVariant(
	pi: ExtensionAPI,
	variant: ProviderVariant,
	runtime: BifrostRuntime,
	options?: BifrostProviderOptions,
): void {
	pi.registerProvider(createBifrostProvider(variant, runtime, options));
}

export function registerBifrostProviders(
	pi: ExtensionAPI,
	runtime: BifrostRuntime = liveRuntime(),
	options?: BifrostProviderOptions,
): void {
	for (const variant of PROVIDERS) {
		registerVariant(pi, variant, runtime, options);
	}
}
