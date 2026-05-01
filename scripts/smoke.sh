#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -f "${ROOT_DIR}/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${ROOT_DIR}/.env"
  set +a
fi

API_KEY="${GEMROUTER_BOOTSTRAP_API_KEY:-${BAIRBI_BOOTSTRAP_API_KEY:-${BARIBI_BOOTSTRAP_API_KEY:-}}}"
ADMIN_TOKEN="${GEMROUTER_ADMIN_TOKEN:-}"
SMOKE_BACKEND="${SMOKE_BACKEND:-auto}"

resolve_api_base() {
  if [[ -n "${API_BASE:-}" ]]; then
    printf '%s\n' "${API_BASE}"
    return 0
  fi

  local candidates=()
  if [[ -n "${PORT:-}" ]]; then
    candidates+=("http://127.0.0.1:${PORT}")
  fi
  candidates+=("http://127.0.0.1:4024")
  candidates+=("http://127.0.0.1:4000")

  local seen=""
  local candidate
  for candidate in "${candidates[@]}"; do
    if [[ "${seen}" == *"|${candidate}|"* ]]; then
      continue
    fi
    seen="${seen}|${candidate}|"
    if curl -fsS --max-time 5 "${candidate}/health" >/dev/null 2>&1; then
      printf '%s\n' "${candidate}"
      return 0
    fi
  done

  printf '%s\n' "${candidates[0]}"
}

API_BASE="$(resolve_api_base)"

if [[ -z "${API_KEY}" ]]; then
  echo "[smoke] Missing bootstrap API key in .env" >&2
  exit 1
fi

request_json() {
  local label="$1"
  local method="$2"
  local url="$3"
  local body="${4:-}"
  local body_file
  local header_file
  body_file="$(mktemp)"
  header_file="$(mktemp)"

  local status
  if [[ -n "${body}" ]]; then
    status="$(
      curl -sS --max-time 120 -D "${header_file}" -o "${body_file}" -w '%{http_code}' -X "${method}" "${url}" \
        -H "Authorization: Bearer ${API_KEY}" \
        -H "x-gemrouter-backend: ${SMOKE_BACKEND}" \
        -H 'Content-Type: application/json' \
        -d "${body}"
    )"
  else
    status="$(
      curl -sS --max-time 120 -D "${header_file}" -o "${body_file}" -w '%{http_code}' -X "${method}" "${url}" \
        -H "Authorization: Bearer ${API_KEY}" \
        -H "x-gemrouter-backend: ${SMOKE_BACKEND}"
    )"
  fi

  echo "[smoke] ${label}"
  print_backend_meta "${header_file}"
  cat "${body_file}"
  printf '\n\n'

  if [[ "${status}" -lt 200 || "${status}" -ge 300 ]]; then
    echo "[smoke] ${label} failed with HTTP ${status}" >&2
    rm -f "${body_file}" "${header_file}"
    exit 1
  fi

  rm -f "${body_file}" "${header_file}"
}

request_json_basic() {
  local label="$1"
  local method="$2"
  local url="$3"
  local body="${4:-}"
  local body_file
  local header_file
  body_file="$(mktemp)"
  header_file="$(mktemp)"

  local status
  if [[ -n "${body}" ]]; then
    status="$(
      curl -sS --max-time 120 -D "${header_file}" -o "${body_file}" -w '%{http_code}' -X "${method}" "${url}" \
        -u "${API_KEY}:" \
        -H "x-gemrouter-backend: ${SMOKE_BACKEND}" \
        -H 'Content-Type: application/json' \
        -d "${body}"
    )"
  else
    status="$(
      curl -sS --max-time 120 -D "${header_file}" -o "${body_file}" -w '%{http_code}' -X "${method}" "${url}" \
        -u "${API_KEY}:" \
        -H "x-gemrouter-backend: ${SMOKE_BACKEND}"
    )"
  fi

  echo "[smoke] ${label}"
  print_backend_meta "${header_file}"
  cat "${body_file}"
  printf '\n\n'

  if [[ "${status}" -lt 200 || "${status}" -ge 300 ]]; then
    echo "[smoke] ${label} failed with HTTP ${status}" >&2
    rm -f "${body_file}" "${header_file}"
    exit 1
  fi

  rm -f "${body_file}" "${header_file}"
}

print_backend_meta() {
  local header_file="$1"
  local backend
  local provider
  local fallback_from
  local fallback_reason
  backend="$(awk 'BEGIN{IGNORECASE=1} /^x-gemrouter-backend:/{sub(/\r$/,"",$2); print $2}' FS=': ' "${header_file}" | tail -n 1)"
  provider="$(awk 'BEGIN{IGNORECASE=1} /^x-gemrouter-provider:/{sub(/\r$/,"",$2); print $2}' FS=': ' "${header_file}" | tail -n 1)"
  fallback_from="$(awk 'BEGIN{IGNORECASE=1} /^x-gemrouter-fallback-from:/{sub(/\r$/,"",$2); print $2}' FS=': ' "${header_file}" | tail -n 1)"
  fallback_reason="$(awk 'BEGIN{IGNORECASE=1} /^x-gemrouter-fallback-reason:/{sub(/\r$/,"",$2); print $2}' FS=': ' "${header_file}" | tail -n 1)"
  if [[ -n "${backend}" ]]; then
    echo "[smoke] backend used: ${backend}"
  fi
  if [[ -n "${provider}" ]]; then
    echo "[smoke] provider label: ${provider}"
  fi
  if [[ -n "${fallback_from}" ]]; then
    echo "[smoke] fallback from: ${fallback_from}"
  fi
  if [[ -n "${fallback_reason}" ]]; then
    echo "[smoke] fallback reason: ${fallback_reason}"
  fi
}

request_admin() {
  if [[ -z "${ADMIN_TOKEN}" ]]; then
    return 0
  fi

  local cookie_file
  local login_body
  local login_status
  cookie_file="$(mktemp)"
  login_body="$(mktemp)"

  login_status="$(
    curl -sS --max-time 30 -o "${login_body}" -w '%{http_code}' \
      -c "${cookie_file}" \
      -H 'Content-Type: application/json' \
      -d "{\"token\":\"${ADMIN_TOKEN}\"}" \
      "${API_BASE}/admin/login"
  )"

  echo "[smoke] admin/login"
  cat "${login_body}"
  printf '\n\n'

  if [[ "${login_status}" -lt 200 || "${login_status}" -ge 300 ]]; then
    echo "[smoke] admin/login failed with HTTP ${login_status}" >&2
    rm -f "${cookie_file}" "${login_body}"
    exit 1
  fi

  local summary_body
  local summary_status
  summary_body="$(mktemp)"
  summary_status="$(
    curl -sS --max-time 30 -o "${summary_body}" -w '%{http_code}' \
      -b "${cookie_file}" \
      "${API_BASE}/admin/summary"
  )"

  echo "[smoke] admin/summary"
  cat "${summary_body}"
  printf '\n\n'

  if [[ "${summary_status}" -lt 200 || "${summary_status}" -ge 300 ]]; then
    echo "[smoke] admin/summary failed with HTTP ${summary_status}" >&2
    rm -f "${cookie_file}" "${login_body}" "${summary_body}"
    exit 1
  fi

  curl -sS --max-time 15 -o /dev/null -X POST -b "${cookie_file}" "${API_BASE}/admin/logout" || true
  rm -f "${cookie_file}" "${login_body}" "${summary_body}"
}

echo "[smoke] API base: ${API_BASE}"
echo "[smoke] backend preference: ${SMOKE_BACKEND}"
printf '\n'

echo "[smoke] health"
curl -fsS --max-time 15 "${API_BASE}/health"
printf '\n\n'

request_json \
  "models" \
  "GET" \
  "${API_BASE}/v1/models"

request_json \
  "chat" \
  "POST" \
  "${API_BASE}/v1/chat/completions" \
  '{"model":"gemini-web","messages":[{"role":"user","content":"Reply only with OK."}]}'

request_json \
  "responses" \
  "POST" \
  "${API_BASE}/v1/responses" \
  '{"model":"gemini-web","input":[{"role":"user","content":[{"type":"input_text","text":"Reply only with PONG."}]}]}'

request_json \
  "deepseek-models" \
  "GET" \
  "${API_BASE}/models"

request_json \
  "deepseek-chat" \
  "POST" \
  "${API_BASE}/chat/completions" \
  '{"model":"gemini-web","messages":[{"role":"user","content":"Reply only with DEEPSEEK-OK."}]}'

request_json_basic \
  "ollama-version" \
  "GET" \
  "${API_BASE}/api/version"

request_json_basic \
  "ollama-tags" \
  "GET" \
  "${API_BASE}/api/tags"

request_json_basic \
  "ollama-show" \
  "POST" \
  "${API_BASE}/api/show" \
  '{"name":"gemini-web"}'

request_json_basic \
  "ollama-chat" \
  "POST" \
  "${API_BASE}/api/chat" \
  '{"model":"gemini-web","stream":false,"messages":[{"role":"user","content":"Reply only with OLLAMA-CHAT-OK."}]}'

request_json_basic \
  "ollama-generate" \
  "POST" \
  "${API_BASE}/api/generate" \
  '{"model":"gemini-web","stream":false,"prompt":"Reply only with OLLAMA-GENERATE-OK."}'

request_admin
