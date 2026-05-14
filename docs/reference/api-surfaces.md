# API Surfaces

GemRouter exposes three compatibility families.

## OpenAI-compatible

- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/responses`
- `GET /v1/provider/runtime`
- `GET /v1/provider/models`
- `GET /v1/provider/quota`

## DeepSeek-compatible

- `GET /models`
- `POST /chat/completions`

## Ollama-compatible

- `GET /api/version`
- `GET /api/tags`
- `POST /api/show`
- `POST /api/chat`
- `POST /api/generate`

All surfaces route into the same backend selection logic.
