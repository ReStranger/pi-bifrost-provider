import {
	buildModelsUrl,
	getRequestTimeoutMs,
	withRequestTimeout,
} from "./config.ts";
import {
	apisFromBifrostModel,
	apisFromDatasheetEntry,
	canonicalDatasheetId,
	canonicalLiveModelId,
	datasheetCandidateScore,
	resolveApisForBifrostModel,
	toPiModelFromDatasheet,
	toPiModels,
} from "./model-mapping.ts";
import type { BifrostRuntime } from "./runtime.ts";
import { DATASHEET_URL } from "./types.ts";
import type {
	BifrostListModelsResponse,
	BifrostModel,
	CatalogApi,
	DatasheetCapabilityIndex,
	DatasheetEntry,
	DatasheetResponse,
	PiModel,
} from "./types.ts";

const CATALOG_API_ORDER = [
	"openai-responses",
	"openai-completions",
] as const satisfies readonly CatalogApi[];

type DatasheetLookupIndex = Map<
	string,
	{
		byApi: Partial<Record<CatalogApi, DatasheetEntry>>;
		fallback?: DatasheetEntry;
	}
>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBifrostListModelsResponse(
	value: unknown,
): BifrostListModelsResponse {
	if (!isRecord(value)) {
		throw new Error(
			"Bifrost /models returned an invalid payload: expected an object",
		);
	}

	const data = value.data;
	if (data !== undefined && !Array.isArray(data)) {
		throw new Error(
			"Bifrost /models returned an invalid payload: data must be an array",
		);
	}

	const models = data?.map((entry, index) => {
		if (!isRecord(entry)) {
			throw new Error(
				`Bifrost /models returned an invalid payload: data[${index}] must be an object`,
			);
		}
		return entry as BifrostModel;
	});
	const nextPageToken =
		typeof value.next_page_token === "string" ? value.next_page_token : undefined;
	return {
		data: models,
		next_page_token: nextPageToken,
	};
}

function parseDatasheetResponse(value: unknown): DatasheetResponse {
	if (!isRecord(value)) {
		throw new Error(
			"Bifrost datasheet returned an invalid payload: expected an object",
		);
	}

	const parsed: DatasheetResponse = {};
	for (const [key, entry] of Object.entries(value)) {
		if (!isRecord(entry)) {
			throw new Error(
				`Bifrost datasheet returned an invalid payload: entry "${key}" must be an object`,
			);
		}
		parsed[key] = entry as DatasheetEntry;
	}
	return parsed;
}

function buildDatasheetCatalogArtifacts(payload: DatasheetResponse): {
	models: PiModel[];
	capabilities: DatasheetCapabilityIndex;
	entries: DatasheetLookupIndex;
} {
	const bestModels = new Map<string, { score: number; model: PiModel }>();
	const capabilityScores = new Map<string, number>();
	const bestEntriesByApi = new Map<
		string,
		{ score: number; entry: DatasheetEntry }
	>();
	const bestFallbackEntries = new Map<
		string,
		{ score: number; entry: DatasheetEntry }
	>();

	for (const [key, entry] of Object.entries(payload)) {
		const id = canonicalDatasheetId(key, entry);
		if (!id) continue;

		const apis = apisFromDatasheetEntry(entry);
		const fallbackScore = Math.min(
			...(apis.length > 0
				? apis
				: (["openai-responses", "openai-completions"] as const)
			).map((api) => datasheetCandidateScore(key, entry, id, api)),
		);
		const existingFallback = bestFallbackEntries.get(id);
		if (!existingFallback || fallbackScore < existingFallback.score) {
			bestFallbackEntries.set(id, { score: fallbackScore, entry });
		}

		for (const api of apis) {
			const mapKey = `${api}:${id}`;
			const score = datasheetCandidateScore(key, entry, id, api);
			const existingScore = capabilityScores.get(mapKey);
			if (existingScore === undefined || score < existingScore) {
				capabilityScores.set(mapKey, score);
			}
			const existingEntry = bestEntriesByApi.get(mapKey);
			if (!existingEntry || score < existingEntry.score) {
				bestEntriesByApi.set(mapKey, { score, entry });
			}

			const model = toPiModelFromDatasheet(id, entry, api);
			if (!model) continue;
			const existingModel = bestModels.get(mapKey);
			if (!existingModel || score < existingModel.score) {
				bestModels.set(mapKey, { score, model });
			}
		}
	}

	const groupedCapabilities = new Map<string, Set<CatalogApi>>();
	for (const mapKey of capabilityScores.keys()) {
		const divider = mapKey.indexOf(":");
		const api = mapKey.slice(0, divider) as CatalogApi;
		const id = mapKey.slice(divider + 1);
		const apis = groupedCapabilities.get(id) ?? new Set<CatalogApi>();
		apis.add(api);
		groupedCapabilities.set(id, apis);
	}

	const capabilities: DatasheetCapabilityIndex = new Map(
		[...groupedCapabilities.entries()].map(([id, apis]) => [
			id,
			CATALOG_API_ORDER.filter((api) => apis.has(api)),
		]),
	);
	const entries: DatasheetLookupIndex = new Map(
		[...bestFallbackEntries.entries()].map(([id, { entry }]) => [
			id,
			{ byApi: {}, fallback: entry },
		]),
	);
	for (const [mapKey, { entry }] of bestEntriesByApi.entries()) {
		const divider = mapKey.indexOf(":");
		const api = mapKey.slice(0, divider) as CatalogApi;
		const id = mapKey.slice(divider + 1);
		const indexedEntry = entries.get(id) ?? { byApi: {} };
		indexedEntry.byApi[api] = entry;
		entries.set(id, indexedEntry);
	}

	return {
		models: [...bestModels.values()].map((entry) => entry.model),
		capabilities,
		entries,
	};
}

async function fetchDatasheetPayload(
	signal: AbortSignal,
	runtime: BifrostRuntime,
): Promise<DatasheetResponse> {
	const response = await runtime.fetch(DATASHEET_URL, {
		headers: { Accept: "application/json" },
		signal: withRequestTimeout(
			signal,
			runtime,
			Math.max(getRequestTimeoutMs(runtime), 12_000),
		),
	});
	if (!response.ok) {
		throw new Error(`Bifrost datasheet fetch failed (${response.status})`);
	}

	return parseDatasheetResponse(await response.json());
}

function resolveDatasheetEntry(
	modelId: string,
	apis: readonly CatalogApi[],
	entries: DatasheetLookupIndex | undefined,
): DatasheetEntry | undefined {
	const canonicalId = canonicalLiveModelId(modelId);
	const indexedEntry = canonicalId ? entries?.get(canonicalId) : undefined;
	if (!indexedEntry) return undefined;
	for (const api of apis) {
		const entry = indexedEntry.byApi[api];
		if (entry) return entry;
	}
	return indexedEntry.fallback;
}

export async function fetchAuthenticatedCatalog(
	apiKey: string,
	baseOrigin: string,
	signal: AbortSignal,
	runtime: BifrostRuntime,
): Promise<PiModel[]> {
	const liveModels: BifrostModel[] = [];
	let nextPageToken: string | undefined;

	do {
		const url = buildModelsUrl(baseOrigin, nextPageToken);
		const response = await runtime.fetch(url, {
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${apiKey}`,
			},
			signal: withRequestTimeout(signal, runtime),
		});

		if (!response.ok) {
			const body = (await response.text()).slice(0, 500);
			throw new Error(
				`Bifrost model refresh failed (${response.status}): ${body}`,
			);
		}

		const payload = parseBifrostListModelsResponse(await response.json());
		liveModels.push(...(payload.data ?? []));
		nextPageToken = payload.next_page_token || undefined;
	} while (nextPageToken && !signal.aborted);

	const needsEnrichment = liveModels.some(
		(model) => apisFromBifrostModel(model).length === 0,
	);
	let datasheetCapabilities: DatasheetCapabilityIndex | undefined;
	let datasheetEntries: DatasheetLookupIndex | undefined;
	if (needsEnrichment) {
		try {
			const datasheetArtifacts = buildDatasheetCatalogArtifacts(
				await fetchDatasheetPayload(signal, runtime),
			);
			datasheetCapabilities = datasheetArtifacts.capabilities;
			datasheetEntries = datasheetArtifacts.entries;
		} catch {
			datasheetCapabilities = undefined;
			datasheetEntries = undefined;
		}
	}

	const deduped = new Map<string, PiModel>();
	for (const model of liveModels) {
		const apis = resolveApisForBifrostModel(model, datasheetCapabilities);
		const datasheetEntry = resolveDatasheetEntry(
			model.id,
			apis,
			datasheetEntries,
		);
		for (const mapped of toPiModels(model, apis, datasheetEntry)) {
			deduped.set(`${mapped.api}:${mapped.id}`, mapped);
		}
	}

	return [...deduped.values()];
}

export async function fetchDatasheetCatalog(
	signal: AbortSignal,
	runtime: BifrostRuntime,
): Promise<PiModel[]> {
	const payload = await fetchDatasheetPayload(signal, runtime);
	return buildDatasheetCatalogArtifacts(payload).models;
}

export function shouldFallbackToDatasheet(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	return /timeout|fetch failed|etimedout|enotfound|econnreset|enetunreach/i.test(
		error.message,
	);
}

export async function fetchCatalog(
	apiKey: string,
	baseOrigin: string,
	signal: AbortSignal,
	runtime: BifrostRuntime,
): Promise<PiModel[]> {
	try {
		return await fetchAuthenticatedCatalog(apiKey, baseOrigin, signal, runtime);
	} catch (error) {
		if (!shouldFallbackToDatasheet(error)) throw error;
		return await fetchDatasheetCatalog(signal, runtime);
	}
}
