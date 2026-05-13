#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd "$script_dir/.." && pwd)"
source_root="${NOVNC_SYSTEM_WEB_ROOT:-/usr/share/novnc}"
dest_root="${PLAYWRIGHT_NOVNC_WEB_ROOT:-$HOME/.local/share/gemrouterfe/novnc-web}"

mkdir -p "$dest_root"
cp -a "$source_root/." "$dest_root/"
cp "$repo_dir/ops/novnc/index.html" "$dest_root/index.html"
