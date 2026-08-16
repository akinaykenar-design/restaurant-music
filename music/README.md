# The `music/` folder

Drop your audio files here (`.mp3`, `.m4a`, `.aac`, `.ogg`, `.wav`, `.flac`,
`.webm`). Each file shows up in the app's **Library**, ready to add to
playlists. The filename (without extension) becomes the track title.

Your own audio files are **not** committed to git — they stay on your machine,
so you control licensing.

## Included music (copyright-free)

This folder ships with six original background tracks (`cafe-01-sunrise.mp3` …
`cafe-06-night-hush.mp3`). They were **generated from scratch in code**
(`scripts/generate-music.js`), so they're 100% original and copyright-free —
safe to play in a venue with no licensing fees. Use them as-is, or delete them
and drop in your own.

- `npm run music` — regenerate the originals (only creates any that are missing).
- `npm run tones` — generate a few short CC0 test tones instead.

## Where to get license-free music

Using royalty-free / license-free tracks means you avoid public-performance
licensing fees (e.g. APRA AMCOS + PPCA in Australia, PRS/PPL in the UK, ASCAP/
BMI/SESAC in the US) for playing recorded music in a venue. Always confirm each
source's licence covers **commercial / public performance**, and keep a record.

- **Pixabay Music** — https://pixabay.com/music/ — free for commercial use, no
  attribution required.
- **Free Music Archive (FMA)** — https://freemusicarchive.org/ — filter by CC0
  / commercial-use licences.
- **Uppbeat** — https://uppbeat.io/ — free tier for business use (check terms).
- **YouTube Audio Library** — creator-focused; check per-track terms.
- **Kevin MacLeod / Incompetech** — https://incompetech.com/ — CC-BY (needs
  attribution).

> Not legal advice — verify each track's licence for your country and use case
> before playing it in your venue.
