# Scope — deeper track analysis (genre / mood / vocals)

Today the app measures only **energy** (loudness) and **tempo** (BPM) in the
browser, which honestly supports **3 energy vibes** (Chill / Warm / Lively) and
nothing about *style*. This scopes what it would take to detect real musical
qualities — and, importantly, to **auto-flag the styles you hate**.

## What we'd want to detect

- **Vocals vs instrumental** — reliable, and the single most useful one for a
  restaurant (instrumental-only rooms).
- **Broad genre** — electronic / house / ambient / downtempo vs jazz / acoustic
  / folk / hip-hop. This is what auto-catches your **hard-nos** (afro, lofi,
  acoustic guitar, jazz) without you listening to each track.
- **Mood** — relaxed / happy / dark / energetic.
- **Timbre** — bright vs warm, sparse vs busy, acoustic vs electronic.

## Options

### A. Richer DSP features (no model) — *light*
Compute extra features on decode: spectral centroid (brightness), spectral
flatness (tonal vs noisy), band-energy ratios (bass/mid/treble), zero-crossing
rate, tempo confidence. Feed simple rules.
- **Gets you:** bright-vs-warm, sparse-vs-busy, a rough acoustic-vs-electronic
  guess. 4–5 *fuzzy* dimensions.
- **Not reliably:** genre names, vocal detection.
- **Cost:** ~1 day. No downloads. Runs fine in-browser / on the Pi.

### B. Pre-trained music-tagging model (Essentia.js / MusiCNN) — *the real answer*
Bundle a small purpose-built music model (Essentia.js, WASM — runs in the
browser and in Node). MusiCNN’s MSD model outputs ~50 tags: **instrumental**,
**vocal**, genres (**electronic, house, ambient, jazz, folk, hip-hop…**), and
moods.
- **Gets you:** real vocal detection + broad genre + mood. Directly powers
  “instrumental only”, auto-excluding afro/lofi/jazz/acoustic, and honest style
  filters/scenes.
- **Cost:** ~2–4 days to integrate, map tags → our vibes/filters, and tune.
  Model bundle ≈ 5–20 MB, stored locally (stays offline). Analysis is a
  one-time pass per track (a few seconds each on the Pi), cached in `data.json`
  exactly like the current energy/vibe cache — so playback is never affected.
- **Where it runs:** either the browser (WASM, like the current analyser) or
  server-side in Node during the library scan. Server-side is better on the Pi
  (analyse once for everyone).

### C. Cloud API — *rejected*
An online service (e.g. AcousticBrainz-style) would be simplest but breaks the
“runs offline on your own box, no subscriptions” promise. Not doing this.

## Recommendation

**Option B, server-side, with Essentia.js.** It’s the only one that delivers
what you actually asked for (genre/mood/vocals), it stays fully offline, and it
turns curation from manual into automatic:

- A one-click **“Deep-analyse library”** (like the current Analyse button) tags
  every track with genre + mood + instrumental/vocal.
- New library filters: **Genre**, **Vocals: instrumental-only**, plus the
  existing energy vibe.
- **Auto-flag** tracks matching your hard-nos (afro / amapiano / lofi / jazz /
  acoustic) so they’re easy to bulk-ban.
- Optionally a smarter Scene like **“Dinner — instrumental, warm”** that’s a
  real audio match, not a guess.

## Risks / honest caveats

- Genre/mood models are ~70–85% accurate on broad tags — great for filtering and
  suggestions, not perfect; you’d still get the final say (like/ban).
- First-run analysis of a big library takes a while on a Pi (minutes for
  hundreds of tracks), but it’s one-time and cached.
- Adds a model file to the project (kept local).

## Effort summary

| Option | What you get | Effort | Downloads |
|---|---|---|---|
| A — DSP features | fuzzy brightness/busyness | ~1 day | none |
| **B — Essentia.js (recommended)** | **genre + mood + vocals, auto-flagging** | ~2–4 days | ~5–20 MB model (local) |
| C — cloud API | same as B, less work | — | rejected (not offline) |
