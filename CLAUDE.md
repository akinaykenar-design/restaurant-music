# Working preferences

- **No popups.** Do not use interactive question/popup dialogs (e.g. AskUserQuestion
  cards). When a choice or clarification is needed, ask it in plain chat text and
  let the user reply normally. When there's a sensible default, just make the call
  and say what you did — don't block on a dialog.

# The venue Pi (Watermans Music box)

Claude has NO access to the Pi — it's on the venue LAN at the restaurant
(Sydney — timezone Australia/Sydney). The user runs all commands on it and
pastes output back.

- App runs as a systemd service: `watermans-music`, port **3100**, repo at
  `~/restaurant-music` on the Pi.
- Web app on venue wifi: `http://watermans-3.local:3100` (hostname is
  `watermans-3`) — or `http://<pi-ip>:3100`.
- SSH from a laptop on the same wifi: `ssh <username>@watermans-3.local`
- Pi username / static IP: (not recorded yet — fill in when known)
- Audio: Pi 3.5mm jack → Q-SYS BGM 1. After-hours Spotify → Bluetooth
  receiver on BGM 2.
- Handy commands on the Pi:
  - `sudo systemctl status watermans-music` — is it running?
  - `journalctl -u watermans-music -f` — live logs
  - `sudo systemctl restart watermans-music` — restart
  - `cd ~/restaurant-music && git pull && sudo systemctl restart watermans-music` — update
- Users update the app from Admin tab → **Update** button (pulls + restarts).
