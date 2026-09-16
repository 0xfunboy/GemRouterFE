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
- `gemrouter.service` - main service (user unit)
- `gemrouter-nightly-restart.service` + `gemrouter-nightly-restart.timer` - nightly restart at 03:30 UTC

**Cloudflare Tunnel:**

Template: `ops/cloudflared/gemrouter.example.yml`. Copy it to the gitignored
`ops/cloudflared/gemrouter.yml` and fill tunnel/domain/credential-file values only
on the deployment host. Systemd templates use `/home/OPERATOR`; customize them
locally before installation. Existing installed units are not changed by Git.

## Security

- Keep `GEMROUTER_ADMIN_TOKEN`, bootstrap API key, and Gemini API keys out of version control.
- Do not commit `.env` or `data/`. Once accounts are managed from the admin UI, `data/gemini-api-accounts.json` holds the **raw Gemini keys** and `data/proxy-config.json` holds proxy credentials - both are gitignored; keep the `data/` directory access-controlled.
- Admin auth (`GEMROUTER_ADMIN_TOKEN`) and client auth (`GEMROUTER_BOOTSTRAP_API_KEY`) are separate - rotate independently.
- Expose the admin UI only to trusted networks. It can add/remove Gemini accounts, edit the routed model set, manage the proxy pool, and create API clients (with optional custom key prefixes) - all live.
- All `/admin/*` endpoints require the admin token or session; client endpoints (`/v1/chat/completions`, `/v1/embeddings`, …) require a valid app key. Secrets are masked in API responses.
- Audit and interaction logs may contain prompt content - store and rotate them accordingly.

## Live admin management

The admin dashboard manages most runtime config without a restart or `.env` edit; changes
persist under `data/` and reload in-process:

- **Gemini Accounts** - add/remove keys, set per-account priority and enabled state, and
  download the free models each account can serve.
- **Routed Models** - choose which Gemini models the router offers and their order
  (first = default, rest = fallback chain).
- **Outbound Proxy** - manage the proxy pool (off by default, not yet applied to upstreams).
- **Codex** - reuse the dedicated account login, inspect actual quota windows and
  measured request tokens, and enable GPT models/thinking separately for each app.
  Quota depletion can fall back to that app's authorized Gemini models. See
  [configuration and limits](codex-account.md).
- **Apps and API Keys** - create/rotate/revoke client apps and choose either a custom
  model allowlist or **All configured models**. A revoked app exposes only
  **Activate** (which creates a new one-time API key) and **Remove app** (which asks
  for confirmation and permanently removes that revoked record). Revocation also
  removes it from the active registry. The all-model policy follows later catalog
  changes automatically; Recent Interactions can be filtered by app.

## Troubleshooting

**`/health` shows no usable backend**

Check `GEMROUTER_GEMINI_API_ENABLED=true` and that at least one key is configured.

**All requests 429 / quota exhausted**

Check `/v1/provider/quota`. Look for models with RPD at limit or keys in cooldown. RPD resets at **midnight America/Los_Angeles** (matches Google's actual reset boundary). Cooldowns can be cleared from the admin UI or via `POST /admin/provider/gemini-api/clear-cooldown`.

Gemini quotas belong to a Google Cloud **project**, not to an API key. Keys from the
same project must therefore use the same `quotaGroup` (preferably the canonical
`projects/<project-number>`). Do not merge unrelated accounts into one global group.
The router keeps one shared RPM/TPM/RPD ledger for every client app, so traffic from
different dApps competes for the same project budget without racing past it.

TPM is an input-token limit. Before dispatch, the router rejects a model candidate
locally when the estimated input is larger than that model's hard TPM ceiling; this is
a local routing skip, not an upstream 429. Dispatched requests remain charged to the
local rolling ledger even when they time out or lose a hedge race.

**Startup fails immediately**

Missing required values - check that `GEMROUTER_ADMIN_TOKEN` and `GEMROUTER_BOOTSTRAP_API_KEY` are set.

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
| `src/llm/providers/ollama-local/` | Local Ollama vision/embedding client |
| `src/ui.ts` | Server-rendered admin dashboard |
| `src/lib/openai.ts` | OpenAI-compatible request/response parsing |
| `src/lib/ollama.ts` | Ollama-compatible request/response parsing |
| `src/store/` | App, audit, and interaction state |
| `data/gemini-api-accounts.json` | Account metadata **and keys** once managed from the admin UI (gitignored) |
| `data/gemini-api-quota-ledger.json` | Runtime quota ledger (auto-managed) |
| `data/model-config.json` | Routed model set + order set from the admin UI |
| `data/proxy-config.json` | Outbound proxy config set from the admin UI |
| `data/ollama-local-usage.json` | Local Ollama daily request counters (Pacific reset) |
| `data/apps.json` | API client apps and key hashes (gitignored) |
| `scripts/start-gemrouter.sh` | Production start helper |
| `scripts/smoke.sh` | End-to-end smoke checks |
| `ops/systemd/` | Systemd unit templates and installer |
| `ops/cloudflared/` | Cloudflare Tunnel config template |
