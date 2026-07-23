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
npm start         # http://127.0.0.1:3100
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
