#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env"
EXAMPLE_FILE="${ROOT_DIR}/.env.example"

if [[ ! -f "${ENV_FILE}" && -f "${EXAMPLE_FILE}" ]]; then
  cp "${EXAMPLE_FILE}" "${ENV_FILE}"
  echo "[setup-gemini-cli] created ${ENV_FILE} from .env.example"
fi

if [[ -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
fi

ensure_key() {
  local key="$1"
  local value="$2"
  if [[ ! -f "${ENV_FILE}" ]]; then
    : > "${ENV_FILE}"
  fi
  if grep -Eq "^${key}=" "${ENV_FILE}"; then
    echo "[setup-gemini-cli] kept ${key}"
    return 0
  fi
  printf '%s=%s\n' "${key}" "${value}" >> "${ENV_FILE}"
  echo "[setup-gemini-cli] set ${key}=${value}"
}

DETECTED_HOME="${HOME:-}"
DETECTED_DOT_GEMINI=""
if [[ -n "${DETECTED_HOME}" && -d "${DETECTED_HOME}/.gemini" ]]; then
  DETECTED_DOT_GEMINI="${DETECTED_HOME}/.gemini"
fi

echo "[setup-gemini-cli] root: ${ROOT_DIR}"
if [[ -n "${DETECTED_DOT_GEMINI}" ]]; then
  echo "[setup-gemini-cli] detected auth dir: ${DETECTED_DOT_GEMINI}"
else
  echo "[setup-gemini-cli] detected auth dir: not found"
fi

ensure_key "GEMINI_CLI_ENABLED" "true"
ensure_key "GEMINI_CLI_MODEL" "${GEMINI_CLI_MODEL:-gemini-2.5-pro}"
ensure_key "GEMINI_CLI_MODELS" "${GEMINI_CLI_MODELS:-gemini-2.5-pro,gemini-2.5-flash,gemini-2.5-flash-lite}"
ensure_key "GEMINI_CLI_TIMEOUT_MS" "${GEMINI_CLI_TIMEOUT_MS:-120000}"
ensure_key "GEMINI_CLI_QUOTA_REFRESH_MS" "${GEMINI_CLI_QUOTA_REFRESH_MS:-60000}"
ensure_key "GEMINI_CLI_EXPECT_AUTH_CACHE" "${GEMINI_CLI_EXPECT_AUTH_CACHE:-true}"
ensure_key "GEMINI_CLI_AUTH_BOOTSTRAP_ENABLED" "${GEMINI_CLI_AUTH_BOOTSTRAP_ENABLED:-true}"
ensure_key "GEMINI_CLI_AUTH_BOOTSTRAP_MODE" "${GEMINI_CLI_AUTH_BOOTSTRAP_MODE:-operator}"
ensure_key "GEMINI_AUTH_CALLBACK_HOST" "${GEMINI_AUTH_CALLBACK_HOST:-127.0.0.1}"
ensure_key "GEMINI_AUTH_AUTO_OPEN_BROWSER" "${GEMINI_AUTH_AUTO_OPEN_BROWSER:-true}"
ensure_key "GEMINI_AUTH_CLIENT_ID" "${GEMINI_AUTH_CLIENT_ID:-}"
ensure_key "GEMINI_AUTH_CLIENT_SECRET" "${GEMINI_AUTH_CLIENT_SECRET:-}"
ensure_key "GEMROUTER_BACKEND_ORDER" "${GEMROUTER_BACKEND_ORDER:-gemini-cli,playwright}"
ensure_key "GEMROUTER_ALLOW_PLAYWRIGHT_FALLBACK" "${GEMROUTER_ALLOW_PLAYWRIGHT_FALLBACK:-true}"
ensure_key "GEMROUTER_BACKEND_RETRY_ON_CLI_AUTH_FAILURE" "${GEMROUTER_BACKEND_RETRY_ON_CLI_AUTH_FAILURE:-true}"
ensure_key "GEMROUTER_BOOTSTRAP_ALLOWED_MODELS" "${GEMROUTER_BOOTSTRAP_ALLOWED_MODELS:-gemini-2.5-pro,gemini-2.5-flash,gemini-2.5-flash-lite,gemini-web,google/gemini-web}"

if [[ -n "${DETECTED_HOME}" ]]; then
  ensure_key "GEMINI_CLI_USER_HOME" "${DETECTED_HOME}"
fi
if [[ -n "${DETECTED_DOT_GEMINI}" ]]; then
  ensure_key "GEMINI_CLI_DOT_GEMINI_DIR" "${DETECTED_DOT_GEMINI}"
fi

echo
echo "[setup-gemini-cli] next steps:"
echo "  1. Review ${ENV_FILE}"
echo "  2. Fill GEMINI_AUTH_CLIENT_ID and GEMINI_AUTH_CLIENT_SECRET if they are blank"
echo "  3. Run pnpm login:gemini-cli if Google auth cache is missing"
echo "  4. Start the router and check /health"
