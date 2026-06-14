# Setup

## 1. Install

```bash
export PATH=/home/funboy/.nvm/versions/node/v23.3.0/bin:$PATH
pnpm install --frozen-lockfile
cp .env.example .env
```

## 2. Configure Secrets

Edit `.env`:

```env
LEAKROUTER_ADMIN_TOKEN=change-me-admin
LEAKROUTER_DASHBOARD_ADMIN_USERS=admin:change-me-password
LEAKROUTER_BOOTSTRAP_API_KEY=change-me-client
```

## 3. Configure Ollama Inventory

Place the private inventory at:

```text
ollama-model-inventory.json
```

Generate or refresh it with:

```bash
pnpm inventory:ollama --input authorized_ollama_urls.txt
```

The router reads endpoint URLs from this file but never exposes those URLs through public model APIs or the admin UI.

## 4. Optional DeepSeek API

```env
LEAKROUTER_DEEPSEEK_ENABLED=true
LEAKROUTER_DEEPSEEK_API_KEY=sk-...
LEAKROUTER_DEEPSEEK_MODELS=deepseek-chat,deepseek-reasoner
```

## 5. Build and Start

```bash
pnpm build
pnpm start
```

Admin UI:

```text
http://127.0.0.1:4024/admin
```

Health:

```bash
curl -fsS http://127.0.0.1:4024/health
```
