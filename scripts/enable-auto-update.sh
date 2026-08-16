#!/usr/bin/env bash
#
# Turn on automatic nightly updates for Watermans Music. After this, the box
# pulls the latest version and restarts itself every night at 4am (when the
# venue is closed), so you never have to update by hand. Run it once:
#
#     cd ~/restaurant-music
#     bash scripts/enable-auto-update.sh
#
# To turn it off later:  sudo systemctl disable --now watermans-update.timer
#
set -e

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_USER="$(whoami)"
HOUR="04:00"   # nightly update time (venue closed) — change if you like

echo "==> App folder: $APP_DIR"
echo "==> Update runs nightly at $HOUR as user: $APP_USER"

# The update job: pull as the app owner (keeps file ownership correct), and if
# anything changed, restart the service. Runs as root so it can restart.
sudo tee /etc/systemd/system/watermans-update.service >/dev/null <<UNIT
[Unit]
Description=Watermans Music — pull latest and restart if changed
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/bin/bash -c 'cd "$APP_DIR" && git config --global --add safe.directory "$APP_DIR" >/dev/null 2>&1; before=\$(sudo -u $APP_USER git rev-parse HEAD); sudo -u $APP_USER -H git pull --ff-only; after=\$(sudo -u $APP_USER git rev-parse HEAD); if [ "\$before" != "\$after" ]; then echo "Updated \$before -> \$after, restarting"; systemctl restart watermans-music; else echo "Already up to date"; fi'
UNIT

sudo tee /etc/systemd/system/watermans-update.timer >/dev/null <<UNIT
[Unit]
Description=Nightly Watermans Music auto-update

[Timer]
OnCalendar=*-*-* $HOUR:00
Persistent=true

[Install]
WantedBy=timers.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable --now watermans-update.timer

echo
echo "==> Auto-update is ON. Next run:"
systemctl list-timers watermans-update.timer --no-pager | sed -n '1,2p' || true
echo
echo "    Update now on demand:   sudo systemctl start watermans-update.service"
echo "    See what it did:        journalctl -u watermans-update.service -n 20 --no-pager"
echo "    Turn it off:            sudo systemctl disable --now watermans-update.timer"
