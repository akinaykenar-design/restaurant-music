#!/usr/bin/env bash
#
# Turn the Pi into an AirPlay speaker called "Watermans", so staff can cast
# audio from an iPhone/iPad/Mac to the venue box — YouTube, Apple Music,
# anything playing on the device. Run once:
#
#     cd ~/restaurant-music
#     bash scripts/enable-airplay.sh
#
# HOW YOUTUBE WORKS: YouTube can't cast to a Pi directly. Instead you play the
# video on your phone and AirPlay the phone's audio to "Watermans" (swipe into
# Control Centre → AirPlay → Watermans). The sound comes out the box.
#
# NOTE ON USE: this streams from a personal device/account — licensed for
# personal use, not public playback. So it's for AFTER CLOSE, no guests. During
# trading hours use the royalty-free library.
#
# ONE PLAYER AT A TIME: pause the app's player (Now Playing ⏸) before casting,
# or they'll fight over the speaker.
set -e

NAME="Watermans"
CARD="${AUDIO_CARD:-2}"          # 3.5mm jack = card 2 on a Pi (matches the app)
DEVICE="plughw:${CARD},0"

echo "==> Installing shairport-sync (AirPlay receiver)…"
sudo apt update
sudo apt install -y shairport-sync

echo "==> Configuring it as '$NAME' on audio device $DEVICE…"
sudo tee /etc/shairport-sync.conf >/dev/null <<CONF
// Watermans — AirPlay. Managed by scripts/enable-airplay.sh
general = {
  name = "$NAME";
  volume_range_db = 60;
};
alsa = {
  output_device = "$DEVICE";
};
CONF

echo "==> Enabling and starting shairport-sync…"
sudo systemctl enable shairport-sync >/dev/null 2>&1 || true
sudo systemctl restart shairport-sync

cat <<DONE

==> Done. On an iPhone/iPad/Mac on the SAME network:
      1. Play something (e.g. a YouTube video).
      2. Open Control Centre → tap the AirPlay icon (top-right of the audio tile).
      3. Pick "$NAME".
    Audio now comes out the venue box. After close only, and pause the app's
    player first so they don't clash.

    To remove later:  sudo apt remove --purge shairport-sync
DONE
