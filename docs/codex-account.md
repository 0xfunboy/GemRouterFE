# Codex inference provider

Codex is an opt-in text inference backend beside Gemini API and NVIDIA. It uses
your Codex account, not a personal ChatGPT conversation, MCP grant or API key.
Source implementation is not automatically deployed to gemrouter.example.com.

## Login and app onboarding

1. During an **authorized deployment**, set `GEMROUTER_CODEX_ENABLED=true` and
   `GEMROUTER_CODEX_COMMAND` to the executable's absolute path visible to systemd.
2. Reuse the existing private parent directory, by default
   `/home/OPERATOR/.local/share/gemrouter-personal-control`; authentication stays
   in its `codex/` child. Never copy credentials into the checkout or environment.
3. Expand **Codex Backend Routing**, below **Backend Routing**, in the reserved
   dashboard and select **Verify account**. An existing valid login needs no new authorization.
4. If needed, select **Connect with device code**, open the official link
   in your normal browser and enter the temporary code there, never in chat.
   No server browser, VNC or desktop is needed.
5. Edit the client app: enable **Allow the selected Codex routing account for this app**,
   authorize the GPT model IDs and choose default thinking. “All models” alone
   does **not** enable Codex. Existing apps default to disabled.
6. Enable **Quota depleted → authorized Gemini fallback** if desired. Authorize
   at least one Gemini too; the existing routed-model order sets its priority.

The account panel is collapsed by default. Temporary login codes are cleared on
expiry, cancellation and dashboard logout. Account routes require admin auth;
browser mutations require CSRF and same-origin checks. Responses are no-store.

### Two accounts and private aliases

**Add account** provisions a second independent profile and starts device login.
Complete the official login yourself with the second account. The **Account to
manage** selector only changes the inspected account. **Select account for routing**
changes the persisted default for new requests from all Codex-enabled apps; it
does not relogin, copy tokens or move queued/in-flight requests. A disconnected or
unverified account cannot be selected. There is no automatic account rotation.
The existing per-app opt-in/model allowlist/thinking/fallback policy still applies.

The original `codex/` profile is kept in place. The second uses
`codex-account-2/` under the same private parent. Each has its own official runtime
and file-backed login, within an owner-only directory (0700). `accounts.json`
stores only fixed slot IDs and selection, is atomically written as 0600, and
rejects symlinks, invalid permissions and corrupt data. The private parent and
both profiles are excluded from repository and app backups. No credentials are
returned to the dashboard or persisted in its browser storage.

Account aliases use the slot number and first two ASCII consonants of the email's
local part (for example, `Account 1 FX` for a synthetic fixture), never the email.
HTTP responses omit the email entirely, including authenticated admin responses.
This is a shortened label, not an anonymity guarantee. Only connected accounts
count in the `Accounts N/2` badge; unfilled slots are not reported as authenticated.
Disconnect acts only on the inspected profile and clears its cached usage. It is
refused while that account has queued/in-flight inference. Reconnect a disconnected
slot with its device-login button; no third slot is provisioned.

### Public quota and optional account activity

**Codex Token Quota** appears between Gemini RPD Capacity and NVIDIA NIM Models,
including before admin login. `/dashboard/codex-quota` returns only cached aliases,
connection/selection flags, observation freshness and service-reported windows
for `codex` and `codex_bengalfox`. Absent buckets are omitted, not shown as empty
quota rows. Weekly windows stay visible; a 5-hour window is hidden only when its
reported usage is exactly zero and appears for any positive or unknown usage.
Each row shows used/remaining percentage, reset date and a live hours/minutes
countdown. A reached reset says it is awaiting refresh; the browser never invents
renewed capacity. Missing data stays unknown,
not zero usage or 100% capacity. Guest requests never trigger upstream reads.
Emails, plan, credentials, profile paths, token activity and inference counters
are excluded from this public projection.

`codex_bengalfox` is a service-reported quota bucket, **not a model ID**. This UI
does not infer which model consumes it or make it a selectable model. Standard
GPT models retain their existing `codex` quota check. See the official
[app-server quota and activity contracts](https://learn.chatgpt.com/docs/app-server).

**Read account usage** starts an optional background read with HTTP 202. An
authenticated GET polls its result; the HTTP request never waits for the upstream
account-activity call. The job is single-flight per account, times out after
20 seconds and drops late results. Individual activity/quota RPCs have an 8-second
timeout. Errors are safe codes, never upstream HTML or raw error bodies. Quota
bars, provider availability and local request/token counters are independent of
this optional historical activity endpoint. It cannot provide remaining token or
request counts when the upstream service does not expose them.

Request/token metrics are persisted separately for each account; Account 1 keeps
the existing `codex-metrics.json`, Account 2 uses `codex-account-2-metrics.json`.
The compatibility CLI below still addresses the original profile, not the
dashboard-selected slot. Use the dashboard to manage the second account.

Read-only account CLI (does not load production .env or open its database):

```sh
pnpm --silent codex:account status
pnpm --silent codex:account models
pnpm --silent codex:account usage
pnpm --silent codex:account login
```

Login requires a terminal and is a no-op if already authenticated. Closing the
runtime is not logout. Old private-dir/command variables remain fallback selectors
to preserve the profile; old MCP/controller enable flags have no effect. Private
profiles and the archived MCP database stay on disk, excluded from backup/restore,
and are not migrated or opened by this provider.

## Models, thinking and API

Exact account catalog verified on 2026-09-16:

| Model | Supported thinking |
|---|---|
| `gpt-5.5` | low, medium, high, xhigh |
| `gpt-5.6-luna` | low, medium, high, xhigh, max |
| `gpt-5.6-sol` | low, medium, high, xhigh, max, ultra |
| `gpt-6-astra` | low, medium, high, xhigh, max, ultra |

Availability and effort are revalidated against model/list. Unavailable IDs or
efforts fail rather than silently selecting another GPT model.

Example, **after deployment**:

```sh
curl https://gemrouter.example.com/v1/chat/completions \
  -H "Authorization: Bearer $GEMROUTER_CLIENT_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-5.6-luna","reasoning_effort":"low","messages":[{"role":"user","content":"Rispondi solo OK"}]}'
```

The same routing applies to /chat/completions (GemRouter/DeepSeek), /v1/responses,
/api/chat and /api/generate. Responses accepts reasoning.effort; text surfaces
also accept x-gemrouter-reasoning-effort. Conflicting values are rejected.
Otherwise the app default applies. /v1/models and /models filter app permissions.

Each request creates one isolated, **ephemeral Codex turn**: no coding tools,
shell, web search, skills, plugins, MCP, apps, approvals or delegation. System
messages become developer instructions; multi-message history is serialized as
labeled conversation data. There is no persistent coding conversation. Client
disconnect/deadline cancels the owned runtime. Dispatch is serial, with a bounded
queue (default 16 waiting).

The official app-server runtime is pinned to **0.154.0-alpha.6.2**. Startup verifies
version, profile, effective restrictions and the returned model. Unexpected
capability/tool requests fail closed. Only final text is exposed, never reasoning
or commentary. This removes our coding/controller workflow; it does **not** create
a raw-model API with zero internal prompt overhead.

Compatibility limits:

- Text only, no tool execution/images. JSON/schema output follows the runtime's
  support; invalid JSON fails instead of being reported successful.
- stream=true is **buffered**: final text is emitted as SSE/NDJSON after completion.
  Cancellation still works while waiting.
- The inspected protocol has no native max_tokens/temperature control. They are
  not enforced; x-gemrouter-ignored-parameters explicitly reports them. A duration
  deadline is not a token cap.
- Headers report actual provider/model, thinking, usage source and stream mode.
  Gemini fallback is identified in both response model and routing headers.

## Quota-only fallback

GPT requests do not go to Gemini as if they were Gemini model IDs. Ordinary
Gemini/NVIDIA requests never consume Codex automatically.

An exhausted **general Codex quota window** or structured upstream
usageLimitExceeded allows fallback to the first authorized configured Gemini
(current curated order starts with gemini-3.8-flash). Existing key rotation and
model downgrades still respect the app allowlist and shared request deadline.
Reorder the routing editor when a new preferred Gemini becomes available.

No fallback for authentication, unsupported model/effort, timeout, ambiguous
error text or generic rate limiting. No authorized Gemini, app/global fallback
disabled or explicit backend pin means an error. Specialized quota buckets are
shown but not applied to unrelated models; new model families need a mapping
review. A quota snapshot is not a reservation against concurrent account users.
An explicit upstream quota rejection also applies a short local backoff equal to
the quota refresh interval, so a lagging snapshot cannot cause immediate retries.

## Consumption measurements

- **account/rateLimits/read**: separate windows/buckets, percent used, duration in
  minutes, reset in Unix seconds. Remaining percentage is displayed. Residual
  tokens/requests are **not exposed**, not estimated. Windows need not be daily.
- **thread/tokenUsage/updated**: input/output/total/cache/reasoning for the exact
  fresh thread and turn. Cumulative snapshots replace, never add to, each other;
  cached/reasoning subcounts are not counted twice. Reported usage is included in
  API responses and recorded on failures/cancellation when supplied.
- **data/codex-metrics.json**: owner-only, atomically persisted counters, totals
  and per model: received, successful, failed, quota-blocked, cancelled, measured
  token components. Missing usage is explicitly counted. Component sums cover
  only reported components. A crash can leave a received request without a terminal
  measurement; there is no invented reconciliation.
- **account/usage/read**: optional manual, historical account-wide activity. Other
  sessions and delayed updates mean it cannot attribute a single request's tokens.
  Unknown/unsupported fields stay null rather than zero.

Read-only quota refresh defaults to 30 seconds; absent/stale snapshots are marked.
No quota-reset credits or billing calls. The metrics file contains no prompts,
answers or credentials. Standard GemRouter interaction logging still stores client
prompts/answers: protect that data directory.

## Configuration

| Variable | Default |
|---|---|
| GEMROUTER_CODEX_ENABLED | false |
| GEMROUTER_CODEX_COMMAND | codex (absolute path recommended for systemd) |
| GEMROUTER_CODEX_PRIVATE_DIR | OS home + .local/share/gemrouter-personal-control |
| GEMROUTER_CODEX_MODEL | gpt-6-astra (account diagnostic default, not substitution) |
| GEMROUTER_CODEX_REASONING_EFFORT | high |
| GEMROUTER_CODEX_TIMEOUT_MS | 120000 (1000–600000) |
| GEMROUTER_CODEX_MAX_QUEUED | 16 (0–128) |
| GEMROUTER_CODEX_QUOTA_REFRESH_MS | 30000 (1000–300000) |
| GEMROUTER_CODEX_FALLBACK_ENABLED | true |

Admin endpoints: GET /admin/codex/account, POST .../refresh, POST .../usage,
GET|POST .../login, POST .../login/cancel, POST .../logout. App create/update accepts
codexEnabled, codexReasoningEffort, codexFallbackEnabled. There is no arbitrary
RPC endpoint, cookie export or credential forwarding.

Protocol: [official Codex App Server documentation](https://learn.chatgpt.com/docs/app-server).

## Verification and retired experiments

See [verification report](codex-verification.md) for automated tests, simulated
HTTP/UI, actual inference and deployment as separate categories.

The entire widget/MCP/browser implementation is archived on
archive/widget-wake-probe-2026-09-16 (12af0c3). Active cleanup retains the Gemini/
NVIDIA routing, retired-model exclusions and revoked-app activation/removal from
September 14. It does not delete live credentials, grants, databases or production
processes. Historical notices remain for attribution.
