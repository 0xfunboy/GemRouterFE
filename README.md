# GemRouter

A lightweight backend router for Gemini API traffic. It exposes OpenAI-, DeepSeek-, and
Ollama-compatible HTTP surfaces while routing requests across a pool of Gemini API keys with
automatic fallback, local quota tracking, and resilient error handling - plus direct routes
to a local Ollama for embeddings and vision.

It is designed to squeeze the maximum useful throughput out of **free-tier** Gemini accounts:
pool many accounts, always try the strongest model first, and gracefully scale down a fallback
chain that ends on very high-quota models - so most traffic is served at **zero API cost**.

## Why it pays off (economic advantages)

GemRouter makes a fleet of free Gemini accounts behave like one large, reliable,
OpenAI-compatible endpoint - without a paid plan and without external billing/monitoring services.

- **Multiplied free quota.** Daily quota is per account. Pool *N* free accounts and the usable
  daily capacity multiplies by *N*. Example with 7 accounts: `gemini-2.5-flash` ~140 req/day,
  `gemini-3.1-flash-lite` ~3,500/day, `gemma-4-31b-it`/`gemma-4-26b-a4b-it` ~9,000/day each →
  **~21,000+ text requests/day at $0**.
- **Strongest-first, graceful degradation.** Each request tries the best model first and only
  falls back down an ordered chain (flagship flash → flash-lite → gemma) when a model is
  exhausted/overloaded. You always get the best model you can serve *for free*, and you keep
  serving traffic instead of failing when the top models run out.
- **No wasted quota on transient failures.** 429s roll back the local counter so a rejected
  request doesn't burn quota; an escalating backoff (1 min → 5 min → daily) parks genuinely
  depleted model+account pairs; a model-wide 503 "high demand" is parked for 30 s instead of
  hammering every key. Net effect: fewer burnt requests, higher effective free throughput.
- **No empty/failed billable retries.** An empty completion is never returned as success - it
  is retried with a larger budget, then falls to the next model. Clients don't pay (in tokens
  or quota) for blank answers, and don't need their own retry glue.
- **Local embeddings & vision = $0 and offloaded.** `bge-m3` (embeddings) and a vision model
  run on your own Ollama box via dedicated `/v1/embeddings` and `/v1/vision` endpoints - no
  per-token embedding/vision API bill, and they run as separate flows that never touch the
  Gemini quota or queue.
- **No external cost to operate.** Quota is tracked entirely in-process (a local JSON ledger);
  there is no Cloud Monitoring, Service Usage, or `gcloud` dependency to pay for or maintain.
- **Drop-in OpenAI compatibility.** Point any OpenAI SDK at GemRouter's base URL and keep your
  code unchanged - you swap a paid endpoint for a free-tier pool with one config line.
- **Operate without redeploys.** Add/remove accounts, set priorities, reorder the routed model
  set, and mint client keys live from the admin UI - no `.env` edits, no restarts, no downtime.

## What it does

- **Multi-account routing** across many Gemini API keys (AI Studio free-tier and Tier 1), with
  capacity-aware rotation (equal-priority accounts with more headroom are preferred).
- **Local quota ledger** - RPM / TPM / RPD tracked per quota-group + model; RPD resets at
  midnight America/Los_Angeles (Google's real boundary). No Google Cloud calls.
- **Resilient fallback** - ordered model chain, strongest→weakest; escalating 429 backoff;
  503 high-demand handling; empty-completion retry/fallback; cross-backend fallback to Ollama.
- **Local Ollama integration** - dedicated `/v1/embeddings` (bge-m3) and `/v1/vision`
  (e.g. minicpm) routes, direct to a local server, with no Gemini fallback and their own
  daily counters.
- **Compatibility surfaces** - OpenAI, DeepSeek, and Ollama-compatible endpoints from one backend.
- **Operator admin UI** at `/admin` - live quota, account manager (add/remove/priority/enable,
  per-account model discovery), routed-model editor, app/key management (with custom key
  prefixes), interaction telemetry filterable by app, and an outbound-proxy manager.

## Endpoints (quick reference)

| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /v1/chat/completions`, `/chat/completions` | client key | Chat, routed across the Gemini pool |
| `POST /v1/embeddings`, `/embeddings` | client key | Embeddings via local Ollama (`bge-m3`) |
| `POST /v1/vision`, `/vision` | client key | Vision via local Ollama (separate flow, no queue) |
| `GET /health`, `GET /dashboard/summary` | none | Health and guest-safe quota/stats |
| `GET /admin`, `POST /admin/*` | admin | Operator dashboard and management APIs |

## Requirements

- Node `23.3.0` (see [`.nvmrc`](./.nvmrc))
- `pnpm` `10.26.1`

## Install

```bash
pnpm install --frozen-lockfile
cp .env.example .env
# edit .env - set at minimum GEMROUTER_ADMIN_TOKEN, GEMROUTER_BOOTSTRAP_API_KEY, GEMROUTER_GEMINI_API_KEYS
pnpm build
```

## Start

```bash
pnpm start
# or for production
./scripts/start-gemrouter.sh
```

Default port: `4024`. Health check:

```bash
curl -fsS http://127.0.0.1:4024/health
```

## Quick example

```bash
curl -sS http://127.0.0.1:4024/v1/chat/completions \
  -H "Authorization: Bearer $GEMROUTER_BOOTSTRAP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-2.5-flash",
    "messages": [{ "role": "user", "content": "Reply only with OK." }]
  }'
```

Use it from the OpenAI SDK by pointing `base_url` at `http://<host>:4024/v1`.

## Documentation

| Guide | Contents |
|---|---|
| [Setup](docs/setup.md) | Installation, configuration, first run |
| [Configuration reference](docs/configuration.md) | All environment variables |
| [Routing and quota](docs/routing.md) | Multi-key routing, fallback, cooldowns, local Ollama, endpoints |
| [Operations](docs/operations.md) | Deployment, systemd, security, live admin management, troubleshooting |

Account metadata/keys live in `data/gemini-api-accounts.json` (gitignored; see
[`docs/gemini-api-accounts.example.json`](docs/gemini-api-accounts.example.json) for the format).
