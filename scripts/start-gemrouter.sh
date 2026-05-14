#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd "$script_dir/.." && pwd)"

export HOME="${HOME:-$(getent passwd "$(id -u)" | cut -d: -f6)}"
export NODE_ENV="${NODE_ENV:-production}"
export PATH="$HOME/.local/share/pnpm:$HOME/.local/bin:$PATH"

if [[ -f "$HOME/.nvm/nvm.sh" ]]; then
  # shellcheck disable=SC1090
  source "$HOME/.nvm/nvm.sh"
  nvm use 23.3.0 >/dev/null 2>&1 || nvm use --silent >/dev/null 2>&1 || true
fi

if ! command -v node >/dev/null 2>&1; then
  echo "[gemrouter] node not found in PATH" >&2
  exit 1
fi

if ! command -v pnpm >/dev/null 2>&1; then
  if command -v corepack >/dev/null 2>&1; then
    corepack enable >/dev/null 2>&1 || true
  fi
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "[gemrouter] pnpm not found in PATH" >&2
  exit 1
fi

cd "$repo_dir"

if [[ ! -f dist/index.js ]] || find src -type f -newer dist/index.js | grep -q .; then
  pnpm build
fi

exec node dist/index.js
