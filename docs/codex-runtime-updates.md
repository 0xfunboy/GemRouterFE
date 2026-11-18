# Managed Codex runtime, model discovery and essential alerts

The official Linux x64 executable is included in Git as verified, split gzip
assets under `vendor/codex/`. Startup is offline-capable, independent of IDE
extensions and PATH. Runtime files are extracted into ignored, owner-only
`.runtime/codex/versions/`; `current.json` records the active checked version.
Private account profiles remain outside the repository and backup trees.

## Dashboard workflow

**Codex Token Quota** shows **Codex login update available** when the official npm registry advertises a newer runtime. The banner concerns GemRouter’s provider executable. It does not require signing in again. `GET /dashboard/codex/runtime` shows the active and latest cached versions; the version in the bundled manifest is the offline baseline. It is visible before
login, but only an authenticated admin with valid mutation/CSRF authorization
can update. Expand **Codex Backend Routing**, then use **Check Codex updates** or
**Update and scan models / thinking**. Checks also run every six hours; guest
HTTP requests only read the cache and never invoke downloads or upstream APIs.

An update runs asynchronously (HTTP 202) with visible phases. Only the official
version-pinned platform tarball is accepted; redirects, arbitrary download URLs,
oversized downloads and SHA-512 mismatches are rejected. Exactly one known
executable member is extracted, not arbitrary archive paths. An unauthenticated
isolated compatibility probe verifies the same restrictions as real inference.

During activation new Codex requests receive `codex_busy`/503 while existing
requests drain within a bounded deadline. Both profiles are restarted on the
candidate, retaining metrics, private logins and preferred account selection.
Connected accounts must remain usable. Failure rolls back to the previous
executable; activation-pointer failure also rolls back. Other backends continue
serving. Updates do not weaken tool restrictions or execute package scripts.

Actual `model/list` replies determine model IDs and thinking levels. New IDs need
no hardcoded whitelist change. Only newly discovered IDs are added to existing
Codex-enabled apps; explicitly excluded older models and apps that did not opt
into Codex are not re-authorized. Removed models fail unavailable, never silently
substitute another GPT model. Results list new/removed models, thinking changes
and the number of updated apps. The app thinking selector reflects discovery;
unsupported model/effort combinations still fail at dispatch.

To refresh the offline bundle, a maintainer updates the pinned `CODEX_RUNTIME_VERSION`, reviews the protocol and tests, then runs `node --import tsx scripts/vendor-codex.ts` from the repository root. Commit the resulting assets and manifest together with the pin. Dashboard-downloaded versions remain ignored
on that machine; they do not push binaries or credentials to Git.

## Account quota fallback

The admin-selected account remains preferred. General Codex 5-hour **or** weekly
exhaustion permits the other authenticated account, but only if it advertises
the exact requested model/effort and has available quota. The selection in
`accounts.json` never changes automatically. Fresh quota after reset restores
normal preference. Stale/unknown quota is not reported as zero or fabricated
capacity. If both accounts are exhausted, the app's existing authorized Gemini
fallback order applies. Authentication, unavailable model/effort, timeout,
restrictions and ambiguous rate-limit errors do not rotate accounts.

Response headers identify actual routing without account identities:
`x-gemrouter-codex-account`, `x-gemrouter-codex-account-fallback-from` and
`x-gemrouter-reasoning-effort`. Streaming remains buffered. Per-account metrics
count attempts: a quota-blocked preferred attempt plus one alternate completion
are not two client completions.

## Telegram alerts

Set `GEMROUTER_TELEGRAM_BOT_TOKEN` and up to two numeric
`GEMROUTER_TELEGRAM_CHAT_IDS` in ignored `.env` (0600). Supergroup IDs normally
include `-100`; verify IDs with the official `getChat` method. The bot must be a
member able to send to the group; the user must have started its private chat.
No webhook, incoming commands or polling listener is installed.

Alerts cover general Codex window exhaustion, sustained login/runtime loss,
three serious inference failures in five minutes, total account unavailability
and failed runtime activation. They use fixed slot IDs, safe reason codes and
reported reset times, never emails, prompts, responses, tokens or credential
URLs. Routine requests and isolated transient errors do not notify. Incidents
are deduplicated persistently per recipient; failed sends have a 15-minute
cooldown and do not block inference. Delivery state is admin-only under
`GET /admin/codex/alerts`. The Telegram token is never returned over HTTP.

Clients can read the cached state with `GET /dashboard/codex/runtime`. The admin mutations
`POST /admin/codex/runtime/check` and `POST /admin/codex/runtime/update` accept
only an empty JSON object. Existing login routes keep their authorization and
session ownership rules.

References: [official Codex app-server](https://learn.chatgpt.com/docs/app-server),
[official package](https://www.npmjs.com/package/@openai/codex),
[Telegram Bot API](https://core.telegram.org/bots/api#sendmessage).
