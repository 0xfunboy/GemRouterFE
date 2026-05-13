#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd "$script_dir/.." && pwd)"

export HOME="${HOME:-$(getent passwd "$(id -u)" | cut -d: -f6)}"
export PATH="$HOME/.local/share/pnpm:$HOME/.local/bin:$PATH"

if [[ -f "$HOME/.nvm/nvm.sh" ]]; then
  # shellcheck disable=SC1090
  source "$HOME/.nvm/nvm.sh"
  nvm use --silent >/dev/null 2>&1 || true
fi

cd "$repo_dir"
pnpm exec playwright install chromium

chrome_path="$(find "$HOME/.cache/ms-playwright" -path '*/chromium-*/chrome-linux64/chrome' | sort | tail -n 1)"
if [[ -z "$chrome_path" ]]; then
  echo "[setup-browser] Chromium binary not found after install" >&2
  exit 1
fi

mkdir -p "$HOME/.local/bin"
ln -sfn "$chrome_path" "$HOME/.local/bin/google-chrome-stable"
echo "[setup-browser] linked $chrome_path -> $HOME/.local/bin/google-chrome-stable"
