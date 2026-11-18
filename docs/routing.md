# Model routing and quota

Use this guide to choose a model policy, understand which provider handled a request, and interpret remaining capacity. The [API reference](api.md) covers request formats and the [configuration guide](configuration.md) lists environment variables.

## How a text request is resolved

1. GemRouter authenticates the app and derives the allowed models from its access policy. A GPT request additionally requires the app’s Codex grant. An explicit Decision model on a chat route returns HTTP 400 with the native Decisions endpoint.
2. Chat and Responses requests that omit `model` start with `gemini-4-hydrogen`. An allowed, configured model ID starts with that model. For an unsupported or unauthorized ordinary text model, the resolver selects the first entry in the configured fallback list that the app may use. An app with no eligible text model receives HTTP 403.
3. Gemini normally tries the exact model first. It ranks alternatives by relative capability, family and model characteristics, using the configured order to break ties. With the default catalog and access to both models, Hydrogen falls back first to `gemini-3.8-flash`. The admin model editor persists the ordered text list to `data/model-config.json`. Models named in `GEMROUTER_GEMINI_API_STRICT_MODELS` are constrained to the requested model on the Gemini path and suppress cross-provider fallback in automatic routing.
4. Check the returned model and, when present, `x-gemrouter-backend`, `x-gemrouter-backend-model`, `x-gemrouter-fallback-from` and `x-gemrouter-fallback-reason`. A Google alias can return a different upstream model version. Buffered streaming and failure after stream headers have been sent can limit the metadata available to a client.

| Request | Automatic provider selection |
|---|---|
| Gemini or Gemma text | Gemini API first. Hydrogen gets the Gemini downgrade chain before a permitted sequential NVIDIA fallback. For other eligible text models, an authorized NVIDIA candidate can race a slow Gemini request after `GEMROUTER_NVIDIA_RACE_HEDGE_DELAY_MS` (default 8 seconds). |
| Configured NVIDIA model or tier alias | NVIDIA first. An eligible failure can use the configured Gemini fallback when permitted. The admin catalog controls the available NVIDIA models and aliases. |
| GPT text | Codex checks the app grant, exact model and thinking level. A depleted quota can trigger account fallback and then an authorized Gemini fallback, according to the separate app settings. |
| Ollama catalog model | The configured Ollama router takes precedence for ordinary Ollama names. The separate local Ollama embeddings and vision endpoints use their own client. |
| `gemini-decision-1` | `POST /v1beta/decisions` evaluates typed questions. Eligible account retries stay within Decision 1. The result includes answers and Google-reported usage when available. |

For a provider pin, send `x-gemrouter-backend` with `gemini-api`, `nvidia` or `codex`. The default is `auto`. A provider pin disables switching to another provider. The Gemini client can still try other authorized Gemini models unless the requested model is strict. [Router](../src/llm/router.ts) · [Gemini model selection](../src/llm/providers/gemini-api/client.ts) · [Codex policy](codex-account.md)

## Accounts and project limits

Google applies limits per project. Give every key for the same project the same `quotaGroup`. The local counters combine all eligible keys in that group for each model. Keys used elsewhere can consume capacity outside GemRouter’s counters. The project’s billing tier and effective limits are available in AI Studio. [Google rate limits](https://aistudio.google.com/docs/rate-limits)

GemRouter loads credentials in this order:

1. A nonempty `GEMROUTER_GEMINI_API_KEYS_JSON` array.
2. Entries carrying a `key` in account metadata. In this mode only the entries with keys are loaded. The `GEMROUTER_GEMINI_API_ACCOUNTS_JSON` array overrides metadata from `GEMROUTER_GEMINI_API_ACCOUNTS_PATH`.
3. The comma-separated `GEMROUTER_GEMINI_API_KEYS` list. Metadata and keys are paired by **array position**.

Use stable IDs and an explicit accounts path when managing accounts in the dashboard. An empty or omitted account `models` list permits all otherwise eligible models. The per-account Google catalog and recorded access denials narrow that set. Listing a model alone does not establish available inference quota. [Example account metadata](gemini-api-accounts.example.json) · [Census and verification](gemini-account-census.md)

The `tier` field is metadata. A built-in limit can be overridden per model by `GEMROUTER_GEMINI_API_LIMITS_PATH`, then by `GEMROUTER_GEMINI_API_LIMITS_JSON`. Group-specific limits take precedence. For a deployment that edits accounts through the dashboard, `GEMROUTER_GEMINI_API_GROUP_LIMITS_JSON` preserves project overrides across account edits. The current account writer serializes resolved keys and omits file-based per-account `limits`.

| Model | Built-in requests/min | Input tokens/min | Requests/day |
|---|---:|---:|---:|
| `gemini-4-hydrogen` | 5 | 250,000 | 20 |
| `gemini-decision-1` | 200 | 50,000 | 10,000 |

These are local admission settings. An operator can adjust them to the project’s actual quota. [Built-in limits](../src/llm/providers/gemini-api/rateLimits.ts)

## What happens under load

The key pool filters disabled keys, unavailable models and exhausted groups. Higher account priority wins. For equal priorities, remaining RPM, TPM and RPD capacity, recent errors, least recent use and configuration order determine the next key. A normal Gemini text call has a shared budget of up to six upstream attempts. One model can use up to three keys, subject to a tighter limit on some fallback candidates. Short local waits, inference attempts and retries share the request deadline.

| Signal | Scheduler behavior |
|---|---|
| Local minute quota exhausted | The scheduler checks other eligible keys or models. It can wait briefly for a minute-window slot when the deadline allows. |
| 429 with a short-window `Retry-After` | The group/model cools down for the reported interval, with a 60-second minimum. |
| Explicit daily 429 | At or above 50% of the local daily allowance, or when the local allowance is unknown, the group/model waits for Pacific midnight. With lower recorded usage the cooldown lasts 30 minutes. |
| Generic 429 | Successive cooldowns are 1, 5, 10 and 15 minutes. A quiet interval of 10 minutes or the Pacific day change resets the escalation. |
| Google reports high demand | The affected group/model receives a short cooldown. The current request moves to the next eligible model without trying every key against the overloaded model. |
| Empty completion | Text generation may retry with a larger output budget. These attempts share the same request budget and can consume upstream quota. |
| Proven model denial | A structured model-not-found response or an explicit supported zero-quota denial quarantines that account/model pair. A later successful targeted probe can restore it. |

The ledger reserves one request and estimated input tokens before dispatch. Google-reported prompt tokens replace the TPM estimate on success. Aborted requests that reached dispatch can still count. `GEMROUTER_GEMINI_API_COUNT_FAILED_429_AS_USAGE` controls whether a failed 429 keeps its reservations (default `false`). Daily reservations reset at midnight in `America/Los_Angeles`. [Key selection](../src/llm/providers/gemini-api/keyPool.ts) · [Quota ledger](../src/llm/providers/gemini-api/quotaLedger.ts)

## Reading the dashboard

The guest summary at `/dashboard/summary` shows local quota groups and retained interaction totals. Count each group **once per model** when aggregating eligible RPD. For client-scoped catalog entries use `/v1/models` with the app’s key. The administrative account viewer and targeted probes help distinguish discovery, inference entitlement and temporary exhaustion.

Three measurements answer different questions:

- **Gemini TPM** measures input tokens admitted per group/model in the rolling minute.
- **Interaction token volume** aggregates the usage recorded for individual requests. Ordinary non-Codex chat and Responses currently estimate usage from text. Decision uses the counts returned by Google. Codex uses measured per-turn usage when available.
- **Codex quota windows** show service-reported percentages and reset times independently of request token totals.

See [HTTP endpoints](api.md), [operations](operations.md) and the [Codex runtime guide](codex-runtime-updates.md).
