# Quickstart

## Prerequisites

You need:

- Node.js
- `pnpm`
- a valid Gemini Web browser profile for Playwright to use
- a headed display path if you plan to run the browser visibly

## Install

```bash
pnpm install
```

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
- admin login and summary when admin credentials are configured

## Open the Dashboard

Open the router base URL in a browser.

Guest mode loads first. Admin mode requires the configured dashboard credentials.

## First Operator Checks

After startup, verify:

1. browser profile is ready
2. Gemini Web session is still authenticated
3. health reports the enabled compatibility surfaces you expect
4. prompt lab can complete a simple request
5. smoke checks pass against the target environment
