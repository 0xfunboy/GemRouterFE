# System Overview

GemRouterFE has four main layers.

## 1. Compatibility Router

This layer accepts provider-style requests and maps them into the internal request model.

It is responsible for:

- route selection
- request parsing
- response reshaping
- surface-specific streaming behavior

## 2. Auth and Policy

This layer authenticates bootstrap keys and app keys, then applies policy:

- allowed models
- allowed origins
- rate limits
- concurrency limits
- session namespace separation

## 3. Browser Runtime

This layer runs the Playwright-managed Gemini session.

It handles:

- browser launch
- profile reuse
- conversation mapping
- tab lifecycle
- DOM-based response capture

## 4. Operator Surface

This layer exposes the dashboard and diagnostics:

- guest telemetry
- admin controls
- prompt lab
- interaction history
- browser recovery access

## End-to-End Flow

1. A request arrives on a compatibility route.
2. Auth and policy are applied.
3. The router creates or reuses a browser session key.
4. Gemini Web is driven through Playwright.
5. Output is normalized for the selected compatibility surface.
6. The interaction is recorded for diagnostics and audit.
