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

detect_bin() {
  if [[ -x "${ROOT_DIR}/node_modules/.bin/gemini" ]]; then
    printf '%s\n' "${ROOT_DIR}/node_modules/.bin/gemini"
    return 0
  fi
  if command -v gemini >/dev/null 2>&1; then
    command -v gemini
    return 0
  fi
  printf '%s\n' "gemini"
}

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

DETECTED_BIN="$(detect_bin)"
DETECTED_HOME="${HOME:-}"
DETECTED_DOT_GEMINI=""
if [[ -n "${DETECTED_HOME}" && -d "${DETECTED_HOME}/.gemini" ]]; then
  DETECTED_DOT_GEMINI="${DETECTED_HOME}/.gemini"
fi

echo "[setup-gemini-cli] root: ${ROOT_DIR}"
echo "[setup-gemini-cli] detected bin: ${DETECTED_BIN}"
if [[ -n "${DETECTED_DOT_GEMINI}" ]]; then
  echo "[setup-gemini-cli] detected auth dir: ${DETECTED_DOT_GEMINI}"
else
  echo "[setup-gemini-cli] detected auth dir: not found"
fi

ensure_key "GEMINI_CLI_ENABLED" "true"
ensure_key "GEMINI_CLI_BIN" "${DETECTED_BIN}"
ensure_key "GEMINI_CLI_MODEL" "${GEMINI_CLI_MODEL:-gemini-2.5-flash}"
ensure_key "GEMINI_CLI_TIMEOUT_MS" "${GEMINI_CLI_TIMEOUT_MS:-120000}"
ensure_key "GEMINI_CLI_OUTPUT_FORMAT" "${GEMINI_CLI_OUTPUT_FORMAT:-json}"
ensure_key "GEMINI_CLI_USE_STDIN" "${GEMINI_CLI_USE_STDIN:-false}"
ensure_key "GEMINI_CLI_EXPECT_AUTH_CACHE" "${GEMINI_CLI_EXPECT_AUTH_CACHE:-true}"
ensure_key "GEMINI_CLI_AUTH_BOOTSTRAP_ENABLED" "${GEMINI_CLI_AUTH_BOOTSTRAP_ENABLED:-true}"
ensure_key "GEMINI_CLI_AUTH_BOOTSTRAP_MODE" "${GEMINI_CLI_AUTH_BOOTSTRAP_MODE:-playwright}"
ensure_key "GEMROUTER_BACKEND_ORDER" "${GEMROUTER_BACKEND_ORDER:-gemini-cli,playwright}"
ensure_key "GEMROUTER_ALLOW_PLAYWRIGHT_FALLBACK" "${GEMROUTER_ALLOW_PLAYWRIGHT_FALLBACK:-true}"
ensure_key "GEMROUTER_BACKEND_RETRY_ON_CLI_AUTH_FAILURE" "${GEMROUTER_BACKEND_RETRY_ON_CLI_AUTH_FAILURE:-true}"

if [[ -n "${DETECTED_HOME}" ]]; then
  ensure_key "GEMINI_CLI_USER_HOME" "${DETECTED_HOME}"
fi
if [[ -n "${DETECTED_DOT_GEMINI}" ]]; then
  ensure_key "GEMINI_CLI_DOT_GEMINI_DIR" "${DETECTED_DOT_GEMINI}"
fi

echo
echo "[setup-gemini-cli] next steps:"
echo "  1. Review ${ENV_FILE}"
echo "  2. Run bash ./scripts/login-gemini-cli.sh if Gemini CLI auth is missing"
echo "  3. Start the router and check /health"
