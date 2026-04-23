# GemRouterFE

GemRouterFE is an OpenAI-compatible router on top of Gemini Web, using Playwright and a persistent Chrome profile instead of the official Google API.

Repo path: `/home/funboy/bairbi-stack/GemRouterFE`  
Project study path: `/home/funboy/bairbi-stack/PROJECT_STUDY.md`

## Public endpoints

- UI and admin deck: `https://solclawn.com`
- API alias: `https://api.solclawn.com`
- noVNC login surface: `https://vnc.solclawn.com`

The UI is served by the same Fastify process as the API. Browser requests to `/` return the admin/test interface, while API clients can keep using `/v1/*`.

## Features

- OpenAI-style `GET /v1/models`
- OpenAI-style `POST /v1/chat/completions`
- OpenAI-style `POST /v1/responses`
- SSE streaming for `chat/completions` and `responses`
- per-app API keys with model/origin/rate/concurrency controls
- admin login with dashboard
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
- `solclawn-tunnel.service`

Unit files are versioned in [ops/systemd](ops/systemd).

Useful commands:

```bash
systemctl --user status gemrouterfe.service
systemctl --user status solclawn-tunnel.service
journalctl --user -u gemrouterfe.service -n 100 --no-pager
journalctl --user -u solclawn-tunnel.service -n 100 --no-pager
```

The hosted service runs on local port `4000`, in headed mode, and is exposed through the `solclawn` Cloudflare tunnel.

## Admin UI

Open `https://solclawn.com` and log in with `GEMROUTER_ADMIN_TOKEN`.

The dashboard provides:

- app creation and update without `curl`
- key rotation and revocation
- runtime status for Playwright/profile/display
- prompt testing through `/admin/test-chat`
- recent interactions, token usage, latency, and manual good/bad labels
- embedded link/iframe to `vnc.solclawn.com`

If Gemini is signed out, log in through the VNC page first, then return to the prompt lab.

## Environment

Use `.env.example` as reference.

Important variables:

- `GEMROUTER_ADMIN_TOKEN`
- `GEMROUTER_BOOTSTRAP_API_KEY`
- `GEMROUTER_ADMIN_SESSION_TTL_MS`
- `GEMROUTER_PUBLIC_BASE_URL`
- `GEMROUTER_VNC_PUBLIC_URL`
- `PLAYWRIGHT_BASE_PROFILE_DIR`
- `PLAYWRIGHT_PROFILE_NAMESPACE`
- `PLAYWRIGHT_EXECUTABLE_PATH`
- `TEGEM_IMPORT_PROFILE_FROM`

Legacy `BARIBI_*` and `BAIRBI_*` names are still accepted as fallbacks.

## API examples

Hosted health:

```bash
curl https://solclawn.com/health
curl https://api.solclawn.com/health
```

Hosted models:

```bash
curl https://api.solclawn.com/v1/models \
  -H "Authorization: Bearer $GEMROUTER_BOOTSTRAP_API_KEY"
```

Hosted chat:

```bash
curl https://api.solclawn.com/v1/chat/completions \
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
curl -N https://api.solclawn.com/v1/chat/completions \
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

Responses API:

```bash
curl https://api.solclawn.com/v1/responses \
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

By default, the router resets the Gemini conversation on every request. For sticky browser sessions, send:

- `x-gemrouter-session`
- `x-gemrouter-user`
- `x-gemrouter-stateful: true`

Legacy `x-baribi-*` headers are still supported.

## Notes

- `gemini-web` and `google/gemini-web` are aliases for the same backend
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
