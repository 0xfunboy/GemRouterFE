#!/usr/bin/env bash
set -euo pipefail

display="${PLAYWRIGHT_DISPLAY:-:99}"
vnc_port="${PLAYWRIGHT_VNC_PORT:-5900}"
password_file="${PLAYWRIGHT_VNC_PASSWORD_FILE:-$HOME/.vnc/passwd}"

if [[ ! -f "$password_file" ]]; then
  echo "[x11vnc] Missing VNC password file: $password_file" >&2
  exit 1
fi

exec /usr/bin/x11vnc \
  -display "$display" \
  -forever \
  -shared \
  -rfbport "$vnc_port" \
  -localhost \
  -rfbauth "$password_file"
