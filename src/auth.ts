import type {
	ApiKeyAuth,
	ApiKeyCredential,
	AuthContext,
	AuthResult,
	ProviderAuthInteraction,
} from "@earendil-works/pi-ai";
import {
	normalizeBaseOrigin,
	resolveEffectiveConfig,
	toApiBase,
} from "./config.ts";
import type { BifrostFlagConfig } from "./config.ts";
import { fetchAuthenticatedCatalog } from "./catalog-source.ts";
import type { BifrostRuntime } from "./runtime.ts";
import { liveRuntime } from "./runtime.ts";
import { BIFROST_API_KEY_ENV, BIFROST_BASE_URL_ENV } from "./types.ts";
import type { PiModel } from "./types.ts";

export type BifrostApiKeyCredential = ApiKeyCredential;
export type BifrostAuthResult = AuthResult;
export type BifrostAuthContext = AuthContext;
export type BifrostAuthInteraction = ProviderAuthInteraction;

export type BifrostAuthenticatedCatalog = {
	baseOrigin: string;
	apiKey: string;
	models: PiModel[];
};

function normalizeApiKey(value: string): string {
	const trimmed = value.trim();
	if (!trimmed) {
		throw new Error("Bifrost API key is required");
	}
	return trimmed;
}

function resolutionSource(effective: {
	baseSource: "stored" | "flag" | "env";
	keySource: "stored" | "flag" | "env";
}): string {
	// Any stored-config involvement wins: the credential was created by /login.
	if (effective.baseSource === "stored" || effective.keySource === "stored") {
		return "stored credential";
	}
	if (effective.baseSource === "flag" || effective.keySource === "flag") {
		return "CLI flag";
	}
	return effective.keySource === "env"
		? BIFROST_API_KEY_ENV
		: BIFROST_BASE_URL_ENV;
}

export async function resolveBifrostAuth(options: {
	ctx: BifrostAuthContext;
	credential?: BifrostApiKeyCredential;
	signal: AbortSignal;
	flags?: BifrostFlagConfig;
}): Promise<BifrostAuthResult | undefined> {
	const envKey = (await options.ctx.env(BIFROST_API_KEY_ENV))?.trim();
	options.signal.throwIfAborted();
	const envBaseOrigin = (await options.ctx.env(BIFROST_BASE_URL_ENV))?.trim();
	options.signal.throwIfAborted();

	const effective = resolveEffectiveConfig({
		credential: options.credential,
		flags: options.flags,
		env: {
			[BIFROST_API_KEY_ENV]: envKey,
			[BIFROST_BASE_URL_ENV]: envBaseOrigin,
		},
	});
	if (!effective) return undefined;

	return {
		auth: {
			apiKey: normalizeApiKey(effective.apiKey),
			baseUrl: toApiBase(effective.baseOrigin),
		},
		env: {
			[BIFROST_BASE_URL_ENV]: effective.baseOrigin,
		},
		source: resolutionSource(effective),
	};
}

export async function loginBifrost(
	interaction: BifrostAuthInteraction,
	options?: {
		runtime?: BifrostRuntime;
		onAuthenticated?: (catalog: BifrostAuthenticatedCatalog) => void;
	},
): Promise<BifrostApiKeyCredential> {
	interaction.signal.throwIfAborted();
	const runtime = options?.runtime ?? liveRuntime();

	interaction.notify({
		type: "info",
		message: `Sign in to Bifrost with your ${BIFROST_BASE_URL_ENV} gateway URL and ${BIFROST_API_KEY_ENV} API key.`,
	});
	const rawBaseUrl = await interaction.prompt({
		type: "text",
		message: "Bifrost base URL",
		placeholder: "https://your-bifrost-gateway.example",
	});
	// Throws `Bifrost base URL is required` / `Invalid Bifrost base URL: ...`
	// before any network call.
	const baseOrigin = normalizeBaseOrigin(rawBaseUrl);
	// Unlike keyless gateways there is no anonymous mode: an empty key is a
	// validation error, not a placeholder credential.
	const apiKey = normalizeApiKey(
		await interaction.prompt({
			type: "secret",
			message: "Bifrost API key",
		}),
	);
	interaction.signal.throwIfAborted();

	interaction.notify({
		type: "progress",
		message: "Discovering Bifrost models...",
	});
	// Validation: a wrong URL/key surfaces here and aborts the login instead
	// of persisting a dead credential.
	const models = await fetchAuthenticatedCatalog(
		apiKey,
		baseOrigin,
		interaction.signal,
		runtime,
	);
	options?.onAuthenticated?.({ baseOrigin, apiKey, models });

	return {
		type: "api_key",
		key: apiKey,
		env: {
			[BIFROST_BASE_URL_ENV]: baseOrigin,
		},
	};
}

export function createBifrostApiKeyAuth(options?: {
	runtime?: BifrostRuntime;
	flags?: BifrostFlagConfig;
	onAuthenticated?: (catalog: BifrostAuthenticatedCatalog) => void;
}): ApiKeyAuth {
	return {
		name: "Bifrost API key",
		login: (interaction) =>
			loginBifrost(interaction, {
				runtime: options?.runtime,
				onAuthenticated: options?.onAuthenticated,
			}),
		resolve: (input) => resolveBifrostAuth({ ...input, flags: options?.flags }),
	};
}
