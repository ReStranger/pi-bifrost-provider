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
import { refreshBifrostModels, setPendingCatalog } from "./refresh-models.ts";
import { liveRuntime } from "./runtime.ts";
import { BIFROST_PROVIDER_ID, BIFROST_PROVIDER_NAME } from "./types.ts";
import type {
	PersistedCatalogEntry,
	ProviderApi,
	RefreshContext as BifrostRefreshContext,
} from "./types.ts";
import type { BifrostRuntime } from "./runtime.ts";

export type BifrostProviderOptions = {
	flags?: BifrostFlagConfig;
};

// Single merged provider (opencode pattern): one provider id serving both
// OpenAI-compatible endpoints. Each model is published once with its
// preferred API (responses wins for dual-endpoint models), and
// createProvider dispatches streaming by model.api.
function createBifrostProvider(
	runtime: BifrostRuntime,
	options?: BifrostProviderOptions,
): Provider<ProviderApi> {
	let models: readonly Model<ProviderApi>[] = [];
	const provider = createProvider<ProviderApi>({
		id: BIFROST_PROVIDER_ID,
		name: BIFROST_PROVIDER_NAME,
		auth: {
			apiKey: createBifrostApiKeyAuth({
				runtime,
				flags: options?.flags,
				onAuthenticated: ({ baseOrigin, models }) =>
					setPendingCatalog({ models, baseOrigin }),
			}),
		},
		models: [],
		api: {
			"openai-completions": openAICompletionsApi(),
			"openai-responses": openAIResponsesApi(),
		},
	});

	return {
		...provider,
		getModels: () => models,
		refreshModels: async (context: RefreshModelsContext) => {
			const outcome = await refreshBifrostModels(
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
export function registerBifrostProviders(
	pi: ExtensionAPI,
	runtime: BifrostRuntime = liveRuntime(),
	options?: BifrostProviderOptions,
): void {
	pi.registerProvider(createBifrostProvider(runtime, options));
}
