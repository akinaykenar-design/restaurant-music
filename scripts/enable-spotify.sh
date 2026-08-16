#!/usr/bin/env bash
#
# Turn the Pi into a Spotify Connect speaker called "Watermans", so staff can
# cast their own Spotify (Premium) to the venue box after hours. Run once:
#
#     cd ~/restaurant-music
#     bash scripts/enable-spotify.sh
#
# It installs raspotify (an open-source Spotify Connect client) and points its
# audio at the same output the music app uses (the 3.5mm jack by default).
#
# NOTE ON USE: this streams a *personal* Spotify account. Personal accounts are
# licensed for personal use, not public/commercial playback — so this is for
# AFTER CLOSE, when there are no guests. During trading hours, stick to the
# royalty-free library (that's the whole point of the box).
#
# The Pi can only play one thing at a time: pause the app's player (Now Playing
# ⏸, or Admin > Venue output > Pause) before casting Spotify, or they'll fight
# over the speaker.
set -e

NAME="Watermans"
CARD="${AUDIO_CARD:-2}"          # 3.5mm jack = card 2 on a Pi (matches the app)
DEVICE="plughw:${CARD},0"

echo "==> Installing raspotify (Spotify Connect)…"
curl -sSL https://dtcooper.github.io/raspotify/install.sh | sh

echo "==> Configuring it as '$NAME' on audio device $DEVICE…"
sudo tee /etc/raspotify/conf >/dev/null <<CONF
# Watermans — Spotify Connect. Managed by scripts/enable-spotify.sh
LIBRESPOT_NAME="$NAME"
LIBRESPOT_DEVICE_TYPE="speaker"
LIBRESPOT_BITRATE="320"
LIBRESPOT_INITIAL_VOLUME="55"
LIBRESPOT_BACKEND="alsa"
LIBRESPOT_DEVICE="$DEVICE"
CONF

echo "==> Restarting raspotify…"
sudo systemctl restart raspotify
sudo systemctl enable raspotify >/dev/null 2>&1 || true

cat <<DONE

==> Done. On any phone/laptop signed into Spotify (Premium), on the SAME network:
      1. Start playing something.
      2. Tap the "Connect to a device" icon (the little speaker/screen icon,
         bottom-left of the Now Playing bar).
      3. Pick "$NAME" from the device list.
    It'll play out the venue box. Remember: after close only, and pause the
    app's player first so they don't fight over the speaker.

    To remove later:  sudo apt remove --purge raspotify
DONE
