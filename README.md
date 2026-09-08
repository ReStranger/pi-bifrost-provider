# pi-bifrost-provider

Pi (0.84.4+) extension registering [getbifrost.ai](https://getbifrost.ai) as
two native providers: `bifrost-responses` (Responses API) and
`bifrost-completions` (Chat Completions API).

## Setup

Configure with either environment variables or `/login` (credential takes
precedence over flags and env):

```bash
export BIFROST_BASE_URL="https://your-gateway.example"
export BIFROST_API_KEY="..."
```

CLI flags (mirror the env vars; prefer env for the secret):

```bash
pi --bifrost-base-url https://your-gateway.example -e ./index.ts
```

When a base URL + key are available at startup (flags or env), the extension
fetches the model catalog once so models are listed immediately. If the
gateway is down, startup logs a warning to stderr and the providers register
anyway — the catalog recovers on the next refresh. You can paste a full
endpoint; trailing `/v1`, `/models`, `/chat/completions`, `/responses` are
stripped automatically.

### `/login`

```text
/login bifrost
```

Prompts for the gateway URL and API key, validates them against
`GET {origin}/v1/models`, and stores the credential. Both values are
required. A stored credential owns its config: after changing the URL via
`/login`, a stale `BIFROST_API_KEY` from another gateway is not mixed in.

## Development

```bash
npm test        # node --test over test/*.test.ts
npm run typecheck
```

See [AGENTS.md](./AGENTS.md) for the contracts that are easy to break
(precedence, owns-config guard, per-token pricing, asserted compat).
