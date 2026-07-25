#!/usr/bin/env node
'use strict';

// Download tracks straight into the ../music folder.
//
// Run this on a machine with OPEN internet — your Raspberry Pi or laptop — NOT
// inside a locked-down sandbox (where outbound web access is blocked).
//
//   node scripts/import-music.js                 # reads music-sources.txt
//   node scripts/import-music.js <url> [url...]  # download specific URLs
//
// Only DIRECT file links work, e.g. an Internet Archive file:
//   https://archive.org/download/<identifier>/<file>.mp3
// Pixabay needs its own Download button, so grab those by hand and drop them
// into the app's Library tab instead.

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const MUSIC_DIR = path.join(ROOT, 'music');
const LIST = path.join(ROOT, 'music-sources.txt');
const AUDIO = /\.(mp3|m4a|aac|ogg|oga|wav|flac|webm)$/i;

function readList() {
  try {
    return fs.readFileSync(LIST, 'utf8').split('\n')
      .map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  } catch { return []; }
}

function safeName(url, headers) {
  const cd = headers && headers['content-disposition'];
  let name = '';
  if (cd) { const m = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(cd); if (m) name = decodeURIComponent(m[1]); }
  if (!name) { try { name = decodeURIComponent(path.basename(new URL(url).pathname)); } catch { name = ''; } }
  name = (name || 'track').replace(/[^\w.\- ]+/g, '_').trim();
  if (!AUDIO.test(name)) name += '.mp3';
  return name;
}

function get(url, redirects) {
  redirects = redirects || 0;
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('too many redirects'));
    const lib = url.startsWith('http:') ? http : https;
    const req = lib.get(url, { headers: { 'User-Agent': 'watermans-music-import' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(get(new URL(res.headers.location, url).toString(), redirects + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      resolve({ res, finalUrl: url });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('timeout')));
  });
}

async function download(url) {
  const { res, finalUrl } = await get(url);
  const name = safeName(finalUrl, res.headers);
  const dest = path.join(MUSIC_DIR, name);
  if (fs.existsSync(dest)) { res.resume(); return { name, skipped: true }; }
  await new Promise((resolve, reject) => {
    const tmp = dest + '.part';
    const out = fs.createWriteStream(tmp);
    res.pipe(out);
    out.on('finish', () => out.close(() => { fs.renameSync(tmp, dest); resolve(); }));
    out.on('error', (e) => { try { fs.unlinkSync(tmp); } catch { /* ignore */ } reject(e); });
    res.on('error', reject);
  });
  return { name };
}

(async () => {
  fs.mkdirSync(MUSIC_DIR, { recursive: true });
  const urls = process.argv.slice(2).length ? process.argv.slice(2) : readList();
  if (!urls.length) {
    console.log('No URLs found. Add direct file links to music-sources.txt (one per line), or pass them as arguments.');
    return;
  }
  let ok = 0, skip = 0, fail = 0;
  for (const url of urls) {
    process.stdout.write('· ' + url + '  … ');
    try {
      const r = await download(url);
      if (r.skipped) { console.log('already have ' + r.name); skip++; }
      else { console.log('saved ' + r.name); ok++; }
    } catch (e) { console.log('FAILED (' + e.message + ')'); fail++; }
  }
  console.log('\nDone. ' + ok + ' downloaded, ' + skip + ' already present, ' + fail + ' failed.');
  console.log('Now open the app → Library → ✨ Analyse audio to tag genre + vibe.');
})();
