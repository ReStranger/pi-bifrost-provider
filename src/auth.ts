import type {
	ApiKeyAuth,
	ApiKeyCredential,
	AuthContext,
	AuthResult,
	ProviderAuthInteraction,
} from "@earendil-works/pi-ai";
import { normalizeBaseOrigin, toApiBase } from "./config.ts";
import { BIFROST_API_KEY_ENV, BIFROST_BASE_URL_ENV } from "./types.ts";

export type BifrostApiKeyCredential = ApiKeyCredential;
export type BifrostAuthResult = AuthResult;
export type BifrostAuthContext = AuthContext;
export type BifrostAuthInteraction = ProviderAuthInteraction;

function normalizeApiKey(value: string): string {
	const trimmed = value.trim();
	if (!trimmed) {
		throw new Error("Bifrost API key is required");
	}
	return trimmed;
}

function resolutionSource(options: {
	usedStoredKey: boolean;
	usedStoredBaseOrigin: boolean;
	usedEnvKey: boolean;
	usedEnvBaseOrigin: boolean;
}): string | undefined {
	if (options.usedStoredKey && options.usedStoredBaseOrigin) {
		return "stored credential";
	}
	if (options.usedEnvKey && options.usedEnvBaseOrigin) {
		return BIFROST_API_KEY_ENV;
	}
	if (options.usedStoredKey || options.usedStoredBaseOrigin) {
		return "stored credential";
	}
	if (options.usedEnvKey) return BIFROST_API_KEY_ENV;
	if (options.usedEnvBaseOrigin) return BIFROST_BASE_URL_ENV;
	return undefined;
}

export async function resolveBifrostAuth(options: {
	ctx: BifrostAuthContext;
	credential?: BifrostApiKeyCredential;
	signal: AbortSignal;
}): Promise<BifrostAuthResult | undefined> {
	const storedKey = options.credential?.key?.trim();
	const envKey = (await options.ctx.env(BIFROST_API_KEY_ENV))?.trim();
	options.signal.throwIfAborted();
	const key = storedKey || envKey;
	if (!key) return undefined;

	const storedBaseOrigin =
		options.credential?.env?.[BIFROST_BASE_URL_ENV]?.trim();
	const envBaseOrigin = (await options.ctx.env(BIFROST_BASE_URL_ENV))?.trim();
	options.signal.throwIfAborted();
	const rawBaseOrigin = storedBaseOrigin || envBaseOrigin;
	if (!rawBaseOrigin) return undefined;

	const baseOrigin = normalizeBaseOrigin(rawBaseOrigin);
	return {
		auth: {
			apiKey: normalizeApiKey(key),
			baseUrl: toApiBase(baseOrigin),
		},
		env: {
			[BIFROST_BASE_URL_ENV]: baseOrigin,
		},
		source: resolutionSource({
			usedStoredKey: Boolean(storedKey),
			usedStoredBaseOrigin: Boolean(storedBaseOrigin),
			usedEnvKey: !storedKey && Boolean(envKey),
			usedEnvBaseOrigin: !storedBaseOrigin && Boolean(envBaseOrigin),
		}),
	};
}

export async function loginBifrost(
	interaction: BifrostAuthInteraction,
): Promise<BifrostApiKeyCredential> {
	interaction.signal.throwIfAborted();
	throw new Error(
		`Bifrost login is not supported; configure ${BIFROST_API_KEY_ENV} and ${BIFROST_BASE_URL_ENV}`,
	);
}

export function createBifrostApiKeyAuth(): ApiKeyAuth {
	return {
		name: "Bifrost API key",
		resolve: resolveBifrostAuth,
	};
}
