# Configuration

LeakRouter uses `.env` variables with the `LEAKROUTER_` prefix. Older `GEMROUTER_` variables are tolerated only as migration fallbacks.

## Server

| Variable | Default | Description |
|---|---:|---|
| `HOST` / `LEAKROUTER_HOST` | `0.0.0.0` | Bind address |
| `PORT` / `LEAKROUTER_PORT` | `4024` | HTTP port |
| `LEAKROUTER_ROOT_DIR` | cwd | Repository root |
| `LEAKROUTER_DATA_DIR` | `data` | Writable runtime data |
| `LEAKROUTER_PUBLIC_BASE_URL` | inferred | Public URL shown in metadata |

## Secrets

| Variable | Description |
|---|---|
| `LEAKROUTER_ADMIN_TOKEN` | Admin bearer token and fallback admin password |
| `LEAKROUTER_DASHBOARD_ADMIN_USERS` | Comma-separated `username:password` pairs |
| `LEAKROUTER_BOOTSTRAP_API_KEY` | Client bearer token for inference |

## Client App Policy

| Variable | Default | Description |
|---|---:|---|
| `LEAKROUTER_BOOTSTRAP_ALLOWED_ORIGINS` | localhost origins | CORS allowlist |
| `LEAKROUTER_BOOTSTRAP_ALLOWED_MODELS` | all configured models | Optional model allowlist |
| `LEAKROUTER_BOOTSTRAP_RATE_LIMIT_PER_MINUTE` | `30` | Per-app RPM |
| `LEAKROUTER_BOOTSTRAP_MAX_CONCURRENCY` | `2` | Per-app concurrency |

## Routing

```env
LEAKROUTER_BACKEND_ORDER=ollama,deepseek-api
```

Supported modes:

| Mode | Description |
|---|---|
| `ollama` | Routes to authorized Ollama endpoints from the local inventory |
| `deepseek-api` | Routes to the DeepSeek OpenAI-compatible API |

## Ollama

| Variable | Default | Description |
|---|---:|---|
| `LEAKROUTER_OLLAMA_ENABLED` | `true` when inventory exists | Enable Ollama routing |
| `LEAKROUTER_OLLAMA_INVENTORY_PATH` | `ollama-model-inventory.json` | Private inventory file |
| `LEAKROUTER_OLLAMA_TIMEOUT_MS` | `120000` | Request timeout |
| `LEAKROUTER_OLLAMA_STREAM_TIMEOUT_MS` | `180000` | Streaming timeout |

The admin UI and model endpoints expose model names and aggregate counts only. Upstream endpoint URLs stay server-side.

## DeepSeek API

| Variable | Default | Description |
|---|---:|---|
| `LEAKROUTER_DEEPSEEK_ENABLED` | based on key presence | Enable DeepSeek API |
| `LEAKROUTER_DEEPSEEK_API_KEY` | — | DeepSeek secret |
| `LEAKROUTER_DEEPSEEK_BASE_URL` | `https://api.deepseek.com/v1` | OpenAI-compatible base URL |
| `LEAKROUTER_DEEPSEEK_MODELS` | `deepseek-chat,deepseek-reasoner` | Public model list |
| `LEAKROUTER_DEEPSEEK_DEFAULT_MODEL` | `deepseek-chat` | Fallback model |

## Compatibility Surfaces

```env
LEAKROUTER_COMPAT_DEFAULT_SURFACE=ollama
LEAKROUTER_COMPAT_ENABLED_SURFACES=openai,deepseek,ollama
```

Routes:

| Surface | Routes |
|---|---|
| OpenAI | `/v1/models`, `/v1/chat/completions`, `/v1/responses` |
| DeepSeek-style | `/models`, `/chat/completions` |
| Ollama | `/api/version`, `/api/tags`, `/api/show`, `/api/chat`, `/api/generate` |
