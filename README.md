# GemRouter

GemRouter is a self-hosted HTTP gateway for applications that share access to AI providers. Each application gets its own API key and model permissions. The gateway chooses an eligible provider account, tracks local quota usage and can move a text request to another permitted model when the first one is busy. Operators manage accounts, app keys, routing and usage from the built-in dashboard.

An OpenAI-compatible client can use `/v1/chat/completions` or `/v1/responses`. The root chat endpoints and the Ollama-compatible routes serve other clients. These interfaces implement a subset of the upstream APIs. For example, use plain text for Gemini chat, use a dedicated endpoint for vision, and expect Gemini and Codex chat streaming to deliver buffered text. [Client API and examples](docs/api.md)

## Run locally

Use Node.js **24.18.0** and pnpm **10.26.1**, the versions specified in `.nvmrc` and `package.json`. From a fresh checkout, install dependencies and create a private configuration file.

```sh
pnpm install --frozen-lockfile
touch .env && chmod 600 .env
```

For a first Gemini text request, set these entries in `.env`. Generate two different random local secrets and replace the Google key placeholder with a credential for your own project. The default data directory is `./data` and the default port is `4024`.

```dotenv
HOST=127.0.0.1
GEMROUTER_ADMIN_TOKEN=<random-operator-secret>
GEMROUTER_BOOTSTRAP_API_KEY=<different-random-client-secret>
GEMROUTER_GEMINI_API_KEYS=<google-project-api-key>
GEMROUTER_GEMINI_API_ACCOUNTS_PATH=data/gemini-api-accounts.json
```

```sh
pnpm build
pnpm start
```

In a second shell, set `GEMROUTER_APP_KEY` to the bootstrap client key or an app key created in the dashboard. The model list shows what that key can discover. Omitting `model` in the text example exercises the default selection. Include `model` when your application needs a particular starting model.

```sh
curl -fsS http://127.0.0.1:4024/health
curl -fsS http://127.0.0.1:4024/v1/models \
  -H "Authorization: Bearer $GEMROUTER_APP_KEY"

curl -sS -i http://127.0.0.1:4024/v1/chat/completions \
  -H "Authorization: Bearer $GEMROUTER_APP_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"Reply with OK."}],"max_tokens":128}'
```

Check the HTTP status and `x-gemrouter-backend-model` to see which model served the reply. For clients that take an OpenAI base URL, use `http://127.0.0.1:4024/v1`. The operator dashboard is at `/admin`. [Installation and initial configuration](docs/setup.md)

## Models and routing

| Workload | Entry point | Routing behavior |
|---|---|---|
| Text chat | `POST /v1/chat/completions`, `POST /v1/responses` | The built-in default is `gemini-4-hydrogen`. With both models enabled and permitted, busy Hydrogen can fall back to `gemini-3.8-flash`. Requests for a particular model start with that model when eligible. |
| Classification and scoring | `POST /v1beta/decisions` | Requires the `gemini-decision-1` grant. Returns typed answers and usage. Accepts text and inline media. |
| Optional text providers | Chat endpoints | NVIDIA NIM, configured Ollama servers and Codex each have their own routing rules. Codex requires provider enablement, a signed-in account and an app grant. |
| Images, video, vision, embeddings | Dedicated endpoints | Availability depends on the configured provider. Vision and embeddings use local Ollama. Agnes can serve image and video generation. |

Gemini admission is tracked per **quota group and model**. Put keys from the same Google project in the same group. A catalog entry confirms that the provider lists a model. A successful inference also verifies that the project could use it at the time of the test. For billing and current project limits, consult the provider. Local counters and dashboard token estimates serve operational monitoring. [Routing and quota](docs/routing.md) · [Google rate limits](https://aistudio.google.com/docs/rate-limits)

## Documentation

| Task | Guide |
|---|---|
| Integrate an application, interpret fallback headers or handle errors | [Client API](docs/api.md) |
| Set up a new installation or choose configuration values | [Setup](docs/setup.md) · [Configuration](docs/configuration.md) |
| Understand model selection, account discovery and quota accounting | [Routing](docs/routing.md) · [Architecture and workflow, in Italian](docs/architecture-workflow.md) |
| Deploy the service, operate the dashboard or recover configuration | [Operations](docs/operations.md) |
| Connect a Codex account or manage its runtime | [Codex provider](docs/codex-account.md) · [Runtime updates](docs/codex-runtime-updates.md) |
| Check which Gemini models individual accounts can actually use | [Account census](docs/gemini-account-census.md) |

## Development

```sh
pnpm check
pnpm test
pnpm build
```

The test suite includes local HTTP fixtures for authentication, routing, quota accounting and fallback. `pnpm smoke` targets a running service and can send real inference requests. Choose the target and credentials before running it. [Operations](docs/operations.md)

The repository's non-commercial license covers eligible original material. Third-party components retain their respective terms. [Licensing scope](LICENSING.md) · [License](LICENSE.md) · [Third-party notices](THIRD_PARTY_NOTICES.md)
