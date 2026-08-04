#!/usr/bin/env bash
#
# Allow the Watermans Music app to shut down / restart the Pi from the Admin
# tab (the "Power" card). Run it once on the Pi:
#
#     cd ~/restaurant-music
#     bash scripts/enable-power.sh
#
# It adds a sudoers rule so the app's user may run shutdown/reboot without a
# password. Nothing else can — the buttons are behind the Admin password.
#
set -e

APP_USER="$(whoami)"
DROPIN=/etc/sudoers.d/watermans-power

echo "==> Allowing user '$APP_USER' to shut down / reboot the box…"
sudo tee "$DROPIN" >/dev/null <<UNIT
$APP_USER ALL=(root) NOPASSWD: /sbin/shutdown, /usr/sbin/shutdown, /sbin/reboot, /usr/sbin/reboot, /sbin/poweroff, /usr/sbin/poweroff
UNIT
sudo chmod 440 "$DROPIN"

# Validate the sudoers file so a typo can never lock you out.
if sudo visudo -cf "$DROPIN" >/dev/null 2>&1; then
  echo "==> Done. The Shut down / Restart buttons in Admin now work."
else
  echo "!! sudoers check failed — removing the rule to be safe."
  sudo rm -f "$DROPIN"
  exit 1
fi
