# Troubleshooting

## `/health` shows no usable Gemini API backend

Check:

- `GEMROUTER_GEMINI_API_ENABLED`
- `GEMROUTER_GEMINI_API_KEYS`
- `GEMROUTER_GEMINI_API_KEYS_JSON`

## Requests fail after key exhaustion

Check the Gemini API quota state in:

- `/health`
- `/v1/provider/quota`

Look for cooldowns, rate limits, disabled keys, or auth failures.

## Startup fails immediately

The usual causes are missing required values:

- `GEMROUTER_ADMIN_TOKEN`
- `GEMROUTER_BOOTSTRAP_API_KEY`

## The admin UI loads but data looks stale

Refresh `/health` and `/admin/summary` after sending a live request. Some backend state only updates after real traffic or explicit model discovery/quota refresh actions.
