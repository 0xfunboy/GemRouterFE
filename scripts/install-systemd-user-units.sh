#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd "$script_dir/.." && pwd)"
units_dir="$repo_dir/ops/systemd"
target_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

mkdir -p "$target_dir"

for unit in gemrouterfe.service xvfb.service x11vnc.service novnc.service; do
  sed "s#%h/GemRouterFE#$repo_dir#g" "$units_dir/$unit" > "$target_dir/$unit"
done

systemctl --user daemon-reload
systemctl --user enable gemrouterfe.service xvfb.service x11vnc.service novnc.service

echo "[systemd] installed user units into $target_dir"
echo "[systemd] repo path: $repo_dir"
echo "[systemd] start with: systemctl --user start xvfb.service x11vnc.service novnc.service gemrouterfe.service"
