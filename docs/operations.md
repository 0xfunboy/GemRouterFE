# Operations

## Deployment

GemRouter runs as a standard Node.js process. The `data/` directory must be writable at runtime.

**Local:**

```bash
pnpm start
```

**Production start script:**

```bash
./scripts/start-gemrouter.sh
```

**Systemd:**

Templates are in `ops/systemd/`. Install with:

```bash
bash ./ops/systemd/install-gemrouter-services.sh
```

Units:
- `gemrouter.service` — main service (user unit)
- `gemrouter-nightly-restart.service` + `gemrouter-nightly-restart.timer` — nightly restart at 03:30 UTC

**Cloudflare Tunnel:**

Template: `ops/cloudflared/gemrouter.yml`

## Security

- Keep `GEMROUTER_ADMIN_TOKEN`, bootstrap API key, and Gemini API keys out of version control.
- Do not commit `.env`, `data/`, or `.gemini/`.
- Admin auth (`GEMROUTER_ADMIN_TOKEN`) and client auth (`GEMROUTER_BOOTSTRAP_API_KEY`) are separate — rotate independently.
- Expose the admin UI only to trusted networks. It reflects live quota state and allows cooldown resets.
- Audit and interaction logs may contain prompt content — store and rotate them accordingly.

## Troubleshooting

**`/health` shows no usable backend**

Check `GEMROUTER_GEMINI_API_ENABLED=true` and that at least one key is configured.

**All requests 429 / quota exhausted**

Check `/v1/provider/quota`. Look for models with RPD at limit or keys in cooldown. RPD resets at **midnight America/Los_Angeles** (matches Google's actual reset boundary). Cooldowns can be cleared from the admin UI or via `POST /admin/provider/gemini-api/clear-cooldown`.

**Startup fails immediately**

Missing required values — check that `GEMROUTER_ADMIN_TOKEN` and `GEMROUTER_BOOTSTRAP_API_KEY` are set.

**Admin UI loads but data looks stale**

Refresh `/health` and `/admin/summary` after sending a live request. Quota state updates on actual traffic; model discovery caches for 6 h by default.

**One account gets all the traffic**

Likely a limit mismatch between accounts (e.g. mixing free-tier and Tier 1 without per-account overrides). Add `limits` to the higher-quota account in `data/gemini-api-accounts.json` so the scoring ratios (remaining/limit) are comparable across accounts. Without overrides the Tier 1 key always wins because its raw remaining values are larger.

## Key repository paths

| Path | Purpose |
|---|---|
| `src/index.ts` | HTTP server and route handlers |
| `src/config.ts` | Environment loading and config assembly |
| `src/llm/router.ts` | Key selection and fallback logic |
| `src/llm/providers/gemini-api/` | Gemini API backend (key pool, quota ledger, rate limits) |
| `src/ui.ts` | Server-rendered admin dashboard |
| `src/lib/openai.ts` | OpenAI-compatible request/response parsing |
| `src/lib/ollama.ts` | Ollama-compatible request/response parsing |
| `src/store/` | App, audit, and interaction state |
| `data/gemini-api-accounts.json` | Per-account metadata and limit overrides |
| `data/gemini-api-quota-ledger.json` | Runtime quota ledger (auto-managed) |
| `scripts/start-gemrouter.sh` | Production start helper |
| `scripts/smoke.sh` | End-to-end smoke checks |
| `ops/systemd/` | Systemd unit templates and installer |
| `ops/cloudflared/` | Cloudflare Tunnel config template |
