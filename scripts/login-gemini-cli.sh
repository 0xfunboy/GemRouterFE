#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env"

if [[ -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
fi

CLI_BIN="${GEMINI_CLI_BIN:-gemini}"
CLI_WORKDIR="${GEMINI_CLI_WORKDIR:-${ROOT_DIR}}"

if [[ -n "${GEMINI_CLI_DOT_GEMINI_DIR:-}" ]]; then
  DOT_DIR="${GEMINI_CLI_DOT_GEMINI_DIR}"
  if [[ "$(basename "${DOT_DIR}")" == ".gemini" ]]; then
    export HOME="$(dirname "${DOT_DIR}")"
    export USERPROFILE="${HOME}"
  fi
elif [[ -n "${GEMINI_CLI_USER_HOME:-}" ]]; then
  export HOME="${GEMINI_CLI_USER_HOME}"
  export USERPROFILE="${HOME}"
fi

unset GEMINI_API_KEY
unset GOOGLE_API_KEY
unset GOOGLE_GENAI_USE_VERTEXAI

echo "[login-gemini-cli] workdir: ${CLI_WORKDIR}"
echo "[login-gemini-cli] home: ${HOME:-}"
echo "[login-gemini-cli] binary: ${CLI_BIN}"
echo "[login-gemini-cli] starting interactive Gemini CLI login flow"

cd "${CLI_WORKDIR}"
exec "${CLI_BIN}"
