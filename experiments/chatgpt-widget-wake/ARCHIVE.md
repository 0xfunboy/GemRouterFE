# Widget wake experiment archive — 2026-09-16

This branch preserves the complete widget microtest, its lockfile, simulated
tests, operator commands, ingress example and chronological live evidence in
`docs/chatgpt-widget-wake-verification.md`.

Verdict: **NO-GO NELLE CONDIZIONI TESTATE**. Manual interaction produced a
model-issued `gateway_status`, reported by the operator. Remote delivery and a
resolved `openai.sendFollowUpMessage` did not produce a visible new message or
model turn. Increasing the session lifetime to 24 hours did not change that.
The later idle test was not reached. No inference completion is claimed.

For recoverability, this snapshot also includes the preceding, uncommitted
personal-chat controller/browser experiment and its documentation. That is
historical context, not a dependency or a successful alternative. The active
checkout removes those experiments and retains only Codex account onboarding
and usage diagnostics as preparation for a separate inference experiment.

No credentials, one-time authorization codes, Codex/browser profiles, SQLite
databases, production environment, compiled assets or dependency directories
belong in this archive. Private runtime profiles remain outside the repository.
Do not run this branch against a live database or deploy its ingress example
without explicit operational authorization.
