# Gemini real-quota sync (Cloud Monitoring)

> Guida operativa passo-passo (console web, in italiano):
> [guida-quota-monitor-setup.md](./guida-quota-monitor-setup.md)

The Gemini API has no quota-remaining endpoint, but every account is a Google Cloud
project and quota usage for `generativelanguage.googleapis.com` is published as
Cloud Monitoring time series. GemRouter reads them with a per-project service
account and realigns its local RPD ledger every 30 minutes (configurable) or on
demand — the local ledger stays authoritative between syncs.

## How it works

- `src/llm/providers/gemini-api/quotaMonitor.ts` exchanges a service-account JWT
  for an OAuth token (no extra dependencies) and queries
  `serviceruntime.googleapis.com/quota/rate/net_usage` (summed from the Pacific
  day start) plus `quota/limit` for `generativelanguage.googleapis.com`.
- Observations that carry a request-count quota metric **and** a model dimension
  are pushed into the ledger via `reconcileRpdUsage`:
  - real usage **higher** than the local count → a synthetic event stamped at the
    Pacific day start fills the gap (it expires at the daily reset);
  - real usage **lower** → only previous synthetic adjustments shrink; real
    traffic events are never removed (monitoring lags a few minutes).
- Everything else (token metrics, undimensioned series) is stored in the snapshot
  (`data/gemini-quota-monitor.json`) for inspection but not reconciled.

## Endpoints

- `GET /v1/provider/quota-monitor` (client key) — snapshot: configured projects,
  last run, per-project observations, credential errors.
- `POST /v1/admin/quota-monitor/refresh` (admin token) — run a sync now.

## Setup per project (repeat for each of the 7 accounts)

```bash
PROJECT_ID=your-gcp-project-id
gcloud services enable monitoring.googleapis.com --project="$PROJECT_ID"
gcloud iam service-accounts create gemrouter-quota --project="$PROJECT_ID"
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:gemrouter-quota@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/monitoring.viewer"
mkdir -p data/secrets
gcloud iam service-accounts keys create "data/secrets/${PROJECT_ID}-monitoring-sa.json" \
  --iam-account="gemrouter-quota@${PROJECT_ID}.iam.gserviceaccount.com"
```

Then list the projects in `data/gcp-monitoring-credentials.json` (template:
`ops/gcp/gcp-monitoring-credentials.example.json`). Each entry maps a project to a
ledger quota group either directly (`quotaGroup`) or via `accountId` (resolved
through `data/gemini-api-accounts.json`). `serviceAccountPath` is relative to the
credentials file, so `secrets/foo.json` resolves inside `data/` — which is
git-ignored, keys never reach the repo.

No credentials file → the monitor idles and reports `no_credentials` (nothing
breaks). Config lives in `.env` under `GEMROUTER_GEMINI_QUOTA_MONITOR_*`.

## Dynamic free-model catalog (related mechanism)

Google changes the free-tier model set over time, so the curated `models` list
in `data/gemini-api-accounts.json` is treated as a cap, not as truth:

- `src/llm/providers/gemini-api/accountCatalog.ts` refreshes each account's own
  `/models` catalog every 6h (`GEMROUTER_GEMINI_API_ACCOUNT_MODELS_REFRESH_MS`)
  or on demand via `POST /v1/admin/gemini/account-models/refresh`. Key selection
  serves a model only when the curated list allows it **and** the account still
  serves it upstream; missing/stale live data fails open.
- Real day limits observed by the quota monitor override the static RPD table
  per model (`monitorRpdLimit` in the ledger).
- The daily free-tier policy scan keeps alerting on added/removed free models.

## Caveats

- Cloud Monitoring quota series lag real traffic by a few minutes; that is why
  downward reconciliation never touches real ledger events.
- The per-model dimension on quota metrics depends on how Google labels the
  series for `generativelanguage.googleapis.com`. If a project's series carry no
  model label, its data stays visible in the snapshot but is not reconciled
  (`skipped` counter in the refresh response).
