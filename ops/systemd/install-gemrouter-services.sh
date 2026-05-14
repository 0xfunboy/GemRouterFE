#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SYSTEMD_DIR="$ROOT_DIR/ops/systemd"

echo "[i] Installing GemRouter systemd units..."
sudo cp "$SYSTEMD_DIR/gemrouter.service" /etc/systemd/system/gemrouter.service
sudo cp "$SYSTEMD_DIR/gemrouter-nightly-restart.service" /etc/systemd/system/gemrouter-nightly-restart.service
sudo cp "$SYSTEMD_DIR/gemrouter-nightly-restart.timer" /etc/systemd/system/gemrouter-nightly-restart.timer
sudo cp "$SYSTEMD_DIR/cloudflared-gemrouter.service" /etc/systemd/system/cloudflared-gemrouter.service

sudo systemctl daemon-reload

sudo systemctl enable --now gemrouter.service
sudo systemctl enable --now gemrouter-nightly-restart.timer
sudo systemctl enable --now cloudflared-gemrouter.service

echo "[ok] GemRouter service + nightly restart timer + tunnel service enabled"
