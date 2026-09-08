import {
	BIFROST_API_KEY_ENV,
	BIFROST_BASE_URL_ENV,
	DEFAULT_REFRESH_INTERVAL_MS,
	DEFAULT_REQUEST_TIMEOUT_MS,
} from "./types.ts";
import type { BifrostRuntime } from "./runtime.ts";

export function normalizeBaseOrigin(value: string): string {
	const trimmed = value.trim();
	if (!trimmed) {
		throw new Error("Bifrost base URL is required");
	}

	let url: URL;
	try {
		url = new URL(trimmed);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Invalid Bifrost base URL: ${message}`);
	}

	const pathname = url.pathname
		.replace(/\/+$/u, "")
		.replace(/\/(models|chat\/completions|responses)$/u, "")
		.replace(/\/v1$/u, "")
		.replace(/\/+$/u, "");
	url.pathname = pathname || "/";
	url.search = "";
	url.hash = "";
	return `${url.origin}${pathname}`;
}

export function tryNormalizeBaseOrigin(
	value: string | undefined,
): string | undefined {
	if (!value?.trim()) return undefined;
	try {
		return normalizeBaseOrigin(value);
	} catch {
		return undefined;
	}
}

export function toApiBase(origin: string): string {
	return `${normalizeBaseOrigin(origin)}/v1`;
}

export function readCredentialBaseOrigin(
	credential:
		| {
				type: string;
				env?: Record<string, string | undefined>;
		  }
		| undefined,
): string | undefined {
	if (credential?.type !== "api_key") return undefined;
	return tryNormalizeBaseOrigin(credential.env?.[BIFROST_BASE_URL_ENV]);
}

// Reads a `--kebab-case value` / `--kebab-case=value` CLI flag from argv.
// A value starting with `--` counts as the next flag (i.e. no value).
// Needed because flag values are applied after provider factories run, so
// startup model discovery cannot see them via pi.getFlag() yet.
export function flagFromArgv(
	name: string,
	argv: readonly string[] = process.argv.slice(2),
): string | undefined {
	const flag = `--${name}`;
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === flag) {
			const next = argv[index + 1];
			if (!next || next.startsWith("--")) return undefined;
			return next;
		}
		if (arg?.startsWith(`${flag}=`)) {
			const value = arg.slice(flag.length + 1);
			return value ? value : undefined;
		}
	}
	return undefined;
}

export type BifrostFlagConfig = {
	baseOrigin?: string;
	apiKey?: string;
};

// CLI-flag config layer: pi.getFlag() first, raw process.argv as fallback.
export function readFlagConfig(options: {
	getFlag?: (name: string) => boolean | string | undefined;
	argv?: readonly string[];
}): BifrostFlagConfig {
	const readFlag = (name: string): string | undefined => {
		const viaApi = options.getFlag?.(name);
		if (typeof viaApi === "string" && viaApi.trim()) return viaApi.trim();
		return flagFromArgv(name, options.argv);
	};
	return {
		baseOrigin: tryNormalizeBaseOrigin(readFlag("bifrost-base-url")),
		apiKey: readFlag("bifrost-api-key") || undefined,
	};
}

export type EffectiveBifrostConfig = {
	baseOrigin: string;
	apiKey: string;
	baseSource: "stored" | "flag" | "env";
	keySource: "stored" | "flag" | "env";
};

// Config precedence: stored /login credential > CLI flags > env.
// Owns-config guard: when the stored credential carries its own base URL,
// ambient keys/flags must not leak into it (e.g. a stale env key for a
// different gateway after the URL was changed via /login). In that case the
// key has to come from the stored credential itself.
export function resolveEffectiveConfig(options: {
	credential?:
		| {
				type: string;
				key?: string;
				env?: Record<string, string | undefined>;
		  }
		| undefined;
	flags?: BifrostFlagConfig;
	env?: Record<string, string | undefined>;
}): EffectiveBifrostConfig | undefined {
	const storedKey =
		options.credential?.type === "api_key"
			? options.credential.key?.trim() || undefined
			: undefined;
	const storedBase = readCredentialBaseOrigin(options.credential);
	const flagBase = options.flags?.baseOrigin;
	const envBase = tryNormalizeBaseOrigin(options.env?.[BIFROST_BASE_URL_ENV]);
	const baseOrigin = storedBase ?? flagBase ?? envBase;
	if (!baseOrigin) return undefined;
	const baseSource = storedBase ? "stored" : flagBase ? "flag" : "env";

	const flagKey = options.flags?.apiKey;
	const envKey = options.env?.[BIFROST_API_KEY_ENV]?.trim() || undefined;
	// Owns-config guard (see above): an owned URL only accepts the stored key.
	const apiKey = storedBase ? storedKey : (storedKey ?? flagKey ?? envKey);
	if (!apiKey) return undefined;
	const keySource = storedKey ? "stored" : flagKey ? "flag" : "env";

	return { baseOrigin, apiKey, baseSource, keySource };
}

export function getRefreshIntervalMs(runtime: BifrostRuntime): number {
	const raw = runtime.env.BIFROST_REFRESH_INTERVAL_MS?.trim();
	if (!raw) return DEFAULT_REFRESH_INTERVAL_MS;
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed >= 0
		? parsed
		: DEFAULT_REFRESH_INTERVAL_MS;
}

export function getRequestTimeoutMs(runtime: BifrostRuntime): number {
	const raw = runtime.env.BIFROST_REQUEST_TIMEOUT_MS?.trim();
	if (!raw) return DEFAULT_REQUEST_TIMEOUT_MS;
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed > 0
		? parsed
		: DEFAULT_REQUEST_TIMEOUT_MS;
}

export function withRequestTimeout(
	signal: AbortSignal,
	runtime: BifrostRuntime,
	timeoutOverride = getRequestTimeoutMs(runtime),
): AbortSignal {
	return AbortSignal.any([signal, AbortSignal.timeout(timeoutOverride)]);
}

export function buildModelsUrl(
	baseOrigin: string,
	nextPageToken: string | undefined,
): URL {
	let url: URL;
	try {
		url = new URL(`${toApiBase(baseOrigin)}/models`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Invalid Bifrost base URL: ${message}`);
	}
	url.searchParams.set("page_size", "200");
	if (nextPageToken) url.searchParams.set("page_token", nextPageToken);
	return url;
}
