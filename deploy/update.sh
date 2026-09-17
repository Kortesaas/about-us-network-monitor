#!/usr/bin/env bash
# Rebuilds and restarts the monitor after new code arrived (git pull or rsync).
# Usage:  sudo bash /opt/about-us-network-monitor/deploy/update.sh [path-to-new-checkout]
set -euo pipefail

APP_DIR=/opt/about-us-network-monitor
SERVICE=aboutus-net-monitor
APP_USER=aboutus
NEW_SRC="${1:-}"

if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo bash deploy/update.sh" >&2
  exit 1
fi

cd "$APP_DIR"
if [[ -n "$NEW_SRC" ]]; then
  echo "==> Syncing from $NEW_SRC"
  rsync -a --delete --exclude node_modules --exclude .git --exclude 'data/*' "$NEW_SRC/" "$APP_DIR/"
elif [[ -d .git ]]; then
  echo "==> git pull"
  sudo -u "$APP_USER" git pull --ff-only || git pull --ff-only
fi

echo "==> Build"
npm ci --no-audit --no-fund
npm run build
npm prune --omit=dev --no-audit --no-fund
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

echo "==> Restart"
cp deploy/$SERVICE.service /etc/systemd/system/$SERVICE.service
systemctl daemon-reload
systemctl restart $SERVICE
sleep 2
systemctl --no-pager --lines=3 status $SERVICE || true
curl -fsS http://127.0.0.1/api/health && echo
