#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SYSTEMD_DIR="$ROOT_DIR/ops/systemd"
USER_SYSTEMD_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

echo "[i] Installing LeakRouter user systemd units..."
mkdir -p "$USER_SYSTEMD_DIR"
cp "$SYSTEMD_DIR/leakrouter.service" "$USER_SYSTEMD_DIR/leakrouter.service"
cp "$SYSTEMD_DIR/leakrouter-nightly-restart.service" "$USER_SYSTEMD_DIR/leakrouter-nightly-restart.service"
cp "$SYSTEMD_DIR/leakrouter-nightly-restart.timer" "$USER_SYSTEMD_DIR/leakrouter-nightly-restart.timer"

systemctl --user daemon-reload
systemctl --user enable --now leakrouter.service
systemctl --user enable --now leakrouter-nightly-restart.timer

echo "[ok] LeakRouter service and timer enabled. Inbound DNS is handled by solclawn-tunnel.service."
