'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1'; // loopback only by default

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
  return { blocks, days, schedule, playlists: {}, settings: { volume: 0.8, followSchedule: true } };
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

function scanLibrary() {
  try {
    fs.mkdirSync(MUSIC_DIR, { recursive: true });
    return fs
      .readdirSync(MUSIC_DIR)
      .filter((f) => AUDIO_EXT.has(path.extname(f).toLowerCase()))
      .sort((a, b) => a.localeCompare(b))
      .map((f) => ({ file: f, title: path.basename(f, path.extname(f)) }));
  } catch {
    return [];
  }
}

// ---- api -------------------------------------------------------------------

app.get('/api/library', (_req, res) => res.json({ tracks: scanLibrary() }));

app.get('/api/state', (_req, res) => {
  res.json({
    blocks: data.blocks,
    days: data.days,
    schedule: data.schedule,
    playlists: data.playlists,
    settings: data.settings,
  });
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

app.put('/api/settings', (req, res) => {
  data.settings = Object.assign({}, data.settings, req.body || {});
  saveData(data);
  res.json({ ok: true, settings: data.settings });
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

app.listen(PORT, HOST, () => {
  console.log(`Venue Music running at http://${HOST}:${PORT}`);
});
