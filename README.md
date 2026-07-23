# Venue Music

Scheduled background music for restaurants and venues, using **royalty-free
tracks you supply** — so you avoid public-performance licensing fees and keep
your audio files on your own machine.

Music switches automatically by time of day and day of week: a calm morning
playlist, a brighter lunch set, a mellow evening vibe, and so on.

## Features (v0.1)

- **Now Playing** — auto-plays the playlist scheduled for the current time
  block, with play/pause/skip, volume, an up-next queue, and a
  *Follow schedule* toggle.
- **Schedule** — a weekly grid of time blocks × days; assign a playlist to each
  cell. Music switches automatically when a block begins (and wraps past
  midnight).
- **Playlists** — build named playlists from the files in your `music/` folder.
- Runs locally (loopback only by default), offline, settings saved to
  `data.json`.

## Quick start

**Windows:** just double-click **`run.bat`**. It installs everything on first
run, generates test tones if you have no music yet, starts the app, and opens
it in your browser. (Needs [Node.js LTS](https://nodejs.org) installed once.)

**Mac / Linux / manual:**

```bash
npm install
npm start         # http://127.0.0.1:3000
```

The app ships with **six original background tracks** in `music/` (soft café
ambience — pads, arpeggios, gentle melodies). They're generated from scratch in
code (`scripts/generate-music.js`), so they're **copyright-free** and safe to
play in a venue with no licensing fees. Run `npm run music` to regenerate them,
or just drop your own royalty-free files into `music/`.

Then open the app, create a playlist on the **Playlists** tab, assign it to
time blocks on the **Schedule** tab, and it plays automatically on
**Now Playing**.

Add your own music by dropping files into `music/` (see `music/README.md` for
license-free sources). Audio files are gitignored — they stay on your machine.

## Playing on your venue's sound system

By default the app plays audio in the browser tab on whatever device runs it.
The simplest venue setup is to run it on a computer or tablet wired into your
amp/mixer — audio comes straight out the line-out. Casting to networked
speakers (Sonos, Chromecast/Cast, AirPlay) is planned; see the issues/roadmap.

## Configuration

- `PORT` — HTTP port (default `3000`).
- `HOST` — bind address (default `127.0.0.1`, loopback only). Set to `0.0.0.0`
  to reach it from other devices on your LAN.

## Tech

Node + Express backend (library scan, playlist/schedule persistence, ranged
audio streaming); vanilla-JS single-page frontend. No external services.
