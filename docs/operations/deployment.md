# Deployment

GemRouterFE is typically deployed as a long-running Node.js service with a persistent Playwright profile and a separately protected browser-recovery path.

## Core Deployment Requirements

- Node.js runtime
- browser executable available to Playwright
- persistent filesystem for the profile and local stores
- headed display path when running with a visible browser
- protected external access for API, dashboard, and noVNC

## Service Shape

A typical deployment includes:

- the GemRouterFE process
- the Playwright-controlled browser
- optional tunnel or reverse proxy
- optional noVNC surface for manual recovery

## What Must Persist

Do not treat these as disposable between normal restarts:

- browser profile
- app store
- compatibility store
- interaction store
- audit log

## Deployment Checklist

1. confirm the browser executable path
2. confirm profile availability
3. confirm admin credentials are set
4. confirm bootstrap API key is set
5. confirm enabled compatibility surfaces
6. confirm dashboard and noVNC are separately protected
7. run `pnpm smoke`

## After Deployment

After the service is live, verify:

- health endpoint
- one request on each compatibility surface
- dashboard guest view
- dashboard admin login
- browser recovery path
