# Security

GemRouterFE controls a real authenticated Gemini Web session. Treat it as a privileged runtime.

## Protect These Separately

- dashboard credentials
- admin token
- bootstrap API key
- app keys
- noVNC access
- browser profile data

## Operational Rules

- keep secrets in environment configuration, not in the repo
- rotate app keys when exposure is suspected
- keep guest mode generic
- reserve admin mode for operators
- do not collapse dashboard auth and noVNC auth into one visible browser flow

## API Key Scope

Use app policies to reduce blast radius:

- restrict origins
- restrict models
- keep concurrency low where possible
- isolate clients with session namespaces

## Browser Profile Handling

The profile is effectively a credential store for Gemini Web.

Protect it accordingly:

- isolate it from unrelated browsing
- avoid copying it unnecessarily
- control filesystem access tightly
- do not expose profile paths in public-facing material
