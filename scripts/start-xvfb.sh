#!/usr/bin/env bash
set -euo pipefail

display="${PLAYWRIGHT_DISPLAY:-:99}"
viewport_width="${PLAYWRIGHT_VIEWPORT_WIDTH:-1440}"
viewport_height="${PLAYWRIGHT_VIEWPORT_HEIGHT:-960}"
screen="${PLAYWRIGHT_XVFB_SCREEN:-${viewport_width}x${viewport_height}x24}"

exec /usr/bin/Xvfb "$display" -screen 0 "$screen" -ac -nolisten tcp
