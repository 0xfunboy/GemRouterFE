# Routing

LeakRouter routes authenticated requests across two modes:

1. `ollama`
2. `deepseek-api`

The default order is:

```env
LEAKROUTER_BACKEND_ORDER=ollama,deepseek-api
```

If the first backend returns a fallback-eligible error, the router tries the next backend when the requested model can be satisfied there.

## Ollama Mode

Ollama mode reads `ollama-model-inventory.json`, builds a private `model -> endpoint` map, and routes requests to an endpoint that has the requested model.

Public responses expose:

- model name
- family/parameter metadata when available
- aggregate endpoint count

Public responses do not expose:

- upstream URL
- upstream host
- source inventory row

## DeepSeek API Mode

DeepSeek API mode uses an OpenAI-compatible `/chat/completions` API:

```env
LEAKROUTER_DEEPSEEK_BASE_URL=https://api.deepseek.com/v1
LEAKROUTER_DEEPSEEK_API_KEY=...
```

## Auth

Every inference route requires a client secret:

```bash
Authorization: Bearer $LEAKROUTER_BOOTSTRAP_API_KEY
```

Admin routes require an admin session or admin token.

## Model Access

Per-app model allowlists are stored in `data/apps.json` and managed from `/admin`.

If `LEAKROUTER_BOOTSTRAP_ALLOWED_MODELS` is empty, the bootstrap app starts with all configured models.
