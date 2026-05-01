# ElizaOS Client Configuration

Use this page when an `elizaOS` or `eliza-bair` client must call `GemRouterFE` over LAN.

These examples use generic placeholder values:

- router host: `192.168.1.50`
- router port: `4000`
- API key: `barb_example_key`

Replace them with your own deployment values.

## Recommended: DeepSeek Provider

If the character already works well with `deepseek`, this is the cleanest route.

Important:

- set `modelProvider` to `deepseek` in the character file
- point `DEEPSEEK_API_URL` to the router root
- do **not** append `/v1`

```env
# OpenAI Configuration
OPENAI_API_KEY=barb_example_key
OPENAI_API_URL=http://192.168.1.50:4000/v1
SMALL_OPENAI_MODEL=gemini-web
MEDIUM_OPENAI_MODEL=gemini-web
LARGE_OPENAI_MODEL=gemini-web
EMBEDDING_OPENAI_MODEL=text-embedding-3-small
IMAGE_OPENAI_MODEL=dall-e-3
USE_OPENAI_EMBEDDING=

# DeepSeek Configuration
DEEPSEEK_API_KEY=barb_example_key
DEEPSEEK_API_URL=http://192.168.1.50:4000
SMALL_DEEPSEEK_MODEL=gemini-web
MEDIUM_DEEPSEEK_MODEL=gemini-web
LARGE_DEEPSEEK_MODEL=gemini-web

# Ollama Configuration
OLLAMA_SERVER_URL=http://192.168.1.50:4000
OLLAMA_MODEL=gemini-web
USE_OLLAMA_EMBEDDING=
OLLAMA_EMBEDDING_MODEL=mxbai-embed-large
SMALL_OLLAMA_MODEL=gemini-web
MEDIUM_OLLAMA_MODEL=gemini-web
LARGE_OLLAMA_MODEL=gemini-web
```

Character example:

```json
{
  "modelProvider": "deepseek"
}
```

## OpenAI-Compatible Alternative

Use this only when the client must stay on the OpenAI provider path.

Important:

- `OPENAI_API_URL` should include `/v1`
- models should stay on `gemini-web`

```env
OPENAI_API_KEY=barb_example_key
OPENAI_API_URL=http://192.168.1.50:4000/v1
SMALL_OPENAI_MODEL=gemini-web
MEDIUM_OPENAI_MODEL=gemini-web
LARGE_OPENAI_MODEL=gemini-web
EMBEDDING_OPENAI_MODEL=text-embedding-3-small
IMAGE_OPENAI_MODEL=dall-e-3
USE_OPENAI_EMBEDDING=
```

Character example:

```json
{
  "modelProvider": "openai"
}
```

## Ollama-Compatible Alternative

Use this only when the client must stay on the Ollama provider path.

Important:

- `OLLAMA_SERVER_URL` must point to the router root
- do **not** append `/api`
- `elizaOS` appends `/api/...` itself

```env
OLLAMA_SERVER_URL=http://192.168.1.50:4000
OLLAMA_MODEL=gemini-web
USE_OLLAMA_EMBEDDING=
OLLAMA_EMBEDDING_MODEL=mxbai-embed-large
SMALL_OLLAMA_MODEL=gemini-web
MEDIUM_OLLAMA_MODEL=gemini-web
LARGE_OLLAMA_MODEL=gemini-web
```

Character example:

```json
{
  "modelProvider": "ollama"
}
```

## Embeddings

Recommended for `GemRouterFE`:

- leave `USE_OPENAI_EMBEDDING` blank
- leave `USE_OLLAMA_EMBEDDING` blank
- keep embeddings local unless you have a separate embedding backend

Why:

- `GemRouterFE` is built around Gemini Web chat-style compatibility
- the current router surfaces are focused on OpenAI chat/responses, DeepSeek chat, and Ollama chat/generate
- enabling OpenAI or Ollama embeddings in the client implies a real embedding endpoint that this router is not intended to emulate

If you need remote embeddings, point the client at a dedicated embedding service instead of the Gemini Web router.

## Model Selection

Use `gemini-web` unless you have a specific reason to use the alias.

Valid router-side model names:

- `gemini-web`
- `google/gemini-web`

Use the same model ID consistently across `SMALL`, `MEDIUM`, and `LARGE` unless you are intentionally routing different classes differently.

## LAN Notes

- use the router's LAN IP, not a public hostname, when the client is on the same private network
- keep the scheme as `http://` unless you have TLS terminated on the LAN address
- if the client and router are on different machines, confirm that the router listens on `0.0.0.0` and that the firewall allows the chosen port
