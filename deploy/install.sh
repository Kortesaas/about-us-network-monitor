#!/usr/bin/env bash
# One-shot installer for a Raspberry Pi (Raspberry Pi OS Bookworm / Debian 12).
# Run from a checkout of this repository:  sudo bash deploy/install.sh
set -euo pipefail

APP_DIR=/opt/about-us-network-monitor
DATA_DIR=/var/lib/aboutus-net-monitor
SERVICE=aboutus-net-monitor
APP_USER=aboutus
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo bash deploy/install.sh" >&2
  exit 1
fi

echo "==> System packages (fping for sweeps, snmp tools for probing, lldpd so switches can see the Pi)"
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq fping snmp lldpd ca-certificates curl git >/dev/null
# lldpd announces the Pi to the switches so the monitor can locate itself via LLDP.
systemctl enable --now lldpd >/dev/null 2>&1 || true

if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | cut -d. -f1 | tr -d v)" -lt 20 ]]; then
  echo "==> Installing Node.js 22 (NodeSource)"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs >/dev/null
fi
echo "    node $(node -v), npm $(npm -v)"

echo "==> Service user and directories"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$DATA_DIR"
chown -R "$APP_USER:$APP_USER" "$DATA_DIR"

echo "==> Copying application to $APP_DIR"
mkdir -p "$APP_DIR"
if [[ "$SRC_DIR" != "$APP_DIR" ]]; then
  rsync -a --delete --exclude node_modules --exclude .git --exclude 'data/*' "$SRC_DIR/" "$APP_DIR/"
fi
cd "$APP_DIR"

echo "==> Installing dependencies and building (this takes a few minutes on a Pi 4)"
npm ci --no-audit --no-fund
npm run build
# The service only needs production dependencies at runtime.
npm prune --omit=dev --no-audit --no-fund
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

echo "==> systemd service"
cp deploy/$SERVICE.service /etc/systemd/system/$SERVICE.service
systemctl daemon-reload
systemctl enable --now $SERVICE
sleep 2
systemctl --no-pager --lines=5 status $SERVICE || true

IP=$(hostname -I | awk '{print $1}')
cat <<MSG

Done. Open the monitor at:
  http://$(hostname)/      (needs DNS on the router or mDNS: http://$(hostname).local/)
  http://$IP/

Useful commands:
  sudo systemctl status $SERVICE
  sudo journalctl -u $SERVICE -f
  sudo systemctl restart $SERVICE
  sudo bash $APP_DIR/deploy/update.sh      # pull + rebuild + restart

Settings and known devices live in $DATA_DIR (backed up via Settings → Export).
MSG
