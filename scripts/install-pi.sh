#!/usr/bin/env bash
#
# One-time setup for running Watermans Music on a Raspberry Pi (or any Debian/
# Ubuntu machine) as an always-on "music box". Run it from inside the app
# folder:
#
#     cd ~/restaurant-music
#     bash scripts/install-pi.sh
#
# It installs Node.js + mpg123, installs the app, and sets it to start on boot
# and play the scheduled music out the Pi's audio output.

set -e

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_USER="$(whoami)"
SERVICE=/etc/systemd/system/watermans-music.service

echo "==> App folder: $APP_DIR"
echo "==> Running as user: $APP_USER"

echo "==> Installing Node.js and mpg123 (needs sudo)…"
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
sudo apt-get install -y mpg123 alsa-utils

echo "==> Installing app dependencies…"
cd "$APP_DIR"
npm install --omit=dev

echo "==> Creating the startup service…"
sudo tee "$SERVICE" >/dev/null <<UNIT
[Unit]
Description=Watermans Music
After=network-online.target sound.target
Wants=network-online.target

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP_DIR
Environment=PORT=3000
Environment=HOST=0.0.0.0
Environment=PLAYER=1
ExecStart=$(command -v node) $APP_DIR/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable watermans-music
sudo systemctl restart watermans-music

echo
echo "==> Done. The app is running and will start automatically on boot."
echo "    Manage it from any phone/computer on the network at:"
for ip in $(hostname -I 2>/dev/null); do echo "        http://$ip:3000"; done
echo
echo "    Set the Pi's audio output (HDMI vs headphone jack vs USB) with:"
echo "        sudo raspi-config   ->  System Options  ->  Audio"
echo "    Check it's running:      sudo systemctl status watermans-music"
echo "    See logs:                journalctl -u watermans-music -f"
