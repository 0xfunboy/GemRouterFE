#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -f "${ROOT_DIR}/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${ROOT_DIR}/.env"
  set +a
fi

API_BASE="${API_BASE:-http://127.0.0.1:${PORT:-4024}}"
API_KEY="${GEMROUTER_BOOTSTRAP_API_KEY:-${BAIRBI_BOOTSTRAP_API_KEY:-${BARIBI_BOOTSTRAP_API_KEY:-}}}"

if [[ -z "${API_KEY}" ]]; then
  echo "[smoke] Missing bootstrap API key in .env" >&2
  exit 1
fi

echo "[smoke] health"
curl -fsS "${API_BASE}/health"
printf '\n\n'

echo "[smoke] models"
curl -fsS "${API_BASE}/v1/models" \
  -H "Authorization: Bearer ${API_KEY}"
printf '\n\n'

echo "[smoke] chat"
curl -fsS "${API_BASE}/v1/chat/completions" \
  -H "Authorization: Bearer ${API_KEY}" \
  -H 'Content-Type: application/json' \
  -d '{"model":"gemini-web","messages":[{"role":"user","content":"Reply only with OK."}]}'
printf '\n\n'

echo "[smoke] responses"
curl -fsS "${API_BASE}/v1/responses" \
  -H "Authorization: Bearer ${API_KEY}" \
  -H 'Content-Type: application/json' \
  -d '{"model":"gemini-web","input":[{"role":"user","content":[{"type":"input_text","text":"Reply only with PONG."}]}]}'
printf '\n'
