# Gemini CLI Fallback Integration

`GemRouterFE` now routes inference through Gemini CLI first and Playwright Gemini Web second.

## Backend Order

1. `gemini-cli`
2. `playwright`

The router keeps its own bearer API keys for client access. Backend Gemini auth is separate:

- Gemini CLI uses cached Google login auth.
- Playwright uses the existing authenticated browser profile.

## Health Signals

`/health` reports:

- router up
- backend order
- fallback enabled
- Gemini CLI installed or not
- Gemini CLI auth cache detected or not
- Playwright profile ready or not
- active default backend
- last backend used and last fallback reason

## Bootstrap Flow

The repo implements the operator-assisted bootstrap path fully:

1. Run `bash ./scripts/setup-gemini-cli.sh`
2. Run `bash ./scripts/login-gemini-cli.sh`
3. Complete Google login once
4. Restart or reuse the router and confirm `/health`

If Gemini CLI auth is missing or unusable, the router falls back to Playwright when available.

## Testing

Use:

- `pnpm smoke`
- `pnpm smoke:gemini-cli`
- `pnpm smoke:playwright`

The smoke script prints the backend headers returned by the router so fallback behavior is visible during validation.
