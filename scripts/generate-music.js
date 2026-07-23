'use strict';

// Generative background-music composer — "organic house / Mediterranean chill"
// style (downtempo groove, hand percussion, warm modal chords, plucky Four-Tet-
// ish arps). Everything is synthesised from scratch, so it's 100% original and
// copyright-free (no APRA/PPCA). Run with:  npm run music
//
// These are a stylistic sketch of the vibe — for a full professionally-produced
// catalogue, curate real tracks from Pixabay (see MUSIC-LIBRARY.md). Pure Node,
// no dependencies; writes WAV files into music/.

const fs = require('fs');
const path = require('path');

const MUSIC_DIR = path.join(__dirname, '..', 'music');
fs.mkdirSync(MUSIC_DIR, { recursive: true });

const SR = 32000;

const mfreq = (m) => 440 * Math.pow(2, (m - 69) / 12);
const sine = (p) => Math.sin(p);
const tri = (p) => (2 / Math.PI) * Math.asin(Math.sin(p));
const saw = (p) => (sine(p) + 0.5 * sine(2 * p) + 0.33 * sine(3 * p) + 0.25 * sine(4 * p)) / 2.08;

// deterministic PRNG so re-runs are identical
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function adsr(t, dur, a, d, s, r) {
  if (t < 0 || t > dur) return 0;
  if (t < a) return t / a;
  if (t < a + d) return 1 - (1 - s) * ((t - a) / d);
  if (t < dur - r) return s;
  return s * Math.max(0, (dur - t) / r);
}

// --- tonal voice into a mono buffer ---
function note(buf, startT, dur, midi, gain, osc, env, detune = 0) {
  const i0 = Math.floor(startT * SR);
  const i1 = Math.min(buf.length, Math.floor((startT + dur) * SR));
  const w = (2 * Math.PI * mfreq(midi)) / SR;
  const wd = (2 * Math.PI * mfreq(midi) * Math.pow(2, detune / 1200)) / SR;
  for (let i = i0; i < i1; i++) {
    const t = (i - i0) / SR;
    const e = env(t, dur);
    if (e <= 0) continue;
    let s = osc(i * w);
    if (detune) s = (s + osc(i * wd)) * 0.5;
    buf[i] += s * e * gain;
  }
}

// --- percussion (synthesised, no samples) ---
function kick(buf, startT, gain) {
  const i0 = Math.floor(startT * SR);
  const dur = 0.28;
  const i1 = Math.min(buf.length, i0 + Math.floor(dur * SR));
  for (let i = i0; i < i1; i++) {
    const t = (i - i0) / SR;
    const f = 110 * Math.pow(0.5, t / 0.04) + 42; // pitch drop -> thump
    const e = Math.pow(1 - t / dur, 2.2);
    buf[i] += Math.sin(2 * Math.PI * f * t) * e * gain;
  }
}
function shaker(buf, startT, gain, dur = 0.05) {
  const i0 = Math.floor(startT * SR);
  const i1 = Math.min(buf.length, i0 + Math.floor(dur * SR));
  let last = 0;
  for (let i = i0; i < i1; i++) {
    const t = (i - i0) / SR;
    const n = Math.random() * 2 - 1;
    const hp = n - last; last = n; // crude high-pass -> "tsss"
    buf[i] += hp * Math.pow(1 - t / dur, 1.5) * gain;
  }
}
function conga(buf, startT, midi, gain) {
  const i0 = Math.floor(startT * SR);
  const dur = 0.18;
  const i1 = Math.min(buf.length, i0 + Math.floor(dur * SR));
  const w = (2 * Math.PI * mfreq(midi)) / SR;
  for (let i = i0; i < i1; i++) {
    const t = (i - i0) / SR;
    const e = Math.pow(1 - t / dur, 2.5);
    buf[i] += (Math.sin((i - i0) * w) * 0.8 + (Math.random() * 2 - 1) * 0.2) * e * gain;
  }
}

// --- simple stereo feedback delay for the "wet" buss ---
function stereoDelay(mono, timeL, timeR, fb, mix) {
  const L = new Float32Array(mono.length);
  const R = new Float32Array(mono.length);
  const dL = Math.floor(timeL * SR), dR = Math.floor(timeR * SR);
  for (let i = 0; i < mono.length; i++) {
    const eL = i >= dL ? L[i - dL] : 0;
    const eR = i >= dR ? R[i - dR] : 0;
    L[i] = mono[i] + eL * fb;
    R[i] = mono[i] + eR * fb;
  }
  const outL = new Float32Array(mono.length);
  const outR = new Float32Array(mono.length);
  for (let i = 0; i < mono.length; i++) {
    outL[i] = mono[i] * (1 - mix) + L[i] * mix;
    outR[i] = mono[i] * (1 - mix) + R[i] * mix;
  }
  return [outL, outR];
}

// --- Schroeder reverb (mono -> stereo) ---
function reverb(dry, wetAmt) {
  const comb = [1116, 1188, 1277, 1356, 1422, 1491].map((d) => ({
    buf: new Float32Array(Math.round((d * SR) / 44100)), idx: 0, fb: 0.82, damp: 0.28, store: 0,
  }));
  const ap = [556, 441, 341, 225].map((d) => ({ buf: new Float32Array(Math.round((d * SR) / 44100)), idx: 0, g: 0.5 }));
  const L = new Float32Array(dry.length), R = new Float32Array(dry.length);
  for (let i = 0; i < dry.length; i++) {
    const input = dry[i] * 0.3;
    let out = 0;
    for (const c of comb) {
      const y = c.buf[c.idx];
      c.store = y * (1 - c.damp) + c.store * c.damp;
      c.buf[c.idx] = input + c.store * c.fb;
      if (++c.idx >= c.buf.length) c.idx = 0;
      out += y;
    }
    for (const a of ap) {
      const bo = a.buf[a.idx];
      const y = -out * a.g + bo;
      a.buf[a.idx] = out + bo * a.g;
      if (++a.idx >= a.buf.length) a.idx = 0;
      out = y;
    }
    L[i] = dry[i] * (1 - wetAmt) + out * wetAmt;
    R[i] = dry[i] * (1 - wetAmt) + out * wetAmt * 0.9;
  }
  return [L, R];
}

function writeWav(file, left, right) {
  const n = left.length, dataSize = n * 4;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataSize, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(dataSize, 40);
  let o = 44;
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE((Math.max(-1, Math.min(1, left[i])) * 32767) | 0, o);
    buf.writeInt16LE((Math.max(-1, Math.min(1, right[i])) * 32767) | 0, o + 2);
    o += 4;
  }
  fs.writeFileSync(path.join(MUSIC_DIR, file), buf);
}

// Chords are semitone sets over a minor/modal root (that Mediterranean colour).
const SONGS = [
  { file: 'cafe-01-olive-grove.wav', title: 'Olive Grove', seed: 11, bpm: 102, root: 57,
    prog: [[0, 3, 7, 10, 14], [-2, 3, 5, 10], [-4, 3, 8, 12], [-5, 2, 7, 10]] },
  { file: 'cafe-02-harbour-lights.wav', title: 'Harbour Lights', seed: 22, bpm: 100, root: 52,
    prog: [[0, 3, 7, 14], [5, 8, 12, 17], [-3, 0, 7, 10], [3, 7, 10, 14]] },
  { file: 'cafe-03-terracotta.wav', title: 'Terracotta', seed: 33, bpm: 104, root: 50,
    prog: [[0, 3, 7, 10], [1, 5, 8, 12], [0, 3, 7, 10], [-2, 3, 5, 9]] }, // Phrygian b2 colour
  { file: 'cafe-04-slow-tide.wav', title: 'Slow Tide', seed: 44, bpm: 98, root: 55,
    prog: [[0, 3, 7, 10, 14], [-5, 0, 3, 7], [-3, 2, 5, 9], [-7, -2, 3, 7]] },
  { file: 'cafe-05-sundowner.wav', title: 'Sundowner', seed: 55, bpm: 100, root: 59,
    prog: [[0, 3, 7, 10], [3, 7, 10, 14], [-2, 3, 5, 10], [-4, 0, 3, 8]] },
];

const SCALE = [0, 2, 3, 5, 7, 9, 10]; // Dorian-ish for melodic runs

function compose(song) {
  const rnd = mulberry32(song.seed);
  const beat = 60 / song.bpm;
  const bar = beat * 4;
  const bars = 40;
  const dur = bars * bar + 2;
  const N = Math.floor(dur * SR);
  const dry = new Float32Array(N); // kick, bass, pads, perc
  const wet = new Float32Array(N); // arp + lead (get delay)

  for (let b = 0; b < bars; b++) {
    const t0 = b * bar;
    const chord = song.prog[b % song.prog.length].map((iv) => song.root + iv);
    const rootN = chord[0];
    const groovedIn = b >= 2; // let it breathe for 2 bars, then groove

    // Warm pad — chord held across the bar
    for (const m of chord) {
      note(dry, t0, bar * 1.02, m, 0.11, (p) => (sine(p) + 0.35 * tri(p)) / 1.35,
        (t, d) => adsr(t, d, 0.5, 0.3, 0.85, 0.8), 7);
    }

    // Bass — root with a little syncopated movement
    note(dry, t0, beat * 1.5, rootN - 24, 0.30, (p) => sine(p) + 0.15 * tri(p),
      (t, d) => adsr(t, d, 0.01, 0.15, 0.6, 0.3));
    note(dry, t0 + beat * 2.5, beat * 1.0, rootN - 12, 0.18, sine,
      (t, d) => adsr(t, d, 0.01, 0.1, 0.5, 0.3));

    if (groovedIn) {
      // Soft four-on-the-floor kick + off-beat shaker + syncopated congas
      for (let bt = 0; bt < 4; bt++) {
        kick(dry, t0 + bt * beat, 0.5);
        shaker(dry, t0 + bt * beat + beat / 2, 0.10); // off-beats
        if (bt % 2 === 1) shaker(dry, t0 + bt * beat + beat * 0.25, 0.05);
      }
      // congas on a light syncopation
      const congaHits = [0.75, 1.5, 2.75, 3.5];
      for (const h of congaHits) conga(dry, t0 + h * beat, rootN + 12 + (rnd() < 0.5 ? 0 : 3), 0.16);
    }

    // Plucky arp (the organic / Four-Tet feel) -> wet buss (delay)
    const arp = [chord[0] + 12, chord[2] + 12, chord[1] + 12, (chord[3] || chord[0]) + 12,
                 chord[2] + 12, chord[0] + 12, chord[1] + 12, chord[2] + 12];
    for (let e = 0; e < 8; e++) {
      if (!groovedIn && e % 2) continue;
      note(wet, t0 + e * (beat / 2), beat * 0.45, arp[e % arp.length], 0.075, saw,
        (t, d) => adsr(t, d, 0.004, 0.12, 0.0, 0.15), 5);
    }

    // Sparse modal lead on some bars -> wet buss
    if (groovedIn && b % 2 === 1) {
      let steps = 2 + Math.floor(rnd() * 3);
      let pos = t0 + beat * (rnd() < 0.5 ? 0 : 1.5);
      for (let s = 0; s < steps && pos < t0 + bar - beat * 0.5; s++) {
        const deg = SCALE[Math.floor(rnd() * SCALE.length)] + (rnd() < 0.3 ? 12 : 0);
        const nd = beat * (rnd() < 0.5 ? 1 : 1.5);
        note(wet, pos, nd, song.root + 12 + deg, 0.10, (p) => sine(p),
          (t, d) => adsr(t, d, 0.02, 0.2, 0.5, 0.3), 4);
        pos += nd;
      }
    }
  }

  // wet buss: stereo delay synced to the eighth note, then blend + reverb everything
  const [wL, wR] = stereoDelay(wet, beat / 2, beat * 0.75, 0.38, 0.5);
  const mono = new Float32Array(N);
  for (let i = 0; i < N; i++) mono[i] = dry[i] + (wL[i] + wR[i]) * 0.5;
  const [L, R] = reverb(mono, 0.24);
  // re-inject delay stereo width
  for (let i = 0; i < N; i++) { L[i] += (wL[i] - wR[i]) * 0.15; R[i] += (wR[i] - wL[i]) * 0.15; }

  // master: fade + soft limit + normalise
  const fade = Math.floor(1.5 * SR);
  let peak = 0;
  for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  const norm = peak > 0 ? 0.82 / peak : 1;
  for (let i = 0; i < N; i++) {
    let f = 1;
    if (i < fade) f = i / fade; else if (i > N - fade) f = (N - i) / fade;
    L[i] = Math.tanh(L[i] * norm * f * 1.15);
    R[i] = Math.tanh(R[i] * norm * f * 1.15);
  }
  writeWav(song.file, L, R);
  return dur;
}

console.log('Composing original organic-house / Mediterranean-chill tracks...\n');
for (const song of SONGS) {
  const mp3 = path.join(MUSIC_DIR, song.file.replace(/\.wav$/, '.mp3'));
  if (fs.existsSync(mp3)) { console.log(`  (skip) ${song.title} — already present`); continue; }
  const d = compose(song);
  console.log(`  ${song.file}  (${Math.round(d)}s)  "${song.title}"`);
}
console.log('\nDone. Start the app (npm start) and these appear in the Library.');
