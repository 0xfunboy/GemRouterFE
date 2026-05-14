# Gemini API Multi-Key Routing

`GemRouterFE` supports three Gemini upstream paths:

- `gemini-api`: official Gemini Developer API through AI Studio API keys.
- `playwright`: Gemini Web through the existing browser profile, also exposed as `gemini-web`.
- `gemini-cli`: embedded Code Assist / Google login path, kept for diagnostics and forced tests.

The default production order is:

```text
gemini-api,playwright,gemini-cli
```

## API Key Config

Simple mode uses one independent quota group per key:

```env
GEMROUTER_GEMINI_API_ENABLED=true
GEMROUTER_GEMINI_API_KEYS=AIza1...,AIza2...,AIza3...
GEMROUTER_GEMINI_API_DEFAULT_TIER=tier1
GEMROUTER_GEMINI_API_DEFAULT_QUOTA_GROUP_MODE=per-key
```

Advanced mode allows labels, priorities, project metadata, model allowlists, and shared quota groups:

```env
GEMROUTER_GEMINI_API_KEYS_JSON='[
  {
    "id": "main-account",
    "key": "AIza...",
    "owner": "main",
    "projectId": "project-a",
    "quotaGroup": "project-a",
    "priority": 100,
    "enabled": true,
    "models": ["gemini-2.5-flash-lite", "gemini-2.5-flash", "gemini-2.5-pro"]
  }
]'
```

If multiple keys belong to the same Google project, put them in the same `quotaGroup`. Multiple keys from the same quota pool do not multiply Google-side quota.

## Quota Ledger

The router tracks local estimated usage in `data/gemini-api-quota-ledger.json`.

It tracks:

- RPM: requests per minute
- TPM: tokens per minute
- RPD: requests per day

Quota exposed by the router is marked with:

```json
{
  "source": "local-ledger",
  "authoritative": false
}
```

This is intentionally not presented as exact Google-side usage. Google does not expose a stable public API endpoint equivalent to the AI Studio rate-limit page for key quota state.

## Model Discovery

The provider discovers official models through:

```text
GET https://generativelanguage.googleapis.com/v1beta/models?key=<API_KEY>
```

Discovery results are cached in `data/gemini-api-models-cache.json` and exposed in:

- `GET /health`
- `GET /v1/provider/runtime`
- `GET /v1/provider/models`

Admin refresh endpoint:

```text
POST /admin/provider/gemini-api/discover-models
```

## Backend Override

Clients can force a backend with:

```text
x-gemrouter-backend: gemini-api
x-gemrouter-backend: playwright
x-gemrouter-backend: gemini-cli
```

`gemini-web` and `google/gemini-web` always route to Playwright.

## Fallback

In `auto` mode, API-native Gemini model IDs try `gemini-api` first and fall back to Playwright when the Gemini API path is unavailable, rate limited, or has an auth/config failure. Invalid requests generally do not fall back because they should be fixed by the caller.

`gemini-cli` stays out of the hot path unless it is explicitly configured in `GEMROUTER_BACKEND_ORDER` or forced with the header.

## Security

Full API keys are never returned by health, admin, or provider endpoints. Only short previews like `AIza...abcd` are exposed.

Gemini API keys can create billable usage. Use Google AI Studio / Google Cloud billing controls, project budgets, and per-project quota settings.

## Validation

```bash
pnpm check
pnpm build
SMOKE_BACKEND=gemini-api API_BASE=http://127.0.0.1:4000 bash ./scripts/smoke.sh
SMOKE_BACKEND=playwright API_BASE=http://127.0.0.1:4000 bash ./scripts/smoke.sh
```

If no API keys are configured, the Gemini API smoke exits cleanly with a clear skip message.

