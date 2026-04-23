# GemRouterFE

GemRouterFE is a Gemini Web router that exposes OpenAI-, DeepSeek-, and Ollama-compatible surfaces on top of the same Playwright-managed browser session.

Repo path: `/bairbi-stack/GemRouterFE`  
Project study path: `/bairbi-stack/PROJECT_STUDY.md`

## Public endpoints

- UI and admin deck: `
- API alias: ``
- noVNC login surface: ``

The UI is served by the same Fastify process as the API. Browser requests to `/` return the admin/test interface, while API clients can keep using `/v1/*` and the additional compatibility aliases.

## Features

- OpenAI-style `GET /v1/models`
- OpenAI-style `POST /v1/chat/completions`
- OpenAI-style `POST /v1/responses`
- DeepSeek-style `GET /models`
- DeepSeek-style `POST /chat/completions`
- Ollama-style `GET /api/version`, `GET /api/tags`, `POST /api/show`
- Ollama-style `POST /api/chat`
- Ollama-style `POST /api/generate`
- SSE streaming for `chat/completions` and `responses`
- NDJSON streaming for Ollama `chat` and `generate`
- per-app API keys with model/origin/rate/concurrency controls
- admin login with dashboard
- dashboard control for enabled compatibility surfaces and primary surface
- prompt lab routed through the live Playwright Gemini session
- interaction log with token counts and good/bad feedback labels
- headed Playwright mode on `DISPLAY=:99`
- noVNC surface for manual Gemini re-login

## Stack

- Node.js + TypeScript
- Fastify
- Playwright
- `pnpm`
- `turbo`
- `systemd --user`
- Cloudflare Tunnel

## Local commands

```bash
source ~/.nvm/nvm.sh
pnpm install
pnpm check
pnpm build
pnpm dev
pnpm smoke
```

`pnpm smoke` now auto-detects the active local API base, validates `/health`, the OpenAI surface, the DeepSeek aliases, the Ollama aliases, and also exercises `/admin/login` plus `/admin/summary` when `GEMROUTER_ADMIN_TOKEN` is available.

Headed runtime commands:

```bash
pnpm start:vnc
pnpm start:xvfb
```

`copilotrm` alignment that is actually verified:

- `start:vnc` uses `DISPLAY=:99` and `PLAYWRIGHT_HEADLESS=false`
- `start:xvfb` uses a private Xvfb display and `PLAYWRIGHT_HEADLESS=false`
- the runtime wiring is correct in both modes
- actual Gemini generation still depends on the copied Chrome profile being logged in

## Hosted runtime

Persistent services are managed with user systemd units:

- `gemrouterfe.service`
- `tunnel.service`

Unit files are versioned in [ops/systemd](ops/systemd).

Useful commands:

```bash
systemctl --user status gemrouterfe.service
systemctl --user status tunnel.service
journalctl --user -u gemrouterfe.service -n 100 --no-pager
journalctl --user -u tunnel.service -n 100 --no-pager
```

The hosted service runs on local port `4000`, in headed mode, and is exposed through the Cloudflare tunnel.

The checked-in `.env` still uses `PORT=4024` for ad-hoc local runs. The systemd unit overrides that to `PORT=4000`, so smoke and operational checks should target the live port rather than assuming the `.env` value.

## Admin UI

Open `https://example.com` and log in with `GEMROUTER_ADMIN_TOKEN`.

The dashboard provides:

- app creation and update without `curl`
- key rotation and revocation
- compatibility surface toggles for `openai`, `deepseek`, and `ollama`
- runtime status for Playwright/profile/display
- live LLM diagnostics including prompt packing style, context/session state, and last launch timestamps
- prompt testing through `/admin/test-chat`
- recent interactions, token usage, latency, and manual good/bad labels
- embedded link/iframe to `vnc.example.com`

If Gemini is signed out, log in through the VNC page first, then return to the prompt lab.

## Environment

Use `.env.example` as reference.

Important variables:

- `GEMROUTER_ADMIN_TOKEN`
- `GEMROUTER_BOOTSTRAP_API_KEY`
- `GEMROUTER_ADMIN_SESSION_TTL_MS`
- `GEMROUTER_PUBLIC_BASE_URL`
- `GEMROUTER_VNC_PUBLIC_URL`
- `GEMROUTER_COMPAT_DEFAULT_SURFACE`
- `GEMROUTER_COMPAT_ENABLED_SURFACES`
- `TEGEM_PROMPT_PACKING_STYLE`
- `PLAYWRIGHT_BASE_PROFILE_DIR`
- `PLAYWRIGHT_PROFILE_NAMESPACE`
- `PLAYWRIGHT_EXECUTABLE_PATH`
- `TEGEM_IMPORT_PROFILE_FROM`

Legacy `BARIBI_*` and `BAIRBI_*` names are still accepted as fallbacks.

`TEGEM_PROMPT_PACKING_STYLE=minimal` is the repo default. The currently deployed local service is configured with `TEGEM_PROMPT_PACKING_STYLE=copilotrm`, which is also reflected in `/health` and `/admin/summary`.

## API examples

Hosted health:

```bash
curl https://example.com/health
curl https://api.example.com/health
```

Hosted models:

```bash
curl https://api.example.com/v1/models \
  -H "Authorization: Bearer $GEMROUTER_BOOTSTRAP_API_KEY"
```

Hosted chat:

```bash
curl https://api.example.com/v1/chat/completions \
  -H "Authorization: Bearer $GEMROUTER_BOOTSTRAP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-web",
    "messages": [
      { "role": "user", "content": "Reply only with OK." }
    ]
  }'
```

Hosted streaming:

```bash
curl -N https://api.example.com/v1/chat/completions \
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

Hosted DeepSeek-compatible chat:

```bash
curl https://api.solclawn.com/chat/completions \
  -H "Authorization: Bearer $GEMROUTER_BOOTSTRAP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-web",
    "messages": [
      { "role": "user", "content": "Reply only with DEEPSEEK-OK." }
    ]
  }'
```

Responses API:

```bash
curl https://api.example.com/v1/responses \
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

Hosted Ollama-compatible tags:

```bash
curl https://api.solclawn.com/api/tags \
  -u "$GEMROUTER_BOOTSTRAP_API_KEY:"
```

Hosted Ollama-compatible generate:

```bash
curl https://api.solclawn.com/api/generate \
  -u "$GEMROUTER_BOOTSTRAP_API_KEY:" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-web",
    "stream": false,
    "prompt": "Reply only with OLLAMA-GENERATE-OK."
  }'
```

## Session control

By default, the router resets the Gemini conversation on every request. For sticky browser sessions, send:

- `x-gemrouter-session`
- `x-gemrouter-user`
- `x-gemrouter-stateful: true`

Legacy `x-baribi-*` headers are still supported.

## Notes

- `gemini-web` and `google/gemini-web` are aliases for the same backend
- `openai`, `deepseek`, and `ollama` surfaces are enabled by env defaults and can be changed from the admin dashboard
- for Eliza `modelProvider=ollama`, set `OLLAMA_SERVER_URL` to the server root, not `/api`, because the provider appends `/api` itself
- if an Ollama client cannot send bearer headers, Basic auth works with URLs like `https://<API_KEY>@api.solclawn.com`
- tool calling is not implemented
- JSON mode is best-effort, not strict schema execution
- runtime data is stored under `data/`
- the Playwright profile directory is intentionally gitignored

## Key files

- server: [src/index.ts](src/index.ts)
- UI shell: [src/ui.ts](src/ui.ts)
- OpenAI compatibility: [src/lib/openai.ts](src/lib/openai.ts)
- app store: [src/store/appStore.ts](src/store/appStore.ts)
- interaction store: [src/store/interactions.ts](src/store/interactions.ts)
- systemd units: [ops/systemd](ops/systemd)
