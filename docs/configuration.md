# Configuration reference

All configuration is read from `.env`. Copy `.env.example` as your starting point.

## Server

| Variable | Default | Description |
|---|---|---|
| `HOST` | `0.0.0.0` | Bind address |
| `PORT` | `4024` | Listen port |
| `GEMROUTER_ROOT_DIR` | - | Absolute path to the repo root |
| `GEMROUTER_DATA_DIR` | `data` | Writable runtime data directory |
| `GEMROUTER_PUBLIC_BASE_URL` | - | Public URL used by the admin UI |

## Admin and auth

| Variable | Description |
|---|---|
| `GEMROUTER_ADMIN_TOKEN` | Bearer token for privileged API calls (required) |
| `GEMROUTER_DASHBOARD_ENABLED` | Enable the operator admin UI (default `true`) |
| `GEMROUTER_DASHBOARD_ADMIN_USERS` | `user:password` pairs for admin UI login |
| `GEMROUTER_ADMIN_SESSION_TTL_MS` | Admin session lifetime (default `86400000`) |

## Bootstrap client

The bootstrap app is the built-in API client identity (e.g. your local Claude Code session).

| Variable | Description |
|---|---|
| `GEMROUTER_BOOTSTRAP_API_KEY` | Client bearer token (required) |
| `GEMROUTER_BOOTSTRAP_APP_NAME` | App label shown in logs |
| `GEMROUTER_BOOTSTRAP_MODEL_ACCESS` | `all` follows the complete active catalog across restarts; `custom` uses the allowlist |
| `GEMROUTER_BOOTSTRAP_ALLOWED_ORIGINS` | CORS origins |
| `GEMROUTER_BOOTSTRAP_ALLOWED_MODELS` | Model IDs this client may request |
| `GEMROUTER_BOOTSTRAP_RATE_LIMIT_PER_MINUTE` | Max requests per minute |
| `GEMROUTER_BOOTSTRAP_MAX_CONCURRENCY` | Max concurrent in-flight requests |

## Backend routing

```env
GEMROUTER_BACKEND_ORDER=gemini-api,ollama
```

Order determines which backend is tried first. When `backendPreference=auto`, the router also applies model-name heuristics: `gemini-*`/`gemma-*` models are routed to `gemini-api` first regardless of list order; all other models prefer `ollama` first. Explicit backend overrides (`x-gemrouter-backend` header) bypass this logic entirely.

`chatgpt` is intentionally not added to the automatic backend order. A registered worker alias,
the reserved `chatgpt/` namespace, or an explicit `x-gemrouter-backend: chatgpt` is resolved
strictly before the ordinary router and can never spill to another provider.

## Native ChatGPT MCP gateway

Disabled by default. See [the complete gateway guide](chatgpt-mcp-gateway.md) before enabling it.

The deployment origin for this checkout is `https://gemr.airewardrop.xyz`; `.env.example`
includes it without enabling the feature. Once an operator has enabled the gateway
through an authorized deployment, the reserved dashboard offers **Prepara → Autorizza →
Avvia la chat**. Environment activation is deliberately not a dashboard restart action.

| Variable | Default | Description |
|---|---|---|
| `GEMROUTER_CHATGPT_ENABLED` | `false` | Register the OAuth/MCP routes and open the durable gateway store |
| `GEMROUTER_CHATGPT_PUBLIC_BASE_URL` | - | Required clean HTTPS public origin; loopback HTTP only for tests |
| `GEMROUTER_CHATGPT_DATA_DIR` | `./data/chatgpt-gateway` | Private SQLite/WAL directory |
| `GEMROUTER_CHATGPT_PROFILE` | `compatibility` | `compatibility` warns for ignored controls; `strict` rejects them |
| `GEMROUTER_CHATGPT_TIMEOUT_MS` | `300000` | Default total worker request deadline |
| `GEMROUTER_CHATGPT_QUEUE_TIMEOUT_MS` | `60000` | Default maximum time before a worker claims a queued job |
| `GEMROUTER_CHATGPT_LONG_POLL_MS` | `20000` | Default bounded MCP poll duration |
| `GEMROUTER_CHATGPT_STALE_AFTER_MS` | `120000` | Recent-contact window used for honest availability/status |
| `GEMROUTER_CHATGPT_MAX_QUEUE_PER_WORKER` | `4` | Default per-worker queued-job limit |
| `GEMROUTER_CHATGPT_MAX_ACTIVE_JOBS` | `32` | Global queued + claimed job limit |
| `GEMROUTER_CHATGPT_MAX_REQUEST_BYTES` | `262144` | UTF-8 serialized request/message boundary |
| `GEMROUTER_CHATGPT_MAX_RESPONSE_BYTES` | `1048576` | UTF-8 worker completion boundary |
| `GEMROUTER_CHATGPT_IDEMPOTENCY_TTL_SECONDS` | `900` | HTTP idempotency and MCP exchange replay guarantee |
| `GEMROUTER_CHATGPT_RETENTION_HOURS` | `24` | Terminal job retention before cleanup; must cover the idempotency TTL |

## Gemini API backend

Confirmed retired model IDs are denied centrally before configuration, caches,
account catalogs, discovery responses, app allowlists, or the free-tier monitor can
publish them again. `gemini-3.1-flash-live-preview` is currently retired and must not
be added back to environment or persisted model lists.

| Variable | Default | Description |
|---|---|---|
| `GEMROUTER_GEMINI_API_ENABLED` | `false` | Enable the backend |
| `GEMROUTER_GEMINI_API_KEYS` | - | Comma-separated API keys |
| `GEMROUTER_GEMINI_API_KEYS_JSON` | - | JSON array of key objects |
| `GEMROUTER_GEMINI_API_ACCOUNTS_PATH` | `data/gemini-api-accounts.json` | Account metadata file |
| `GEMROUTER_GEMINI_API_BASE_URL` | `https://generativelanguage.googleapis.com` | API base |
| `GEMROUTER_GEMINI_API_VERSION` | `v1beta` | API version |
| `GEMROUTER_GEMINI_API_DEFAULT_TIER` | `tier1` | Default quota tier for keys without metadata |
| `GEMROUTER_GEMINI_API_DEFAULT_QUOTA_GROUP_MODE` | `per-key` | `per-key` or `shared` |
| `GEMROUTER_GEMINI_API_LIMITS_JSON` | - | Global per-model rate limits as JSON |
| `GEMROUTER_GEMINI_API_LIMITS_PATH` | - | Path to a JSON file with per-model limits |
| `GEMROUTER_GEMINI_API_GROUP_LIMITS_JSON` | - | Per-quota-group limit overrides as JSON |
| `GEMROUTER_GEMINI_API_LEDGER_PATH` | `data/gemini-api-quota-ledger.json` | Local quota ledger |
| `GEMROUTER_GEMINI_API_DISCOVERY_CACHE_PATH` | `data/gemini-api-models-cache.json` | Model discovery cache |
| `GEMROUTER_GEMINI_API_DISCOVERY_REFRESH_MS` | `21600000` | Discovery refresh interval (6 h) |
| `GEMROUTER_GEMINI_API_QUOTA_COOLDOWN_MS` | `600000` | Default cooldown after generic 429 (10 min); day-scope 429s hold until Pacific midnight |
| `GEMROUTER_GEMINI_API_RPM_WINDOW_MS` | `60000` | RPM tracking window |
| `GEMROUTER_GEMINI_API_TPM_WINDOW_MS` | `60000` | TPM tracking window |
| `GEMROUTER_GEMINI_API_COUNT_TOKENS_PREFLIGHT` | `false` | Count tokens before sending |
| `GEMROUTER_GEMINI_API_COUNT_FAILED_429_AS_USAGE` | `false` | Count quota for failed 429 requests |
| `GEMROUTER_GEMINI_API_TIMEOUT_MS` | `120000` | Request timeout |
| `GEMROUTER_GEMINI_API_STREAM_TIMEOUT_MS` | `180000` | Streaming timeout |

## Model lists

| Variable | Description |
|---|---|
| `GEMROUTER_DIRECT_MODELS` | Models exposed by `/v1/models` and `/models` |
| `GEMROUTER_FREE_TIER_TEXT_MODELS` | Text models available on free-tier keys |
| `GEMROUTER_FREE_TIER_AUDIO_MODELS` | Audio/TTS models available on free-tier keys |
| `GEMROUTER_FREE_TIER_EMBEDDING_MODELS` | Embedding models |
| `GEMROUTER_TEXT_FALLBACK_MODELS` | Ordered fallback list for failed requests |
| `GEMROUTER_DEFAULT_MODEL` | Default model when caller does not specify |

## Compatibility surfaces

| Variable | Default | Description |
|---|---|---|
| `GEMROUTER_COMPAT_DEFAULT_SURFACE` | `gemrouter` | Default surface (`gemrouter`, `openai`, `deepseek`, `ollama`) |
| `GEMROUTER_COMPAT_ENABLED_SURFACES` | all | Comma-separated list of enabled surfaces |

## Thinking / reasoning

| Variable | Default | Description |
|---|---|---|
| `GEMROUTER_INCLUDE_THOUGHTS` | `false` | Include thinking tokens in response |
| `GEMROUTER_STRIP_REASONING` | `true` | Strip `<thinking>` blocks before returning |
| `GEMROUTER_THINKING_LEVEL` | `minimal` | `none`, `minimal`, `low`, `medium`, `high`, `max` |
| `GEMROUTER_THINKING_BUDGET` | `0` | Legacy numeric budget used by Gemini 2.5 Flash/Lite |

Thinking config is applied per model: omitted entirely for `gemma-*`; `thinkingBudget` is used only for `gemini-2.5-flash`/`-lite`; Gemini 3.x reasoning variants use `thinkingLevel`. Gemini 3.7 and 3.8 Flash do not accept `minimal`, so the router promotes only that combination to `low` while preserving explicit `low`, `medium`, or `high` values. Gemini 3.8 also receives no legacy sampling parameters such as `temperature`.

## Local Ollama (vision + embeddings)

A dedicated single-instance Ollama server reached **only** on a direct request for the
configured model, fully outside the Gemini fallback chain. Off by default.

| Variable | Default | Description |
|---|---|---|
| `GEMROUTER_OLLAMA_LOCAL_ENABLED` | `false` | Enable the local vision/embedding route |
| `GEMROUTER_OLLAMA_LOCAL_BASE_URL` | `http://127.0.0.1:11434` | Local Ollama endpoint |
| `GEMROUTER_OLLAMA_LOCAL_EMBEDDING_MODEL` | - | Model served by `POST /v1/embeddings` (e.g. `bge-m3`) |
| `GEMROUTER_OLLAMA_LOCAL_EMBEDDING_RPD` | `0` | Soft daily request budget shown on the dashboard (0 = unlimited) |
| `GEMROUTER_OLLAMA_LOCAL_VISION_MODEL` | - | Vision model served on direct chat request (e.g. `minicpm-v4.5:8b`) |
| `GEMROUTER_OLLAMA_LOCAL_VISION_RPD` | `0` | Soft daily request budget |
| `GEMROUTER_OLLAMA_LOCAL_TIMEOUT_MS` | `120000` | Request timeout |
| `GEMROUTER_OLLAMA_LOCAL_USAGE_PATH` | `data/ollama-local-usage.json` | Persisted daily counters (Pacific reset) |

## Outbound proxy

Managed proxy pool for non-bypassed upstreams. Off by default and **not yet applied** to
upstream fetches (Gemini runs direct); configurable via the admin "Outbound Proxy" panel
which persists to `data/proxy-config.json`.

| Variable | Default | Description |
|---|---|---|
| `GEMROUTER_OUTBOUND_PROXY_ENABLED` | `false` | Enable the outbound proxy layer |
| `GEMROUTER_OUTBOUND_PROXY_STRATEGY` | `round-robin` | `round-robin` or `random` |
| `GEMROUTER_OUTBOUND_PROXY_URLS` | - | Comma-separated proxy URLs (`http://user:pass@host:port`) |
| `GEMROUTER_OUTBOUND_PROXY_BYPASS_HOSTS` | `localhost,127.0.0.1,::1,generativelanguage.googleapis.com,*.googleapis.com` | Hosts that always go direct |
| `GEMROUTER_OUTBOUND_PROXY_PATH` | `data/proxy-config.json` | Persisted proxy config |
