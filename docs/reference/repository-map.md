# Repository Map

| Path | Purpose |
| --- | --- |
| `src/index.ts` | HTTP server and compatibility routes |
| `src/config.ts` | Environment loading and runtime config |
| `src/llm/router.ts` | Gemini API routing and fallback state |
| `src/llm/providers/gemini-api/` | Gemini API key-pool backend |
| `src/lib/openai.ts` | OpenAI-compatible request parsing and responses |
| `src/lib/ollama.ts` | Ollama-compatible request parsing and responses |
| `src/store/` | App, audit, compatibility, and interaction state |
| `scripts/start-gemrouter.sh` | Production-oriented start helper |
| `scripts/smoke.sh` | End-to-end smoke checks |
| `ops/systemd/gemrouter.service` | User service template |
