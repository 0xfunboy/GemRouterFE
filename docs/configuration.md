# Configuration reference

All configuration is read from `.env`. Copy `.env.example` as your starting point.

## Server

| Variable | Default | Description |
|---|---|---|
| `HOST` | `0.0.0.0` | Bind address |
| `PORT` | `4024` | Listen port |
| `GEMROUTER_ROOT_DIR` | — | Absolute path to the repo root |
| `GEMROUTER_DATA_DIR` | `data` | Writable runtime data directory |
| `GEMROUTER_PUBLIC_BASE_URL` | — | Public URL used by the admin UI |

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
| `GEMROUTER_BOOTSTRAP_ALLOWED_ORIGINS` | CORS origins |
| `GEMROUTER_BOOTSTRAP_ALLOWED_MODELS` | Model IDs this client may request |
| `GEMROUTER_BOOTSTRAP_RATE_LIMIT_PER_MINUTE` | Max requests per minute |
| `GEMROUTER_BOOTSTRAP_MAX_CONCURRENCY` | Max concurrent in-flight requests |

## Backend routing

```env
GEMROUTER_BACKEND_ORDER=gemini-api
```

Only `gemini-api` is active. Order controls fallback priority if multiple backends are listed.

## Gemini API backend

| Variable | Default | Description |
|---|---|---|
| `GEMROUTER_GEMINI_API_ENABLED` | `false` | Enable the backend |
| `GEMROUTER_GEMINI_API_KEYS` | — | Comma-separated API keys |
| `GEMROUTER_GEMINI_API_KEYS_JSON` | — | JSON array of key objects |
| `GEMROUTER_GEMINI_API_ACCOUNTS_PATH` | `data/gemini-api-accounts.json` | Account metadata file |
| `GEMROUTER_GEMINI_API_BASE_URL` | `https://generativelanguage.googleapis.com` | API base |
| `GEMROUTER_GEMINI_API_VERSION` | `v1beta` | API version |
| `GEMROUTER_GEMINI_API_DEFAULT_TIER` | `tier1` | Default quota tier for keys without metadata |
| `GEMROUTER_GEMINI_API_DEFAULT_QUOTA_GROUP_MODE` | `per-key` | `per-key` or `shared` |
| `GEMROUTER_GEMINI_API_LIMITS_JSON` | — | Global per-model rate limits as JSON |
| `GEMROUTER_GEMINI_API_LIMITS_PATH` | — | Path to a JSON file with per-model limits |
| `GEMROUTER_GEMINI_API_GROUP_LIMITS_JSON` | — | Per-quota-group limit overrides as JSON |
| `GEMROUTER_GEMINI_API_LEDGER_PATH` | `data/gemini-api-quota-ledger.json` | Local quota ledger |
| `GEMROUTER_GEMINI_API_DISCOVERY_CACHE_PATH` | `data/gemini-api-models-cache.json` | Model discovery cache |
| `GEMROUTER_GEMINI_API_DISCOVERY_REFRESH_MS` | `21600000` | Discovery refresh interval (6 h) |
| `GEMROUTER_GEMINI_API_QUOTA_COOLDOWN_MS` | `600000` | Default cooldown after 429 (10 min) |
| `GEMROUTER_GEMINI_API_RPM_WINDOW_MS` | `60000` | RPM tracking window |
| `GEMROUTER_GEMINI_API_TPM_WINDOW_MS` | `60000` | TPM tracking window |
| `GEMROUTER_GEMINI_API_RPD_WINDOW_MS` | `86400000` | RPD window (resets at UTC midnight) |
| `GEMROUTER_GEMINI_API_COUNT_TOKENS_PREFLIGHT` | `false` | Count tokens before sending |
| `GEMROUTER_GEMINI_API_COUNT_FAILED_429_AS_USAGE` | `true` | Count quota for failed 429 requests |
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
| `GEMROUTER_THINKING_BUDGET` | `0` | Token budget for thinking (0 = model default) |
