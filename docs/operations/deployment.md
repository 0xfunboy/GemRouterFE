# Deployment

GemRouter deploys as a normal long-running Node.js service.

## Expected runtime

- Node `23.3.0`
- `pnpm`
- writable `data/` directory
- configured `.env`

## Start options

Local:

```bash
pnpm start
```

Service helper:

```bash
./scripts/start-gemrouter.sh
```

Systemd templates:

- `ops/systemd/gemrouter.service`
- `ops/systemd/gemrouter-nightly-restart.service`
- `ops/systemd/gemrouter-nightly-restart.timer`
- `ops/systemd/cloudflared-gemrouter.service`

Systemd installer:

```bash
bash ./ops/systemd/install-gemrouter-services.sh
```

The restart schedule is handled with `systemd` timers at `03:30`, matching the service-oriented style used by the other local packages.
