# Client concurrency recovery — 2026-09-19

## Root cause and scope

Authenticated generation handlers acquired an app concurrency slot before parsing
the request. Validation failures returned HTTP 400 before entering the inference
`try/finally`, leaking the acquired slot. Two invalid requests could permanently
block a two-slot app until process restart. This affected every app using Chat
Completions (both paths), Responses, Image Generations (both paths), Ollama Chat
or Ollama Generate: five handlers, seven public routes.

The authenticated model-list endpoint also acquires an app slot. On an affected
app it waited for the configured 90-second admission timeout and then returned
`429 concurrency_limit_exceeded`; clients with 45-second timeouts saw only a
timeout. Public `/health` did not exercise the affected admission path.

The production diagnostic reproduced HTTP 429 after **90,220 ms** on `/v1/models`
using the affected app's valid key. The audit log contained two prior HTTP 400
validation failures for that app. The deployed build contained the missing
release paths. No inference was performed by that diagnostic.

## Correction

Every affected validation catch releases its slot before logging or returning.
Normal inference success, provider errors, model-policy rejection and streaming
continue to use the existing `finally` release. Other authenticated handlers
were reviewed for an equivalent early return outside their release scope.
App limits and authorization remain unchanged; this is not an increased-limit
workaround. Restarting the patched service clears already leaked in-memory slots.

## Regression checks

`scripts/smoke-client-slots.ts` runs inside the existing isolated HTTP smoke,
with a temporary database, generated test keys and simulated upstream. For
independent apps with limits one and two it verifies:

- More consecutive invalid requests than available slots on all seven routes;
- HTTP 200 model listing after each route's errors;
- Concurrent mixed-route validation failures followed by successful inference;
- Repeated model and thinking rejection without leaking admission slots;
- Subsequent non-streaming and streaming completions and model listing.

Before the fix the regression failed on the second invalid Chat Completions
request: expected 400, received 429. After the fix the regression passed. The
isolated test uses a short admission timeout, never production's database or keys.

Commands: `pnpm check:app`, `pnpm test`, `pnpm smoke:codex:ui`, `git diff --check`.
These are simulated upstream tests, not evidence of a live Gemini completion.

## Authorized production verification

The full **116-test** suite, TypeScript check, HTTP/UI smoke and build passed.
The existing service restarted gracefully at **2026-09-19 02:56:08 UTC** with a
private rollback build retained outside Git. No second instance, network change,
app-limit change, credential rotation or Codex-account switch was performed.
Both Codex logins and the selected account survived the restart.

Using the affected app's real key against public HTTPS, sequential probes returned:

| Probe | HTTP | Elapsed |
| --- | --- | --- |
| Model listing | 200 | 1,316 ms |
| Invalid Chat Completions body 1 | 400 | 67 ms |
| Invalid Chat Completions body 2 | 400 | 83 ms |
| Invalid Chat Completions body 3 | 400 | 42 ms |
| Model listing after validation failures | 200 | 1,012 ms |
| Actual Gemini Chat Completion | 200 | 9,664 ms |

The completion used exactly **gemini-3.8-flash**, backend **gemini-api**, with no
fallback, and returned the requested diagnostic marker. Reported usage was
**9 input + 4 output = 13 tokens**. The successful interaction was verified through
the admin interactions endpoint. These are live production results, not fixtures;
they originate on the gateway host through public HTTPS, not the destination VPS.

The three intentional invalid requests exceeded the app's two-slot limit without
poisoning it. App policy remained unchanged. This verifies this incident's fix,
not a guarantee against every unrelated saturation or upstream timeout.

## Client configuration

Use an OpenAI-compatible Chat Completions client with base URL
`https://router.example.test/v1`, the client app's key as a Bearer token, and an
authorized model such as `gemini-3.8-flash`. Do not append a second `/v1`.
No Codex login, OAuth or cookies are involved. For Gemini-only routing send
`x-gemrouter-backend: gemini-api`; omit it to retain normal provider routing.
Start with one request at a time, retries disabled, a 10-second connect timeout
and a 120-second request timeout. Configure production concurrency/rate limits
to match the app; avoid unlimited automatic retries on 429 or timeouts.

`GET /v1/models` does not generate an interaction. Missing/invalid keys are rejected
before app admission. Successfully authenticated inference records appear in
Recent Interactions after completion; validation failures are in the audit log.
The dashboard's app filter currently searches only the loaded recent global
window, not the entire retained history. This release does not change that filter.

Never commit client keys or put them in diagnostic output. If a key was shared for
an incident test, rotate it after verification and update the destination service.
