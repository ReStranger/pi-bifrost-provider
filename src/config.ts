import {
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

	const pathname = url.pathname.replace(/\/v1\/?$/u, "").replace(/\/+$/u, "");
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
