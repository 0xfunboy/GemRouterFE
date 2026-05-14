# Quickstart

## 1. Install dependencies

```bash
pnpm install --frozen-lockfile
```

## 2. Create local config

```bash
cp .env.example .env
```

Set at least:

- `GEMROUTER_ADMIN_TOKEN`
- `GEMROUTER_BOOTSTRAP_API_KEY`
- `GEMROUTER_GEMINI_API_KEYS` or `GEMROUTER_GEMINI_API_KEYS_JSON`

## 3. Verify the repo

```bash
pnpm check
pnpm build
```

## 4. Start GemRouter

```bash
pnpm start
```

## 5. Check health

```bash
curl -fsS http://127.0.0.1:4024/health
```

## 6. Send an OpenAI-compatible request

```bash
curl -sS http://127.0.0.1:4024/v1/chat/completions \
  -H "Authorization: Bearer $GEMROUTER_BOOTSTRAP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-2.5-flash",
    "messages": [
      { "role": "user", "content": "Reply only with OK." }
    ]
  }'
```
