# API Surfaces

GemRouterFE exposes three compatibility families.

## OpenAI-Compatible

- `GET /v1/models`
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

- `gemini-web`
- `google/gemini-web`

These map to the same Gemini Web backend runtime.
