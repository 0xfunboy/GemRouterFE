# Gemini CLI Fallback Integration

`GemRouterFE` now routes inference through an embedded Gemini Code Assist client first and Playwright Gemini Web second.

## Backend Order

1. `gemini-cli`
2. `playwright`

The router keeps its own bearer API keys for client access. Backend Gemini auth is separate:

- The direct backend uses the same cached Google login auth files that Gemini CLI uses.
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

If cached auth is missing, unusable, or the direct quota is exhausted, the router falls back to Playwright when available.

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
