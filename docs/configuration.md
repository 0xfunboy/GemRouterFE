# Configuration reference

GemRouter loads its process environment and uses dotenv to fill unset variables from `.env` in the working directory. Run it from the checkout root. Environment values passed by systemd or another supervisor take precedence over values loaded by dotenv. Changes to startup settings require a process restart. The dashboard also persists settings that take effect while the service is running.

The tables below use code defaults for omitted variables. The [environment template](../.env.example) supplies explicit values for a sample deployment. Lists use commas unless the variable ends in `_JSON`.

## Listener and identity

| Variable | Default or requirement | Purpose |
| --- | --- | --- |
| `HOST`, `PORT` | `0.0.0.0`, `4024` | Listener. Use `127.0.0.1` for a same-host reverse proxy or tunnel. |
| `GEMROUTER_ROOT_DIR` | Current working directory | Base for most relative runtime paths. |
| `GEMROUTER_DATA_DIR` | `data` under the root | Apps, interaction and audit logs, saved surface policy and model order. Provider files with their own path settings can still resolve under `<root>/data/`. |
| `GEMROUTER_PUBLIC_BASE_URL` | Inferred from the request | Public origin used in links and client configuration. |
| `GEMROUTER_ADMIN_TOKEN` | Required | Admin bearer token. |
| `GEMROUTER_DASHBOARD_ENABLED` | `true` | Enables the browser UI. Protect privileged API routes and the public origin independently. |
| `GEMROUTER_DASHBOARD_ADMIN_USERS` | User `admin` with the admin token as password | Comma-separated `username:password` entries for browser login. |
| `GEMROUTER_ADMIN_SESSION_TTL_MS` | `86400000` | Browser admin session lifetime. Sessions are held in memory. |

## Client policy

| Variable | Role |
| --- | --- |
| `GEMROUTER_BOOTSTRAP_API_KEY` | Required client credential. Use a separate value from the admin token. |
| `GEMROUTER_BOOTSTRAP_APP_NAME`, `GEMROUTER_BOOTSTRAP_SESSION_NAMESPACE` | Bootstrap app label and session namespace, both defaulting to `local-client`. |
| `GEMROUTER_BOOTSTRAP_MODEL_ACCESS`, `GEMROUTER_BOOTSTRAP_ALLOWED_MODELS` | Select `custom` (default) or `all`; use known model IDs for an explicit allowlist. Codex also requires its own per-app grant. |
| `GEMROUTER_BOOTSTRAP_ALLOWED_ORIGINS` | Browser origin patterns. The default permits loopback origins. Requests without an Origin header still need a valid client credential. |
| `GEMROUTER_BOOTSTRAP_RATE_LIMIT_PER_MINUTE`, `GEMROUTER_BOOTSTRAP_MAX_CONCURRENCY`, `GEMROUTER_BOOTSTRAP_CONCURRENCY_WAIT_MS` | Defaults of 30 requests per minute, 2 concurrent requests and a 90000 ms queue wait. Newly created apps have individually configurable rate and concurrency settings. Admission varies by endpoint. |

At startup the router locates the bootstrap app by key hash and reapplies its environment policy. Changing the bootstrap key alone creates a different identity. When rotating it, also revoke the previous app record once clients have switched. Other app records retain their own policies in `apps.json`.

## Gemini credentials and quotas

Set `GEMROUTER_GEMINI_API_ENABLED=true` to start the backend before provisioning a key through the dashboard. If omitted, it is enabled when the startup loader finds Gemini keys. For dashboard-managed credentials, explicitly configure `GEMROUTER_GEMINI_API_ACCOUNTS_PATH=data/gemini-api-accounts.json`. When the variable is absent the writer defaults to this path, but the startup metadata reader only opens an explicitly configured path. Use an absolute file path if the service working directory differs from its project root.

The loader selects credentials in the following order.

1. A nonempty `GEMROUTER_GEMINI_API_KEYS_JSON` array of objects containing `key` selects that credential list.
2. Otherwise, the router reads metadata from `GEMROUTER_GEMINI_API_ACCOUNTS_PATH`. A nonempty `GEMROUTER_GEMINI_API_ACCOUNTS_JSON` array overrides the file. If any account record contains a nonempty `key`, only records carrying a key supply credentials.
3. Otherwise, `GEMROUTER_GEMINI_API_KEYS` supplies a comma-separated list of raw keys. The loader pairs these with metadata by array position. Emptying the dashboard-managed registry can reactivate this environment list on the next startup. Once the saved registry is authoritative, remove obsolete credential sources from the service environment.

The account editor persists raw keys. It writes the registry from its in-memory account records and drops per-account `limits` fields from that file on rewrite. For project-specific overrides that must survive dashboard edits, set `GEMROUTER_GEMINI_API_GROUP_LIMITS_JSON` in the service configuration. The metadata [example](gemini-api-accounts.example.json) illustrates IDs, model policy and the limits object.

| Variable | Default or behavior |
| --- | --- |
| `GEMROUTER_GEMINI_API_BASE_URL`, `GEMROUTER_GEMINI_API_VERSION` | `https://generativelanguage.googleapis.com` and `v1beta`. The Decisions provider uses `/v1beta/decisions`. |
| `GEMROUTER_GEMINI_API_DEFAULT_TIER`, `GEMROUTER_GEMINI_API_DEFAULT_QUOTA_GROUP_MODE` | Tier label `tier1` and grouping `per-key`. `shared` puts accounts without an explicit group in one default group. Give keys for the same Google project the same `quotaGroup`. The tier label does not query Google for limits or change billing. |
| `GEMROUTER_GEMINI_API_LIMITS_PATH`, `GEMROUTER_GEMINI_API_LIMITS_JSON` | Global model budgets. The JSON environment map overrides matching entries in the file, which overrides the built-in table. |
| `GEMROUTER_GEMINI_API_GROUP_LIMITS_JSON` | Per-group model map, e.g. `{"project-a":{"gemini-4-hydrogen":{"rpm":5,"tpm":250000,"rpd":20}}}`. Overrides matching limits supplied by account metadata. |
| `GEMROUTER_GEMINI_API_LEDGER_PATH` | `data/gemini-api-quota-ledger.json`. Tracks RPM, input TPM and RPD by group and model across apps. |
| `GEMROUTER_GEMINI_API_RPM_WINDOW_MS`, `GEMROUTER_GEMINI_API_TPM_WINDOW_MS` | `60000` each. The daily quota boundary is midnight in `America/Los_Angeles`. |
| `GEMROUTER_GEMINI_API_COUNT_FAILED_429_AS_USAGE` | Defaults to `false`. Controls local reservation accounting for HTTP 429. |
| `GEMROUTER_GEMINI_API_DISCOVERY_CACHE_PATH`, `GEMROUTER_GEMINI_API_ACCOUNT_MODELS_PATH` | `data/gemini-api-models-cache.json` (global) and `data/gemini-api-account-models.json` (per-account). |
| `GEMROUTER_GEMINI_API_DISCOVERY_REFRESH_MS`, `GEMROUTER_GEMINI_API_ACCOUNT_MODELS_REFRESH_MS` | `21600000` each. Discovery indicates advertised methods. Use a bounded inference probe to establish that a specific credential can serve a model. |
| `GEMROUTER_GEMINI_API_TIMEOUT_MS`, `GEMROUTER_REQUEST_DEADLINE_MS` | Defaults of `120000` for the Gemini provider and `75000` for routed requests. Model budgets and remaining time can shorten an individual attempt. |
| `GEMROUTER_GEMINI_API_STRICT_MODELS` | Comma-separated model IDs for exact-model routing where app policy allows the requested model. |

The current Gemini generation path estimates input for admission, applies its implemented cooldown policy, and buffers Gemini streaming responses. The configuration parser accepts `GEMROUTER_GEMINI_API_COUNT_TOKENS_PREFLIGHT`, `GEMROUTER_GEMINI_API_QUOTA_COOLDOWN_MS`, `GEMROUTER_GEMINI_API_RPD_WINDOW_MS` and `GEMROUTER_GEMINI_API_STREAM_TIMEOUT_MS`; changing these values has no corresponding effect in the current generation or ledger code. Limits shown by the router are local estimates. For actual project allocations consult [Google AI Studio rate limits](https://aistudio.google.com/docs/rate-limits).

## Catalog, routing and compatibility

| Variables | Effect |
| --- | --- |
| `GEMROUTER_FREE_TIER_TEXT_MODELS`, `GEMROUTER_TEXT_FALLBACK_MODELS` | Seed the enabled Gemini text models and ordered fallback list. The saved `data/model-config.json` text order overrides both at startup. |
| `GEMROUTER_DEFAULT_MODEL`, `GEMROUTER_DIRECT_MODELS` | Seed the direct catalog and its leading model. Current chat and Responses parsers map an omitted model to the first built-in text ID (`gemini-4-hydrogen`). If that ID is unavailable under app policy, the handler selects an authorized candidate from the runtime order. |
| `GEMROUTER_FREE_TIER_AUDIO_MODELS`, `GEMROUTER_FREE_TIER_EMBEDDING_MODELS` | Describe model families for the free-tier inventory. Dedicated local Ollama endpoints have independent model settings. |
| `GEMROUTER_FREE_TIER_POLICY_ENABLED`, `GEMROUTER_FREE_TIER_REFRESH_MS`, `GEMROUTER_FREE_TIER_PRICING_URL`, `GEMROUTER_FREE_TIER_PARSE_MODEL`, `GEMROUTER_FREE_TIER_POLICY_PATH` | Pricing monitor enabled by default, 24-hour interval, Google pricing page, a configured fallback model and `data/free-tier-policy.json`. Refresh can perform network access and model inference. |
| `GEMROUTER_COMPAT_DEFAULT_SURFACE`, `GEMROUTER_COMPAT_ENABLED_SURFACES` | Seed the surface policy. Defaults to `gemrouter` and all four surfaces (`gemrouter,openai,deepseek,ollama`). Saved `compatibility.json` takes precedence. |
| `GEMROUTER_BACKEND_ORDER` | Defaults to `gemini-api`. Eligible providers, model family, explicit backend preference and app policy also influence dispatch. Hydrogen gives the authorized Gemini downgrade chain first use of the request budget. |

Hydrogen leads the built-in Gemini chat chain, followed by `gemini-3.8-flash`. Decision 1 uses its own route and quota. The router filters retired model IDs against its [model policy](../src/lib/models.ts). See [routing behavior](routing.md) and the [Gemini account census](gemini-account-census.md).

### Thinking and output

`GEMROUTER_THINKING_LEVEL` accepts `minimal` (default), `low`, `medium`, `high` or `xhigh`. Gemini 4 Hydrogen maps `minimal` to `low`. Gemini 3.7 and 3.8 Flash also use `low` for that setting, and models below Hydrogen map `xhigh` to `high` where levels apply. Hydrogen and 3.7/3.8 Flash omit the legacy temperature setting. Gemma omits thinking configuration. `GEMROUTER_THINKING_BUDGET` is a legacy numeric setting for compatible Gemini 2.5 models. `GEMROUTER_INCLUDE_THOUGHTS` controls the provider request; the Gemini adapter excludes thought-tagged parts from returned text. `GEMROUTER_STRIP_REASONING` is parsed but does not switch off the adapter's text filtering.

## Optional providers

### NVIDIA

`GEMROUTER_NVIDIA_API_KEY` enables the provider by default when set. `GEMROUTER_NVIDIA_ENABLED=false` disables it. `GEMROUTER_NVIDIA_BASE_URL` defaults to `https://integrate.api.nvidia.com`.

| Controls | Behavior |
| --- | --- |
| `GEMROUTER_NVIDIA_MODELS_JSON`, `GEMROUTER_NVIDIA_MODELS_PATH`, `GEMROUTER_NVIDIA_DEFAULT_TIER` | Nonempty JSON overrides `data/nvidia-models.json`; a built-in catalog is the fallback. Tier defaults to `large`; available tiers are `small`, `medium`, `large`. |
| `GEMROUTER_NVIDIA_RPM_LIMIT`, `GEMROUTER_NVIDIA_MAX_CONCURRENCY`, `GEMROUTER_NVIDIA_RATE_LIMIT_COOLDOWN_MS` | Local budget defaults of 36 RPM, 8 concurrent calls, 60000 ms cooldown. |
| `GEMROUTER_NVIDIA_FIRST_TOKEN_TIMEOUT_MS`, `GEMROUTER_NVIDIA_TIMEOUT_MS` | 25000 ms for first token and 120000 ms provider timeout. |
| `GEMROUTER_NVIDIA_PROBE_ENABLED`, `GEMROUTER_NVIDIA_PROBE_INTERVAL_MS`, `GEMROUTER_NVIDIA_PROBE_MAX_TOKENS`, `GEMROUTER_NVIDIA_SCOREBOARD_PATH` | Background probes enabled by default for the active backend, hourly, up to 16 output tokens each. Scores persist in `data/nvidia-scoreboard.json`. |
| `GEMROUTER_NVIDIA_RACE_ENABLED`, `GEMROUTER_NVIDIA_RACE_HEDGE_DELAY_MS`, `GEMROUTER_NVIDIA_RACE_MAX_CANDIDATES` | NVIDIA tier race defaults of enabled, 8000 ms, 3 candidates. The outer router also uses the delay for eligible cross-provider hedges. |
| `GEMROUTER_NVIDIA_FALLBACK_MODEL` | Defaults to `gemini-3.5-flash` for eligible downgrades from NVIDIA to Gemini. |

### Ollama

The inventory-backed provider reads `GEMROUTER_OLLAMA_INVENTORY_PATH` (default `ollama-model-inventory.json`). Use `GEMROUTER_OLLAMA_ENABLED` to control routing and `GEMROUTER_OLLAMA_MODELS` for the configured list. `GEMROUTER_OLLAMA_EXCLUDE_CLOUD_MODELS` defaults to true and `GEMROUTER_OLLAMA_MIN_PARAMETER_SCORE` to zero. Requests use `GEMROUTER_OLLAMA_TIMEOUT_MS` (default 120000). The streaming implementation buffers the response.

A separate local instance handles vision and embeddings. Enable `GEMROUTER_OLLAMA_LOCAL_ENABLED` and set `GEMROUTER_OLLAMA_LOCAL_BASE_URL` (default `http://127.0.0.1:11434`) and `GEMROUTER_OLLAMA_LOCAL_EMBEDDING_MODEL` or `GEMROUTER_OLLAMA_LOCAL_VISION_MODEL`. The dedicated endpoints are `/v1/embeddings` and `/v1/vision`; both also have unversioned aliases. `GEMROUTER_OLLAMA_LOCAL_EMBEDDING_RPD` and `GEMROUTER_OLLAMA_LOCAL_VISION_RPD` are dashboard budgets. `0` means unlimited. Counters use `GEMROUTER_OLLAMA_LOCAL_USAGE_PATH` (default `data/ollama-local-usage.json`) and the timeout is `GEMROUTER_OLLAMA_LOCAL_TIMEOUT_MS` (120000).

### Agnes

`GEMROUTER_AGNES_API_KEY` enables the media provider by default when supplied. `GEMROUTER_AGNES_ENABLED` can disable it. Configure `GEMROUTER_AGNES_BASE_URL`, `GEMROUTER_AGNES_IMAGE_MODELS` and `GEMROUTER_AGNES_VIDEO_MODELS` for the deployment. Image timeout defaults to 90000 ms, video timeout to 300000 ms and video polling interval to 12000 ms, controlled by `GEMROUTER_AGNES_IMAGE_TIMEOUT_MS`, `GEMROUTER_AGNES_VIDEO_TIMEOUT_MS` and `GEMROUTER_AGNES_VIDEO_POLL_MS`. `GEMROUTER_AGNES_USAGE_PATH` defaults to `data/agnes-usage.json`.

### Codex and alerts

Codex requires `GEMROUTER_CODEX_ENABLED=true` and an explicit per-app grant. Inspect the current supported models through the account catalog. `GEMROUTER_CODEX_PRIVATE_DIR` locates the private state independently from router data. `GEMROUTER_CODEX_FALLBACK_ENABLED` controls eligible quota fallbacks to Gemini, while `GEMROUTER_CODEX_ACCOUNT_FALLBACK_ENABLED` controls switching between Codex accounts. Model selection, reasoning effort, queue size, timeout, quota polling, vendored runtime selection and optional outbound Telegram alerts are covered in the [Codex guide](codex-account.md) and [runtime operations](codex-runtime-updates.md).

### Outbound proxy settings

The operator UI persists `enabled`, strategy, URLs and bypass hosts under `GEMROUTER_OUTBOUND_PROXY_PATH` (default `data/proxy-config.json`). Environment seeds are `GEMROUTER_OUTBOUND_PROXY_ENABLED`, `GEMROUTER_OUTBOUND_PROXY_STRATEGY`, `GEMROUTER_OUTBOUND_PROXY_URLS` and `GEMROUTER_OUTBOUND_PROXY_BYPASS_HOSTS`. The upstream clients currently connect directly. The saved settings take effect in the admin interface only.
