# Gemini account/model census

## Live findings — 2026-10-07

The existing production service was used; no second router was started against
its data. Credentials, private profiles, keys and identifying account names are
excluded from this report. Fixed account slots are used below.

All **11 enabled keys** successfully listed the same catalog: **43** non-retired
`generateContent` entries. Every one of the nine configured fallback models was listed on every
key. Listing **does not prove inference entitlement or a paid/free billing tier**.
The configured `tier1` labels are local metadata, not an upstream verification.
Google's API tier belongs to the Cloud project; it must not be inferred from a
consumer Gemini Pro subscription. See [API rate limits](https://ai.google.dev/gemini-api/docs/rate-limits)
and [model listing](https://ai.google.dev/api/models).

The primary inference census ran from approximately **14:35 to 14:38:29 UTC**:
**117 bounded requests**, one per eligible key/model, maximum 128 output tokens,
15-second timeout, three concurrent account sequences, no retries or fallback.
It tested the nine fallback models on all keys, plus two additional models with
configured quota capacity on slots 2–10. Thirteen responses contained text;
their reported total usage was **795 tokens**. Four earlier exploratory calls
are separate: high demand, timeout, an unsupported thinking argument, and a
zero-quota Pro response. None is counted as a successful completion.

| Slot | 3.8 Flash | 3.7 Flash | 3.6 Flash | 3.5 Flash | 3.5 Lite | 3 Flash preview | 3.1 Lite | Gemma 31B | Gemma 26B | 2.5 Pro | 3.1 Lite preview |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | timeout | timeout | 503 | 503 | timeout | 503 | 503 | 500 | 200 | capped | capped |
| 2 | timeout | 200 | 503 | 503 | timeout | 503 | 503 | 500 | 200 | zero quota | timeout |
| 3 | timeout | 503 | 503 | 503 | 200 | 503 | 503 | 500 | 200 | zero quota | 503 |
| 4 | 503 | 503 | 503 | 503 | timeout | 503 | 503 | 500 | 200 | 404 | 503 |
| 5 | 503 | 503 | 503 | 503 | timeout | 503 | 503 | 500 | 200 | 404 | 503 |
| 6 | timeout | 503 | 503 | 503 | timeout | 503 | 503 | timeout | 200 | 404 | 503 |
| 7 | timeout | 503 | 503 | 503 | timeout | 503 | timeout | 500 | 200 | 404 | 503 |
| 8 | 503 | 503 | 503 | 503 | timeout | 503 | timeout | 500 | 200 | 404 | timeout |
| 9 | 503 | 503 | 503 | 503 | timeout | 503 | 503 | 500 | 200 | 404 | 503 |
| 10 | 503 | 503 | 503 | 503 | timeout | 503 | timeout | timeout | 200 | 404 | 503 |
| 11 | 503 | 503 | 503 | 503 | timeout | timeout | 503 | 500 | 200 | capped | capped |

`capped` means the existing curated allowlist already excluded the model, so no
probe was sent. `200` means nonempty text was actually returned. The Gemma names
are `gemma-4-31b-it` and `gemma-4-26b-a4b-it`. **500, 503 and timeout are
inconclusive access checks**, not evidence of model retirement. In particular,
no successful 3.8 Flash completion was obtained in this short diagnostic window.

`gemini-2.5-pro` is unusable on all nine slots that previously admitted it:
slots **2–3** returned `RESOURCE_EXHAUSTED` with explicit Google **limit: 0**;
slots **4–10** returned structured `NOT_FOUND`/404. This is not the same as
exhausting a nonzero daily allowance. These observations do **not date a new
Google policy change**: existing source comments already warned that this Pro
model had no usable free quota, while static configuration still advertised
100 RPD. There is no evidence here supporting a blanket deletion of current
Flash models or entire accounts.

After deployment, a separate protected live census checked
`gemini-3.1-pro-preview` on **all 11 slots**, from **15:05:22 to 15:05:25 UTC**.
Every slot returned structured **429 / explicit quota limit zero**. Individual
end-to-end probe durations (including the catalog check), in slot order 1–11,
were **431, 360, 387, 356, 299, 258, 300, 291, 292, 256, 284 ms**. No completion
or token usage was reported. Access observations were persisted by the running
service; slots 2–10 had this ID additionally removed from their curated caps.
Slots 1/11 already excluded it and kept the same allowed model list. No inference
access to a Pro model was demonstrated merely by these projects' local labels.

## Applied production recalibration

Using the existing protected admin account-update endpoint, slots **2–10** were
capped to their freshly listed `generateContent` models **minus 2.5 Pro**. Slots
1 and 11 kept their existing curated policy. All 11 accounts, nine fallback
models, priorities, quota groups, keys and historical ledger data were preserved.
The public production summary then reported **zero quota groups offering 2.5
Pro**, instead of nine phantom 100-RPD capacities. This operation was hot-applied
without a router restart. A private owner-only pre-change account configuration
backup was retained under ignored `data/diagnostics/`; it is not a Git artifact.
The new caps intentionally require operator review before authorizing future
new models or restoring the excluded Pro model.

Direct upstream diagnostic calls are **not client requests through GemRouter**:
they do not appear in Recent Interactions or update its local usage ledger. Thus
the census consumes some upstream quota outside the locally measured counts.
The local ledger is an estimate, not an authoritative account balance.

## Router safeguards and repeatable diagnostic

The new code retains the last complete successful per-key catalog during failed
or stale refreshes; a known missing model cannot silently return after 48 hours.
A valid empty catalog denies all models; an unknown/malformed/partial catalog
does not remove them. Pagination is bounded and complete; credentials are sent
in `x-goog-api-key`, not discovery URLs. Cache writes are atomic and owner-only.
Key rotation discards obsolete evidence, including late old-key replies.

Real inference records structured model-not-found and explicit Google zero-quota
responses per key/model. These exclusions survive restart and catalog refresh;
listing alone cannot erase a zero-quota observation. A genuinely successful
inference can restore access. For a blocked pair, the protected admin
`POST /admin/provider/gemini-api/accounts/probe-model` endpoint accepts only
`{ "accountId": "account2", "model": "gemini-2.5-pro" }`. Its fixed, text-only
diagnostic can update the gate without allowing normal inference through it;
an independent curated exclusion still needs explicit operator review. The
endpoint uses existing admin/CSRF protection, two concurrent probes maximum and
one probe per account/model per minute, with no retries or arbitrary prompts.
Transient failure, authentication failure and
ordinary nonzero quota exhaustion cannot permanently remove a model. The same
gate controls dispatch and displayed quota capacity. Deleted/disabled groups
are excluded, per-group configured limits are honored, and shared-project quota
is counted once with model-specific eligible account labels.

The account model viewer distinguishes catalog listing from inference proof and
labels excluded entries. These safeguards were deployed with explicit user
authorization. Graceful shutdown began at **15:01:26.039 UTC** and HTTP listening
resumed at **15:03:32.813 UTC** (approximately **127 seconds**, including draining
existing long-running requests). The initial 50-second readiness window expired
before that drain finished; no forced kill or second instance was used. Both
Codex logins and preferred slot 2 survived; active runtime remained **0.160.1**.
An early CLI attempt while HTTP was unavailable made no upstream generation or
policy updates. The CLI now preflights the live authenticated service and exits
nonzero on that failure rather than presenting a completed census.

Run from the configured checkout (requires private `.env` and account files):

```sh
pnpm census:gemini
pnpm census:gemini --probe
pnpm census:gemini --probe --models=gemini-3.8-flash,gemini-3.7-flash
pnpm census:gemini --probe --models=gemini-2.5-pro --apply
```

Default operation is list-only and limits candidates to Gemini/Gemma chat flags;
neither those flags nor listing prove inference entitlement. `--probe` explicitly consumes upstream inference
quota through the existing live service's protected probe endpoint: at most one
generation request per target/key, 20-second catalog and generation deadlines,
45-second HTTP ceiling, 128 output tokens, two concurrent account sequences.
No second router instance is started. Explicit probes update access evidence,
not client interaction/usage counters. JSON-lines output contains safe slot IDs,
model names, individual durations, statuses and reported tokens, not keys,
identities or raw upstream errors. `--apply` requires `--probe` and only narrows
policy for proven zero quota/structured 404, through the live loopback admin API.
It never updates policy after failed discovery, transient error or a changed
account/key. It never widens an existing allowlist and refuses an empty list
because the existing router interprets an empty list as unrestricted. It does
not enable/disable accounts, restart production, or assert that listing proves
access. Take a private configuration backup before an intentional `--apply` run.

## Verification boundaries

Automated regression coverage checks full pagination, failure retention,
valid empty vs malformed catalogs, strict zero-quota detection, key rotation,
concurrent observations, inference routing, quota projections and shared groups.
Tests use simulated Google responses. The table above is from **real upstream
calls**, not those tests. Production recalibration was verified over the running
service's HTTP API. Do not present temporary Google overload as a confirmed
free-tier entitlement change.

Final automated verification: **156 tests**, TypeScript checks and production
build; isolated HTTP/frontend smoke used a **simulated Codex** runtime and a
separate temporary database. The production public HTTPS dashboard was then
checked independently: 11 enabled Gemini slots, no 2.5 Pro quota capacity,
model-specific account eligibility, Codex 0.160.1/no update, and **zero browser
JavaScript errors**.

Two additional **real public HTTPS inference requests through the deployed
router** returned `ROUTER_LIVE_OK`: `gemma-4-26b-a4b-it`, slot 9, HTTP 200 in
**1,529 ms** (**8 input + 4 output = 12 tokens**), followed by exact
`gpt-6.1-sol`, Codex slot 2, default `xhigh`, HTTP 200 in **3,599 ms** (**3,949
input + 10 output = 3,959 tokens**). The temporary verification app was revoked
and removed afterward. These are not the remote AIR3 client's own requests,
not personal ChatGPT-chat/MCP verification, and not simulated completions.
