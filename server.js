'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const https = require('https');
const http = require('http');
const qrcode = require('qrcode-generator');

const app = express();
// Port 3100 (not the very common 3000) so it doesn't clash with other local
// dev servers such as a POS. Override with the PORT env var if needed.
const PORT = process.env.PORT || 3100;
// Bind to all interfaces so the venue's Q-SYS Core can pull /stream over the
// LAN. Set HOST=127.0.0.1 to restrict to this machine only.
const HOST = process.env.HOST || '0.0.0.0';

const ROOT = __dirname;
const MUSIC_DIR = path.join(ROOT, 'music');
const DATA_FILE = path.join(ROOT, 'data.json');

const AUDIO_EXT = new Set(['.mp3', '.m4a', '.aac', '.ogg', '.oga', '.wav', '.flac', '.webm']);
const MIME = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.webm': 'audio/webm',
};

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(ROOT, 'public')));

// ---- persistence -----------------------------------------------------------

function defaultData() {
  // 7 days x 4 time blocks. Each cell holds a playlist name (or "").
  const blocks = [
    { id: 'morning', label: 'Morning', start: '06:00' },
    { id: 'lunch', label: 'Lunch', start: '11:00' },
    { id: 'afternoon', label: 'Afternoon', start: '15:00' },
    { id: 'evening', label: 'Evening', start: '18:00' },
  ];
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const schedule = {};
  for (const d of days) {
    schedule[d] = {};
    for (const b of blocks) schedule[d][b.id] = '';
  }
  return {
    blocks, days, schedule, playlists: {}, autoPlaylists: [], ratings: {}, meta: {},
    // licensed = commercial/copyrighted tracks staff added for AFTER-HOURS only
    // (no guests). Kept out of the trading-hours rotation; only the "afterhours"
    // play token (admin-gated) ever plays them.
    licensed: {},
    settings: {
      venueName: 'Watermans',
      volume: 0.8, venueVolume: 80, followSchedule: true, shuffle: true, crossfade: 4,
      // physical audio output on the box (chosen in Admin > Audio output).
      // '' = system default; otherwise an ALSA device like 'hw:2,0'.
      audioDevice: '', audioCard: null, audioControl: null,
      afterHoursPassword: 'staff', // change it in the unlocked panel
    },
  };
}

// Settings safe to send to the browser (never leak the after-hours password).
function publicSettings() {
  const s = Object.assign({}, data.settings);
  delete s.afterHoursPassword;
  s.afterHoursSet = !!data.settings.afterHoursPassword;
  return s;
}

function loadData() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Object.assign(defaultData(), parsed);
  } catch {
    return defaultData();
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

let data = loadData();

// ---- library scan ----------------------------------------------------------

// Turn a filename into a friendly display title:
// "cafe-01-sunrise.mp3" -> "Sunrise", "chill_organic_house.mp3" -> "Chill Organic House"
function prettyTitle(file) {
  let base = path.basename(file, path.extname(file));
  let tokens = base.split(/[-_\s]+/).filter(Boolean);
  // Drop a leading "cafe" tag and any leading pure-number tokens (track numbers).
  while (tokens.length > 1 && (/^\d+$/.test(tokens[0]) || tokens[0].toLowerCase() === 'cafe')) {
    tokens.shift();
  }
  return tokens
    .map((t) => (t.length ? t[0].toUpperCase() + t.slice(1) : t))
    .join(' ');
}

// Approximate track length in seconds (CBR MP3 from file size / bitrate; 0 if unknown).
function trackDuration(file) {
  try {
    const full = path.join(MUSIC_DIR, file);
    const stat = fs.statSync(full);
    if (path.extname(file).toLowerCase() === '.mp3') {
      const fd = fs.openSync(full, 'r');
      const buf = Buffer.alloc(16384);
      const n = fs.readSync(fd, buf, 0, 16384, 0);
      fs.closeSync(fd);
      const br = mp3ByteRate(buf.subarray(0, n)); // bytes/sec
      if (br > 0) return Math.round(stat.size / br);
    }
  } catch { /* ignore */ }
  return 0;
}

// Standard ID3v1 genre names (index -> name). Used to resolve numeric genre
// references like "(17)" that ID3v2 TCON frames sometimes carry.
const ID3_GENRES = [
  'Blues', 'Classic Rock', 'Country', 'Dance', 'Disco', 'Funk', 'Grunge', 'Hip-Hop', 'Jazz', 'Metal',
  'New Age', 'Oldies', 'Other', 'Pop', 'R&B', 'Rap', 'Reggae', 'Rock', 'Techno', 'Industrial',
  'Alternative', 'Ska', 'Death Metal', 'Pranks', 'Soundtrack', 'Euro-Techno', 'Ambient', 'Trip-Hop', 'Vocal', 'Jazz+Funk',
  'Fusion', 'Trance', 'Classical', 'Instrumental', 'Acid', 'House', 'Game', 'Sound Clip', 'Gospel', 'Noise',
  'Alt. Rock', 'Bass', 'Soul', 'Punk', 'Space', 'Meditative', 'Instrumental Pop', 'Instrumental Rock', 'Ethnic', 'Gothic',
  'Darkwave', 'Techno-Industrial', 'Electronic', 'Pop-Folk', 'Eurodance', 'Dream', 'Southern Rock', 'Comedy', 'Cult', 'Gangsta',
  'Top 40', 'Christian Rap', 'Pop/Funk', 'Jungle', 'Native American', 'Cabaret', 'New Wave', 'Psychadelic', 'Rave', 'Showtunes',
  'Trailer', 'Lo-Fi', 'Tribal', 'Acid Punk', 'Acid Jazz', 'Polka', 'Retro', 'Musical', 'Rock & Roll', 'Hard Rock',
  'Folk', 'Folk-Rock', 'National Folk', 'Swing', 'Fast Fusion', 'Bebob', 'Latin', 'Revival', 'Celtic', 'Bluegrass',
  'Avantgarde', 'Gothic Rock', 'Progressive Rock', 'Psychedelic Rock', 'Symphonic Rock', 'Slow Rock', 'Big Band', 'Chorus', 'Easy Listening', 'Acoustic',
  'Humour', 'Speech', 'Chanson', 'Opera', 'Chamber Music', 'Sonata', 'Symphony', 'Booty Bass', 'Primus', 'Porn Groove',
  'Satire', 'Slow Jam', 'Club', 'Tango', 'Samba', 'Folklore', 'Ballad', 'Power Ballad', 'Rhythmic Soul', 'Freestyle',
  'Duet', 'Punk Rock', 'Drum Solo', 'A capella', 'Euro-House', 'Dance Hall', 'Goa', 'Drum & Bass', 'Club-House', 'Hardcore',
  'Terror', 'Indie', 'BritPop', 'Afro-Punk', 'Polsk Punk', 'Beat', 'Christian Gangsta Rap', 'Heavy Metal', 'Black Metal', 'Crossover',
  'Contemporary Christian', 'Christian Rock', 'Merengue', 'Salsa', 'Thrash Metal', 'Anime', 'JPop', 'Synthpop',
];

// Resolve a raw TCON genre string: "(17)" -> "Rock", "(17)Rock" -> "Rock",
// "Deep House" -> "Deep House". Returns '' when nothing usable is found.
function cleanGenre(v) {
  if (!v) return '';
  v = String(v).trim();
  const m = v.match(/^\((\d+)\)\s*(.*)$/);
  if (m) return m[2].trim() || ID3_GENRES[+m[1]] || '';
  if (/^\d+$/.test(v)) return ID3_GENRES[+v] || v;
  return v;
}

// Decode an ID3v2 text-frame body honouring its encoding byte.
function decodeTextFrame(b) {
  if (!b || !b.length) return '';
  const enc = b[0];
  let body = b.subarray(1);
  let s;
  if (enc === 1) { // UTF-16 with BOM
    if (body[0] === 0xff && body[1] === 0xfe) s = body.subarray(2).toString('utf16le');
    else if (body[0] === 0xfe && body[1] === 0xff) s = Buffer.from(body.subarray(2)).swap16().toString('utf16le');
    else s = body.toString('utf16le');
  } else if (enc === 2) { // UTF-16BE, no BOM
    s = Buffer.from(body).swap16().toString('utf16le');
  } else if (enc === 3) { // UTF-8
    s = body.toString('utf8');
  } else { // ISO-8859-1
    s = body.toString('latin1');
  }
  return s.replace(/\0+$/, '').replace(/\0/g, ' ').trim();
}

// Read genre / artist / title / BPM tags from an audio file (ID3v2 at the head,
// ID3v1 at the tail as a fallback). Best-effort; returns {} on anything odd.
function readId3(full) {
  const out = { genre: '', artist: '', title: '', bpm: null };
  let fd;
  try {
    fd = fs.openSync(full, 'r');
    const stat = fs.fstatSync(fd);
    const head = Buffer.alloc(10);
    fs.readSync(fd, head, 0, 10, 0);
    if (head.toString('latin1', 0, 3) === 'ID3') {
      const ver = head[3];
      const size = ((head[6] & 0x7f) << 21) | ((head[7] & 0x7f) << 14) | ((head[8] & 0x7f) << 7) | (head[9] & 0x7f);
      const readLen = Math.min(size, 1 << 20); // cap tag read at 1MB (skips huge cover art)
      const buf = Buffer.alloc(readLen);
      fs.readSync(fd, buf, 0, readLen, 10);
      const wanted = { TCON: 'genre', TPE1: 'artist', TIT2: 'title', TBPM: 'bpm' };
      let i = 0;
      while (i + 10 <= buf.length) {
        const id = buf.toString('latin1', i, i + 4);
        if (!/^[A-Z0-9]{4}$/.test(id)) break; // hit padding / end of frames
        let fsz;
        if (ver === 4) fsz = ((buf[i + 4] & 0x7f) << 21) | ((buf[i + 5] & 0x7f) << 14) | ((buf[i + 6] & 0x7f) << 7) | (buf[i + 7] & 0x7f);
        else fsz = (buf[i + 4] << 24) | (buf[i + 5] << 16) | (buf[i + 6] << 8) | buf[i + 7];
        if (fsz <= 0 || i + 10 + fsz > buf.length) break;
        const key = wanted[id];
        if (key) {
          const val = decodeTextFrame(buf.subarray(i + 10, i + 10 + fsz));
          if (key === 'genre') out.genre = cleanGenre(val);
          else if (key === 'bpm') { const n = parseInt(val, 10); if (n > 0 && n < 300) out.bpm = n; }
          else out[key] = val;
        }
        i += 10 + fsz;
      }
    }
    if ((!out.genre || !out.artist) && stat.size > 128) { // ID3v1 fallback
      const v1 = Buffer.alloc(128);
      fs.readSync(fd, v1, 0, 128, stat.size - 128);
      if (v1.toString('latin1', 0, 3) === 'TAG') {
        if (!out.artist) out.artist = v1.toString('latin1', 33, 63).replace(/\0.*$/, '').trim();
        if (!out.title) out.title = v1.toString('latin1', 3, 33).replace(/\0.*$/, '').trim();
        if (!out.genre) { const g = v1[127]; if (g < ID3_GENRES.length) out.genre = ID3_GENRES[g]; }
      }
    }
  } catch { /* ignore */ }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ } }
  return out;
}

// Extract embedded cover art (ID3v2 APIC frame) from a file, if present.
// Returns { mime, data:Buffer } or null. Reads up to 8MB of tag to reach art.
function readArt(full) {
  let fd;
  try {
    fd = fs.openSync(full, 'r');
    const head = Buffer.alloc(10);
    fs.readSync(fd, head, 0, 10, 0);
    if (head.toString('latin1', 0, 3) !== 'ID3') return null;
    const ver = head[3];
    const size = ((head[6] & 0x7f) << 21) | ((head[7] & 0x7f) << 14) | ((head[8] & 0x7f) << 7) | (head[9] & 0x7f);
    const readLen = Math.min(size, 8 << 20);
    const buf = Buffer.alloc(readLen);
    fs.readSync(fd, buf, 0, readLen, 10);
    let i = 0;
    while (i + 10 <= buf.length) {
      const id = buf.toString('latin1', i, i + 4);
      if (!/^[A-Z0-9]{4}$/.test(id)) break;
      let fsz;
      if (ver === 4) fsz = ((buf[i + 4] & 0x7f) << 21) | ((buf[i + 5] & 0x7f) << 14) | ((buf[i + 6] & 0x7f) << 7) | (buf[i + 7] & 0x7f);
      else fsz = (buf[i + 4] << 24) | (buf[i + 5] << 16) | (buf[i + 6] << 8) | buf[i + 7];
      if (fsz <= 0 || i + 10 + fsz > buf.length) break;
      if (id === 'APIC') {
        const end = i + 10 + fsz;
        let p = i + 10;
        const enc = buf[p]; p += 1;
        let mimeEnd = buf.indexOf(0, p); if (mimeEnd < 0 || mimeEnd >= end) mimeEnd = p;
        const mime = buf.toString('latin1', p, mimeEnd); p = mimeEnd + 1;
        p += 1; // picture-type byte
        if (enc === 1 || enc === 2) { while (p + 1 < end && !(buf[p] === 0 && buf[p + 1] === 0)) p += 2; p += 2; }
        else { while (p < end && buf[p] !== 0) p += 1; p += 1; }
        const data = buf.subarray(p, end);
        if (data.length > 100) return { mime: /^image\//.test(mime) ? mime : 'image/jpeg', data: Buffer.from(data) };
      }
      i += 10 + fsz;
    }
    return null;
  } catch { return null; }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ } }
}
const artCache = new Map(); // file -> { mtime, mime?, data?, none? }

// Bucket a track into a serving "vibe" from its measured energy (RMS, ~0.02–0.30
// for music) and tempo. Three levels is the reliable ceiling for energy+tempo:
// Two vibes: Chill (calm/slower) and Lively (upbeat/faster). '' = not analysed.
function vibeFor(energy, bpm) {
  if (energy == null || !isFinite(energy)) return '';
  const e = Math.max(0, Math.min(1, (energy - 0.03) / 0.20));      // loudness/density
  const b = bpm ? Math.max(0, Math.min(1, (bpm - 72) / (128 - 72))) : e; // tempo
  const s = 0.6 * e + 0.4 * b;
  return s < 0.5 ? 'Chill' : 'Lively';
}

// Migrate old labels to the current two-vibe scheme so libraries analysed
// before this change keep working without a re-scan: Upbeat and the old
// middle 'Warm' tier both fold into Lively (Chill stays for truly calm tracks).
const normalizeVibe = (v) => (v === 'Upbeat' || v === 'Warm' ? 'Lively' : v || '');

let metaDirty = false;

// Per-file metadata cache. ID3 tags + duration are read once per file and reused
// until the file's size/mtime changes; audio analysis (energy/vibe) is preserved
// across tag re-reads and only cleared when the underlying audio is replaced.
function trackMeta(file) {
  const full = path.join(MUSIC_DIR, file);
  let sig = '';
  try { const st = fs.statSync(full); sig = st.size + ':' + Math.round(st.mtimeMs); } catch { /* ignore */ }
  data.meta = data.meta || {};
  const prev = data.meta[file];
  if (prev && prev.sig === sig) return prev;
  const keep = prev && !prev.sig; // analyse-before-scan entry: keep its analysis
  const id3 = readId3(full);
  const m = {
    sig,
    genre: id3.genre || '',
    artist: id3.artist || '',
    title: id3.title || '',
    bpm: id3.bpm || null,
    duration: trackDuration(file),
    energy: keep && prev.energy != null ? prev.energy : null,
    analyzedBpm: keep ? (prev.analyzedBpm || null) : null,
    vibe: keep ? normalizeVibe(prev.vibe) : '',
    analyzedAt: keep ? (prev.analyzedAt || null) : null,
  };
  data.meta[file] = m;
  metaDirty = true;
  return m;
}

function scanLibrary() {
  try {
    fs.mkdirSync(MUSIC_DIR, { recursive: true });
    const files = fs
      .readdirSync(MUSIC_DIR)
      .filter((f) => AUDIO_EXT.has(path.extname(f).toLowerCase()))
      .sort((a, b) => a.localeCompare(b));
    const tracks = files.map((f) => {
      const m = trackMeta(f);
      return {
        file: f,
        title: (m.title && m.title.trim()) || prettyTitle(f),
        duration: m.duration || 0,
        // a manually-set genre wins over the file's tag (Pixabay tracks
        // often ship with no genre, so staff can set one that sticks)
        genre: (data.genres && data.genres[f]) || m.genre || '',
        artist: m.artist || (data.credits && data.credits[f] && data.credits[f].artist) || '',
        bpm: m.analyzedBpm || m.bpm || null,
        energy: m.energy != null ? m.energy : null,
        vibe: normalizeVibe((data.vibes && data.vibes[f]) || m.vibe),
        // commercial/licensed track added for after-hours (no guests) only
        licensed: !!(data.licensed && data.licensed[f]),
      };
    });
    // Drop cache entries for files that no longer exist.
    if (data.meta) {
      const live = new Set(files);
      for (const k of Object.keys(data.meta)) if (!live.has(k)) { delete data.meta[k]; metaDirty = true; }
    }
    if (metaDirty) { saveData(data); metaDirty = false; }
    return tracks;
  } catch {
    return [];
  }
}

// ---- api -------------------------------------------------------------------

app.get('/api/library', (_req, res) => res.json({ tracks: scanLibrary() }));

// Embedded cover art for a track (or 404 if the file has none). Cached by mtime.
app.get('/api/art', (req, res) => {
  const file = String(req.query.file || '');
  if (!file || file.includes('..') || file.includes('/') || file.includes('\\')) return res.status(400).end();
  const full = path.join(MUSIC_DIR, file);
  let stat; try { stat = fs.statSync(full); } catch { return res.status(404).end(); }
  let c = artCache.get(file);
  if (!c || c.mtime !== stat.mtimeMs) {
    const art = readArt(full);
    c = art ? { mtime: stat.mtimeMs, mime: art.mime, data: art.data } : { mtime: stat.mtimeMs, none: true };
    artCache.set(file, c);
  }
  if (c.none) return res.status(404).end();
  res.set('Content-Type', c.mime);
  res.set('Cache-Control', 'public, max-age=86400');
  res.end(c.data);
});

// QR code (SVG) for a URL — used to open the app on phones/iPads by scanning.
app.get('/api/qr', (req, res) => {
  const text = String(req.query.text || '').slice(0, 512);
  if (!text) return res.sendStatus(400);
  try {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    res.set('Content-Type', 'image/svg+xml').set('Cache-Control', 'no-cache').send(qr.createSvgTag(6, 4));
  } catch (e) {
    res.sendStatus(500);
  }
});

// Upload an audio file (raw body; the browser posts the file bytes directly).
app.post('/api/upload', express.raw({ type: '*/*', limit: '300mb' }), (req, res) => {
  const name = path.basename(String(req.query.name || ''));
  if (!name || !AUDIO_EXT.has(path.extname(name).toLowerCase())) {
    return res.status(400).json({ error: 'audio file (mp3, m4a, ogg, wav, flac...) required' });
  }
  if (!req.body || !req.body.length) return res.status(400).json({ error: 'empty upload' });
  try {
    fs.mkdirSync(MUSIC_DIR, { recursive: true });
    fs.writeFileSync(path.join(MUSIC_DIR, name), req.body);
    // Uploaded from the after-hours panel? Flag it licensed so it stays out of
    // the trading-hours rotation.
    if (String(req.query.licensed || '') === '1') {
      data.licensed = data.licensed || {};
      data.licensed[name] = true;
      saveData(data);
    }
    res.json({ ok: true, file: name, title: prettyTitle(name), licensed: isLicensed(name) });
  } catch (e) {
    res.status(500).json({ error: 'could not save file' });
  }
});

// Delete a track from the library (and from any playlist that referenced it).
app.delete('/api/track', (req, res) => {
  const name = path.basename(String(req.query.name || ''));
  const full = path.join(MUSIC_DIR, name);
  if (!name || !AUDIO_EXT.has(path.extname(name).toLowerCase()) || !fs.existsSync(full)) {
    return res.status(404).json({ error: 'not found' });
  }
  try {
    fs.unlinkSync(full);
    for (const pl of Object.keys(data.playlists)) {
      data.playlists[pl] = data.playlists[pl].filter((f) => f !== name);
    }
    if (data.licensed) delete data.licensed[name];
    saveData(data);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'could not delete' });
  }
});

app.get('/api/state', (_req, res) => {
  res.json({
    blocks: data.blocks,
    days: data.days,
    schedule: data.schedule,
    playlists: data.playlists,
    autoPlaylists: data.autoPlaylists || [],
    ratings: data.ratings || {},
    settings: publicSettings(),
  });
});

// Like / dislike / clear a track. Likes play more often, dislikes never play.
app.post('/api/rate', (req, res) => {
  const file = req.body && req.body.file;
  const rating = req.body && req.body.rating;
  if (!file) return res.status(400).json({ error: 'file required' });
  data.ratings = data.ratings || {};
  if (rating === 'like' || rating === 'less' || rating === 'dislike') data.ratings[file] = rating;
  else delete data.ratings[file];
  saveData(data);
  res.json({ ok: true, ratings: data.ratings });
});

// Manually set (or clear) a track's genre — overrides the file's tag and
// survives re-scans, so tracks with no embedded genre (e.g. many Pixabay
// downloads) can still be scheduled and picked by genre.
app.post('/api/genre', (req, res) => {
  const file = req.body && req.body.file;
  const genre = ((req.body && req.body.genre) || '').trim();
  if (!file) return res.status(400).json({ error: 'file required' });
  data.genres = data.genres || {};
  if (genre) data.genres[file] = genre;
  else delete data.genres[file];
  saveData(data);
  res.json({ ok: true, genres: data.genres });
});

// Manually set a track's vibe (Chill / Lively) from the Library — a hand-set
// vibe wins over the analysed one and survives re-scans.
app.post('/api/vibe', (req, res) => {
  const file = req.body && req.body.file;
  const vibe = normalizeVibe((req.body && req.body.vibe) || '');
  if (!file) return res.status(400).json({ error: 'file required' });
  data.vibes = data.vibes || {};
  if (vibe) data.vibes[file] = vibe;
  else delete data.vibes[file];
  saveData(data);
  res.json({ ok: true, vibe: vibe || '' });
});

// Store audio-analysis results (energy + tempo) for a track, computed in the
// browser via the Web Audio API, and derive its serving "vibe".
app.post('/api/analyze', (req, res) => {
  const file = req.body && req.body.file;
  if (!file) return res.status(400).json({ error: 'file required' });
  const full = path.join(MUSIC_DIR, path.basename(file));
  if (!fs.existsSync(full)) return res.status(404).json({ error: 'not found' });
  const energy = Number(req.body.energy);
  const bpm = req.body.bpm ? Math.round(Number(req.body.bpm)) : null;
  data.meta = data.meta || {};
  const m = data.meta[file] || {};
  if (isFinite(energy)) m.energy = energy;
  if (bpm && bpm > 0 && bpm < 300) m.analyzedBpm = bpm;
  m.vibe = vibeFor(m.energy, m.analyzedBpm || m.bpm);
  m.analyzedAt = Date.now();
  data.meta[file] = m;
  saveData(data);
  res.json({ ok: true, file, genre: m.genre || '', vibe: m.vibe, bpm: m.analyzedBpm || m.bpm || null, energy: m.energy });
});

app.put('/api/playlists', (req, res) => {
  const playlists = req.body && req.body.playlists;
  if (!playlists || typeof playlists !== 'object') {
    return res.status(400).json({ error: 'playlists object required' });
  }
  data.playlists = playlists;
  // Optionally update which playlists are auto-generated (from the vibe tools);
  // always prune the list to playlists that still exist.
  if (Array.isArray(req.body.auto)) data.autoPlaylists = req.body.auto;
  data.autoPlaylists = (data.autoPlaylists || []).filter((n) => n in playlists);
  // Drop schedule references to playlists that no longer exist.
  for (const d of data.days) {
    for (const b of data.blocks) {
      const name = data.schedule[d][b.id];
      if (name && !(name in playlists)) data.schedule[d][b.id] = '';
    }
  }
  saveData(data);
  res.json({ ok: true, playlists: data.playlists, autoPlaylists: data.autoPlaylists, schedule: data.schedule });
});

app.put('/api/schedule', (req, res) => {
  const schedule = req.body && req.body.schedule;
  if (!schedule || typeof schedule !== 'object') {
    return res.status(400).json({ error: 'schedule object required' });
  }
  data.schedule = schedule;
  saveData(data);
  res.json({ ok: true, schedule: data.schedule });
});

// Add / remove / rename time blocks and edit their start times.
app.put('/api/blocks', (req, res) => {
  const blocks = req.body && req.body.blocks;
  if (!Array.isArray(blocks) || !blocks.length) {
    return res.status(400).json({ error: 'non-empty blocks array required' });
  }
  const seen = new Set();
  const clean = blocks.map((b, i) => {
    let id = String(b.id || '').replace(/[^a-z0-9_-]/gi, '').toLowerCase() || 'block' + i;
    while (seen.has(id)) id = id + '-' + i;
    seen.add(id);
    const start = /^\d{1,2}:\d{2}$/.test(b.start || '') ? b.start : '00:00';
    return { id, label: String(b.label || 'Block').slice(0, 40) || 'Block', start };
  });
  // sort by start time so the grid reads left-to-right through the day
  clean.sort((a, b) => a.start.localeCompare(b.start));
  data.blocks = clean;
  // reconcile the schedule: every day keeps a slot for every (surviving) block
  for (const d of data.days) {
    const row = data.schedule[d] || {};
    const next = {};
    for (const b of clean) next[b.id] = row[b.id] || '';
    data.schedule[d] = next;
  }
  saveData(data);
  station.refresh(true);
  res.json({ ok: true, blocks: data.blocks, schedule: data.schedule });
});

app.put('/api/settings', (req, res) => {
  const patch = Object.assign({}, req.body || {});
  delete patch.afterHoursPassword; // never set the secret via the public settings route
  data.settings = Object.assign({}, data.settings, patch);
  saveData(data);
  res.json({ ok: true, settings: publicSettings() });
});

// ---- after-hours staff mode ------------------------------------------------
app.post('/api/afterhours/unlock', (req, res) => {
  const password = req.body && req.body.password;
  const ok = !!data.settings.afterHoursPassword && password === data.settings.afterHoursPassword;
  res.json({ ok });
});

const adminOk = (req) => {
  const password = req.body && req.body.password;
  return !!data.settings.afterHoursPassword && password === data.settings.afterHoursPassword;
};

// Flag / un-flag a track as licensed (after-hours only). Admin-gated.
app.post('/api/afterhours/track', (req, res) => {
  if (!adminOk(req)) return res.status(403).json({ error: 'wrong password' });
  const file = path.basename(String((req.body && req.body.file) || ''));
  if (!file) return res.status(400).json({ error: 'file required' });
  data.licensed = data.licensed || {};
  if (req.body.on) data.licensed[file] = true; else delete data.licensed[file];
  saveData(data);
  res.json({ ok: true, licensed: !!data.licensed[file] });
});

// Download / restore a full backup of the app's data (playlists, schedule, etc.)
app.get('/api/backup', (_req, res) => {
  res.set('Content-Disposition', 'attachment; filename="watermans-music-backup.json"');
  res.set('Content-Type', 'application/json');
  res.send(JSON.stringify(data, null, 2));
});

app.post('/api/restore', (req, res) => {
  const b = req.body;
  if (!b || typeof b !== 'object' || typeof b.playlists !== 'object' || typeof b.schedule !== 'object') {
    return res.status(400).json({ error: 'not a valid backup file' });
  }
  data = Object.assign(defaultData(), b);
  saveData(data);
  station.refresh(true);
  res.json({ ok: true });
});

app.post('/api/afterhours/password', (req, res) => {
  const current = req.body && req.body.current;
  const next = req.body && req.body.next;
  if (current !== data.settings.afterHoursPassword) {
    return res.status(403).json({ error: 'wrong current password' });
  }
  if (!next || typeof next !== 'string') return res.status(400).json({ error: 'new password required' });
  data.settings.afterHoursPassword = next;
  saveData(data);
  res.json({ ok: true });
});

// ---- audio output selection (which physical output the box plays out) ------
// Parse `aplay -l` into a list of playback devices.
function parseAplay(text) {
  const out = [];
  const seen = new Set();
  for (const ln of String(text).split('\n')) {
    // e.g. "card 2: Headphones [bcm2835 Headphones], device 0: bcm2835 Headphones [bcm2835 Headphones]"
    const m = ln.match(/^card (\d+):\s*(.+?)\s*\[(.+?)\],\s*device (\d+):/);
    if (!m) continue;
    const dev = `hw:${m[1]},${m[4]}`;
    if (seen.has(dev)) continue;
    seen.add(dev);
    out.push({ dev, card: Number(m[1]), device: Number(m[4]), label: (m[3] || m[2]).trim() });
  }
  return out;
}
function listAudioDevices() {
  return new Promise((resolve) => {
    let out = '';
    try {
      const pr = spawn('aplay', ['-l']);
      pr.stdout.on('data', (d) => { out += d; });
      pr.stderr.on('data', (d) => { out += d; });
      pr.on('error', () => resolve([]));
      pr.on('close', () => resolve(parseAplay(out)));
    } catch { resolve([]); }
  });
}
// Find a usable playback volume control on a card (names vary: PCM/Master/…).
function resolveAudioControl(card) {
  return new Promise((resolve) => {
    let out = '';
    try {
      const pr = spawn('amixer', ['-c', String(card), 'scontrols']);
      pr.stdout.on('data', (d) => { out += d; });
      pr.on('error', () => resolve(null));
      pr.on('close', () => {
        const names = [...out.matchAll(/'([^']+)'/g)].map((x) => x[1]);
        const prefer = ['PCM', 'Master', 'Headphone', 'Speaker', 'Digital', 'Playback', 'Analogue'];
        resolve(prefer.find((p) => names.includes(p)) || names[0] || null);
      });
    } catch { resolve(null); }
  });
}

app.get('/api/audio/devices', async (_req, res) => {
  const devices = await listAudioDevices();
  res.json({
    enabled: HEADLESS_PLAYER,
    devices,
    current: audioDevice(),          // '' = system default
    card: audioCard(),
    control: audioControl(),
  });
});

app.post('/api/audio/output', async (req, res) => {
  if (!adminOk(req)) return res.status(403).json({ error: 'wrong password' });
  const dev = String((req.body && req.body.device) || '').trim(); // 'hw:X,Y' or '' for default
  if (dev && !/^hw:\d+,\d+$/.test(dev)) return res.status(400).json({ error: 'bad device' });
  data.settings.audioDevice = dev;
  const m = dev.match(/^hw:(\d+),/);
  data.settings.audioCard = m ? m[1] : null;
  // auto-detect the right mixer control for the chosen card
  data.settings.audioControl = m ? await resolveAudioControl(m[1]) : null;
  saveData(data);
  applyVenueVolume(venueTargetVol());
  playerFadeRestart(); // restart mpg123 on the new output
  res.json({ ok: true, device: audioDevice(), card: audioCard(), control: audioControl() });
});

// ---- find royalty-free music (in-app search) -------------------------------
// Searches Openverse (aggregates Creative-Commons / public-domain audio from
// Jamendo, ccMixter, Freesound, etc.), filtered to commercially-usable tracks
// so they're safe to play in the venue. Needs the box to have internet.
function httpGet(url, opts, depth) {
  depth = depth || 0;
  return new Promise((resolve, reject) => {
    if (depth > 5) return reject(new Error('too many redirects'));
    const mod = url.slice(0, 5) === 'http:' ? http : https;
    // family: 4 forces IPv4 — some boxes have broken IPv6 and Node would
    // otherwise stall on an AAAA address that never connects (curl doesn't).
    const base = { family: 4, headers: { 'User-Agent': 'WatermansMusic/1.0', 'Accept-Encoding': 'identity' } };
    const options = Object.assign(base, opts || {});
    if (opts && opts.headers) options.headers = Object.assign({}, base.headers, opts.headers);
    const req = mod.get(url, options, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        r.resume();
        return resolve(httpGet(new URL(r.headers.location, url).toString(), opts, depth + 1));
      }
      resolve(r); // caller consumes the stream
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('timeout')));
  });
}
async function fetchJson(url) {
  const r = await httpGet(url, { headers: { 'User-Agent': 'WatermansMusic/1.0', Accept: 'application/json' } });
  if (r.statusCode !== 200) { r.resume(); throw new Error('http ' + r.statusCode); }
  let d = '';
  return new Promise((resolve, reject) => {
    r.on('data', (c) => { d += c; });
    r.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error('bad json')); } });
    r.on('error', reject);
  });
}

app.get('/api/find', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ results: [], count: 0 });
  const base = process.env.OPENVERSE_BASE || 'https://api.openverse.org/v1/audio/';
  // CC0 + Public-Domain-Mark ONLY — no attribution ever needed, same as
  // Pixabay, so it's fully safe to play without crediting anyone. page_size is
  // capped at 20 for anonymous requests (more returns 401), so pull the first
  // few pages and combine them for a decent set.
  const PAGES = 4;
  const mkUrl = (pg) => base + '?license=cc0,pdm&page_size=20&page=' + pg + '&q=' + encodeURIComponent(q);
  try {
    const pages = await Promise.all(
      Array.from({ length: PAGES }, (_, i) => fetchJson(mkUrl(i + 1)).catch(() => null))
    );
    if (!pages.some(Boolean)) throw new Error('no pages');
    const seenId = new Set();
    const combined = [];
    for (const pj of pages) {
      for (const t of (pj && pj.results) || []) {
        if (t && t.id && !seenId.has(t.id)) { seenId.add(t.id); combined.push(t); }
      }
    }
    const j = { results: combined, result_count: (pages.find(Boolean) || {}).result_count };
    // Attribution-free only (CC0 / public domain) — belt-and-braces.
    const venueOk = (t) => /^(cc0|pdm)$/i.test(String(t.license || ''));
    // Drop sound-effects/audiobooks — keep music (or untagged). Freesound is
    // mostly effects, so treat its untagged items as non-music too.
    const isMusic = (t) => t.category ? t.category === 'music' : String(t.source || '').toLowerCase() !== 'freesound';
    // Rank (don't hard-filter) by how well each result matches — so a genre
    // search floats tag-matches to the top but still shows everything the
    // search found, rather than throwing away results that just aren't tagged.
    const by = String(req.query.by || 'genre').toLowerCase();
    const qWords = q.toLowerCase().split(/[\s/,&|-]+/).filter((w) => w.length > 2);
    const tagText = (t) => (
      (Array.isArray(t.genres) ? t.genres.join(' ') : '') + ' ' +
      (Array.isArray(t.tags) ? t.tags.map((x) => (x && x.name) || x || '').join(' ') : '')
    ).toLowerCase();
    const hits = (txt) => qWords.reduce((s, w) => s + (txt.includes(w) ? 1 : 0), 0);
    const scoreOf = (t) => {
      const tagS = hits(tagText(t));
      const titleS = hits((t.title || '').toLowerCase());
      return by === 'title' ? titleS * 3 + tagS : tagS * 3 + titleS; // weight the chosen field
    };
    let pool = (j.results || []).filter((t) => venueOk(t) && isMusic(t));
    pool = pool.map((t, i) => ({ t, s: scoreOf(t), i }))
      .sort((a, b) => b.s - a.s || a.i - b.i) // best match first, stable otherwise
      .map((x) => x.t);
    const results = pool.map((t) => ({
      title: t.title || 'Untitled',
      artist: t.creator || '',
      license: ((t.license || '') + (t.license_version ? ' ' + t.license_version : '')).trim().toUpperCase(),
      licenseUrl: t.license_url || '',
      attribution: t.attribution || '',
      preview: t.url || '',                 // direct audio file (preview + download)
      landing: t.foreign_landing_url || '',
      duration: t.duration ? Math.round(t.duration / 1000) : 0,
      ext: String(t.filetype || 'mp3').toLowerCase(),
      source: t.source || '',
    })).filter((t) => t.preview);
    res.json({ results, count: results.length });
  } catch (e) {
    res.status(502).json({ error: 'search unavailable (is the box online?)', detail: e.message });
  }
});

// Download a found track straight into the library (server-side, avoids CORS).
app.post('/api/find/add', async (req, res) => {
  const url = String((req.body && req.body.url) || '');
  if (!/^https?:\/\//.test(url)) return res.status(400).json({ error: 'bad url' });
  const title = String((req.body && req.body.title) || 'track');
  let ext = String((req.body && req.body.ext) || 'mp3').replace(/[^a-z0-9]/gi, '').toLowerCase();
  if (!AUDIO_EXT.has('.' + ext)) ext = 'mp3';
  const base = (title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'track').slice(0, 60);
  fs.mkdirSync(MUSIC_DIR, { recursive: true });
  let name = base + '.' + ext, n = 1;
  while (fs.existsSync(path.join(MUSIC_DIR, name))) name = base + '-' + (++n) + '.' + ext;
  const dest = path.join(MUSIC_DIR, name);
  const MAX = 40 * 1024 * 1024;
  try {
    const r = await httpGet(url, { headers: {
      'User-Agent': 'Mozilla/5.0 (Watermans Music box)',
      Accept: 'audio/*,*/*;q=0.8',
      Referer: (req.body && req.body.landing) || url,
    } });
    if (r.statusCode !== 200) { r.resume(); return res.status(502).json({ error: 'download failed (http ' + r.statusCode + ')' }); }
    // Accept anything that isn't obviously a web page / error body.
    const ct = (r.headers['content-type'] || '').toLowerCase();
    if (/text\/html|application\/json|text\/plain|application\/xml/.test(ct)) { r.resume(); return res.status(415).json({ error: 'that link returned a web page, not an audio file' }); }
    await new Promise((resolve, reject) => {
      let size = 0;
      const ws = fs.createWriteStream(dest);
      r.on('data', (c) => { size += c.length; if (size > MAX) { r.destroy(); ws.destroy(); reject(new Error('file too large')); } });
      r.pipe(ws);
      ws.on('finish', () => (size > 1024 ? resolve() : reject(new Error('empty download'))));
      ws.on('error', reject);
      r.on('error', reject);
    });
    // keep the licence/credit alongside the track, and the artist so it shows
    // on Now Playing (that display IS the attribution for CC-BY tracks).
    data.credits = data.credits || {};
    data.credits[name] = {
      artist: (req.body && req.body.artist) || '',
      license: (req.body && req.body.license) || '',
      attribution: (req.body && req.body.attribution) || '',
      source: (req.body && req.body.landing) || '',
    };
    saveData(data);
    res.json({ ok: true, file: name, title: prettyTitle(name) });
  } catch (e) {
    fs.unlink(dest, () => {});
    res.status(502).json({ error: 'could not download', detail: e.message });
  }
});

// One-tap update: pull the latest code, then exit so systemd (Restart=always)
// relaunches the service on the new version — no terminal needed. Admin-gated
// by the same password as the after-hours / Admin unlock.
app.post('/api/update', (req, res) => {
  const password = req.body && req.body.password;
  if (!data.settings.afterHoursPassword || password !== data.settings.afterHoursPassword) {
    return res.status(403).json({ error: 'wrong password' });
  }
  const git = spawn('git', ['pull', '--ff-only'], { cwd: ROOT });
  let out = '';
  git.stdout.on('data', (d) => { out += d; });
  git.stderr.on('data', (d) => { out += d; });
  git.on('error', (e) => { if (!res.headersSent) res.status(500).json({ error: 'git unavailable: ' + e.message }); });
  git.on('close', (code) => {
    if (res.headersSent) return;
    const text = out.trim();
    if (code !== 0) return res.status(500).json({ ok: false, output: text || ('git exited ' + code) });
    const updated = !/Already up to date/i.test(text);
    res.json({ ok: true, updated, output: text });
    // Flush the response, then exit; systemd restarts us on the pulled code.
    if (updated) setTimeout(() => process.exit(0), 1200);
  });
});

// Safely power the box off or restart it (better than pulling the plug).
// Admin-gated. Needs a one-time sudoers grant — see scripts/enable-power.sh.
app.post('/api/power', (req, res) => {
  const password = req.body && req.body.password;
  const action = req.body && req.body.action;
  if (!data.settings.afterHoursPassword || password !== data.settings.afterHoursPassword) {
    return res.status(403).json({ error: 'wrong password' });
  }
  if (action !== 'shutdown' && action !== 'reboot') return res.status(400).json({ error: 'bad action' });
  const args = action === 'reboot' ? ['-n', 'reboot'] : ['-n', 'shutdown', '-h', 'now'];
  const proc = spawn('sudo', args);
  let err = '';
  proc.stderr.on('data', (d) => { err += d; });
  proc.on('error', (e) => { if (!res.headersSent) res.status(500).json({ error: 'cannot run power command: ' + e.message }); });
  proc.on('close', (code) => {
    if (res.headersSent) return;
    if (code === 0) res.json({ ok: true, action });
    else res.status(500).json({ error: 'Not permitted yet — run "bash scripts/enable-power.sh" on the Pi once. ' + err.trim() });
  });
});

// ---- audio streaming (HTTP range) -----------------------------------------

app.get('/audio/:file', (req, res) => {
  const name = path.basename(req.params.file); // prevent traversal
  const full = path.join(MUSIC_DIR, name);
  if (!AUDIO_EXT.has(path.extname(name).toLowerCase()) || !fs.existsSync(full)) {
    return res.sendStatus(404);
  }
  const stat = fs.statSync(full);
  const type = MIME[path.extname(name).toLowerCase()] || 'application/octet-stream';
  const range = req.headers.range;

  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    const start = m && m[1] ? parseInt(m[1], 10) : 0;
    const end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1;
    if (start >= stat.size) {
      res.status(416).set('Content-Range', `bytes */${stat.size}`).end();
      return;
    }
    res.status(206).set({
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': type,
    });
    fs.createReadStream(full, { start, end }).pipe(res);
  } else {
    res.set({ 'Content-Length': stat.size, 'Content-Type': type, 'Accept-Ranges': 'bytes' });
    fs.createReadStream(full).pipe(res);
  }
});

// ---- venue stream: a continuous MP3 "radio" the Q-SYS Core can pull --------
//
// The app's browser tab plays on this computer's own audio. To reach the
// venue's Q-SYS system (which pulls a network stream, like Mustard does), we
// run a server-side station that follows the schedule and broadcasts one
// continuous MP3 stream at /stream. Point the Q-SYS streaming input at it.

function dayKey(d) {
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
}

function currentBlockId(now) {
  const mins = now.getHours() * 60 + now.getMinutes();
  const parsed = data.blocks
    .map((b) => {
      const [h, m] = b.start.split(':').map(Number);
      return { id: b.id, at: h * 60 + m };
    })
    .sort((a, b) => a.at - b.at);
  let active = parsed[parsed.length - 1]; // wraps past midnight
  for (const b of parsed) if (mins >= b.at) active = b;
  return active ? active.id : null;
}

// Parse the first MP3 frame header to get the (CBR) byte rate, so we can pace
// the broadcast at real-time speed. Skips a leading ID3v2 tag if present.
function mp3ByteRate(buf) {
  let i = 0;
  if (buf.length > 10 && buf.toString('ascii', 0, 3) === 'ID3') {
    const sz = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    i = 10 + sz;
  }
  const V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
  const V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
  for (; i < buf.length - 4; i++) {
    if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) continue;
    const ver = (buf[i + 1] >> 3) & 0x03; // 3=MPEG1, 2=MPEG2, 0=MPEG2.5
    const layer = (buf[i + 1] >> 1) & 0x03; // 1=Layer III
    const brIdx = (buf[i + 2] >> 4) & 0x0f;
    if (layer !== 1 || brIdx === 0 || brIdx === 15) continue;
    const kbps = ver === 3 ? V1_L3[brIdx] : V2_L3[brIdx];
    if (!kbps) continue;
    return (kbps * 1000) / 8; // bytes per second
  }
  return 20000; // sensible default (160 kbps)
}

// Build a weighted, shuffled play order from a track list: banned tracks never
// play, "less" tracks appear less, liked tracks more.
function buildQueue(tracks) {
  tracks = (tracks || []).filter((f) => fs.existsSync(path.join(MUSIC_DIR, f)));
  const ratings = data.ratings || {};
  const weightOf = (r) => (r === 'like' ? 3 : r === 'less' ? 1 : 2);
  let pool = tracks.filter((f) => ratings[f] !== 'dislike');
  if (!pool.length) pool = tracks.slice();
  const weighted = [];
  for (const f of pool) { const w = weightOf(ratings[f]); for (let k = 0; k < w; k++) weighted.push(f); }
  if (data.settings.shuffle !== false) {
    for (let i = weighted.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [weighted[i], weighted[j]] = [weighted[j], weighted[i]];
    }
  }
  return weighted;
}

// Resolve a schedule cell / token to a list of files. Tokens: "style:Chill",
// "genre:Deep House", or a playlist name.
const isLicensed = (f) => !!(data.licensed && data.licensed[f]);
function resolveTokenFiles(val) {
  if (!val) return [];
  // The after-hours set is ONLY the licensed tracks.
  if (val === 'afterhours') return scanLibrary().filter((t) => t.licensed).map((t) => t.file);
  // Everything else is trading-hours music — licensed tracks are excluded so
  // they can never reach guests, no matter how the schedule is set up.
  const noLic = (files) => files.filter((f) => !isLicensed(f));
  if (val.slice(0, 6) === 'style:') { const s = val.slice(6); return noLic(scanLibrary().filter((t) => t.vibe === s).map((t) => t.file)); }
  if (val.slice(0, 6) === 'genre:') { const g = val.slice(6); return noLic(scanLibrary().filter((t) => (t.genre || '') === g).map((t) => t.file)); }
  const pl = data.playlists[val];
  return pl ? noLic(pl.slice()) : [];
}

// Resolve a "play this now on the venue" token from the app into files + label.
// Tokens: "block:ID", "style:X", "genre:X", or a playlist name.
function resolvePlayToken(token) {
  if (!token) return { files: [], label: '' };
  if (token.slice(0, 6) === 'block:') {
    const bid = token.slice(6);
    const now = new Date();
    const dk = dayKey(now);
    const val = data.schedule[dk] && data.schedule[dk][bid];
    const blk = data.blocks.find((b) => b.id === bid);
    return { files: resolveTokenFiles(val), label: (blk && blk.label) || 'Block' };
  }
  if (token === 'afterhours') return { files: resolveTokenFiles('afterhours'), label: 'After hours (licensed)' };
  if (token.slice(0, 6) === 'genre:') return { files: resolveTokenFiles(token), label: 'Genre · ' + token.slice(6) };
  if (token.slice(0, 6) === 'style:') return { files: resolveTokenFiles(token), label: token.slice(6) };
  return { files: resolveTokenFiles(token), label: token };
}

const station = {
  queue: [],
  idx: 0,
  blockKey: null,
  override: null, // {label} while a manual override is active; null = follow schedule
  // Recompute the queue from the schedule; never leave the venue silent.
  refresh(force) {
    if (this.override) return; // a manual override holds until "Schedule" is tapped
    const now = new Date();
    const key = dayKey(now) + '/' + currentBlockId(now);
    if (!force && key === this.blockKey && this.queue.length) return;
    this.blockKey = key;
    const [dk, bk] = key.split('/');
    let tracks = resolveTokenFiles(data.schedule[dk] && data.schedule[dk][bk]);
    if (!tracks.length) {
      const pn = Object.keys(data.playlists).find((n) => (data.playlists[n] || []).length);
      if (pn) tracks = data.playlists[pn].filter((f) => !isLicensed(f));
    }
    // fall back to the whole library — but never the licensed after-hours tracks
    if (!tracks.length) tracks = scanLibrary().filter((t) => !t.licensed).map((t) => t.file);
    this.queue = buildQueue(tracks);
    if (this.idx >= this.queue.length) this.idx = 0;
  },
  // Play a specific set now (scene / block / genre override).
  playFiles(files, label) {
    this.override = { label: label || 'Playing now' };
    this.queue = buildQueue(files);
    this.idx = 0;
  },
  // Hand control back to the weekly schedule.
  followSchedule() {
    this.override = null;
    this.blockKey = null;
    this.refresh(true);
  },
  current() {
    return this.queue[this.idx];
  },
  advance() {
    if (!this.queue.length) return;
    // The weighted queue repeats liked tracks, so the very next slot can be the
    // SAME file — step past any run of the current file so a skip always lands
    // on a different track (unless there's genuinely only one).
    const cur = this.queue[this.idx];
    for (let n = 0; n < this.queue.length; n++) {
      this.idx += 1;
      if (this.idx >= this.queue.length) { this.idx = 0; this.refresh(true); }
      if (this.queue[this.idx] !== cur) break;
    }
  },
  prev() {
    if (!this.queue.length) return;
    const cur = this.queue[this.idx];
    for (let n = 0; n < this.queue.length; n++) {
      this.idx = (this.idx - 1 + this.queue.length) % this.queue.length;
      if (this.queue[this.idx] !== cur) break;
    }
  },
};

const streamClients = new Set();

function startBroadcast() {
  station.refresh(true);
  (function playNext() {
    const file = station.current();
    if (!file) {
      setTimeout(() => { station.refresh(true); playNext(); }, 1000);
      return;
    }
    let audio;
    try {
      audio = fs.readFileSync(path.join(MUSIC_DIR, file));
    } catch {
      station.advance();
      return playNext();
    }
    const byteRate = mp3ByteRate(audio);
    const CHUNK = 4096;
    const interval = (CHUNK / byteRate) * 1000; // pace at real-time
    let off = 0;
    (function pump() {
      if (off >= audio.length) {
        station.advance();
        return playNext();
      }
      const slice = audio.subarray(off, Math.min(off + CHUNK, audio.length));
      for (const res of streamClients) {
        try { res.write(slice); } catch { /* client gone */ }
      }
      off += CHUNK;
      setTimeout(pump, interval);
    })();
  })();
}

// The continuous stream endpoint. Q-SYS (or VLC/a browser, to test) connects
// here and receives whatever is scheduled right now.
app.get('/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'audio/mpeg',
    'Cache-Control': 'no-cache, no-store',
    'Connection': 'close',
    'icy-name': 'Venue Music',
  });
  streamClients.add(res);
  req.on('close', () => streamClients.delete(res));
});

// LAN URLs to hand to whoever programs the Q-SYS Core.
function lanStreamUrls() {
  const urls = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) urls.push(`http://${ni.address}:${PORT}/stream`);
    }
  }
  return urls;
}

app.get('/api/stream-info', (_req, res) => {
  res.json({ urls: lanStreamUrls(), path: '/stream', now: station.current() || null });
});

// ---- headless player: play scheduled music out this device's audio ---------
//
// On the venue "music box" (a Pi/mini-PC) there's no browser open, so the
// server itself plays the scheduled music out the local audio output (into
// the Q-SYS input). Enabled with PLAYER=1 so it never double-plays on a
// laptop used only for management. Requires `mpg123` (sudo apt install mpg123).

const HEADLESS_PLAYER = process.env.PLAYER === '1';
let playerProc = null;
let playerPaused = false;
let playerBroken = false;
// When we kill the current track to jump somewhere specific (play a scene /
// go to previous), the exit handler must NOT auto-advance to the next track —
// the queue has already been repositioned. This flag suppresses that advance
// for exactly one exit. It is set ONLY right before such a kill and consumed by
// the very next exit, so it can never leak into a later skip.
let playerNoAdvance = false;
let fadeInNext = false;   // the next track should ramp up from silent (after a faded skip)
let hwVol = null;         // last level we set on the sound card (percent), for fades
let fadeTimer = null;

// Title / artist / genre for the venue "now playing" readout.
function trackInfo(file) {
  if (!file) return { title: null, artist: null, genre: null };
  let m = {};
  try { m = trackMeta(file) || {}; } catch { m = {}; }
  const credit = (data.credits && data.credits[file]) || {};
  return {
    title: (m.title && m.title.trim()) || prettyTitle(file),
    artist: (m.artist && m.artist.trim()) || (credit.artist || '').trim() || null,
    genre: (data.genres && data.genres[file]) || m.genre || null,
  };
}

function venueTargetVol() {
  return data.settings.venueVolume != null ? data.settings.venueVolume : 80;
}

// Which sound card + mixer control the venue volume drives. Chosen in Admin >
// Audio output; falls back to the Pi's 3.5mm jack (card 2, control "PCM").
function audioCard() {
  if (data.settings.audioCard != null && data.settings.audioCard !== '') return String(data.settings.audioCard);
  return process.env.AUDIO_CARD || '2';
}
function audioControl() {
  return data.settings.audioControl || process.env.AUDIO_CONTROL || 'PCM';
}
// The mpg123 output device (ALSA), e.g. "hw:2,0". Empty = system default.
function audioDevice() {
  return data.settings.audioDevice || process.env.AUDIO_DEVICE || '';
}

// Set the sound card level immediately. Best-effort: if amixer or the control
// name differs, we just skip — the app volume still tracks it.
function amixerSet(pct) {
  if (!HEADLESS_PLAYER) return;
  hwVol = Math.max(0, Math.min(100, Math.round(pct)));
  try {
    const amix = spawn('amixer', ['-c', audioCard(), 'sset', audioControl(), hwVol + '%', 'unmute']);
    amix.on('error', () => { /* amixer missing / control differs — ignore */ });
  } catch { /* ignore */ }
}

// Ramp the card level from where it is now to `to` over `ms`, then call done().
// Used to fade the room out before a skip and fade the next track back in, so
// guests never hear an abrupt cut.
function rampVol(to, ms, done) {
  if (fadeTimer) { clearInterval(fadeTimer); fadeTimer = null; }
  if (!HEADLESS_PLAYER) { if (done) done(); return; }
  const from = hwVol == null ? venueTargetVol() : hwVol;
  const steps = 8;
  if (from === to || steps <= 0) { amixerSet(to); if (done) done(); return; }
  let i = 0;
  fadeTimer = setInterval(() => {
    i += 1;
    amixerSet(from + (to - from) * (i / steps));
    if (i >= steps) { clearInterval(fadeTimer); fadeTimer = null; if (done) done(); }
  }, Math.max(25, Math.round(ms / steps)));
}

// Direct volume set from the app's slider — cancel any fade and snap to it.
function applyVenueVolume(level) {
  if (!HEADLESS_PLAYER) return;
  if (fadeTimer) { clearInterval(fadeTimer); fadeTimer = null; }
  amixerSet(level);
}

// Fade the room down, then run `swap` (which kills the current track). The exit
// handler brings the next one in. If the track ends on its own mid-fade, the
// proc has changed under us — don't kill the new one, just restore the level.
function fadeThen(swap) {
  const dying = playerProc;
  if (!HEADLESS_PLAYER || playerBroken || !dying) { swap(); return; }
  // Short fade so a skip feels instant but doesn't hard-click the room.
  rampVol(0, 160, () => {
    if (playerProc === dying) swap();
    else rampVol(venueTargetVol(), 250);
  });
}

function playerPlayCurrent() {
  if (!HEADLESS_PLAYER || playerPaused || playerBroken || playerProc) return;
  const file = station.current();
  if (!file) {
    setTimeout(() => { station.refresh(true); playerPlayCurrent(); }, 1000);
    return;
  }
  const full = path.join(MUSIC_DIR, file);
  const fadeIn = fadeInNext; fadeInNext = false;
  if (fadeIn) amixerSet(0); // start silent so the ramp-up isn't a hard hit
  const dev = audioDevice();
  const args = dev ? ['-q', '-a', dev, full] : ['-q', full]; // -a picks the ALSA output
  playerProc = spawn('mpg123', args);
  playerProc.on('error', (e) => {
    playerBroken = true;
    playerProc = null;
    console.warn(`Headless player: could not start mpg123 (${e.message}).`);
    console.warn('Install it on the box with:  sudo apt install -y mpg123');
  });
  playerProc.on('exit', () => {
    playerProc = null;
    if (!HEADLESS_PLAYER || playerPaused || playerBroken) return;
    if (playerNoAdvance) { playerNoAdvance = false; playerPlayCurrent(); return; }
    station.advance();
    playerPlayCurrent();
  });
  if (fadeIn) rampVol(venueTargetVol(), 250);
}

// Repoint the venue player to whatever station.current() now is (the queue has
// already been moved to the target), fading out the old track and the new one
// in. The exit handler must NOT advance again, so we flag it.
function playerFadeRestart() {
  if (!HEADLESS_PLAYER || playerBroken) return;
  playerPaused = false;
  if (!playerProc) { fadeInNext = true; playerPlayCurrent(); return; }
  fadeThen(() => { fadeInNext = true; playerNoAdvance = true; playerProc.kill('SIGTERM'); });
}

app.get('/api/player/state', (_req, res) => {
  const track = station.current() || null;
  const info = trackInfo(track);
  res.json({
    enabled: HEADLESS_PLAYER,
    broken: playerBroken,
    paused: playerPaused,
    playing: !!playerProc && !playerPaused,
    track,
    title: info.title,
    artist: info.artist,
    genre: info.genre,
    mode: station.override ? station.override.label : 'Schedule',
    onSchedule: !station.override,
    volume: data.settings.venueVolume != null ? data.settings.venueVolume : 80,
  });
});

app.post('/api/player/skip', (_req, res) => {
  if (HEADLESS_PLAYER && !playerBroken) {
    // Advance the queue immediately on EVERY press (so two quick taps skip two
    // tracks, and the response already reports the new track), then fade-restart
    // onto it. playerFadeRestart flags the exit handler not to advance again.
    station.advance();
    playerFadeRestart();
  }
  res.json({ ok: true, track: station.current() || null });
});

app.post('/api/player/prev', (_req, res) => {
  station.prev();
  playerFadeRestart();
  res.json({ ok: true, track: station.current() || null });
});

// Play a scene / block / genre now, or hand back to the weekly schedule when
// token === 'schedule'.
app.post('/api/player/play', (req, res) => {
  const token = (req.body && req.body.token) || '';
  if (token === 'schedule' || token === 'block:schedule') {
    station.followSchedule();
  } else if (token === 'afterhours') {
    // Licensed music — only ever after close, and only with the admin password,
    // so it can never be triggered to a room full of guests.
    if (!adminOk(req)) return res.status(403).json({ ok: false, error: 'admin password required' });
    const { files, label } = resolvePlayToken(token);
    if (!files.length) return res.status(400).json({ ok: false, error: 'no licensed tracks added yet' });
    station.playFiles(files, label);
  } else {
    const { files, label } = resolvePlayToken(token);
    if (!files.length) return res.status(400).json({ ok: false, error: 'nothing to play for ' + token });
    station.playFiles(files, label);
  }
  playerFadeRestart();
  res.json({ ok: true, track: station.current() || null, mode: station.override ? station.override.label : 'Schedule' });
});

app.post('/api/player/volume', (req, res) => {
  let level = Number(req.body && req.body.level);
  if (!Number.isFinite(level)) return res.status(400).json({ ok: false, error: 'bad level' });
  level = Math.max(0, Math.min(100, Math.round(level)));
  data.settings.venueVolume = level;
  saveData(data);
  applyVenueVolume(level);
  res.json({ ok: true, volume: level });
});

app.post('/api/player/pause', (_req, res) => {
  playerPaused = !playerPaused;
  if (playerPaused) {
    // Fade out, then stop. No playerNoAdvance: the exit handler returns early
    // while paused, so there's no advance to suppress (and nothing to leak).
    if (playerProc) fadeThen(() => playerProc.kill('SIGTERM'));
  } else {
    fadeInNext = true; // ease back in when resuming
    playerPlayCurrent();
  }
  res.json({ ok: true, paused: playerPaused });
});

app.listen(PORT, HOST, () => {
  console.log(`Venue Music running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  const urls = lanStreamUrls();
  if (urls.length) {
    console.log('Venue stream (point your Q-SYS streaming input here):');
    for (const u of urls) console.log('   ' + u);
  }
  startBroadcast();
  if (HEADLESS_PLAYER) {
    console.log('Headless player ON — playing scheduled music out this device.');
    applyVenueVolume(venueTargetVol());
    station.refresh(true);
    playerPlayCurrent();
  }
});
