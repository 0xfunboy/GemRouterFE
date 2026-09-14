# Native ChatGPT MCP reverse-RPC gateway

GemRouter can expose an operator-managed ChatGPT conversation as an exact local model alias. The implementation is an in-process reverse-RPC gateway: an authenticated HTTP request becomes a durable job, and a dedicated ChatGPT conversation claims and completes that job through GemRouter's MCP endpoint.

This feature does **not** install or run Pi Agent/PiLink, does not call an OpenAI model API, and does not use an intermediate HTTP provider. It uses `@modelcontextprotocol/sdk` 1.30.0 and its Streamable HTTP transport directly inside GemRouter. The gateway application protocol is separately versioned as `1.0`; the MCP wire protocol is negotiated by the official SDK/client.

## Trust and capability statement

- A worker is one dedicated, persistent ChatGPT conversation. Earlier requests in that conversation can influence later requests. `user`, session IDs, and request IDs do not create isolated contexts.
- `declaredModel` and `declaredReasoning` are operator declarations. GemRouter cannot independently verify the ChatGPT model behind the conversation. Responses therefore report `modelVerification=operator_declared`.
- Token usage is unavailable and is omitted, never estimated. Request/response byte sizes and measured queue/processing latency are separate metrics.
- `stream: true` is OpenAI-compatible SSE but buffered: GemRouter waits for the complete validated MCP result before sending the HTTP 200 status and first event.
- The worker can return text. `response_format: {"type":"json_object"}` is gateway-validated after generation; it is not native constrained decoding. Tools, media, `json_schema`, `role:tool`, and request-level context reset are not supported.
- A ChatGPT error never falls back to Gemini, NVIDIA, Ollama, another alias, or a repair model.

## Enable safely

The feature is off by default. Configure a clean HTTPS origin which resolves to this GemRouter instance:

```dotenv
GEMROUTER_CHATGPT_ENABLED=true
GEMROUTER_CHATGPT_PUBLIC_BASE_URL=https://gemr.airewardrop.xyz
GEMROUTER_CHATGPT_DATA_DIR=./data/chatgpt-gateway
```

All OAuth metadata, token endpoints, and `/mcp/chatgpt/:workerId` are absent while the feature is disabled. HTTP is accepted only for `localhost`, `127.0.0.1`, or `::1` test origins.

Before enabling remotely:

1. Terminate TLS at a trusted reverse proxy and preserve the public `Host` header.
2. Ensure the proxy and remote client timeouts exceed the selected worker timeout. Raising Node's timeout cannot override a shorter external proxy timeout.
3. Restrict dashboard/admin access and protect the gateway data directory. If you make an out-of-band copy, treat it as secret material.
4. Use the normal authorized deployment/restart procedure. Dashboard registry changes apply live, but environment changes require a process restart.

## Guided onboarding (recommended)

Sign in at [GemRouter administration](https://gemr.airewardrop.xyz/admin) and open **ChatGPT MCP Gateway**. The Italian-language wizard provides three steps:

1. **Prepara**: enter a friendly chat name and model alias, select one existing GemRouter app, and confirm the persistent-context warning. GemRouter generates the worker ID, creates it disabled, then explicitly activates it and adds only its aliases to the selected app's model permissions. Existing app permissions are preserved; no OpenAI API key is required.
2. **Autorizza**: copy the generated MCP URL and use **Apri ChatGPT**. Enable developer mode if permitted, add the MCP connection, and complete OAuth. If GemRouter requests a login, it returns you safely to the pending authorization. Review the worker and approve (or cancel) consent. The wizard polls the server and only unlocks the next step when a non-revoked grant exists.
3. **Avvia la chat**: open a dedicated ChatGPT conversation, select the intended model and MCP connection, copy the prepared instructions, and send them. The wizard displays actual gateway contact/polling/claim state and the last completed request, not a simulated success. A real end-to-end check still requires a request from the authorized app and observation of that ChatGPT conversation.

Current official guidance describes **Settings → Security and login → Developer mode**, then **Plugins → +**; labels and availability can vary by account/workspace. These ChatGPT-side confirmations and the conversation start cannot be automated by this server. See [OpenAI's connection instructions](https://developers.openai.com/plugins/deploy/connect-chatgpt) and [OAuth requirements](https://developers.openai.com/plugins/build/auth). The OpenAI Docs review informed the wizard's steps and its explicit automation limits.

Use **Riprendi un collegamento** after a reload. Only the worker ID is kept in session storage—never OAuth tokens or claim handles. Expired pairing windows can be reopened; **Rigenera istruzioni** prepares a wake-up prompt without replacing the grant. Re-pairing an already authorized worker requires confirmation. Errors retain the selected worker so a partial setup can be resumed without creating duplicates. The UI supports keyboard focus, live status announcements, mobile layout, and clipboard fallback.

If the gateway is disabled, the wizard shows a short operator setup panel for `https://gemr.airewardrop.xyz`. It does not edit `.env`, deploy, or restart the server. The code remains usable at other origins configured through `GEMROUTER_CHATGPT_PUBLIC_BASE_URL`.

### Advanced worker management

The expandable advanced controls retain worker creation, aliases, declared model metadata, app allowlists, timeouts, versions, drain/release, and grant revocation. Advanced creation always starts disabled and does not implicitly modify app permissions. Access is allowed only when both are true:

   ```text
   app model policy permits alias
   AND worker.allowedAppIds contains authenticated app ID
   ```

   `modelAccess: all` does not bypass the worker allowlist.

Review and enable the worker, then choose **Pair** to open a short Dynamic Client Registration window for that exact worker. Pairing alone neither enables the worker nor grants inference access. OAuth uses Authorization Code + PKCE S256, exact redirect/resource binding, explicit consent, short-lived access tokens, scope-preserving rotating refresh tokens, revocation, and hashed-at-rest opaque secrets. Refresh tokens are issued only for grants containing `offline_access`.

Approving a replacement pairing revokes the prior grants and tokens and releases the existing run, fencing every old claim. Reopening requires `gateway_open`. Every worker has an independent OAuth resource and at most one live run. The MCP server exposes exactly three tools:

- `gateway_open`: idempotently opens the worker run without disclosing a competing run's handles.
- `gateway_exchange`: atomically completes the preceding claim and enters the next bounded poll.
- `gateway_status`: reads a passive status for the OAuth-bound worker only.

The generated prompt instructs ChatGPT to keep `run_id`, `exchange_id`, `request_id`, and `claim_token` inside MCP calls; retry an ambiguous transport failure with identical arguments at most three times; discard cancelled/expired claims; and stop on `released`.

## HTTP use

Only these inference surfaces support worker aliases:

```text
POST /v1/chat/completions
POST /chat/completions
GET  /v1/models
GET  /v1/chatgpt/capabilities?model=ALIAS
```

The app-authenticated model list exposes only aliases permitted by both policy layers. Other API surfaces reject explicit ChatGPT intent before model normalization or fallback.

Alias matching trims surrounding whitespace, lowercases ASCII-style IDs, accepts the ordinary `models/` compatibility prefix, and treats `chatgpt/ALIAS` as an explicit reserved selector for the stored bare alias. It never uses substring/fuzzy matching or prompt contents.

Text completion:

```bash
: "${GEMROUTER_BASE_URL:?Set the public GemRouter HTTPS origin}"
: "${GEMROUTER_API_KEY:?Set a key for an app authorized on the worker}"
: "${GEMROUTER_CHATGPT_ALIAS:?Set the exact configured worker alias}"

curl --fail-with-body --max-time 320 \
  "${GEMROUTER_BASE_URL%/}/v1/chat/completions" \
  -H "Authorization: Bearer ${GEMROUTER_API_KEY}" \
  -H "Content-Type: application/json" \
  -H "x-gemrouter-backend: chatgpt" \
  -H "Idempotency-Key: app-request-2026-09-14-001" \
  --data-binary @- <<JSON
  {
    "model": "${GEMROUTER_CHATGPT_ALIAS}",
    "messages": [
      {"role":"system","content":"Answer concisely."},
      {"role":"user","content":"Summarize the supplied text."}
    ]
  }
JSON
```

Buffered SSE:

```bash
curl --fail-with-body --max-time 320 -N \
  "${GEMROUTER_BASE_URL%/}/v1/chat/completions" \
  -H "Authorization: Bearer ${GEMROUTER_API_KEY}" \
  -H "Content-Type: application/json" \
  -H "x-gemrouter-backend: chatgpt" \
  -d "{\"model\":\"${GEMROUTER_CHATGPT_ALIAS}\",\"stream\":true,\"messages\":[{\"role\":\"user\",\"content\":\"Reply OK\"}]}"
```

Gateway-validated JSON:

```json
{
  "model": "chatgpt-research",
  "messages": [{"role": "user", "content": "Return a JSON object."}],
  "response_format": {"type": "json_object"}
}
```

In compatibility profile, explicitly supplied sampling/storage controls from the documented allowlist are accepted but ignored and named in `X-GemRouter-Gateway-Warnings`. In strict profile they fail before enqueue. A server-wide strict profile cannot be weakened by a request header.

The same `Idempotency-Key` plus app and surface reuses the same outcome for the configured TTL. Reusing it with another payload or alias returns `chatgpt_idempotency_conflict`. Change the key for a new inference. After the TTL, the deduplication guarantee ends.

Successful responses expose safe metadata such as:

```text
X-GemRouter-Backend: chatgpt
X-GemRouter-Provider: chatgpt-mcp
X-GemRouter-Model-Verification: operator-declared
X-GemRouter-Stream: buffered
X-GemRouter-Usage: unavailable
X-GemRouter-Context: persistent-chat
X-GemRouter-Gateway-Profile: compatibility
```

## State, retries, and recovery

SQLite stores workers, aliases, OAuth state, grants, runs, jobs, claim fencing, and exchange replay records transactionally in `gateway.sqlite` with WAL, foreign keys, synchronous durability, and a single-process ownership guard. The data directory is owner-only and the database file is mode `0600`.

`gateway_exchange` is the unit of idempotency. A completion and the following claim are committed in one transaction. Repeating the same run/exchange ID with identical arguments replays the complete prior result only while its authorization, run generation and claim remain valid; otherwise it returns recovery/release without the old request payload. Changing arguments is a protocol conflict. In-flight sharing is grant-bound and every consumer is revalidated at delivery. Claims carry a run generation and random claim token.

An expired or ambiguously disconnected stateful claim is terminal and is never delivered again. A late completion after timeout, cancellation, app revocation, OAuth revocation, release, or restart cannot publish a result to the HTTP caller. On process restart, queued/claimed synchronous requests become `chatgpt_gateway_restarted`, live runs are released, and workers must call `gateway_open` again.

Dashboard actions:

- **Drain** stops new admissions, finishes accepted work, then releases the run.
- **Release** immediately invalidates the run and pending work.
- Disabling a worker releases it. Deletion is refused while jobs are active; after release it removes aliases and OAuth bindings.
- Removing an app from a worker invalidates queued and already-delivered jobs from that app, preventing late publication.
- Revoking a grant revokes its access/refresh tokens and releases its live run.

Worker status is synthetic and honest: polling, recent contact, stale, processing claim, queue length/age, last completion, lease, last error, and a suggested next action. It is not a claim that ChatGPT is permanently online. Worker-supplied error prose is not persisted or propagated into interaction logs: failures use fixed safe messages. Terminal request replay payloads are scrubbed. OAuth endpoints have bounded request sizes, burst protection, no-store/referrer/frame protections, and durable record caps; initialized and in-progress MCP sessions share the transport capacity limit.

The existing admin configurator backup deliberately excludes the ChatGPT gateway directory, including SQLite/WAL data, OAuth clients/tokens/grants, authorization requests, runs, claims, replay payloads, and jobs. Import also refuses those paths and does not copy them into the pre-import safety snapshot. Restoring ordinary GemRouter configuration therefore never resurrects a ChatGPT run or authorization; recreate the worker configuration if needed and complete a new pairing. Older backups without ChatGPT remain valid.

Retention cleanup runs once per minute and during activity. Hard safety ceilings
bound persisted state without evicting still-valid idempotency records early:
128 workers; 10,000 retained jobs; 16,384 replays (1,024/run); 16,384 runs
(1,024/worker); 8,192 grants (128/worker); 1,024 OAuth clients (16/worker);
128 pending authorizations (8/client); 32,768 token records (128 active access
tokens/grant). Unapproved clients expire after ten minutes; expired or spent
tokens and retained released runs/revoked grants are pruned. Capacity errors
require waiting for retention or reviewing abandoned configuration; no valid
claim is silently replaced. Payload scrubbing is logical deletion from records,
not a promise of forensic erasure from SQLite/WAL or out-of-band copies.

## Stable HTTP errors

| Condition | HTTP | `error.code` |
|---|---:|---|
| Unknown explicit alias | 404 | `chatgpt_model_not_found` |
| Either policy layer denies access | 403 | `chatgpt_model_not_allowed` |
| Alias plus another explicit backend | 400 | `chatgpt_backend_mismatch` |
| Unsupported surface/parameter/reset | 400 | `chatgpt_unsupported_surface`, `chatgpt_unsupported_parameter`, `chatgpt_context_reset_unsupported` |
| UTF-8 request too large | 413 | `chatgpt_payload_too_large` |
| Idempotency conflict | 409 | `chatgpt_idempotency_conflict` |
| Queue full | 429 | `chatgpt_queue_full` |
| Worker is not actively usable | 503 | `chatgpt_worker_unavailable` |
| Queue/total deadline | 504 | `chatgpt_queue_timeout`, `chatgpt_request_timeout` |
| Worker error/invalid JSON/empty reply | 502 | `chatgpt_completion_failed`, `chatgpt_invalid_json`, `chatgpt_empty_response` |
| Process restarted during work | 503 | `chatgpt_gateway_restarted` |

## Verification

```bash
pnpm check
pnpm test
pnpm smoke:chatgpt-mcp
pnpm smoke:chatgpt-ui
pnpm audit --audit-level=low
```

The repository test matrix is grouped as follows:

| Requirement group | Concrete coverage |
|---|---|
| A — feature flag/regressions | `chatgpt-config.test.ts`, router isolation tests, all pre-existing provider/quota/hedge tests, compiled feature-off smoke |
| B — registry/policy | registry collision/default-disable tests, two-worker/app isolation, dormant-alias restart, model-list and mismatch smoke |
| C — OAuth/transport | PKCE/code/refresh/revocation tests plus official MCP client smoke with credential-plane, Host/Origin and CSRF checks |
| D — claims/races | claim fencing, serialized queue, concurrent workers, whole-exchange replay/conflict, duplicate-poll abort isolation and late completion tests |
| E — HTTP/capabilities | protocol boundary tests and compiled text, multipart JSON, strict profile and buffered SSE smoke |
| F — deadlines/recovery | queue/claim timeout, no redelivery, backpressure/drain, disconnect sharing, restart recovery, store ownership and router-deadline tests |
| G — dashboard/privacy/licenses | dashboard script/controls, audit redaction, private interaction/unknown usage, backup exclusion tests and `THIRD_PARTY_NOTICES.md` |

The browser smoke uses pinned `playwright-core` with an existing Chrome/Chromium
binary. Set `GEMROUTER_BROWSER_EXECUTABLE` for a nonstandard installation. It
starts its own isolated GemRouter, verifies real local onboarding and app policy,
OAuth login/consent, progress gating, reload/prompt recovery, console errors,
and desktop/mobile layout. Worker polling is explicitly simulated; ChatGPT is
never contacted. Optional `GEMROUTER_UI_SCREENSHOT_DIR` saves visual evidence.
See [the verification report](chatgpt-mcp-verification.md) for recorded results.

The security review upgrades the existing Fastify 4 runtime to pinned Fastify
5.12.4, using Node 24 already required by this repository. OAuth redirects use
the current signature and browser fetches attach JSON content type only when a
body exists (including DELETE). Compatible URI-parser and development-tool
updates are locked in `pnpm-lock.yaml`; no new provider runtime is introduced.

The smoke first starts the compiled app with the feature disabled and verifies that OAuth/MCP routes and the gateway database remain absent. It then starts an isolated loopback process, completes DCR + PKCE OAuth, connects an official Streamable HTTP MCP client, and verifies credential-plane isolation, onboarding app permissions, exact tool inventory/annotations, text, multipart JSON, strict rejection, buffered SSE, status, release and token-family revocation. It restarts that isolated process with the feature disabled to check dormant aliases. It uses generated test credentials, an allowlisted environment, and a temporary working directory: it does not load the repository `.env` or enable other providers. It shuts down only its own child processes and removes only its temporary directory. It never contacts ChatGPT.

Only after a real worker is already paired and polling, explicitly select the separate live mode. It makes two remote inference requests but does not deploy, pair, release, revoke, or choose the ChatGPT model:

```bash
GEMROUTER_BASE_URL=https://gemr.airewardrop.xyz \
GEMROUTER_API_KEY='app-key-for-this-worker' \
GEMROUTER_CHATGPT_ALIAS='chatgpt-research' \
pnpm smoke:chatgpt-mcp:live
```

A real live acceptance test remains manual: pair the connector in ChatGPT, approve the exact worker consent, paste the generated prompt into its dedicated conversation, observe `gateway_open`/polling, send an app request, and verify that the real conversation returns it. Record that separately from the simulated smoke; an installed connector, issued grant, or successful remote smoke alone is not proof of a live ChatGPT completion. The remote script verifies the gateway response, not the worker's identity.

Live checklist:

```text
[ ] public HTTPS endpoint and both discovery documents verified
[ ] OAuth completed by the actual ChatGPT connector in use
[ ] exactly gateway_open, gateway_exchange and gateway_status visible; approval behavior checked
[ ] gateway_open and first bounded poll observed
[ ] authorized remote HTTP request returned by that real worker to the same client
[ ] alias and X-GemRouter-Backend: chatgpt verified
[ ] buffered SSE verified
[ ] stopped/dormant-chat behavior verified
[ ] release and OAuth revocation verified
```

The model/reasoning choice is manual in ChatGPT. An operator observation of the displayed model is a declaration, not server attestation. The worker context is persistent and shared across its authorized callers, token usage remains unavailable, buffered streaming is not token streaming, and no code can guarantee that a hosted conversation will poll forever.
