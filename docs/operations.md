# Operations

## Runtime Files

| Path | Purpose |
|---|---|
| `.env` | Local secrets and runtime config |
| `data/apps.json` | Client app keys and model policy |
| `data/interactions.json` | Request history and usage summaries |
| `data/audit.log` | Admin and API audit trail |
| `ollama-model-inventory.json` | Private Ollama inventory |

Do not commit `.env`, `data/`, `authorized_ollama_urls.txt`, or inventory output files.

## Refresh Ollama Inventory

```bash
pnpm inventory:ollama --input authorized_ollama_urls.txt
```

Then restart the service so the in-memory model map reloads.

## Health

```bash
curl -fsS http://127.0.0.1:4024/health
```

## Production Service

The production unit template is:

```text
ops/systemd/leakrouter.service
```

It binds `HOST=127.0.0.1` for deployments where Cloudflare Tunnel or private networking handles inbound access. On this machine the user service runs from `/home/funboy/leakrouter` and reads `/home/funboy/leakrouter/.env`.

Install templates:

```bash
bash ./ops/systemd/install-leakrouter-services.sh
```

Cloudflare Tunnel is documented as inbound-only. It does not hide outbound egress IPs from upstream Ollama servers.

## Proxy Egress Test

```bash
pnpm proxy:test
```

This reads `.env`, performs a proxied request to `LEAKROUTER_EGRESS_TEST_URL` (default `https://api.ipify.org?format=json`), and prints the IP seen through the proxy. It does not make a direct request by default. Direct comparison requires the explicit flag:

```bash
pnpm proxy:test --direct
```

## Admin UI

```text
http://127.0.0.1:4024/admin
```

Use it to:

- create and rotate client app keys
- adjust model allowlists
- inspect available modes
- inspect usage by app/model/status
- benchmark Ollama models by latency and output tokens/sec
- test prompts against selected models

## Benchmark

The admin Benchmark button calls `/admin/benchmark`. It runs a short non-streaming prompt against each available Ollama model and stores:

- response status
- latency in milliseconds
- output tokens per second
- output token count
- endpoint count for the model

Results are sorted from larger/higher-parameter models to smaller models. When models are comparable, higher live tokens/sec wins. A static family-priority catalog informed by public leaderboards is used only as a tie-breaker; live benchmark results from your endpoints take precedence.

## Troubleshooting

**No models are listed**

Check `LEAKROUTER_OLLAMA_INVENTORY_PATH` and make sure the JSON inventory exists and has `ok: true` endpoints with model entries.

**All Ollama requests fail**

Check `/health` for `provider.ollama.lastError`. Refresh the inventory if endpoints changed.

**DeepSeek-style clients fail**

Check that `LEAKROUTER_COMPAT_ENABLED_SURFACES` includes `deepseek`. This is a client compatibility surface; it does not require the DeepSeek upstream API when `LEAKROUTER_BACKEND_ORDER=ollama`.
