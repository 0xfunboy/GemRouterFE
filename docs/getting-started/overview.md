# Product Overview

GemRouterFE is a compatibility router for Gemini Web.

It uses a Playwright-managed browser session as the real execution backend, then exposes multiple API surfaces on top of that same runtime.

## What Problem It Solves

Many existing clients already speak one of these API styles:

- OpenAI
- DeepSeek
- Ollama

GemRouterFE lets those clients keep their existing request format while routing the actual work through Gemini Web.

## What It Contains

GemRouterFE combines:

- the HTTP router
- per-app authentication and policy
- a browser-backed Gemini runtime
- an operator dashboard
- browser recovery access through noVNC

## What It Is Not

GemRouterFE is not:

- a wrapper around the official Gemini API
- a local Ollama runtime
- a generic AI portal
- a stateless proxy with no browser awareness

The browser is the backend. The compatibility surfaces are the transport layer.

## Main Product Surfaces

### Compatibility APIs

The router exposes OpenAI-, DeepSeek-, and Ollama-compatible routes.

### Operator Dashboard

The dashboard provides guest telemetry plus authenticated admin controls.

### Browser Recovery

When Gemini Web authentication or session state needs attention, operators can open the browser through noVNC.

## Why Browser State Matters

Gemini Web is not called through a native server SDK here. The runtime depends on:

- a persistent browser profile
- a real authenticated Gemini session
- conversation and tab lifecycle management
- DOM-driven response capture

This is why GemRouterFE includes diagnostics, session lifecycle controls, and recovery tooling instead of pretending the backend is stateless.
