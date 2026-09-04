declare const process: {
	env: Record<string, string | undefined>;
};

export interface BifrostRuntime {
	env: Record<string, string | undefined>;
	fetch: typeof fetch;
	now(): number;
}

export function liveRuntime(): BifrostRuntime {
	return {
		env: process.env,
		fetch: globalThis.fetch,
		now: () => Date.now(),
	};
}
