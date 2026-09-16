# Widget wake: archived experiment

The complete prototype, build/lockfile, tests, operator commands, deployment
example and chronological evidence are preserved in:

- Branch: `archive/widget-wake-probe-2026-09-16`
- Commit after the authorized privacy rewrite: `12af0c3faa5402b5d5c2f32db604f812b1497e48`
- Report in that branch: `docs/chatgpt-widget-wake-verification.md`
- Code in that branch: `experiments/chatgpt-widget-wake/`

Verdict: **NO-GO NELLE CONDIZIONI TESTATE**. The manual baseline produced a
model-issued `gateway_status`, as reported by the operator. The remote event
reached the widget and the documented bridge alias resolved, but the operator
observed no new message/turn/tool call. A 24-hour session did not solve it. The
second wake after inactivity was not reached. No live inference was verified.

Inspect without changing the running checkout:

```sh
git show archive/widget-wake-probe-2026-09-16:docs/chatgpt-widget-wake-verification.md
```

This branch also preserves the preceding personal-chat/browser controller work
for recovery. Neither experiment is part of the active implementation. Private
profiles, runtime credentials, one-time codes, databases and generated artifacts
were excluded from the commit; 59 staged files were scanned for private paths,
private keys, JWTs and common credential formats, with no detections. This is a
scoped secret check, not a guarantee about arbitrary encoded data in all history.

Codex is now implemented as an independent inference provider; see
[codex-account.md](codex-account.md). No MCP grant is required or modified by it.

## Operational boundary

After explicit authorization on 2026-09-16, the temporary widget user service was
stopped, its ingress removed and the tunnel gracefully restarted. The retired
endpoint returns 404. Generated widget assets were moved to a private local rollback
directory. Source, tests and chronological evidence remain in the sanitized archive.

GemRouter was separately deployed with the Codex inference provider; see the
[production verification](codex-verification.md). Existing private profiles,
MCP grants and the archived database remain intact but are unused by the new
provider. No old experiment can consume inference requests in this source tree.

The public archive substitutes synthetic identifiers, example hostnames and
placeholder home paths. Original unpublished snapshots exist only in a private
local recovery bundle. Do not treat archived example URLs as usable connections.
