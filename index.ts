import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fetchAuthenticatedCatalog } from "./src/catalog-source.ts";
import { readFlagConfig, tryNormalizeBaseOrigin } from "./src/config.ts";
import type { BifrostFlagConfig } from "./src/config.ts";
import { setPendingCatalog } from "./src/refresh-models.ts";
import { registerBifrostProviders } from "./src/register-internal.ts";
import type { BifrostRuntime } from "./src/runtime.ts";
import { liveRuntime } from "./src/runtime.ts";
import { BIFROST_API_KEY_ENV, BIFROST_BASE_URL_ENV } from "./src/types.ts";

declare const process: {
	argv: string[];
	env: Record<string, string | undefined>;
	stderr: { write(chunk: string): boolean };
};

export type BifrostExtensionOverrides = {
	runtime?: BifrostRuntime;
	warn?: (message: string) => void;
};

function defaultWarn(message: string): void {
	process.stderr.write(message);
}

// Best-effort startup model discovery: when a base URL + API key are already
// available (flags or env), fetch the catalog once so the first refresh of
// each variant can publish it immediately — even offline. Any failure only
// warns: providers are always registered and recover via refreshModels with
// the persisted catalog. The entrypoint never throws.
async function discoverStartupCatalog(
	flags: BifrostFlagConfig,
	runtime: BifrostRuntime,
	warn: (message: string) => void,
): Promise<void> {
	const baseOrigin =
		flags.baseOrigin ?? tryNormalizeBaseOrigin(runtime.env[BIFROST_BASE_URL_ENV]);
	const apiKey =
		flags.apiKey ?? (runtime.env[BIFROST_API_KEY_ENV]?.trim() || undefined);
	if (!baseOrigin || !apiKey) return;

	try {
		const models = await fetchAuthenticatedCatalog(
			apiKey,
			baseOrigin,
			AbortSignal.timeout(15_000),
			runtime,
		);
		setPendingCatalog({ models, baseOrigin });
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		warn(
			`pi-bifrost-provider: startup model discovery failed, continuing without a preloaded catalog: ${detail}\n`,
		);
	}
}

export default async function bifrostProvider(
	pi: ExtensionAPI,
	overrides?: BifrostExtensionOverrides,
): Promise<void> {
	pi.registerFlag("bifrost-base-url", {
		description: `Bifrost base URL (env: ${BIFROST_BASE_URL_ENV})`,
		type: "string",
	});
	// The secret intentionally points at the env var in its help text; prefer
	// the environment over passing secrets on the command line.
	pi.registerFlag("bifrost-api-key", {
		description: `Bifrost API key (prefer env: ${BIFROST_API_KEY_ENV})`,
		type: "string",
	});

	const runtime = overrides?.runtime ?? liveRuntime();
	const warn = overrides?.warn ?? defaultWarn;
	const flags = readFlagConfig({ getFlag: (name) => pi.getFlag(name) });

	await discoverStartupCatalog(flags, runtime, warn);
	registerBifrostProviders(pi, runtime, { flags });
}
