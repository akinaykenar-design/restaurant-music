# Setting up the Raspberry Pi "music box"

This turns a Raspberry Pi into an always-on music box: it plays your scheduled
music out its audio output into the venue's sound system, and you manage it
(playlists, schedule, uploads) from any phone or computer on the network.

## What you need
- **Raspberry Pi 4 (2GB is plenty)** + power supply + case
- **microSD card** (32–64GB) with **Raspberry Pi OS** on it
- **Ethernet cable** into the rack switch (recommended — more reliable than WiFi)
- Audio out: the **Pi's 3.5mm headphone jack**, or a **$10 USB audio adapter**
  for cleaner sound
- The cable that currently goes into the **Mustard box** (you'll move it to the Pi)

## Step 1 — Put Raspberry Pi OS on the card
On any computer, install **Raspberry Pi Imager** (raspberrypi.com/software),
then:
1. Choose **Raspberry Pi OS (64-bit)**.
2. Click the gear / "Edit settings" and set: a **hostname** like `watermans`,
   enable **SSH**, set a username/password, and your **WiFi** (if not using
   ethernet). This lets you set it up without a monitor.
3. Write the card, put it in the Pi, power on.

## Step 2 — Get the app onto the Pi
From your computer, connect to the Pi (replace `watermans` with your hostname):

```bash
ssh <username>@watermans.local
```

Copy the app across (the `restaurant-music` folder), or unzip the tarball there,
so you have `~/restaurant-music` on the Pi.

## Step 3 — Run the installer
```bash
cd ~/restaurant-music
bash scripts/install-pi.sh
```

This installs everything and sets the app to **start automatically on boot**
and play the scheduled music out the Pi. When it finishes it prints the address
to open from your phone, e.g. `http://watermans.local:3100` or
`http://192.168.x.x:3100`.

## Step 4 — Choose the audio output
```bash
sudo raspi-config
```
→ **System Options → Audio** → pick the **Headphone jack** (or your USB adapter).
Test it:
```bash
speaker-test -t sine -f 440 -c 2   # you should hear a tone; Ctrl+C to stop
```

## Step 5 — Connect it to the sound system
Move the audio cable **from the Mustard box into the Pi's headphone jack**
(or the USB adapter). On the Q-SYS iPad, keep the source on **BGM 1** — the Pi
is now feeding that input instead of Mustard.

## Everyday use
- Open `http://watermans.local:3100` on any phone/computer on the venue network.
- **Playlists** tab → drag & drop your MP3s to upload, build playlists.
- **Schedule** tab → set which playlist plays at each time of day.
- **Now Playing** → the "Venue output" panel shows what the box is playing, with
  Skip / Pause.
- Tap **Add to Home Screen** on your phone for an app-like icon.

## Handy commands
```bash
sudo systemctl status watermans-music     # is it running?
journalctl -u watermans-music -f          # live logs
sudo systemctl restart watermans-music    # restart it
```

The box plays on its own from boot — you only open the app when you want to
change the music or schedule.

## After-hours: play Spotify from a phone (optional Bluetooth)

For after-close staff music, the easiest way to let anyone play Spotify off
their phone is a small **Bluetooth audio receiver** wired into a spare input:

1. Buy a **Bluetooth 5.x audio receiver** with a 3.5mm/RCA output (~$20–35,
   e.g. Amazon AU "Bluetooth receiver 3.5mm/RCA"). Plug its output into a spare
   Q-SYS input (ask your Q-SYS programmer to wire it to **BGM 2**, say).
2. **Connect:** on the phone open **Settings → Bluetooth**, and pair with the
   receiver (it shows a name like "BT-Receiver"/"BTR"; some need a pairing
   button held for a few seconds). Once paired, open Spotify and play — audio
   goes out the venue speakers.
3. On the Q-SYS iPad, select **BGM 2** as the source when using it, and back to
   **BGM 1** (this music box) for normal hours.

> Licensing: personal Spotify is fine for **staff-only, venue-closed** use, but
> it is **not** licensed to play to customers during trading — use your own
> royalty-free library (this app) for that.
