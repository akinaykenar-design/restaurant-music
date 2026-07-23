'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

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
    blocks, days, schedule, playlists: {}, ratings: {},
    settings: {
      volume: 0.8, followSchedule: true, shuffle: true, crossfade: 4,
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

function scanLibrary() {
  try {
    fs.mkdirSync(MUSIC_DIR, { recursive: true });
    return fs
      .readdirSync(MUSIC_DIR)
      .filter((f) => AUDIO_EXT.has(path.extname(f).toLowerCase()))
      .sort((a, b) => a.localeCompare(b))
      .map((f) => ({ file: f, title: prettyTitle(f) }));
  } catch {
    return [];
  }
}

// ---- api -------------------------------------------------------------------

app.get('/api/library', (_req, res) => res.json({ tracks: scanLibrary() }));

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
    res.json({ ok: true, file: name, title: prettyTitle(name) });
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
  if (rating === 'like' || rating === 'dislike') data.ratings[file] = rating;
  else delete data.ratings[file];
  saveData(data);
  res.json({ ok: true, ratings: data.ratings });
});

app.put('/api/playlists', (req, res) => {
  const playlists = req.body && req.body.playlists;
  if (!playlists || typeof playlists !== 'object') {
    return res.status(400).json({ error: 'playlists object required' });
  }
  data.playlists = playlists;
  // Drop schedule references to playlists that no longer exist.
  for (const d of data.days) {
    for (const b of data.blocks) {
      const name = data.schedule[d][b.id];
      if (name && !(name in playlists)) data.schedule[d][b.id] = '';
    }
  }
  saveData(data);
  res.json({ ok: true, playlists: data.playlists, schedule: data.schedule });
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
  res.json({ ok: password === data.settings.afterHoursPassword });
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

const station = {
  queue: [],
  idx: 0,
  blockKey: null,
  // Recompute the queue from the schedule; never leave the venue silent.
  refresh(force) {
    const now = new Date();
    const key = dayKey(now) + '/' + currentBlockId(now);
    if (!force && key === this.blockKey && this.queue.length) return;
    this.blockKey = key;
    const [dk, bk] = key.split('/');
    let tracks = [];
    const name = data.schedule[dk] && data.schedule[dk][bk];
    if (name && data.playlists[name] && data.playlists[name].length) tracks = data.playlists[name].slice();
    if (!tracks.length) {
      const pn = Object.keys(data.playlists).find((n) => (data.playlists[n] || []).length);
      if (pn) tracks = data.playlists[pn].slice();
    }
    if (!tracks.length) tracks = scanLibrary().map((t) => t.file); // fall back to whole library
    tracks = tracks.filter((f) => fs.existsSync(path.join(MUSIC_DIR, f)));

    // Smart rotation: drop dislikes, play likes more, shuffle.
    const ratings = data.ratings || {};
    let pool = tracks.filter((f) => ratings[f] !== 'dislike');
    if (!pool.length) pool = tracks.slice();
    const weighted = [];
    for (const f of pool) { weighted.push(f); if (ratings[f] === 'like') weighted.push(f); }
    if (data.settings.shuffle !== false) {
      for (let i = weighted.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [weighted[i], weighted[j]] = [weighted[j], weighted[i]];
      }
    }
    this.queue = weighted;
    if (this.idx >= this.queue.length) this.idx = 0;
  },
  current() {
    return this.queue[this.idx];
  },
  advance() {
    this.idx += 1;
    if (this.idx >= this.queue.length) {
      this.idx = 0;
      this.refresh(true);
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

function playerPlayCurrent() {
  if (!HEADLESS_PLAYER || playerPaused || playerBroken || playerProc) return;
  const file = station.current();
  if (!file) {
    setTimeout(() => { station.refresh(true); playerPlayCurrent(); }, 1000);
    return;
  }
  const full = path.join(MUSIC_DIR, file);
  playerProc = spawn('mpg123', ['-q', full]);
  playerProc.on('error', (e) => {
    playerBroken = true;
    playerProc = null;
    console.warn(`Headless player: could not start mpg123 (${e.message}).`);
    console.warn('Install it on the box with:  sudo apt install -y mpg123');
  });
  playerProc.on('exit', () => {
    playerProc = null;
    if (!HEADLESS_PLAYER || playerPaused || playerBroken) return;
    station.advance();
    playerPlayCurrent();
  });
}

app.get('/api/player/state', (_req, res) => {
  const track = station.current() || null;
  res.json({
    enabled: HEADLESS_PLAYER,
    broken: playerBroken,
    paused: playerPaused,
    playing: !!playerProc && !playerPaused,
    track,
    title: track ? prettyTitle(track) : null,
  });
});

app.post('/api/player/skip', (_req, res) => {
  if (HEADLESS_PLAYER && !playerBroken) {
    if (playerProc) playerProc.kill('SIGTERM'); // exit handler advances + plays next
    else { station.advance(); playerPlayCurrent(); }
  }
  res.json({ ok: true, track: station.current() || null });
});

app.post('/api/player/pause', (_req, res) => {
  playerPaused = !playerPaused;
  if (playerPaused) { if (playerProc) playerProc.kill('SIGTERM'); }
  else playerPlayCurrent();
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
    station.refresh(true);
    playerPlayCurrent();
  }
});
