#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd "$script_dir/.." && pwd)"

export HOME="${HOME:-$(getent passwd "$(id -u)" | cut -d: -f6)}"
export NODE_ENV="${NODE_ENV:-production}"
export DISPLAY="${DISPLAY:-${PLAYWRIGHT_DISPLAY:-:99}}"
export PATH="$HOME/.local/share/pnpm:$HOME/.local/bin:$PATH"

if [[ -f "$HOME/.nvm/nvm.sh" ]]; then
  # shellcheck disable=SC1090
  source "$HOME/.nvm/nvm.sh"
  nvm use --silent >/dev/null 2>&1 || true
fi

if ! command -v node >/dev/null 2>&1; then
  echo "[gemrouterfe] node not found in PATH" >&2
  exit 1
fi

if ! command -v pnpm >/dev/null 2>&1; then
  if command -v corepack >/dev/null 2>&1; then
    corepack enable >/dev/null 2>&1 || true
  fi
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "[gemrouterfe] pnpm not found in PATH" >&2
  exit 1
fi

cd "$repo_dir"
pnpm build
exec node dist/index.js
