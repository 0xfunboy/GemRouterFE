# First Install

This page is the operator runbook for bringing up GemRouterFE on a brand-new machine.

## What the Repo Covers

The repository now contains the non-secret runtime shape for:

- Playwright browser bootstrap
- headed browser geometry
- Xvfb / x11vnc / noVNC user services
- systemd user-unit installation
- smoke validation

What still stays outside git by design:

- `.env` secrets and deployment URLs
- the VNC password file contents
- authenticated Gemini browser cookies and sessions
- Cloudflare tunnel and DNS setup
- OS packages such as `Xvfb`, `x11vnc`, `websockify`, and noVNC assets

## Prerequisites

You need:

- Node.js 24
- `corepack`
- `Xvfb`
- `x11vnc`
- `websockify`
- noVNC web assets available under `/usr/share/novnc`

## Clone and Install

```bash
git clone git@github.com:0xfunboy/GemRouterFE.git
cd GemRouterFE
corepack enable
pnpm install
pnpm setup:browser
```

`pnpm setup:browser` installs Playwright Chromium and links it to `~/.local/bin/google-chrome-stable`.

## Prepare Environment

Create the local environment file:

```bash
cp .env.example .env
```

Set at least:

- admin token
- bootstrap API key
- public base URL if you expose the router
- noVNC public URL if you expose the headed browser
- any Gemini direct auth OAuth values you intend to use

For a local headed setup, keep the repo defaults unless you have a reason to change them:

- `PLAYWRIGHT_VIEWPORT_WIDTH=1440`
- `PLAYWRIGHT_VIEWPORT_HEIGHT=960`
- `PLAYWRIGHT_DISPLAY=:99`
- `PLAYWRIGHT_XVFB_SCREEN=1440x960x24`
- `PLAYWRIGHT_VNC_PORT=5900`
- `PLAYWRIGHT_NOVNC_PORT=6080`

## Create the VNC Password

```bash
mkdir -p ~/.vnc
x11vnc -storepasswd ~/.vnc/passwd
```

Point `.env` at that path if you want a custom location.

## Install User Services

```bash
pnpm setup:systemd
systemctl --user start xvfb.service x11vnc.service novnc.service gemrouterfe.service
```

The installer writes user units for the current clone path, so the repo does not have to live at `~/GemRouterFE` specifically.

## First Login Paths

For the Playwright Gemini Web backend:

1. Open noVNC.
2. Sign in to Gemini in the headed browser if the profile is not already authenticated.
3. Confirm the prompt box is interactive.

For the Gemini direct backend:

```bash
pnpm setup:gemini-cli
pnpm login:gemini-cli
```

If direct auth is not ready, the router can still serve through Playwright when the browser profile is valid.

## Validate the Install

```bash
pnpm smoke:playwright
```

Then optionally:

```bash
pnpm smoke
```

What a good first install should show:

- `/health` returns `ok: true`
- `profileReady: true`
- headed browser services are active
- Playwright requests complete successfully

## Common First-Install Failures

- `node` or `pnpm` not found
  Fix the shell environment or install Node 24 correctly, then retry the service.

- noVNC opens but the browser is blank
  Check that `xvfb.service`, `x11vnc.service`, and `novnc.service` are running.

- browser opens but Gemini is signed out
  Log in through noVNC and keep the profile persisted under `.playwright/`.

- direct backend unavailable
  Run `pnpm login:gemini-cli`; this does not block Playwright fallback.
