# GemRouter

A lightweight backend router for Gemini API traffic. It exposes OpenAI-compatible, DeepSeek-compatible, and Ollama-compatible HTTP surfaces while routing requests across a pool of Gemini API keys with automatic fallback and local quota tracking.

## What it does

- Routes requests across multiple Gemini API keys (AI Studio free-tier and Tier 1).
- Tracks RPM / TPM / RPD quotas per key and model locally; falls back to the next available key on exhaustion or rate limiting.
- Supports per-account quota tiers via `data/gemini-api-accounts.json`.
- Exposes an operator admin UI at `/admin` for live quota inspection and key management.
- Serves OpenAI, DeepSeek, and Ollama compatibility surfaces from the same backend.

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

## Documentation

| Guide | Contents |
|---|---|
| [Setup](docs/setup.md) | Installation, configuration, first run |
| [Configuration reference](docs/configuration.md) | All environment variables |
| [Routing and quota](docs/routing.md) | Multi-key routing, quota scoring, API surfaces |
| [Operations](docs/operations.md) | Deployment, systemd, security, troubleshooting |

Account metadata lives in [`data/gemini-api-accounts.json`](data/gemini-api-accounts.json) (see [`docs/gemini-api-accounts.example.json`](docs/gemini-api-accounts.example.json) for the format).
