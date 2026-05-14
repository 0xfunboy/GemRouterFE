# Gemini CLI Fallback Integration

`GemRouterFE` now routes normal direct inference through the official `gemini-api` provider first. The embedded Gemini Code Assist client remains available as `gemini-cli` for diagnostics and forced tests, while Playwright Gemini Web remains the browser fallback.

## Backend Order

1. `gemini-api`
2. `playwright`
3. `gemini-cli`

The router keeps its own bearer API keys for client access. Backend Gemini auth is separate:

- The API backend uses AI Studio / Gemini Developer API keys.
- The CLI backend uses the same cached Google login auth files that Gemini CLI uses.
- Playwright uses the existing authenticated browser profile.

## Health Signals

`/health` reports:

- router up
- backend order
- fallback enabled
- direct auth cache detected or not
- direct auth verified or not
- quota buckets or quota error state
- Playwright profile ready or not
- active default backend
- last backend used and last fallback reason

## Bootstrap Flow

The repo implements the operator-assisted bootstrap path fully:

1. Run `bash ./scripts/setup-gemini-cli.sh`
2. Run `pnpm login:gemini-cli`
3. Complete Google login once
4. Restart or reuse the router and confirm `/health`

If API keys are missing, rate-limited, or unusable, the router falls back to Playwright when available. If the CLI backend is forced and cached auth is missing, unusable, or exhausted, that path can also fall back to Playwright when enabled.

## Testing

Use:

- `pnpm smoke`
- `pnpm smoke:gemini-cli`
- `pnpm smoke:playwright`

The smoke script waits for `/health`, prints the backend headers returned by the router, and runs `admin/test-chat` when admin credentials are configured. `pnpm smoke:playwright` uses `gemini-web` as the primary inference model so the Playwright path can be validated independently from direct-model quota state.

## Runtime Endpoints

Authenticated router clients can query:

- `/v1/provider/runtime`
- `/v1/provider/models`
- `/v1/provider/quota`

These endpoints make it possible to drive model selection and quota-aware orchestration externally without scraping the dashboard.
