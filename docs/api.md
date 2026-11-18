# Client HTTP API

Give each integration its own GemRouter app key. An operator creates the app, selects its models and allowed browser origins, and supplies the key. Keep it on the application server and send it as `Authorization: Bearer <app-key>`. Dashboard credentials and provider keys serve separate roles. For a browser application, have your backend hold the key and call GemRouter on behalf of the signed-in user.

## Make a text request

Set `GEMROUTER_URL` to the deployment origin without a trailing slash, and load `GEMROUTER_APP_KEY` from your secret store. Use HTTPS for remote deployments. The following commands use the OpenAI surface.

```bash
export GEMROUTER_URL=http://127.0.0.1:4024

curl -fsS "$GEMROUTER_URL/v1/models" \
  -H "Authorization: Bearer $GEMROUTER_APP_KEY"

curl -fsS "$GEMROUTER_URL/v1/chat/completions" \
  -H "Authorization: Bearer $GEMROUTER_APP_KEY" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Reply with OK."}],"max_completion_tokens":64}'
```

The model list contains `data[].id` values visible to this app. Read a successful chat reply from `choices[0].message.content`. Supply `model` when a particular starting model matters. The built-in text default is `gemini-4-hydrogen`. The router can serve an authorized fallback when the requested text model is unavailable or outside the app's policy. An explicit Codex request requires the app's Codex permission and the requested model grant. Use `POST /v1beta/decisions` for `gemini-decision-1`. [Routing policy](routing.md) · [Codex permissions](codex-account.md)

For an OpenAI-compatible SDK, set its base URL to `$GEMROUTER_URL/v1` and its API key to the app key. With the unversioned GemRouter or DeepSeek surface, use the origin as the base URL. Operators choose which surfaces to enable. Fetch `GET /health` and inspect `compatibility.enabledSurfaces` for this deployment.

## Route reference

The paths below are relative to the origin. Client routes require an app key. A request with a browser `Origin` header must match the app's origin policy.

| Method and path | Input | Successful result |
| --- | --- | --- |
| `GET /v1/models`, `GET /models` | App key | App-filtered model list. A Decision entry includes its native endpoint. |
| `POST /v1/chat/completions`, `POST /chat/completions` | Nonempty `messages` array, optional `model` | Chat completion or server-sent events (SSE). |
| `POST /v1/responses` | `input` text or messages, optional `instructions`, `model`, `max_output_tokens` | Assistant text in `output[0].content[0].text` or Responses SSE events. |
| `POST /v1beta/decisions` | `model`, `input`, `questions` | Typed `answers` keyed by question ID and native Google `usage` when supplied. |
| `POST /v1/images/generations`, `POST /images/generations` | Authorized image model, `prompt`, optional `size`, `n: 1`, `response_format` | Gemini returns `data[0].b64_json` by default or a data URL for `url`. Agnes returns a provider URL. |
| `POST /v1/embeddings`, `POST /embeddings` | Configured local embedding `model` and `input` as one string or an array of strings | `data[].embedding` vectors with indices, model and estimated input usage. |
| `POST /v1/vision`, `POST /vision` | Chat messages containing text and inline image data | A synchronous chat completion from the configured local Ollama vision model. |
| `POST /v1/videos`, `POST /videos` | Authorized Agnes video `model`, `prompt` and optional `size` | Waits for the provider job and returns `data[0].url`, `size` and `seconds`. |
| `GET /api/version`, `GET /api/tags`, `POST /api/show` | Ollama surface. For show, supply `model` or `name`. | Compatibility version, models visible to the app, or model information. |
| `POST /api/chat`, `POST /api/generate` | Ollama `messages` or `prompt`, optional `model`, `format`, `options`, `stream` | Newline-delimited JSON by default. Set `stream: false` for one JSON response. |

GemRouter and DeepSeek share the unversioned model, chat and image routes. Either surface enables those paths. The OpenAI switch controls its model, chat, image and Responses routes. Decisions, local embeddings, local vision and Agnes video have their own provider availability checks. Ask the operator for the exact local models and enabled Agnes IDs when using these dedicated routes. The image route forwards `size` to Agnes. Gemini image requests currently use the provider's default dimensions. [Configuration](configuration.md)

## Messages, streaming and usage

Chat accepts the roles `system`, `developer`, `user` and `assistant`. The router maps `developer` to `system`. Send the conversation history the model should use on each request. The supported text contract is one completion per request. Nonempty tool lists are rejected. For structured text, provide `response_format` on chat or `text.format` on Responses and validate the returned JSON against your schema. Use the local vision endpoint for image interpretation through Ollama. It accepts an `image_url` content part with a base64 data URL alongside the user's text.

For chat SSE, set `stream: true`, read `choices[].delta.content`, and consume the stream through its terminal event. Set `stream_options.include_usage: true` to request a usage chunk when available. Responses streams emit events such as `response.output_text.delta` and `response.completed`. Ollama streams use one JSON object per line and a final `done: true` record. The Gemini and Codex clients buffer the provider result before delivering generated text. Applications consuming streams should handle errors after the initial HTTP 200.

On nonstreaming text responses, inspect `x-gemrouter-backend`, `x-gemrouter-backend-model` and, when supplied, `x-gemrouter-fallback-reason` to identify which backend actually answered. Streaming headers can carry only the information available when the stream opens. Keep the `x-request-id` for correlation with the operator.

Chat and Responses usage for Gemini, NVIDIA and Ollama is estimated from text length. Codex uses measured upstream tokens when available. Decision responses use Google's input and output counters. Operators can inspect recent text interaction prompts and replies in the dashboard. Treat submitted content accordingly. [Guest and operator telemetry](operations.md)

## Classify input with Gemini Decision 1

Use this route with a standard app key that has access to `gemini-decision-1`. Send between one and 1,000 named questions over the same input. The question types are `noul` for a yes/no decision, `choice` for a single selection and `score` for a rubric. Supply text or inline media. GemRouter rejects provider file URIs because provider accounts are shared across applications. [Google Decisions request and response formats](https://aistudio.google.com/docs/decisions-api)

```bash
curl -fsS "$GEMROUTER_URL/v1beta/decisions" \
  -H "Authorization: Bearer $GEMROUTER_APP_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model":"gemini-decision-1",
    "input":"My mug arrived cracked.",
    "questions":{"damaged":{"type":"noul","instructions":"Did the item arrive damaged?"}}
  }'
```

Read the probability from `answers.damaged.noul` and the confidence from `answers.damaged.confidence`. Decision usage can have positive `total_input_tokens` with zero `total_output_tokens`.

## Diagnostics and errors

| Route | Access | Meaning |
| --- | --- | --- |
| `GET /health` | Public | Runtime snapshot and enabled compatibility surfaces. HTTP success confirms the router answered. A successful inference verifies a specific model. |
| `GET /dashboard/summary` | Public | Guest overview with aggregate activity and usage. |
| `GET /v1/provider/models` | App key | App-filtered entries from the provider catalog with capability and availability fields. |
| `GET /v1/provider/runtime`, `GET /v1/provider/quota` | App key | Runtime routing data and shared pool quota observations. Local remaining quota is an estimate for each project group and model. |
| `GET /v1/provider/nvidia/scoreboard` | App key | NVIDIA model telemetry when configured. |

Most router-generated HTTP errors contain `error.code`, `error.message` and `error.type`. Framework-level errors and stream events can use a different envelope.

| Status | Common cause | Client action |
| --- | --- | --- |
| 400 | Invalid input or incompatible endpoint | Check the model, content shape and supported features. |
| 401 / 403 | Missing, invalid or revoked app key, disallowed origin or missing model access | Check the key and app policy with the operator. |
| 404 | Disabled surface or unavailable model | Check enabled surfaces and the model ID. |
| 429 | App rate or concurrency limit, or exhausted provider quota | Inspect the error code. Reduce concurrency or retry with bounded backoff when capacity can return. |
| 502 / 503 / 504 | Upstream failure, unavailable backend or deadline | Record the request ID. A timeout can arrive after upstream dispatch, so a retry can consume additional quota or create another media job. |
