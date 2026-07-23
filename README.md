# Watermans Music

Scheduled background music for restaurants and venues, using **royalty-free
tracks you supply** — no public-performance licensing fees (APRA/PPCA), no
subscription, and your audio stays on your own machine. A free, self-hosted
alternative to services like Mustard Live, styled to match the HOT toolkit.

Control it from any phone, tablet, or computer on the venue network — it's a
web app (nothing to install).

## Features

- **Now Playing** — dual-deck player with **crossfade** (adjustable) for
  seamless, gap-free background music; play/pause/skip, a seekable progress
  bar, volume, **up-next** queue and **recently-played** history.
- **Like / Dislike** — like a track so it plays *more often*; dislike to *ban*
  it. Works from Now Playing or inline in the Library.
- **Shuffle** with weighted rotation (likes surface more, dislikes never).
- **Schedule** — fully **editable time blocks** (add / rename / delete / re-time)
  × days; assign a playlist per cell; switches automatically through the day.
- **Library** — drag-and-drop upload, search, delete; friendly track titles.
- **After-hours staff mode** — hidden, password-gated; play a staff playlist
  off-schedule. Password stays server-side.
- **Venue stream** — a continuous MP3 stream (`/stream`) a Q-SYS Core (or VLC)
  can pull; plus a headless player mode for a Raspberry Pi "music box".
- **Design** — HOT teal/orange brand, **light + dark** (auto or manual toggle),
  Add-to-Home-Screen. **Keyboard**: space = play/pause, ←/→ = skip, L/D = rate.
- Runs offline from local files; settings saved to `data.json`.

## Quick start

**Windows:** just double-click **`run.bat`**. It installs everything on first
run, generates test tones if you have no music yet, starts the app, and opens
it in your browser. (Needs [Node.js LTS](https://nodejs.org) installed once.)

**Mac / Linux / manual:**

```bash
npm install
npm start         # http://127.0.0.1:3100
```

The library starts empty. Add music on the **Playlists** tab by dragging your
MP3s into the page (or drop files into the `music/` folder). Use license-free
tracks so there are no venue fees — see `MUSIC-LIBRARY.md` for a curated list of
free, restaurant-safe sources (Pixabay Organic House, etc.).

Then open the app, create a playlist on the **Playlists** tab, assign it to
time blocks on the **Schedule** tab, and it plays automatically on
**Now Playing**.

Add your own music by dropping files into `music/` (see `music/README.md` for
license-free sources). Audio files are gitignored — they stay on your machine.

## Playing on your venue's sound system

The browser tab plays on the local computer's own audio. To reach a venue
system that pulls a **network stream** (e.g. a Q-SYS Core, like Mustard Live),
the app also broadcasts a continuous MP3 stream that follows your schedule:

```
http://<this-computer's-LAN-IP>:3100/stream
```

The exact address is shown on the **Now Playing** tab (with a Copy button) and
printed in the console at startup. To get audio into the venue:

1. Run the app on an **always-on computer on the venue network** (so the stream
   URL is always available).
2. **Test the stream** first by opening that URL in VLC (*Media → Open Network
   Stream*) or a browser — you should hear the scheduled music.
3. Hand the URL to whoever programs your **Q-SYS Core** and ask them to point
   the streaming audio input at it (and route it to your zones). This is a
   small change in Q-SYS Designer — the app can't configure the Core itself.

The stream runs server-side and follows the Schedule on its own, independent of
whether a browser is open. It never goes silent: if nothing is scheduled it
falls back to another playlist, then to the whole library.

> The stream is CBR MP3. Q-SYS streaming inputs commonly accept a Shoutcast/
> Icecast MP3 URL — if yours is configured for HLS or AES67 instead, tell me
> and the output can be adapted.

The server binds to all network interfaces by default so the Core can reach it.
Set `HOST=127.0.0.1` to restrict the app to the local machine only.

## Configuration

- `PORT` — HTTP port (default `3100`).
- `HOST` — bind address (default `127.0.0.1`, loopback only). Set to `0.0.0.0`
  to reach it from other devices on your LAN.

## Tech

Node + Express backend (library scan, playlist/schedule persistence, ranged
audio streaming); vanilla-JS single-page frontend. No external services.
