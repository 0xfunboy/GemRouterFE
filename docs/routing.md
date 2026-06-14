# Routing

LeakRouter routes authenticated requests to the Ollama upstream inventory:

1. `ollama`

The default order is:

```env
LEAKROUTER_BACKEND_ORDER=ollama
```

If the requested Ollama endpoint fails, the router tries another endpoint for the same model, then smaller or lower-priority Ollama models when needed.

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

Set `LEAKROUTER_OLLAMA_EXCLUDE_CLOUD_MODELS=true` to remove `:cloud` and `-cloud` models from routing, `/api/tags`, admin model pickers, and benchmarks.

## Fallback Order

For Ollama mode, LeakRouter tries:

1. the requested model on the preferred endpoint
2. the same model on slower/alternate endpoints
3. smaller or less powerful models, preferring the same family when possible

The admin benchmark records local response latency and output tokens per second. These runtime results are combined with a static family-priority catalog informed by public benchmark sources.

## Outbound Privacy

Inbound exposure and outbound privacy are separate:

```text
client machines
-> Cloudflare Tunnel / private access
-> LeakRouter
-> outbound proxy
-> internet Ollama upstreams
```

Cloudflare Tunnel only protects inbound access to LeakRouter. Upstream Ollama servers would still see the LeakRouter host IP unless outbound proxying is enabled. Set `LEAKROUTER_OUTBOUND_PROXY_ENABLED=true` and keep `LEAKROUTER_OUTBOUND_PROXY_REQUIRED=true` in production to fail closed if the proxy is unavailable.

## Client Compatibility

Client machines can call LeakRouter through Ollama-compatible, OpenAI-compatible, DeepSeek-style, or root LeakRouter routes. All of those routes require the client bearer secret and resolve to the configured Ollama upstream inventory.

## Auth

Every inference route requires a client secret:

```bash
Authorization: Bearer $LEAKROUTER_BOOTSTRAP_API_KEY
```

Admin routes require an admin session or admin token.

## Model Access

Per-app model allowlists are stored in `data/apps.json` and managed from `/admin`.

If `LEAKROUTER_BOOTSTRAP_ALLOWED_MODELS` is empty, the bootstrap app starts with all configured models.
