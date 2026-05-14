# Gemini API Multi-Key Routing

GemRouter keeps Gemini API routing local to the backend.

## Backend order

Example:

```env
GEMROUTER_BACKEND_ORDER=gemini-api
```

## Key pool behavior

- Multiple API keys can be configured with `GEMROUTER_GEMINI_API_KEYS` or `GEMROUTER_GEMINI_API_KEYS_JSON`.
- Each key can carry an `id`, `quotaGroup`, `priority`, `enabled` flag, and optional model allowlist.
- Local quota and cooldown state is stored under `data/`.

## Fallback behavior

When `backendPreference=auto`, GemRouter can move to the next usable API key when a request hits a fallback-eligible failure such as:

- API auth failure
- model unavailable upstream
- rate limit
- quota exhaustion
- temporary upstream timeout or transport failure

Invalid requests do not fall back. They should be fixed by the caller.

## Observability

Use:

- `/health`
- `/v1/provider/runtime`
- `/v1/provider/models`
- `/v1/provider/quota`

These endpoints expose backend order, recent selection state, key usage, cooldowns, and discovered models.
