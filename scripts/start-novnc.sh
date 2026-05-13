#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"$script_dir/prepare-novnc-web-root.sh"

novnc_port="${PLAYWRIGHT_NOVNC_PORT:-6080}"
vnc_port="${PLAYWRIGHT_VNC_PORT:-5900}"
web_root="${PLAYWRIGHT_NOVNC_WEB_ROOT:-$HOME/.local/share/gemrouterfe/novnc-web}"

exec /usr/bin/websockify --web "$web_root" "$novnc_port" "localhost:${vnc_port}"
