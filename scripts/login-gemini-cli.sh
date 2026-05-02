#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -f "${ROOT_DIR}/.env" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${ROOT_DIR}/.env"
  set +a
fi

echo "[login-gemini-cli] root: ${ROOT_DIR}"
echo "[login-gemini-cli] auth dir: ${GEMINI_CLI_DOT_GEMINI_DIR:-${HOME:-}/.gemini}"
echo "[login-gemini-cli] starting embedded Google login flow"

cd "${ROOT_DIR}"
exec pnpm exec tsx ./src/bin/gemini-login.ts
