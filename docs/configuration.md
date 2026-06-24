# Configuration

LeakRouter uses `.env` variables with the `LEAKROUTER_` prefix.

## Server

| Variable | Default | Description |
|---|---:|---|
| `HOST` / `LEAKROUTER_HOST` | `0.0.0.0` | Bind address |
| `PORT` / `LEAKROUTER_PORT` | `4024` | HTTP port |
| `LEAKROUTER_ROOT_DIR` | cwd | Repository root |
| `LEAKROUTER_DATA_DIR` | `data` | Writable runtime data |
| `LEAKROUTER_PUBLIC_BASE_URL` | inferred | Public URL shown in metadata |

## Secrets

| Variable | Description |
|---|---|
| `LEAKROUTER_ADMIN_TOKEN` | Admin bearer token and fallback admin password |
| `LEAKROUTER_DASHBOARD_ADMIN_USERS` | Comma-separated `username:password` pairs |
| `LEAKROUTER_BOOTSTRAP_API_KEY` | Client bearer token for inference |

## Client App Policy

| Variable | Default | Description |
|---|---:|---|
| `LEAKROUTER_BOOTSTRAP_ALLOWED_ORIGINS` | localhost origins | CORS allowlist |
| `LEAKROUTER_BOOTSTRAP_ALLOWED_MODELS` | all configured models | Optional model allowlist |
| `LEAKROUTER_BOOTSTRAP_RATE_LIMIT_PER_MINUTE` | `30` | Per-app RPM |
| `LEAKROUTER_BOOTSTRAP_MAX_CONCURRENCY` | `2` | Per-app concurrency |

## Routing

```env
LEAKROUTER_BACKEND_ORDER=ollama
```

Supported upstream modes for this deployment:

| Mode | Description |
|---|---|
| `ollama` | Routes to authorized Ollama endpoints from the local inventory |

## Ollama

| Variable | Default | Description |
|---|---:|---|
| `LEAKROUTER_OLLAMA_ENABLED` | `true` when inventory exists | Enable Ollama routing |
| `LEAKROUTER_OLLAMA_INVENTORY_PATH` | `ollama-model-inventory.json` | Private inventory file |
| `LEAKROUTER_OLLAMA_EXCLUDE_CLOUD_MODELS` | `true` | Hide and skip `:cloud` / `-cloud` models |
| `LEAKROUTER_OLLAMA_TIMEOUT_MS` | `120000` | Request timeout |
| `LEAKROUTER_OLLAMA_STREAM_TIMEOUT_MS` | `180000` | Streaming timeout |

The admin UI and model endpoints expose model names and aggregate counts only. Upstream endpoint URLs stay server-side.

## Optional DeepSeek API Upstream

| Variable | Default | Description |
|---|---:|---|
| `LEAKROUTER_DEEPSEEK_ENABLED` | `false` | Enable DeepSeek API upstream fallback |
| `LEAKROUTER_DEEPSEEK_API_KEY` | — | DeepSeek secret |
| `LEAKROUTER_DEEPSEEK_BASE_URL` | `https://api.deepseek.com/v1` | OpenAI-compatible base URL |
| `LEAKROUTER_DEEPSEEK_MODELS` | `deepseek-chat,deepseek-reasoner` | Public model list |
| `LEAKROUTER_DEEPSEEK_DEFAULT_MODEL` | `deepseek-chat` | Fallback model |

Keep this disabled for the Ollama-only deployment. The DeepSeek-style client surface still works without this upstream mode; it routes authenticated client requests to the Ollama inventory.

## Gemini API Quota Ledger

| Variable | Default | Description |
|---|---:|---|
| `LEAKROUTER_GEMINI_API_LIMITS_JSON` | built-in table | Exact RPM, TPM, and RPD limits for the current AI Studio project, keyed by model. |
| `LEAKROUTER_GEMINI_API_GROUP_LIMITS_JSON` | — | Per-quota-group override of those limits. |
| `LEAKROUTER_GEMINI_API_COUNT_FAILED_429_AS_USAGE` | `false` | Keep false: a rejected request is not treated as confirmed daily usage. |
| `LEAKROUTER_GEMINI_API_QUOTA_COOLDOWN_MS` | `600000` | Conservative cooldown when Gemini returns a 429 without `RetryInfo`. |
| `LEAKROUTER_GEMINI_API_STRICT_MODELS` | — | Models that must fail rather than fall through to another Gemini model. |
| `LEAKROUTER_GEMINI_API_ACCOUNTS_PATH` | — | Optional account metadata file containing the real Google Cloud `projectId`. |

The ledger is an observed router ledger, not a Google balance API: it can account exactly for
successful requests made through LeakRouter after a reset, but it cannot see requests made outside
the router. Gemini RPD resets at midnight `America/Los_Angeles` (PST/PDT). Google AI Studio does not
publish an API for exact real-time remaining RPM, TPM, or RPD; Cloud Monitoring is delayed telemetry,
and Service Usage exposes limits rather than an authoritative free-tier balance. The admin refresh
endpoint labels this distinction instead of reporting an inferred balance as authoritative.

## Outbound Proxy

Outbound proxying applies only to LeakRouter's upstream inference calls from this Node process. It does not configure system-wide `HTTP_PROXY`, change the default gateway, or affect unrelated services.

| Variable | Default | Description |
|---|---:|---|
| `LEAKROUTER_OUTBOUND_PROXY_ENABLED` | `false` | Enable proxied upstream inference requests |
| `LEAKROUTER_OUTBOUND_PROXY_REQUIRED` | `true` | Fail closed instead of falling back direct |
| `LEAKROUTER_OUTBOUND_PROXY_URL` | — | Single proxy URL |
| `LEAKROUTER_OUTBOUND_PROXY_URLS` | — | Comma-separated proxy URLs; preferred over `URL` |
| `LEAKROUTER_OUTBOUND_PROXY_STRATEGY` | `single` | `single`, `round-robin`, or `random` |
| `LEAKROUTER_PROXY_CONNECT_TIMEOUT_MS` | `10000` | Proxy connect timeout |
| `LEAKROUTER_PROXY_REQUEST_TIMEOUT_MS` | `120000` | Proxied request timeout |
| `LEAKROUTER_OUTBOUND_PROXY_BYPASS_HOSTS` | `localhost,127.0.0.1,::1` | Safety bypass hostnames |
| `LEAKROUTER_OUTBOUND_PROXY_BYPASS_PRIVATE_IPS` | `true` | Safety bypass for private IP literals |

When proxying is enabled and required, public upstream inference requests never retry direct. Proxy credentials are redacted in diagnostics.

For testing, Webshare Free is a reasonable first option because it offers 10 free proxies, no credit card, HTTP/SOCKS5 support, and a claimed 99.97% uptime. Decodo and Oxylabs are better-quality trial/premium options. IPRoyal Free Proxy List and ProxyScrape Free Proxy List are fallback/testing sources only, not stable production infrastructure. Do not hardcode public free proxy IPs; treat them as dynamic and unreliable.

## Compatibility Surfaces

```env
LEAKROUTER_COMPAT_DEFAULT_SURFACE=ollama
LEAKROUTER_COMPAT_ENABLED_SURFACES=leakrouter,openai,deepseek,ollama
```

Routes:

| Surface | Routes |
|---|---|
| OpenAI | `/v1/models`, `/v1/chat/completions`, `/v1/responses` |
| DeepSeek-style | `/models`, `/chat/completions` |
| Ollama | `/api/version`, `/api/tags`, `/api/show`, `/api/chat`, `/api/generate` |
