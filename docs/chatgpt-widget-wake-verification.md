# Widget wake: archived experiment

The complete prototype, build/lockfile, tests, operator commands, deployment
example and chronological evidence are preserved in:

- Branch: `archive/widget-wake-probe-2026-09-16`
- Commit: `165a7b01bf083ed95d4eb58c38c5f428cbec591c`
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

Source cleanup is not a deployment. At cleanup time, the existing temporary
`gemrouter-widget-wake-probe.service` user unit and its ingress were **not**
stopped/reloaded: authorization for that live cleanup was requested separately.
The process has no automatic restart (`Restart=no`); do not manually restart it
from this checkout after removing the prototype sources. Its already-loaded
code, ignored `build/`/`node_modules/` and private state are not a new live test.

After explicit authorization, stop **only** that temporary user unit, remove
the `/widget-wake-probe/*` ingress in `ops/cloudflared/gemrouter.yml`, and reload
or restart **only** `cloudflared-gemrouter`. That tunnel may briefly reconnect.
Do not restart `gemrouter.service`, modify AIR3 or revoke its MCP grant as part
of this cleanup. Preserve private profiles; remove generated widget artifacts
only after the transient process has stopped.
