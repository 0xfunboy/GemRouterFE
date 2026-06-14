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

## Admin UI

```text
http://127.0.0.1:4024/admin
```

Use it to:

- create and rotate client app keys
- adjust model allowlists
- inspect available modes
- inspect usage by app/model/status
- test prompts against selected models

## Troubleshooting

**No models are listed**

Check `LEAKROUTER_OLLAMA_INVENTORY_PATH` and make sure the JSON inventory exists and has `ok: true` endpoints with model entries.

**All Ollama requests fail**

Check `/health` for `provider.ollama.lastError`. Refresh the inventory if endpoints changed.

**DeepSeek fallback does not work**

Set `LEAKROUTER_DEEPSEEK_ENABLED=true` and `LEAKROUTER_DEEPSEEK_API_KEY`.
