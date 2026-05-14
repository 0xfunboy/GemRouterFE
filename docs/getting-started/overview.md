# Overview

GemRouter is a backend router for Gemini traffic.

It accepts client requests over compatible HTTP APIs and routes them through the configured Gemini API key pool.

The primary use case is Gemini API key pooling with automatic fallback when a key is exhausted, rate-limited, auth-failed, or temporarily unavailable.

GemRouter is intentionally backend-only:

- no browser automation
- no Gemini Web scraping
- no remote desktop tooling

The admin UI is only a thin operator surface on top of the backend APIs.
