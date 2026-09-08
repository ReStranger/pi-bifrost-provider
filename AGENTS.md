# AGENTS.md — pi-bifrost-provider

Pi extension registering getbifrost.ai as two native providers:
`bifrost-responses` (`openai-responses`) and `bifrost-completions`
(`openai-completions`). Catalog: `GET {origin}/v1/models?page_size=200`
(+ `page_token` pagination), enriched with the Bifrost datasheet.

## Contracts that are easy to break

1. **Config precedence: stored `/login` credential > CLI flags > env.**
   `resolveEffectiveConfig` (`src/config.ts`) is the single implementation,
   shared by request-time auth (`src/auth.ts`) and `refreshVariantModels`.
   Do not reimplement precedence anywhere else.
2. **Owns-config guard.** When the stored credential carries its own
   `BIFROST_BASE_URL`, ambient keys/flags must NOT leak into it (URL changed
   via `/login` + stale env key for another gateway). In that case auth
   resolves only if the stored credential also has the key, otherwise
   `undefined`. Same rule for refresh: no silent ambient fallback.
3. **Login requires URL *and* key.** Empty key/URL = validation error before
   any network call. There is no keyless mode and no placeholder key —
   a different Bifrost product has those; this gateway does not.
4. **Login catalog goes through the pending slot, not the network path.**
   `onAuthenticated` → `setPendingCatalog`, consumed once per provider id by
   the next refresh (even offline) via `persist + update`. Same slot is used
   by startup discovery. Always `setPendingCatalog(undefined)` in tests that
   set it — the slot is module-global.
5. **Startup entrypoint (`index.ts`) never throws.** Discovery failure warns
   to stderr (`pi-bifrost-provider: startup model discovery failed…`) and
   providers register with an empty catalog; recovery via
   refresh/persisted. `AbortSignal.timeout(15_000)` bounds discovery.
6. **Prices are per-token everywhere.** `perMillion` in `src/model-mapping.ts`
   multiplies by 1e6 assuming per-token inputs. A per-million input value
   would inflate prices 1e6× — there is intentionally NO threshold heuristic.
   `cacheRead`/`cacheWrite` fall back to the input price (undercharges paid
   cache writes, e.g. Anthropic 1.25× — accepted default, documented in code).
7. **Compat flags are asserted, not probed.** `compatForApi(api, reasoning)`
   trusts the gateway (`supportsDeveloperRole`, `supportsStrictMode`,
   `supportsUsageInStreaming`, `maxTokensField: "max_tokens"` for
   completions). Only `supportsReasoningEffort` is per-model (= `reasoning`).
   If the live gateway disagrees, change the asserted values — do not add
   probing.
8. **URL normalization strips endpoint suffixes first.** `normalizeBaseOrigin`
   removes trailing `/models`, `/chat/completions`, `/responses`, then `/v1`.
   Persisted catalogs are endpoint-scoped: a baseUrl change invalidates them.
9. **Model catalog pattern is reassign, not splice.** `getModels` is an
   overridden closure getter (`src/register-internal.ts`), so refresh
   replaces the array reference. Do not "fix" this to in-place mutation.
10. **Discovery errors: parsed message, transport-only datasheet fallback.**
    `errorMessage()` prefers `{ error.message | error | message }` from the
    response body (truncated to 500 chars). HTTP failures (e.g. 403/502)
    propagate; only transport failures fall back to the datasheet catalog.
    Old persisted models without the newer compat fields keep working; new
    fields appear after the first refresh.

## Test rules

- `npm test` (node --test over `test/*.test.ts`) and `npx tsc --noEmit`
  must both be green. Test files use `// @ts-nocheck`, source does not.
- `test/register-internal.test.ts` imports the plugin through a temp-package
  dir with symlinked `@earendil-works/*` — reuse that harness for anything
  needing the real provider objects (e.g. streaming via
  `createModels().completeSimple` with injected `fetch`).
- The streaming test injects `{ apiKey, env: { BIFROST_BASE_URL }, fetch }`
  per-request; never hit the network.
