# Operate GemRouter

Run one GemRouter process per writable state directory. App permissions, provider budgets and request admission are coordinated inside that process. Two servers pointing at the same JSON files can overwrite each other's updates. For a migration, give the target its own state and switch traffic after it passes the client and provider checks.

## Process and service ownership

A foreground installation starts with `pnpm start` after `pnpm build`. The Linux helper selects Node, checks for pnpm, builds when its freshness check requires it, and runs the compiled entry point. [Start helper](../scripts/start-gemrouter.sh)

Determine which systemd manager owns an existing installation before upgrading it. Run the first command as the deployment user.

```bash
systemctl --user show gemrouter.service -p LoadState -p FragmentPath -p UnitFileState -p ActiveState
systemctl show gemrouter.service -p LoadState -p FragmentPath -p UnitFileState -p ActiveState
```

For a user service, use `systemctl --user` and `journalctl --user`. Check whether the service starts at boot and can run without an interactive session.

```bash
systemctl --user is-enabled gemrouter.service
systemctl --user is-active gemrouter.service
loginctl show-user "$(id -un)" -p Linger
systemctl --user list-timers --all gemrouter-nightly-restart.timer
journalctl --user -u gemrouter.service --since '20 minutes ago' --no-pager
```

An enabled user unit with lingering enabled can start when the machine boots. For a system service, use the system manager and its journal instead. [systemd user lingering](https://www.freedesktop.org/software/systemd/man/latest/loginctl.html)

### Bundled system service and tunnel

The repository installer copies four units into `/etc/systemd/system/`, reloads the manager and immediately enables and starts the router, restart timer and Cloudflare tunnel. It requires sudo. Prepare deployment-specific copies of the templates before running the installer on a new host. The script overwrites same-named system units. [Installer and templates](../ops/systemd/)

- Set `User`, home, working directory, environment file, Node and pnpm paths for the actual service account. The main unit builds in `ExecStartPre`, so its environment needs the build dependencies.
- Set the cloudflared binary path and the tunnel ID in `ExecStart`. Use the same ID in the private YAML and supply the actual hostname and credential-file path. Match the ingress origin port to the router listener. The tracked example includes a terminal 404 rule. [Tunnel configuration](../ops/cloudflared/gemrouter.example.yml)
- The sample timer specifies 03:30 in the host timezone and sets `Persistent=true`. Inspect the next occurrence on the target with `systemd-analyze calendar '*-*-* 03:30:00'`. The nightly service restarts the **system** router. User deployments need a unit targeting the user manager. [Calendar expressions](https://www.freedesktop.org/software/systemd/man/latest/systemd.time.html)
- Use a private umask for runtime state. For a systemd deployment, `UMask=0077` in the service section protects newly created credential and telemetry files. Check existing file modes after importing or migrating data.

For a release, install from the lockfile, run checks and build in a separate checkout, then install the prepared build and restart through the owning manager. The supplied main unit uses `KillMode=mixed` and a ten-minute stop timeout. The Node process calls Fastify's close handler on SIGTERM. A single-instance restart still has a gap before its replacement accepts requests.

## Check a release

1. Verify `GET /health` against the loopback listener, then against the public origin. These checks isolate listener and tunnel faults.
2. With the intended app key, check the catalog, send a small generation and inspect the response's backend and served model. A successful downgrade confirms service availability but a model-specific rollout also needs an exact served-model match. Follow [the client verification steps](setup.md#verify-the-listener-app-and-provider).
3. For a permission change, check one affected app and one app outside the change. Look at the active app catalog and request outcomes. For an account-specific Gemini change, compare discovery and a bounded inference probe. [Account census](gemini-account-census.md)
4. After a restart, check the model order, app grants and account settings again. Review the operator summary for new provider errors and the guest dashboard for aggregate traffic. An `all` app follows the changing catalog, while a `custom` app follows its saved grants; Codex also requires per-app enablement.

## State and retention

| Location under the default layout | What it holds |
| --- | --- |
| `.env` | Server, provider and bootstrap secrets, runtime defaults |
| `data/apps.json` | App identities, key hashes and access policies. App key creation and rotation return the raw value once. |
| `data/gemini-api-accounts.json` | Gemini credentials, quota groups, priority, enablement and per-key model policy |
| `data/model-config.json`, `data/compatibility.json` | Ordered Gemini text catalog and compatibility surface selections |
| `data/gemini-api-quota-ledger.json` | Shared per-group/model quota events and cooldowns |
| `data/gemini-api-models-cache.json`, `data/gemini-api-account-models.json`, `data/free-tier-policy.json` | Discovery results, per-account model observations and pricing monitor state |
| `data/interactions.json` | Up to 1,000 recent interactions, including prompt and reply excerpts, plus hourly token aggregates retained for 72 hours |
| `data/audit.log` | Append-only operational events during normal operation. Plan rotation and access control at the host level. |
| `data/nvidia-models.json`, `data/nvidia-scoreboard.json`, `data/ollama-local-usage.json`, `data/agnes-usage.json` | Optional providers' model catalogs, observations and counters |
| `data/proxy-config.json` | Operator-managed proxy settings, potentially including credentials |
| `GEMROUTER_CODEX_PRIVATE_DIR`, `.runtime/` | Private Codex profile and state, and managed runtime files. Document their actual paths for recovery. |

Service units, tunnel configuration and credentials can live outside the checkout. Some providers resolve their own paths against the project root even when `GEMROUTER_DATA_DIR` has been changed. Inventory actual paths before moving installations. [Configuration reference](configuration.md)

## Back up and restore

The operator UI and the admin-authenticated routes support a portable configuration snapshot. The export contains plaintext secrets and may contain interaction excerpts. Keep the downloaded file in restricted storage; use the hosting environment's encryption and retention policy.

| Operation | Behavior |
| --- | --- |
| `GET /v1/admin/backup/summary` | Counts eligible files and bytes, environment entries, active apps and configured accounts. |
| `GET /v1/admin/backup/export` | Downloads `gemrouter.cfg` as JSON with the root `.env` and eligible files under the configured data directory, read as UTF-8. Individual files over 32 MiB or unreadable files appear in `skipped`. |
| `POST /v1/admin/backup/import` | Accepts the same JSON format with a 64 MiB request-body limit. Copies existing data and `.env` to `backups/pre-import-<timestamp>/`, writes inputs over matching files and reports `skippedPaths`. Files absent from the import remain on the target. On success the process exits after about 800 ms. A supervisor with `Restart=always` brings it back; restart a foreground process manually. |
| `GET /v1/admin/backup/private-download/:filename` | Serves a separately prepared owner-only `gemrouter-private-<timestamp>[-<hex>].tar.gz` already present in `backups/private/`. Archive creation and off-host storage are operator tasks. |

The portable export skips symlinks during traversal and excludes the private Codex profile directory, the managed runtime and the archived ChatGPT gateway directories. Back up out-of-tree provider files, private account state, tunnel credentials and service definitions separately if required for recovery. App hashes restore verification of existing client keys. Preserve the client copies of issued keys.

Check the actual export size and its `skipped` list. An export can exceed the import route's total size limit even when each individual file fits. Use a consistent filesystem backup during a maintenance window when a full deployment includes larger files or must represent one point in time. Verify sufficient free space for the pre-import copy. Import writes files in sequence, so a storage failure can leave a partial restore.

Rehearse recovery in a separate, access-controlled installation. Use a separate port and storage directory, keep its tunnel disconnected, and account for deployment-specific paths and background providers before starting it. Verify app authentication, model order, quotas, account policies and an authorized inference. Check the service manager after the import exits. Retain the previous usable backup until these checks pass. [Backup implementation](../src/lib/backup.ts) · [Private archive downloads](../src/lib/privateBackupDownload.ts)

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Service fails before binding | Working directory, `.env` location, required router credentials, file ownership, installed Node version, and journal output from the build or startup step. |
| Browser login works but client calls fail | Client bearer key, app status, allowed origin for browser calls, and the enabled compatibility surface. |
| HTTP 429 | Determine whether the error concerns the app rate or concurrency limit, the local Gemini ledger, or Google. Inspect `/v1/provider/quota` with a client key and account details as an admin. Clearing a local cooldown cannot change Google's project quota. |
| HTTP 503 or an unexpected served model | Check the returned backend/model, app grants, provider availability, strict-model policy, remaining request time, per-account eligibility and high-demand cooldowns. |
| One account is selected more often | Recheck configured priority first. For equal priority, the scheduler uses remaining capacity and recent failures. Ensure keys sharing a Google project use one quota group and maintain appropriate group limits. |
| Dashboard changes disappear after restart | Inspect service-level environment overrides, the bootstrap policy and account-source precedence. A nonempty advanced environment key list takes priority over dashboard-managed keys. [Account configuration](configuration.md#gemini-credentials-and-quotas) |
| Tunnel fails but local health succeeds | Check the tunnel unit and journal in its own service manager, secret-file permissions, tunnel ID, hostname, DNS and ingress origin. |
