# Dashboard Model

The dashboard is an operator console, not a public chatbot UI.

## Guest Mode

Guest mode is safe to expose as generic telemetry.

It shows:

- aggregate requests
- success rate
- average latency
- token volume
- hourly throughput
- compatibility-surface mix
- high-level runtime health

It does not expose:

- prompts
- app names
- API keys
- operator-only controls

## Admin Mode

Admin mode adds the operational surfaces:

- apps
- API keys
- compatibility surfaces
- prompt lab
- recent interactions
- runtime diagnostics
- browser session access
- recovery tools

## Auth Model

Admin dashboard sessions are stored in an HttpOnly cookie after successful login.

That session is separate from noVNC access.

## noVNC

The dashboard can link to the browser, but it should not carry or inject the VNC password.

noVNC remains a separate protected surface because it grants direct visibility into the real browser backend.
