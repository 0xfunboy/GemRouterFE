# Quickstart

If this is a brand-new machine, start with [First Install](./first-install.md).

## Prerequisites

You need:

- Node.js 24 with `corepack`
- `Xvfb`
- `x11vnc`
- `websockify` with the noVNC web assets available under `/usr/share/novnc`
- a valid Gemini Web browser profile for Playwright to use, or operator access to log in through noVNC
- a headed display path if you plan to run the browser visibly

## Install

```bash
corepack enable
pnpm install
pnpm setup:browser
```

If you plan to expose the headed browser stack, create the VNC password file once:

```bash
mkdir -p ~/.vnc
x11vnc -storepasswd ~/.vnc/passwd
```

Install the repo-provided user services:

```bash
pnpm setup:systemd
```

This writes the user `systemd` units against the current clone path.

## Validate the Codebase

```bash
pnpm check
pnpm build
```

## Run in Development

```bash
pnpm dev
```

## Run Smoke Validation

```bash
pnpm smoke
```

Smoke validation exercises:

- `/health`
- OpenAI-compatible routes
- DeepSeek-compatible routes
- Ollama-compatible routes
- `admin/test-chat` when admin credentials are present

Use `pnpm smoke:playwright` when you want to prove the Playwright/Gemini Web path specifically; it uses `gemini-web` for the primary inference checks.
- admin login and summary when admin credentials are configured

## Open the Dashboard

Open the router base URL in a browser.

Guest mode loads first. Admin mode requires the configured dashboard credentials.

If Playwright has no authenticated Gemini session yet, open noVNC and log in interactively after the headed services are up.

## First Operator Checks

After startup, verify:

1. browser profile is ready
2. Gemini Web session is still authenticated
3. health reports the enabled compatibility surfaces you expect
4. prompt lab can complete a simple request
5. smoke checks pass against the target environment
