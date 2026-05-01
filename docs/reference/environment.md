# Environment Map

Use `.env.example` as the authoritative reference.

This page groups the environment surface by role.

## Dashboard and Admin

- dashboard enablement
- admin token
- dashboard user list
- admin session TTL

## Provider Access

- bootstrap API key
- bootstrap app name
- allowed origins
- allowed models
- rate limit
- concurrency limit

## Compatibility

- default surface
- enabled surfaces
- backend order
- fallback enablement

## Gemini CLI Runtime

- CLI enablement
- CLI binary path
- CLI model
- CLI timeout
- CLI workdir
- cached auth expectations
- user home and `.gemini` auth directory
- bootstrap visibility flags

## Playwright Runtime

- browser executable path
- base profile directory
- profile namespace
- profile import path
- headed or headless mode

## Session Lifecycle

- max tabs
- conversation TTL
- responded-tab TTL
- orphan-tab TTL
- concurrency wait time

## Public URLs

- public base URL
- noVNC public URL

Keep environment values deployment-specific. Avoid baking real deployment addresses into reusable documentation.
