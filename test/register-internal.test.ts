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
		assert.equal(typeof provider.auth.apiKey?.login, "function");
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

test("streams chat completions with injected fetch and bearer auth", async () => {
	const dir = makeTempPackageDir();
	const [{ registerBifrostProviders }] = await Promise.all([
		import(pathToFileURL(join(dir, "src", "register-internal.ts")).href),
	]);
	const { createModels } = await import("@earendil-works/pi-ai");

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
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		now: () => 1_234,
	};
	registerBifrostProviders(pi, runtime);
	const completions = registered.find(
		(provider) => provider.id === "bifrost-completions",
	);
	await completions.refreshModels({
		credential: {
			type: "api_key",
			key: "secret",
			env: { BIFROST_BASE_URL: "https://credential.example" },
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

	const models = createModels();
	models.setProvider(completions);
	const model = models.getModel("bifrost-completions", "chat-model");
	assert.ok(model);

	const seen: { url?: string; authorization?: string | null; body?: any } = {};
	const sse = [
		'data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}\n\n',
		'data: {"choices":[{"delta":{"content":" world"},"finish_reason":null}]}\n\n',
		'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
		"data: [DONE]\n\n",
	].join("");
	const message = await models.completeSimple(
		model,
		{ messages: [{ role: "user", content: "Say hi", timestamp: 1 }] },
		{
			apiKey: "stream-key",
			env: { BIFROST_BASE_URL: "https://credential.example" },
			fetch: (async (url: any, init: any) => {
				seen.url = String(url);
				seen.authorization = new Headers(init?.headers).get("authorization");
				seen.body = JSON.parse(String(init?.body ?? "{}"));
				return new Response(sse, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}) as typeof fetch,
		},
	);

	assert.equal(seen.url, "https://credential.example/v1/chat/completions");
	assert.equal(seen.authorization, "Bearer stream-key");
	assert.equal(seen.body?.model, "chat-model");
	assert.equal(
		message.content
			.filter((block: any) => block.type === "text")
			.map((block: any) => block.text)
			.join(""),
		"Hello world",
	);
	assert.equal(message.stopReason, "stop");
});
