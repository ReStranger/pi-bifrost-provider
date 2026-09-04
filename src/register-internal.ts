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
import { refreshVariantModels } from "./refresh-models.ts";
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

function createBifrostProvider(
	variant: ProviderVariant,
	runtime: BifrostRuntime,
): Provider<ProviderApi> {
	let models: readonly Model<ProviderApi>[] = [];
	const provider = createProvider<ProviderApi>({
		id: variant.id,
		name: variant.name,
		auth: {
			apiKey: createBifrostApiKeyAuth(),
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

export function registerVariant(
	pi: ExtensionAPI,
	variant: ProviderVariant,
	runtime: BifrostRuntime,
): void {
	pi.registerProvider(createBifrostProvider(variant, runtime));
}

export function registerBifrostProviders(
	pi: ExtensionAPI,
	runtime: BifrostRuntime = liveRuntime(),
): void {
	for (const variant of PROVIDERS) {
		registerVariant(pi, variant, runtime);
	}
}
