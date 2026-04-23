# GemRouterFE

OpenAI-compatible router for Gemini Web, backed by Playwright and a persistent Chrome profile.

The local repo lives at `/home/funboy/bairbi-stack/GemRouterFE`.
The project study lives outside the repo at `/home/funboy/bairbi-stack/PROJECT_STUDY.md`.

## What it does

- exposes `GET /v1/models`
- exposes `POST /v1/chat/completions`
- exposes `POST /v1/responses`
- accepts `Authorization: Bearer <api-key>`
- reuses the copied Playwright profile already authenticated against Gemini
- provisions per-app API keys with origin/model policies

## Stack

- Node.js + TypeScript
- Fastify
- Playwright
- `pnpm`
- `turbo`

## Install

```bash
source ~/.nvm/nvm.sh
pnpm install
```

## Start commands

The repo uses `pnpm` commands throughout. `turbo` is used for pipeline-style tasks such as build, type-check, and smoke runs. Runtime commands are direct on purpose, because Playwright display/headless overrides are more reliable that way.

### Build

```bash
pnpm build
```

### Development

```bash
pnpm dev
```

### Headless server mode

```bash
pnpm start:xvfb
```

This starts headed Chrome inside a virtual X display.

### Existing VNC / noVNC desktop mode

```bash
pnpm start:vnc
```

This matches the `copilotrm` pattern more closely:

- `DISPLAY` defaults to `:99`
- `PLAYWRIGHT_HEADLESS=false`
- Chrome stays headed and visible inside the running VNC desktop

These commands were verified to set the runtime mode correctly:

- `start:vnc` exposed `display=:99` and `headless=false`
- `start:xvfb` exposed `display=:100` and `headless=false`

Actual Gemini prompt execution still depends on the current copied browser profile being authenticated. In the latest local verification, the runtime mode was correct, but Gemini login readiness was not reliable in both headed variants.

If your VNC desktop is on a different display:

```bash
DISPLAY=:100 pnpm start:vnc
```

### Quick smoke test

```bash
pnpm smoke
```

## Environment

Use `.env.example` as reference.

Main variables:

- `GEMROUTER_ROOT_DIR`
- `GEMROUTER_DATA_DIR`
- `GEMROUTER_ADMIN_TOKEN`
- `GEMROUTER_BOOTSTRAP_API_KEY`
- `PLAYWRIGHT_BASE_PROFILE_DIR`
- `PLAYWRIGHT_PROFILE_NAMESPACE`
- `PLAYWRIGHT_HEADLESS`
- `PLAYWRIGHT_EXECUTABLE_PATH`
- `TEGEM_IMPORT_PROFILE_FROM`

Legacy `BARIBI_*` env names are still accepted as fallback for compatibility.

## Playwright profile

The persistent Gemini profile is stored locally in:

- `/home/funboy/bairbi-stack/GemRouterFE/.playwright/profiles`

It is intentionally ignored by git.

## API examples

### Health

```bash
curl http://127.0.0.1:4024/health
```

### Models

```bash
curl http://127.0.0.1:4024/v1/models \
  -H "Authorization: Bearer $GEMROUTER_BOOTSTRAP_API_KEY"
```

### Chat Completions

```bash
curl http://127.0.0.1:4024/v1/chat/completions \
  -H "Authorization: Bearer $GEMROUTER_BOOTSTRAP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-web",
    "messages": [
      { "role": "user", "content": "Reply only with OK." }
    ]
  }'
```

### Streaming

```bash
curl -N http://127.0.0.1:4024/v1/chat/completions \
  -H "Authorization: Bearer $GEMROUTER_BOOTSTRAP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-web",
    "stream": true,
    "stream_options": { "include_usage": true },
    "messages": [
      { "role": "user", "content": "Write only ABC." }
    ]
  }'
```

### Responses API

```bash
curl http://127.0.0.1:4024/v1/responses \
  -H "Authorization: Bearer $GEMROUTER_BOOTSTRAP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-web",
    "input": [
      {
        "role": "user",
        "content": [
          { "type": "input_text", "text": "Reply only with PONG." }
        ]
      }
    ]
  }'
```

## Session control

By default the router resets the Gemini conversation on every request. That keeps it compatible with OpenAI-style clients that always send the full message history.

If you want to keep a stateful Gemini session, use:

- `x-gemrouter-session`
- or `x-gemrouter-user`
- or `x-gemrouter-stateful: true`

Legacy `x-baribi-*` headers are still accepted.

## Admin endpoints

List apps:

```bash
curl http://127.0.0.1:4024/admin/apps \
  -H "Authorization: Bearer $GEMROUTER_ADMIN_TOKEN"
```

Create app:

```bash
curl http://127.0.0.1:4024/admin/apps \
  -H "Authorization: Bearer $GEMROUTER_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "my-frontend",
    "allowedOrigins": ["http://localhost:3000"],
    "allowedModels": ["gemini-web"],
    "sessionNamespace": "my-frontend",
    "rateLimitPerMinute": 60,
    "maxConcurrency": 3
  }'
```

## Notes

- `gemini-web` and `google/gemini-web` are aliases for the same backend
- tool calling is not implemented yet
- structured JSON output is best-effort, not strict schema execution
- runtime audit and app metadata are stored in `data/`

## Key files

- study path: `/home/funboy/bairbi-stack/PROJECT_STUDY.md`
- server: [src/index.ts](src/index.ts)
- OpenAI compatibility layer: [src/lib/openai.ts](src/lib/openai.ts)
- app/API key store: [src/store/appStore.ts](src/store/appStore.ts)
