# Setup

## Requirements

- Node `23.3.0` (use [nvm](https://github.com/nvm-sh/nvm): `nvm use`)
- `pnpm` `10.26.1`

## Install

```bash
pnpm install --frozen-lockfile
cp .env.example .env
pnpm build
```

## Minimum required config

Open `.env` and set:

```env
GEMROUTER_ADMIN_TOKEN=your-secret-admin-token
GEMROUTER_BOOTSTRAP_API_KEY=your-client-api-key
GEMROUTER_GEMINI_API_ENABLED=true
GEMROUTER_GEMINI_API_KEYS=AIza...
```

For multiple keys use a comma-separated list or `GEMROUTER_GEMINI_API_KEYS_JSON` (JSON array).

## Account metadata (optional but recommended)

`data/gemini-api-accounts.json` lets you assign quota groups, tiers, and per-model limit overrides to individual keys. See [`docs/gemini-api-accounts.example.json`](gemini-api-accounts.example.json) for the format.

Example with a free-tier account and a Tier 1 account:

```json
[
  {
    "id": "account1",
    "quotaGroup": "my-free-project",
    "tier": "free",
    "priority": 100,
    "enabled": true
  },
  {
    "id": "account2",
    "quotaGroup": "my-tier1-project",
    "tier": "tier1",
    "priority": 100,
    "enabled": true,
    "limits": {
      "gemini-2.5-flash": { "rpm": 1000, "tpm": 1000000, "rpd": 10000 }
    }
  }
]
```

When per-model `limits` are present they override the global defaults for that quota group, which fixes the scoring imbalance that would otherwise occur when mixing free and paid accounts.

## Start

```bash
pnpm start
```

Health check:

```bash
curl -fsS http://127.0.0.1:4024/health
```

Admin UI: open `http://127.0.0.1:4024/admin` in a browser and log in with `GEMROUTER_DASHBOARD_ADMIN_USERS`.

## Verify

```bash
curl -sS http://127.0.0.1:4024/v1/chat/completions \
  -H "Authorization: Bearer $GEMROUTER_BOOTSTRAP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-2.5-flash",
    "messages": [{ "role": "user", "content": "Reply only with OK." }]
  }'
```

## Smoke tests

```bash
bash scripts/smoke.sh
```
