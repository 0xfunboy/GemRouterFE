# API Surfaces

GemRouterFE exposes three compatibility families.

## OpenAI-Compatible

- `GET /v1/models`
- `GET /v1/provider/runtime`
- `GET /v1/provider/models`
- `GET /v1/provider/quota`
- `POST /v1/chat/completions`
- `POST /v1/responses`

## DeepSeek-Compatible

- `GET /models`
- `POST /chat/completions`

## Ollama-Compatible

- `GET /api/version`
- `GET /api/tags`
- `POST /api/show`
- `POST /api/chat`
- `POST /api/generate`

## Authentication Notes

- Bearer auth is supported on the OpenAI and DeepSeek style routes
- Basic auth is supported for Ollama-style clients that expect that pattern

## Model IDs

Common exposed aliases:

- `gemini-2.5-pro`
- `gemini-2.5-flash`
- `gemini-2.5-flash-lite`
- `gemini-web`
- `google/gemini-web`

The `gemini-web` aliases map to the Playwright Gemini Web runtime.
The `gemini-2.5-*` IDs map to the embedded direct backend that reuses Gemini CLI auth cache files.
