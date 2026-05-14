# GemRouter

GemRouter is a lightweight Gemini routing backend. It exposes GemRouter-native, OpenAI-compatible, DeepSeek-compatible, and Ollama-compatible HTTP surfaces while routing requests across configured Gemini API keys.

This repo is the backend-only fork of the previous browser-automation codebase. The legacy browser runtime, remote desktop tooling, and web-scraping paths have been removed.

## What It Does

- Routes requests across multiple Gemini API keys.
- Falls back across configured backends in `GEMROUTER_BACKEND_ORDER`.
- Tracks local quota and cooldown state for Gemini API keys.
- Exposes operator APIs and a small admin UI for runtime inspection.
- Preserves chat, responses, and image-generation surfaces where supported by the Gemini model.

## What It No Longer Does

- No browser automation.
- No browser runtime.
- No Gemini Web scraping.
- No remote desktop tooling.
- No display-service dependencies.

## Requirements

- Node `23.3.0`
- `pnpm` `10.26.1`

The repo already targets Node `23.3.0` in [`.nvmrc`](./.nvmrc).

## Install

```bash
pnpm install --frozen-lockfile
cp .env.example .env
pnpm check
pnpm build
```

Fill the required values in `.env` before starting:

- `GEMROUTER_ADMIN_TOKEN`
- `GEMROUTER_BOOTSTRAP_API_KEY`
- `GEMROUTER_GEMINI_API_KEYS` or `GEMROUTER_GEMINI_API_KEYS_JSON`
- `GEMROUTER_DIRECT_MODELS`

Recommended `GEMROUTER_DIRECT_MODELS` for the current HTTP router:

- `gemini-3.1-pro-preview`
- `gemini-3.1-flash-lite`
- `gemini-3-flash-preview`
- `gemini-2.5-pro`
- `gemini-2.5-flash-lite`
- `gemini-2.5-flash-image`
- `gemini-3-pro-image-preview`
- `gemini-3.1-flash-image-preview`
- `nano-banana-pro-preview`

Chat and image-generation models are exposed by `/v1/models` and `/models`.
Live audio, embeddings, and video generation models still need dedicated APIs and are not exposed by default.

## Start

```bash
pnpm start
```

The service start helper for deployment is:

```bash
./scripts/start-gemrouter.sh
```

## Health Check

```bash
curl -fsS http://127.0.0.1:4024/health
```

## OpenAI-Compatible Example

```bash
curl -sS http://127.0.0.1:4024/v1/chat/completions \
  -H "Authorization: Bearer $GEMROUTER_BOOTSTRAP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-2.5-flash-lite",
    "messages": [
      { "role": "user", "content": "Reply only with OK." }
    ]
  }'
```

## OpenAI-Compatible Images Example

```bash
curl -sS http://127.0.0.1:4024/v1/images/generations \
  -H "Authorization: Bearer $GEMROUTER_BOOTSTRAP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-2.5-flash-image",
    "prompt": "Create a minimal black circle centered on a white background.",
    "response_format": "b64_json"
  }'
```

## Notes

- Default port is `4024`.
- Default backend order is `gemini-api`.
- Default primary compatibility surface is `gemrouter`.
- The admin UI is served at `/` and `/admin`.
- Systemd unit templates live in `ops/systemd/`.
- `ops/systemd/install-gemrouter-services.sh` installs the system units when root access is available.
- Nightly restarts are handled by `ops/systemd/gemrouter-nightly-restart.timer` at `03:30`.
- The Cloudflare tunnel template lives in `ops/cloudflared/gemrouter.yml`.

## Docs

- [Documentation Index](./docs/README.md)
