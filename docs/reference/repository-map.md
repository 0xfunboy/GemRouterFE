# Repository Map

## Top Level

| Path | Purpose |
| --- | --- |
| `src/` | application source |
| `docs/` | documentation set |
| `docs/assets/` | branding and documentation images |
| `ops/systemd/` | service unit files |
| `scripts/` | helper scripts |
| `data/` | runtime state and logs |

## Important Source Areas

| Path | Purpose |
| --- | --- |
| `src/index.ts` | Fastify server, routes, auth, dashboard endpoints |
| `src/ui.ts` | dashboard HTML shell |
| `src/lib/` | compatibility and response-normalization helpers |
| `src/llm/providers/tegem/` | Playwright-backed Gemini runtime |
| `src/store/` | apps, interactions, audit, compatibility, admin sessions |

## Operational Files

| Path | Purpose |
| --- | --- |
| `ops/systemd/gemrouterfe.service` | main service unit |
| `ops/systemd/solclawn-tunnel.service` | tunnel unit template in this repo |
| `scripts/smoke.sh` | local smoke validation |
