#!/usr/bin/env bash
set -euo pipefail

# Napoleon eFIRE HomeKit Bridge — Raspberry Pi Setup
# Run once with: sudo bash setup-pi.sh

if [ "$EUID" -ne 0 ]; then
  echo "Please run as root: sudo bash setup-pi.sh"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE_BIN="$(which node)"

echo "==> Installing system dependencies..."
apt-get update
apt-get install -y bluetooth bluez libbluetooth-dev libudev-dev

echo "==> Granting BLE capabilities to node..."
setcap cap_net_raw+eip "$NODE_BIN"

echo "==> Installing npm packages..."
sudo -u pi npm install --prefix "$SCRIPT_DIR"

echo "==> Installing systemd service..."
cp "$SCRIPT_DIR/napoleon-homekit.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable napoleon-homekit.service

echo ""
echo "Setup complete!"
echo ""
echo "Next steps:"
echo "  1. Run: npm run scan"
echo "     to find your fireplace's peripheral ID"
echo "  2. Run: npm start"
echo "     to launch the bridge and complete interactive setup"
echo "  3. The service will auto-start on boot after first successful run"
echo ""
