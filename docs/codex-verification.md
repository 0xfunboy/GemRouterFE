# Codex provider verification — 2026-09-16

## Implementation

Branch: `feat/codex-provider`. Former widget, native MCP and personal-chat/browser
work is recoverable on `archive/widget-wake-probe-2026-09-16`, commit `165a7b0`.
The active code retains Gemini/NVIDIA and the September 14 retired-model and
revoked-app fixes. No hard reset or live database rollback was performed.

Implemented: exact GPT routing, per-app opt-in/allowlist, thinking validation,
bounded isolated inference, quota-only authorized Gemini fallback, usage accounting,
device login, admin quota/request/token dashboard and API compatibility.

## Automated tests

Commands:

```sh
pnpm check:app
pnpm test
pnpm smoke:codex:ui
git diff --check
```

Result: **105/105 tests passed**, TypeScript check passed, HTTP/UI smoke passed,
and diff whitespace check clean. A staged scan covered 40 added/modified/renamed
files for private/generated paths, private keys, JWTs and common credential
formats, with no findings. This is a scoped check, not a claim about all historical
commits or arbitrary encoded secrets. Private profiles/databases were not staged.

The suite includes protocol fixtures (not real OpenAI calls), exact model/effort,
no unauthorized tools, usage deduplication, denied capabilities, private profiles,
login ownership/expiry, opt-in, quota normalization, quota-only fallback,
bounded queue/cancellation, durable metrics, missing usage and legacy Gemini/NVIDIA
regressions. The isolated HTTP test uses temporary app data, random test keys and
an ephemeral loopback port. It never loads production `.env`, opens its database
or builds/replaces production `dist/`.

## Simulated HTTP and frontend smoke

`pnpm smoke:codex:ui` passed. Upstream is a deterministic stdio fixture; its token
numbers are not consumption measurements. Verified app creation, opt-in rejection,
model listing, `/v1/chat/completions`, `/chat/completions`, `/v1/responses`,
`/api/chat`, buffered streaming, upstream usage mapping, admin/CSRF and origin checks.
Headless Chrome is used **only to test the local dashboard**, never for inference,
ChatGPT control or account login. The UI checks the collapsed Codex panel, account
refresh, quota/model display and saving app Codex permissions/thinking without
JavaScript errors. No external chat interaction occurs.

## Actual live Codex inference

Existing authenticated private profile; official app-server `0.154.0-alpha.6.2`.
No new OAuth, API key, browser, MCP connector or personal-chat wake.

| Test | Model / thinking | Elapsed | Reported input | Output | Total |
|---|---|---:|---:|---:|---:|
| Direct provider adapter | gpt-5.6-luna / low | 5,175 ms | 3,441 | 8 | 3,449 |
| Isolated HTTP `/v1/chat/completions` → actual Codex | gpt-5.6-luna / low | 4,130 ms | 3,441 | 8 | 3,449 |

Both returned exactly `CODEX_PROVIDER_OK`; cached input and reasoning tokens were
reported as 0. Combined measured total of these two probes: **6,898 tokens**.
The short prompt is not the entire input cost: internal runtime context is included.
Timings are individual observations, not latency guarantees or throughput benchmarks.

The HTTP test used `pnpm smoke:codex:live`, a temporary app with Codex explicitly
enabled and fallback disabled. It verified the actual model, provider header,
response payload, reported usage and persisted local metrics. The process and its
temporary data were removed afterward. Real runtime/account/model/quota reads were
also verified; private identity and account history are not included in Git.

Not claimed live: completions on the other three models, a quota-exhaustion event,
Gemini fallback triggered by a real exhausted Codex subscription, production API
serving, concurrent load or personal ChatGPT/MCP wake. Fallback was verified with
controlled fixtures, without deliberately draining the account.

## Production boundary and proposed deployment

No production deployment, restart, tunnel edit, grant revocation or network change
was performed. Existing services retained their original PIDs/start times during
verification. Old credentials/profiles and AIR3 data remain untouched. The obsolete
temporary widget process/ingress remains running pending explicit live cleanup
authorization; source removal alone does not stop an already-running process.

An authorized deployment would:

1. Preserve private rollback copies of the current build/config/app data, without
   exporting credentials into Git. Preserve the archived MCP SQLite directory.
2. Build/install the checked provider source; set Codex enabled, its absolute
   executable and the existing private directory for the service user. The app
   account starts disabled until explicitly enabled in each chosen app.
3. Restart **only `gemrouter.service`**, check health and one explicitly authorized
   app request. No second instance on the production database. The old MCP routes
   and personal-chat worker aliases will no longer be served by this implementation.
4. Separately stop **only** `gemrouter-widget-wake-probe.service` (user unit), remove
   its `/widget-wake-probe/*` ingress, validate tunnel config and restart only
   `cloudflared-gemrouter`; this can cause a short public tunnel reconnection.
5. Keep private profiles and grants for rollback; remove ignored generated widget
   artifacts only after its process has stopped. Roll back source/config/build
   together if needed, not the live database via a destructive reset.

These steps are a proposal, not a record of actions already performed.
