# LeakRouter

LeakRouter is a small authenticated router for Ollama-compatible inference and optional DeepSeek API fallback. It exposes OpenAI-compatible, DeepSeek-compatible, and Ollama-compatible HTTP surfaces while keeping upstream Ollama endpoint URLs private.

## What It Does

- Reads an authorized Ollama inventory from `ollama-model-inventory.json`.
- Exposes model names without exposing source server URLs.
- Routes inference in two selectable modes: `ollama` and `deepseek-api`.
- Requires a client bearer secret for inference and an admin secret/session for operations.
- Tracks per-app request usage, success/failure, latency, and token estimates.
- Provides an admin UI at `/admin` for app keys, model access, routing state, and usage.

## Requirements

- Node `23.3.0` (see `.nvmrc`)
- `pnpm` `10.26.1`

## Install

```bash
pnpm install --frozen-lockfile
cp .env.example .env
pnpm build
```

Edit `.env` and set at minimum:

```bash
LEAKROUTER_ADMIN_TOKEN=...
LEAKROUTER_DASHBOARD_ADMIN_USERS=admin:...
LEAKROUTER_BOOTSTRAP_API_KEY=...
```

For Ollama mode, keep `ollama-model-inventory.json` in the repo root. For DeepSeek API mode, set `LEAKROUTER_DEEPSEEK_API_KEY` and enable it.

## Start

```bash
pnpm start
```

Default port: `4024`.

```bash
curl -fsS http://127.0.0.1:4024/health
```

## Ollama Example

```bash
curl -sS http://127.0.0.1:4024/api/chat \
  -H "Authorization: Bearer $LEAKROUTER_BOOTSTRAP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3-coder-next:Q4_K_M",
    "messages": [{ "role": "user", "content": "Reply only with OK." }],
    "stream": false
  }'
```

## OpenAI-Compatible Example

```bash
curl -sS http://127.0.0.1:4024/v1/chat/completions \
  -H "Authorization: Bearer $LEAKROUTER_BOOTSTRAP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3-coder-next:Q4_K_M",
    "messages": [{ "role": "user", "content": "Reply only with OK." }]
  }'
```

## Docs

- [Setup](docs/setup.md)
- [Configuration](docs/configuration.md)
- [Routing](docs/routing.md)
- [Operations](docs/operations.md)
