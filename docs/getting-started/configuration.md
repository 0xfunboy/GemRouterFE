# Configuration

Use `.env.example` as the canonical reference.

The configuration is easier to reason about if you treat it in groups.

## Core Service

These values define the basic router process:

- port
- public base URL
- dashboard enablement

## Admin Access

These values control dashboard authentication and session lifetime:

- admin token
- dashboard credential list
- admin session TTL

## Provider Access

These values define the bootstrap application and API access defaults:

- bootstrap API key
- bootstrap app name
- allowed origins
- allowed models
- rate limit
- concurrency limit

## Compatibility Surfaces

These values define the API shapes the router exposes:

- default compatibility surface
- enabled compatibility surfaces

## Browser Runtime

These values control the Playwright-backed Gemini session:

- browser executable path
- base profile directory
- profile namespace
- profile import path
- headless or headed mode

## Session Lifecycle

These values control browser tab and conversation retention:

- max tabs
- conversation TTL
- responded-tab TTL
- orphan-tab TTL
- concurrency wait window

## Practical Guidance

- Keep secrets out of the repo.
- Keep noVNC credentials separate from dashboard credentials.
- Use the smallest app policy that still satisfies the client.
- Treat browser-profile paths as deployment details, not product-facing constants.
