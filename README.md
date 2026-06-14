# LeakRouter

LeakRouter is a small authenticated router for Ollama-compatible inference. It exposes OpenAI-compatible, DeepSeek-compatible, LeakRouter, and Ollama-compatible HTTP surfaces to client machines while keeping upstream Ollama endpoint URLs private.

## What It Does

- Reads an authorized Ollama inventory from `ollama-model-inventory.json`.
- Exposes model names without exposing source server URLs.
- Routes upstream inference through Ollama inventory servers.
- Serves client requests through selectable compatibility surfaces: Ollama, OpenAI-style, DeepSeek-style, and LeakRouter root routes.
- Requires a client bearer secret for inference and an admin secret/session for operations.
- Tracks per-app request usage, success/failure, latency, and token estimates.
- Provides an admin UI at `/admin` for app keys, model access, routing state, and usage.
- Includes an admin benchmark runner for Ollama models, measuring latency and output tokens/sec without exposing source URLs.
- Supports selective outbound proxying for upstream inference calls, so internet Ollama servers see the proxy IP instead of the LeakRouter host IP.

## Intended Topology

```text
client machines
-> Cloudflare Tunnel / private access
-> LeakRouter
-> outbound proxy
-> internet Ollama upstreams
```

Cloudflare Tunnel is only for inbound traffic. It does not hide LeakRouter's outbound IP from upstream Ollama servers; `LEAKROUTER_OUTBOUND_PROXY_*` is the feature that does that.

## Requirements

- Node `23.3.0` (see `.nvmrc`)
- `pnpm` `10.26.1`

## Install

```bash
pnpm install --frozen-lockfile
cp .env.example .env
pnpm build
```

Edit `.env` and set at minimum:

```bash
LEAKROUTER_ADMIN_TOKEN=...
LEAKROUTER_DASHBOARD_ADMIN_USERS=admin:...
LEAKROUTER_BOOTSTRAP_API_KEY=...
```

For the Ollama-only deployment, keep `ollama-model-inventory.json` in the repo root. Upstream Ollama servers do not use authentication; client machines authenticate to LeakRouter with `LEAKROUTER_BOOTSTRAP_API_KEY`.

Cloud-tagged inventory models are excluded by default:

```env
LEAKROUTER_OLLAMA_EXCLUDE_CLOUD_MODELS=true
```

Outbound proxying is disabled by default. To force inference traffic through one proxy:

```env
LEAKROUTER_OUTBOUND_PROXY_ENABLED=true
LEAKROUTER_OUTBOUND_PROXY_REQUIRED=true
LEAKROUTER_OUTBOUND_PROXY_URL=http://USERNAME:PASSWORD@HOST:PORT
LEAKROUTER_OUTBOUND_PROXY_STRATEGY=single
```

Test proxy egress without a direct leak:

```bash
pnpm proxy:test
```

## Start

```bash
pnpm start
```

Default port: `4024`.

```bash
curl -fsS http://127.0.0.1:4024/health
```

## Ollama Example

```bash
curl -sS http://127.0.0.1:4024/api/chat \
  -H "Authorization: Bearer $LEAKROUTER_BOOTSTRAP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3-coder-next:Q4_K_M",
    "messages": [{ "role": "user", "content": "Reply only with OK." }],
    "stream": false
  }'
```

## OpenAI-Compatible Example

```bash
curl -sS http://127.0.0.1:4024/v1/chat/completions \
  -H "Authorization: Bearer $LEAKROUTER_BOOTSTRAP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3-coder-next:Q4_K_M",
    "messages": [{ "role": "user", "content": "Reply only with OK." }]
  }'
```

## Docs

- [Setup](docs/setup.md)
- [Configuration](docs/configuration.md)
- [Routing](docs/routing.md)
- [Operations](docs/operations.md)
