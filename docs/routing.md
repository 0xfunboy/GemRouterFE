# Routing and quota

## Key pool

Configure one or more Gemini API keys via:

```env
GEMROUTER_GEMINI_API_KEYS=AIza...key1,AIza...key2
# or
GEMROUTER_GEMINI_API_KEYS_JSON=[{"id":"k1","key":"AIza...","quotaGroup":"proj-a","tier":"free","priority":100,"enabled":true}]
```

For richer per-account metadata (tiers, limit overrides) use `data/gemini-api-accounts.json`. The file matches keys by `id` to accounts by `id`. See `docs/gemini-api-accounts.example.json`.

## Quota tracking

GemRouter tracks quota entirely in-process in `data/gemini-api-quota-ledger.json` — no Google Cloud calls, no `gcloud` CLI, no service account required. Tracked per quota group + model:

- **RPM** — requests in the last 60 s sliding window
- **TPM** — tokens in the last 60 s sliding window  
- **RPD** — requests since midnight **America/Los_Angeles** (matches Google's actual reset boundary, including DST changes)

On every response the ledger records real token counts (from the API reply) and upstream rate-limit headers (`x-ratelimit-remaining-requests-day`, etc.) as secondary validation. On a 429 the relevant events are optionally rolled back (`GEMROUTER_GEMINI_API_COUNT_FAILED_429_AS_USAGE`).

### Key selection

The pool picks the key/group with the best multi-factor score, evaluated in this order:

1. **Priority** — higher `priority` field wins
2. **Rotation** — least recently used key wins (round-robin at equal priority)
3. **Capacity score** — `rpmRatio×30 + tpmRatio×30 + rpdRatio×30` where each ratio is `remaining / limit`
4. **Config order** — tie-break by position in the key list

Keys at or beyond any limit (RPM, TPM, or RPD) are excluded from selection before scoring.

## Per-account tiers

Mixing free-tier (RPM 5, RPD 20) and Tier 1 (RPM 1000+, RPD 10 000+) accounts without limit overrides would make scoring unfair — the Tier 1 key would always win. Fix with per-model limit overrides in `data/gemini-api-accounts.json`:

```json
{
  "id": "account-tier1",
  "quotaGroup": "my-tier1-project",
  "tier": "tier1",
  "limits": {
    "gemini-2.5-flash": { "rpm": 1000, "tpm": 1000000, "rpd": 10000 },
    "gemini-3-flash-preview": { "rpm": 1000, "tpm": 2000000, "rpd": 10000 }
  }
}
```

Or via environment variable:

```env
GEMROUTER_GEMINI_API_GROUP_LIMITS_JSON={"my-tier1-project":{"gemini-2.5-flash":{"rpm":1000,"tpm":1000000,"rpd":10000}}}
```

## Backend routing

When `backendPreference=auto` (default), the backend sequence is resolved by model name:

- **gemini-\* / gemma-\*** → `gemini-api` first, then other backends if fallback is allowed
- **everything else** → `ollama` first, then other backends

Force a specific backend per request with the `x-gemrouter-backend` header (`gemini-api`, `gemini`, `ai-studio`, or `auto`). The alias `x-baribi-backend` is also accepted.

### Strict model IDs

Models listed in `strictModelIds` (config) never fall back to another backend, even on error. Use this to prevent Gemma models from silently falling back to a Flash endpoint.

## Fallback behavior

When `backendPreference=auto`, GemRouter falls back to the next backend on:

- 429 rate limit / quota exhaustion
- 401 / 403 auth failure
- model unavailable
- upstream timeout or transport error

Caller-error 4xx (bad request, invalid parameters) do not fall back.

The fallback chain is annotated in the response as `fallbackFrom` / `fallbackReason`.

## Cooldown

A failed attempt holds the model+account out for a window determined by the cooldown source:

| Source | Trigger | Duration |
|---|---|---|
| `retry-after` | 429 with `Retry-After` header | Exact header value |
| `pacific-reset` | 429 with `rateLimitScope=day` | Until next Pacific midnight (marks `dailyDepleted`) |
| `429-backoff` | generic 429 (no header/scope) | Escalating ladder (see below) |
| `daily-depleted` | 3rd generic 429 strike | Until next Pacific midnight |
| `high-demand` | 503 "overloaded/unavailable" | 30 s skip (model-wide; does not retry other accounts) |

### 429 escalation ladder

Generic 429s with no `Retry-After` and no day scope escalate **per model+account**, with
strikes accruing within a Pacific day and resetting at the midnight rollover:

1. **strike 1** → 1 min cooldown
2. **strike 2** → 5 min cooldown
3. **strike 3** → treated as daily quota depletion, parked until the next Pacific reset

A successful call clears the strike count and lifts any `429-backoff`/`daily-depleted`
cooldown for that model+account.

### High demand (503)

A 503 "high demand" is a Google-side capacity condition shared by all accounts, so the
router does **not** sweep the other keys — it records one attempt, applies a 30 s cooldown,
and moves straight to the next model in the chain.

Cooldowns can be cleared from the admin UI or via:

```bash
curl -X POST http://127.0.0.1:4024/admin/provider/gemini-api/clear-cooldown \
  -H "Authorization: Bearer $GEMROUTER_ADMIN_TOKEN"
```

## Quota exposed to the dashboard

The guest dashboard at `/dashboard/summary` receives a compact quota snapshot:

```json
{
  "provider": {
    "quota": {
      "apiKeys": [...],
      "quotaGroups": [
        {
          "id": "my-project",
          "models": [
            {
              "model": "gemini-2.5-flash",
              "rpm": { "used": 2, "limit": 5, "remaining": 3 },
              "tpm": { "used": 4200, "limit": 250000, "remaining": 245800 },
              "rpd": { "used": 8, "limit": 20, "remaining": 12 }
            }
          ]
        }
      ],
      "rpdResetAt": "2026-06-26T07:00:00.000Z",
      "rpdWindow": "America/Los_Angeles"
    }
  }
}
```

The **cumulative remaining RPD** for a model across all accounts is the sum of `rpd.remaining` across every quota group. This is computed client-side by the frontend from the per-group data above. All values come directly from the local ledger — no Cloud Monitoring, no Google API calls.

## Local Ollama (vision + embeddings)

When `GEMROUTER_OLLAMA_LOCAL_ENABLED=true`, two models are served directly by the local
Ollama server, on explicit request only, with **no fallback**:

- **Embeddings** — `POST /v1/embeddings` (and `/embeddings`) for the configured embedding
  model returns an OpenAI-style vector list via Ollama `/api/embed`.
- **Vision** — an explicit chat request for the configured vision model is intercepted
  before free-tier text resolution and served via Ollama `/api/chat`; image parts
  (`image_url`/`input_image`, data URIs or bare base64) are forwarded. On error it returns
  502 and never falls back to Gemini.

Per-model daily request counters persist to `data/ollama-local-usage.json` (Pacific reset)
and surface in the dashboard's "Ollama Local RPD" box.

## Admin management endpoints

All require the admin bearer token or session.

| Endpoint | Description |
|---|---|
| `GET/POST /admin/provider/gemini-api/accounts` | List accounts; `add`/`update`/`remove`/`list-models` subpaths manage the key pool live (persist to `accounts.json`, hot reload) |
| `GET/POST /admin/provider/models-config` | Read/set the routed model set and order (applied live, persisted to `model-config.json`) |
| `GET/POST /admin/provider/proxy` | Read/set the outbound proxy config |
| `POST /admin/apps` | Create an app; accepts an optional custom `apiKey` (e.g. `goon_` prefix) |

## Observability endpoints

| Endpoint | Auth | Description |
|---|---|---|
| `GET /health` | none | Runtime health and compact quota summary |
| `GET /dashboard/summary` | none | Guest-safe stats, quota view, and local Ollama RPD |
| `GET /admin/summary` | admin | Full diagnostics, model catalog, apps |
| `GET /v1/provider/runtime` | client | Backend order and current key selection state |
| `GET /v1/provider/models` | client | Discovered model list |
| `GET /v1/provider/quota` | client | Per-key, per-model quota snapshot |

## API surfaces

All surfaces route through the same backend selection logic.

**OpenAI-compatible**

```
GET  /v1/models
POST /v1/chat/completions
POST /v1/responses
POST /v1/images/generations
GET  /v1/provider/runtime
GET  /v1/provider/models
GET  /v1/provider/quota
```

**DeepSeek-compatible**

```
GET  /models
POST /chat/completions
```

**Ollama-compatible**

```
GET  /api/version
GET  /api/tags
POST /api/show
POST /api/chat
POST /api/generate
```
