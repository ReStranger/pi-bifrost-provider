import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

declare const process: {
	env: Record<string, string | undefined>;
};

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = resolve(TEST_DIR, "..");

function resolveHostPiMonorepoDir(): string | undefined {
	const piPackageDir = process.env.PI_PACKAGE_DIR;
	if (!piPackageDir) return undefined;
	const candidate = resolve(
		piPackageDir,
		"..",
		"..",
		"lib",
		"node_modules",
		"pi-monorepo",
	);
	return existsSync(join(candidate, "package.json")) ? candidate : undefined;
}

function resolveLocalPackageDir(name: string): string | undefined {
	const candidate = join(PACKAGE_DIR, "node_modules", "@earendil-works", name);
	return existsSync(join(candidate, "package.json")) ? candidate : undefined;
}

function resolveTestModuleDirs(): {
	piAi: string;
	piCodingAgent: string;
} {
	const hostMonorepo = resolveHostPiMonorepoDir();
	if (hostMonorepo) {
		return {
			piAi: join(hostMonorepo, "node_modules", "@earendil-works", "pi-ai"),
			piCodingAgent: hostMonorepo,
		};
	}
	const piAi = resolveLocalPackageDir("pi-ai");
	const piCodingAgent = resolveLocalPackageDir("pi-coding-agent");
	if (!piAi || !piCodingAgent) {
		throw new Error(
			"register-internal.test.ts needs @earendil-works/pi-ai and @earendil-works/pi-coding-agent: run `npm install`, or run inside pi so PI_PACKAGE_DIR is set",
		);
	}
	return { piAi, piCodingAgent };
}

function makeTempPackageDir(): string {
	mkdirSync("/tmp/pi", { recursive: true });
	const dir = join(
		tmpdir(),
		`pi-bifrost-provider-register-${Date.now()}-${Math.random().toString(16).slice(2)}`,
	);
	cpSync(PACKAGE_DIR, dir, {
		recursive: true,
		filter: (source: string) => !source.includes(`${PACKAGE_DIR}/node_modules`),
	});
	const { piAi, piCodingAgent } = resolveTestModuleDirs();
	if (!existsSync(join(piAi, "package.json"))) {
		throw new Error(`pi-ai package not found at ${piAi}: run \`npm install\``);
	}
	if (!existsSync(join(piCodingAgent, "package.json"))) {
		throw new Error(
			`pi-coding-agent package not found at ${piCodingAgent}: run \`npm install\``,
		);
	}
	const scopeDir = join(dir, "node_modules", "@earendil-works");
	mkdirSync(scopeDir, { recursive: true });
	for (const [name, target] of [
		["pi-ai", piAi],
		["pi-coding-agent", piCodingAgent],
	] as const) {
		const link = join(scopeDir, name);
		if (!existsSync(link)) symlinkSync(target, link, "dir");
	}
	return dir;
}

test("registers bifrost completions and responses providers", async () => {
	const dir = makeTempPackageDir();
	const [{ registerBifrostProviders }] = await Promise.all([
		import(pathToFileURL(join(dir, "src", "register-internal.ts")).href),
	]);

	const registered: Array<any> = [];
	const pi = {
		registerProvider(provider: unknown) {
			registered.push(provider);
		},
	};
	const runtime = {
		env: {},
		fetch: async () =>
			new Response(
				JSON.stringify({
					data: [
						{
							id: "chat-model",
							supported_methods: ["chat.completions"],
						},
						{
							id: "response-model",
							supported_methods: ["responses"],
						},
						{
							id: "dual-model",
							supported_methods: ["chat.completions", "responses"],
						},
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		now: () => 1_234,
	};

	registerBifrostProviders(pi, runtime);

	assert.deepEqual(
		registered.map((provider) => provider.id),
		["bifrost-responses", "bifrost-completions"],
	);
	assert.deepEqual(
		registered.map((provider) => provider.name),
		["Bifrost (Responses)", "Bifrost (Completions)"],
	);
	for (const provider of registered) {
		assert.equal(provider.auth.apiKey?.login, undefined);
		await provider.refreshModels({
			credential: {
				type: "api_key",
				key: "secret",
				env: {
					BIFROST_BASE_URL: "https://credential.example",
				},
			},
			stored: undefined,
			allowNetwork: true,
			force: true,
			signal: new AbortController().signal,
			publish: async (publication: { update?: () => void }) => {
				publication.update?.();
				return true;
			},
		});
	}

	const responses = registered.find(
		(provider) => provider.id === "bifrost-responses",
	);
	assert.deepEqual(
		responses?.getModels().map((model: any) => model.id),
		["response-model", "dual-model"],
	);
	assert.ok(
		responses
			?.getModels()
			.every((model: any) => model.api === "openai-responses"),
	);

	const completions = registered.find(
		(provider) => provider.id === "bifrost-completions",
	);
	assert.deepEqual(
		completions?.getModels().map((model: any) => model.id),
		["chat-model", "dual-model"],
	);
	assert.ok(
		completions
			?.getModels()
			.every((model: any) => model.api === "openai-completions"),
	);
});
