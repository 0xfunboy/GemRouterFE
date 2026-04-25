# Browser Runtime

The browser runtime is the core of GemRouterFE.

## Execution Model

The runtime opens Gemini Web through Playwright and keeps a persistent browser profile available for later requests.

It does not rely on a native Gemini server API.

## Persistent Profile

The browser profile carries the authenticated Gemini state.

This profile is what makes the router usable across requests without forcing a new sign-in for every call.

## Session Keys

Requests are mapped to session keys so that the router can:

- isolate app traffic
- reuse conversation context when needed
- avoid tab collisions between unrelated clients

## Locking

The runtime uses per-session locking so two overlapping writes do not corrupt the same Gemini conversation.

## Tab Lifecycle

Tabs are not all treated equally.

GemRouterFE can distinguish between:

- tabs that already produced a response
- tabs that are still busy
- orphaned tabs that no longer matter operationally

This lets the router close successful tabs on a shorter timer and clean up stale tabs more aggressively.

## Failure Modes

The browser runtime can fail in ways that a normal API backend would not:

- Gemini sign-out
- upstream UI changes
- DOM parsing drift
- stuck tabs
- display issues in headed mode

This is why runtime diagnostics and recovery tooling are part of the product, not optional extras.
