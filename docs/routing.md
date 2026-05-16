# Routing and quota

## Key pool

Configure one or more Gemini API keys via:

```env
GEMROUTER_GEMINI_API_KEYS=AIza...key1,AIza...key2
# or
GEMROUTER_GEMINI_API_KEYS_JSON=[{"id":"k1","key":"AIza...","quotaGroup":"proj-a","tier":"free","priority":100,"enabled":true}]
```

For richer per-account metadata (tiers, limit overrides, project IDs) use `data/gemini-api-accounts.json`. The file matches keys by `id` to accounts by `id`. See `docs/gemini-api-accounts.example.json`.

## Quota tracking

GemRouter tracks quota locally in `data/gemini-api-quota-ledger.json` without any Google Cloud calls. Tracked per key + model:

- **RPM** — requests in the last 60 s sliding window
- **TPM** — tokens in the last 60 s sliding window
- **RPD** — requests since UTC midnight (matches Google's reset boundary)

On each request the router picks the key/model combination with the best availability score:

```
score = priority + rpmRatio×30 + tpmRatio×30 + rpdRatio×30
```

Where each ratio is `remaining / limit` (clamped 0–1). Higher score wins. Keys at or near their limit are skipped.

## Per-account tiers

Mixing free-tier (RPM=5, RPD=20) and Tier 1 (RPM=1000, RPD=10000) accounts without limit overrides would make the scoring unfair. Use per-model limit overrides in `data/gemini-api-accounts.json`:

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

Alternatively override via environment variable (as JSON):

```env
GEMROUTER_GEMINI_API_GROUP_LIMITS_JSON={"my-tier1-project":{"gemini-2.5-flash":{"rpm":1000,"tpm":1000000,"rpd":10000}}}
```

## Fallback behavior

When `backendPreference=auto` (default), GemRouter retries the next usable key/model on:

- 429 rate limit / quota exhaustion
- 401/403 auth failure
- model unavailable
- upstream timeout or transport error

Invalid requests (4xx from caller errors) do not fall back.

## Cooldown

After a 429 with a `Retry-After` header, the model is cooled down for the specified duration. Without the header, no cooldown is applied (the quota ledger itself prevents re-selection until the window clears).

Cooldowns can be cleared from the admin UI or via:

```bash
curl -X POST http://127.0.0.1:4024/v1/provider/quota/clear-cooldown \
  -H "Authorization: Bearer $GEMROUTER_ADMIN_TOKEN"
```

## Observability endpoints

| Endpoint | Description |
|---|---|
| `GET /health` | Overall backend health and quota summary |
| `GET /v1/provider/runtime` | Backend order, current key selection state |
| `GET /v1/provider/models` | Discovered model list |
| `GET /v1/provider/quota` | Per-key, per-model quota snapshot |

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
