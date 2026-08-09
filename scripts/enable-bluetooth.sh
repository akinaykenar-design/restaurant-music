#!/usr/bin/env bash
#
# Turn the Pi into a Bluetooth speaker called "Watermans", so a phone (esp.
# Android) can pair and play anything to the venue box — YouTube included.
# Run once:
#
#     cd ~/restaurant-music
#     bash scripts/enable-bluetooth.sh
#
# THIS IS THE FIDDLY ONE. Bluetooth on the Pi is short-range (keep the phone
# near the box) and less reliable than Spotify Connect / AirPlay. Try those
# first; use this only for Android phones.
#
# NOTE ON USE: personal device audio isn't licensed for public playback — AFTER
# CLOSE only. And pause the app's player first (one player at a time).
set -e

NAME="Watermans"

echo "==> Installing Bluetooth audio support…"
sudo apt update
sudo apt install -y bluez bluez-tools libspa-0.2-bluetooth pipewire pipewire-pulse wireplumber

echo "==> Naming the box '$NAME' and making it discoverable…"
sudo hostnamectl set-hostname watermans >/dev/null 2>&1 || true
# friendly Bluetooth name
sudo sed -i "s/^#\?Name = .*/Name = $NAME/" /etc/bluetooth/main.conf 2>/dev/null || true
sudo sed -i "s/^#\?DiscoverableTimeout = .*/DiscoverableTimeout = 0/" /etc/bluetooth/main.conf 2>/dev/null || true
sudo systemctl restart bluetooth
sleep 2

# Auto-accept pairing with no PIN (the box has no screen/keyboard).
echo "==> Setting up auto-pairing agent…"
sudo tee /etc/systemd/system/bt-agent.service >/dev/null <<UNIT
[Unit]
Description=Bluetooth auto-pair agent (Watermans)
After=bluetooth.service
Requires=bluetooth.service

[Service]
ExecStartPre=/usr/bin/bluetoothctl discoverable on
ExecStart=/usr/bin/bt-agent --capability=NoInputNoOutput
Restart=always

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now bt-agent.service

bluetoothctl <<BTCTL
power on
pairable on
discoverable on
BTCTL

cat <<DONE

==> Done. On your phone: Settings → Bluetooth → pair with "$NAME", then play
    something (e.g. YouTube). It should come out the venue box.

    If it pairs but there's no sound, the PipeWire audio routing may need a
    nudge — reboot the Pi once (sudo reboot) and try again, and make sure the
    app's own player is paused.

    Reminder: after close only, phone kept near the box.
    To remove later:  sudo systemctl disable --now bt-agent && sudo apt remove --purge bluez-tools
DONE
