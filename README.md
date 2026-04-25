# GemRouterFE

<p align="center">
  <img src="./docs/assets/GemRouterFE_Docs_header.png" alt="GemRouterFE" width="960" />
</p>

<p align="center">
  <strong>Browser-backed Gemini Web router with OpenAI, DeepSeek, and Ollama compatible API surfaces.</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-24-43853D?logo=node.js" alt="Node.js"/>
  <img src="https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript" alt="TypeScript"/>
  <img src="https://img.shields.io/badge/Fastify-4-000000?logo=fastify" alt="Fastify"/>
  <img src="https://img.shields.io/badge/Playwright-Browser%20Runtime-2EAD33?logo=playwright" alt="Playwright"/>
  <img src="https://img.shields.io/badge/Gemini-Web%20Session-0B1220" alt="Gemini Web"/>
  <img src="https://img.shields.io/badge/OpenAI-Compatible-10A37F" alt="OpenAI surface"/>
  <img src="https://img.shields.io/badge/DeepSeek-Compatible-2563EB" alt="DeepSeek surface"/>
  <img src="https://img.shields.io/badge/Ollama-Compatible-111827" alt="Ollama surface"/>
  <img src="https://img.shields.io/badge/noVNC-Recovery%20Surface-7C3AED" alt="noVNC"/>
</p>

## Overview

`GemRouterFE` exposes one Playwright-managed Gemini Web session through provider-style HTTP APIs that existing clients already know how to call.

This repository is the product workspace for:

- the compatibility router
- the browser-backed Gemini runtime
- app and API-key policy management
- the operator dashboard
- recovery access through noVNC

It is not a native SDK wrapper and it is not pretending to be a different backend. The runtime is Gemini Web. The router shape is what changes.

## Core Product Capabilities

- OpenAI-compatible `models`, `chat/completions`, and `responses`
- DeepSeek-compatible `models` and `chat/completions`
- Ollama-compatible `version`, `tags`, `show`, `chat`, and `generate`
- Playwright-managed Gemini Web session reuse
- app-scoped API keys with model, origin, rate, and concurrency controls
- guest telemetry and admin controls in one dashboard
- prompt lab routed through the live browser session
- interaction logging with token estimates, latency, and feedback labels
- browser recovery path through noVNC

## Repository Layout

| Path | Role |
| --- | --- |
| [`src/`](./src) | router, dashboard, compatibility layers, runtime wiring |
| [`docs/`](./docs) | operator and product documentation |
| [`docs/assets/`](./docs/assets) | product branding and documentation images |
| [`ops/systemd/`](./ops/systemd) | user-systemd unit files |
| [`scripts/`](./scripts) | helper and smoke scripts |
| [`data/`](./data) | local runtime state, stores, and interaction logs |

## Quick Start

```bash
pnpm install
pnpm check
pnpm build
pnpm dev
```

Useful validation command:

```bash
pnpm smoke
```

The smoke flow validates health plus the OpenAI, DeepSeek, and Ollama surfaces, and exercises admin login when admin credentials are available.

## Dashboard Model

The dashboard has two clearly separated views.

### Guest View

Guest mode shows only aggregate telemetry:

- request volume
- success rate
- latency
- token volume
- compatibility-surface mix
- generic runtime health

Guest mode hides prompts, app names, API keys, and operator-only controls.

### Admin View

Admin mode exposes the operator console:

- apps and API keys
- compatibility surfaces
- prompt lab
- recent interactions
- runtime diagnostics
- browser session access
- recovery controls

noVNC stays separately protected.

## Documentation

The documentation set is split into topical pages under [`docs/`](./docs).

### Docs Index

- [Documentation Index](./docs/README.md)

### Getting Started

- [Product Overview](./docs/getting-started/overview.md)
- [Quickstart](./docs/getting-started/quickstart.md)
- [Configuration](./docs/getting-started/configuration.md)

### Architecture

- [System Overview](./docs/architecture/overview.md)
- [Browser Runtime](./docs/architecture/browser-runtime.md)
- [Dashboard Model](./docs/architecture/dashboard.md)

### Operations

- [Deployment](./docs/operations/deployment.md)
- [Security](./docs/operations/security.md)
- [Troubleshooting](./docs/operations/troubleshooting.md)

### Reference

- [API Surfaces](./docs/reference/api-surfaces.md)
- [Environment Map](./docs/reference/environment.md)
- [Repository Map](./docs/reference/repository-map.md)

## Notes

- `gemini-web` and `google/gemini-web` are aliases for the same backend
- the router exposes multiple API shapes over one Gemini Web browser runtime
- Ollama compatibility is route and envelope compatibility over Gemini Web, not a local Ollama engine
- dashboard and API access are intentionally separate from noVNC access
