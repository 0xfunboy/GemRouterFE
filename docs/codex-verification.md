# Codex provider verification — 2026-09-16

## Follow-up: multi-account dashboard (checkout verification)

The Codex controls now use the same panel/chip/table/meter CSS as the existing
dashboard. **Codex Backend Routing** sits immediately below Backend Routing,
collapsed with **Expand**. All Codex controls and app options are in English.
**Codex Token Quota** is visible before login, between Gemini RPD Capacity and
NVIDIA NIM Models, with two long-window rows per account. Badges show the real
connected account count, not a fabricated 2/2.

Two separately stored official Codex profiles can be managed through **Add account**,
the account dropdown, and **Select account for routing**. The original profile is
preserved. Selection persists independently of credentials; new requests use the
selected account, old requests stay pinned. Emails are removed from HTTP DTOs,
not merely hidden with CSS. Aliases use only slot number and two consonants.

Additional automated coverage: isolated profile paths, private registry permissions,
corrupt/symlink rejection, selection persistence, per-account counters, queued and
in-flight pinning, logout isolation, CSRF/admin checks, secret-free projections,
asynchronous usage single-flight/timeout/late-response handling, and invalidation
of a quota refresh completing after logout.

The isolated browser smoke verifies expanded/collapsed controls, a mock device
login for Account 2 alongside an already-connected fixture Account 1, switching
to Account 2 and back without relogin, background usage reads,
two quota rows per account and the unauthenticated mobile view. There are no page
JavaScript errors. These fixtures **do not demonstrate two real accounts**.
The follow-up suite passes **114/114 tests**, TypeScript checking and isolated
HTTP/browser smoke. The earlier 105-test result below is the original release.
A build to a separate temporary output directory also passed, without replacing
the running production build. A scoped scan of the 16 changed/new files found no
private account identifiers, personal email addresses, private keys, JWTs or
common service-token patterns. See the authorized follow-up rollout below for
the subsequent production deployment and history rewrite.

Read-only production diagnostic of the existing (pre-change) usage endpoint:
HTTP 200 in **1,312 ms**, both account activity and quota available. The reported
Cloudflare error was not reproduced in this observation; no persistent upstream
failure is asserted. The replacement usage endpoint responds immediately with
202, is polled separately, and reports safe timeout/unavailable codes. Optional
historical activity does not gate quota display or inference.

These checkout checks were followed by an explicitly authorized deployment.
A second real account login still requires the operator and has not been claimed.

### Authorized follow-up rollout — 15:38 UTC

The existing GemRouter service was restarted after a successful production build,
with no Codex requests queued/in-flight at shutdown. No tunnel/network change or
second production instance was needed. The original account remained authenticated;
all four configured models were returned by its real catalog.

Verified over public HTTPS:

- The unauthenticated quota endpoint returns HTTP 200, one connected account and
  two long-window rows, with no email in its DTO.
- The deployed dashboard shows the public quota card before login, the admin
  routing panel collapsed by default, an enabled **Add account** button and an
  accurate **Accounts 1/2** badge. A temporary admin session was logged out after
  verification. No account login was replaced and no second account was invented.
- Optional account usage was accepted with HTTP 202 in **85 ms**, then completed
  successfully through polling. This was a real upstream activity read.
- A temporary, Luna-only app with thinking low and fallback disabled returned
  **CODEX_ACCOUNTS_OK**, HTTP 200, backend **codex**, exact model **gpt-5.6-luna**.
  The probe completed in **3,523 ms**, including the follow-up counter check.
  Actual usage: **3,443 input + 10 output = 3,453 total tokens**; cached/reasoning
  subcounts were zero. Per-account production metrics recorded the usage.
- The temporary inference app was revoked and deleted. Existing app permissions
  and the original login were preserved. Switching two real accounts still awaits
  the operator's second login; the two-account switching test was simulated.

The separately authorized full-history cleanup and its limits are documented in
[privacy-history-rewrite.md](privacy-history-rewrite.md). This supersedes the
initial publication boundary at the bottom of this document.

## Implementation

Branch: `feat/codex-provider`. Former widget, native MCP and personal-chat/browser
work is recoverable on `archive/widget-wake-probe-2026-09-16`, commit `12af0c3`.
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
Gemini fallback triggered by an actually depleted subscription, concurrent load
or personal ChatGPT/MCP wake. Fallback was tested with controlled fixtures.

## Authorized production rollout — 2026-09-16

The operator subsequently authorized deployment, service/tunnel restarts, widget
retirement and a privacy-checked push. Deployment completed and was verified:

- Production build and locked dependency installation succeeded.
- GemRouter and its tunnel were gracefully restarted; both returned active/running.
  The package-manager wrapper did not propagate its initial SIGTERM, so the exact
  owned production Node process was stopped gracefully after checking its UID,
  cgroup and working directory. The existing Restart=always policy restarted it.
- The existing Codex account remained authenticated. All four requested models
  and account quota buckets were available from the production runtime.
- Public health and the actual HTML dashboard returned 200; the Codex panel is
  present. Unauthenticated account access returned 401.
- The temporary widget service was stopped, its ingress removed and the tunnel
  configuration validated before restart. The old widget endpoint returns 404.
- Old widget build/dependency artifacts and unused compiled MCP code were moved
  to a private local rollback directory, not deleted irrecoverably.
- Existing OAuth grant, refresh-token and worker records were preserved; the
  archived SQLite database passed quick_check. No production DB downgrade or
  second GemRouter instance was started.

### Actual public API completion

At **2026-09-16 13:16 UTC**, a temporary app with only gpt-5.6-luna allowed,
thinking low and fallback disabled called the public production OpenAI-compatible
endpoint. Result: **HTTP 200**, backend **codex**, exact model **gpt-5.6-luna**,
payload **CODEX_PRODUCTION_OK** in **3,561 ms**.

Upstream usage: **3,442 input + 9 output = 3,451 total tokens**; cached/reasoning
subcounts were 0. Production request/token counters recorded the inference.
The temporary app was revoked and removed immediately afterward. Existing app
permissions were not expanded: operators must explicitly enable Codex per app.

This is a real production inference, distinct from the earlier isolated HTTP
test and the simulated UI/HTTP suite. It does not establish that every model,
reasoning level or future quota exhaustion has been exercised live.

## Initial publication privacy boundary (superseded by authorized full rewrite)

The two unpublished implementation/archive snapshots were recreated with anonymous
GitHub noreply commit metadata. Personal chat URLs, runtime identifiers, deployment
domains, tunnel identifiers, invite links and home paths were replaced with inert
examples in the archive. The active runtime tunnel configuration is now ignored;
only gemrouter.example.yml is versioned. The original snapshots, environment,
build and consistent SQLite backup remain in a private owner-only local rollback
directory, never in Git or the push set.

The automated check scans every newly published commit and its trees, not merely
the latest diff. It checks sensitive/generated paths, credential formats, personal
email metadata, account identifiers supplied privately to the scanner, personal
chat URLs and credential-bearing URLs. Reserved test domains and synthetic fixture
IDs are distinguished from actual private endpoints.

Already-published remote ancestry was not force-rewritten. It contained deployment
references and personal author metadata predating this work; current tracked
templates were sanitized, but removal from historical remote commits would be a
separate coordinated history rewrite. No claim is made that this push erases old
public objects. Only explicit main/provider/archive refs are pushed; unrelated
local branches and the private recovery bundle are excluded.

Recheck an outgoing push set before publication:

```sh
pnpm check:privacy main feat/codex-provider archive/widget-wake-probe-2026-09-16
```
