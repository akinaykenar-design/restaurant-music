'use strict';

// Generative background-music composer.
//
// Everything here is synthesised from scratch in code, so the output is 100%
// original and copyright-free — safe to play in a venue with no licensing
// (no APRA/PPCA/PRS/ASCAP fees). Run with:  npm run music
//
// It writes a handful of gentle, restaurant-appropriate ambient tracks (soft
// chord pads, arpeggios, bass, and the occasional melody) as WAV files into
// music/. No external dependencies — pure Node.

const fs = require('fs');
const path = require('path');

const MUSIC_DIR = path.join(__dirname, '..', 'music');
fs.mkdirSync(MUSIC_DIR, { recursive: true });

const SR = 32000; // sample rate — plenty for background music, smaller files

// ---- tiny deterministic PRNG (so re-runs produce identical tracks) ---------
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const mfreq = (m) => 440 * Math.pow(2, (m - 69) / 12);

// ---- oscillators -----------------------------------------------------------
function sine(ph) { return Math.sin(ph); }
function triangle(ph) { return (2 / Math.PI) * Math.asin(Math.sin(ph)); }
function softSaw(ph) {
  // band-limited-ish saw: a few harmonics, gentle
  return (
    Math.sin(ph) + 0.5 * Math.sin(2 * ph) + 0.33 * Math.sin(3 * ph) + 0.25 * Math.sin(4 * ph)
  ) / 2.08;
}

// ADSR envelope (times in seconds), returns gain at time t within a note of
// total length dur.
function adsr(t, dur, a, d, s, r) {
  if (t < 0 || t > dur) return 0;
  if (t < a) return t / a;
  if (t < a + d) return 1 - (1 - s) * ((t - a) / d);
  if (t < dur - r) return s;
  return s * Math.max(0, (dur - t) / r);
}

// Add a note into a mono float buffer.
function addNote(buf, startT, dur, midi, gain, osc, env, detune = 0) {
  const f = mfreq(midi);
  const i0 = Math.floor(startT * SR);
  const i1 = Math.min(buf.length, Math.floor((startT + dur) * SR));
  const w = 2 * Math.PI * f / SR;
  const wd = 2 * Math.PI * (f * Math.pow(2, detune / 1200)) / SR;
  for (let i = i0; i < i1; i++) {
    const t = (i - i0) / SR;
    const e = env(t, dur);
    if (e <= 0) continue;
    let s = osc(i * w);
    if (detune) s = (s + osc(i * wd)) * 0.5;
    buf[i] += s * e * gain;
  }
}

// ---- Schroeder reverb (mono in, stereo out) --------------------------------
function reverb(dry, wetAmt) {
  const combTune = [1116, 1188, 1277, 1356, 1422, 1491];
  const apTune = [556, 441, 341, 225];
  const scale = SR / 44100;
  const combs = combTune.map((d) => ({
    buf: new Float32Array(Math.round(d * scale)),
    idx: 0,
    fb: 0.8,
    damp: 0.25,
    store: 0,
  }));
  const aps = apTune.map((d) => ({ buf: new Float32Array(Math.round(d * scale)), idx: 0, g: 0.5 }));

  const wetL = new Float32Array(dry.length);
  const wetR = new Float32Array(dry.length);
  for (let i = 0; i < dry.length; i++) {
    const input = dry[i] * 0.35;
    let out = 0;
    for (const c of combs) {
      const y = c.buf[c.idx];
      c.store = y * (1 - c.damp) + c.store * c.damp;
      c.buf[c.idx] = input + c.store * c.fb;
      if (++c.idx >= c.buf.length) c.idx = 0;
      out += y;
    }
    for (const a of aps) {
      const bufOut = a.buf[a.idx];
      const y = -out * a.g + bufOut;
      a.buf[a.idx] = out + bufOut * a.g;
      if (++a.idx >= a.buf.length) a.idx = 0;
      out = y;
    }
    // slight stereo decorrelation
    wetL[i] = dry[i] * (1 - wetAmt) + out * wetAmt;
    wetR[i] = dry[i] * (1 - wetAmt) + out * wetAmt * 0.92;
  }
  return [wetL, wetR];
}

// ---- WAV writer (16-bit stereo) --------------------------------------------
function writeWav(file, left, right) {
  const n = left.length;
  const dataSize = n * 4; // 2 ch * 2 bytes
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22); // stereo
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  let o = 44;
  for (let i = 0; i < n; i++) {
    const l = Math.max(-1, Math.min(1, left[i]));
    const r = Math.max(-1, Math.min(1, right[i]));
    buf.writeInt16LE((l * 32767) | 0, o);
    buf.writeInt16LE((r * 32767) | 0, o + 2);
    o += 4;
  }
  fs.writeFileSync(path.join(MUSIC_DIR, file), buf);
}

// ---- composition -----------------------------------------------------------
// Chords are arrays of semitone offsets from the track's tonic (midi root).
const SONGS = [
  {
    file: 'cafe-01-sunrise.wav', title: 'Sunrise', seed: 101, bpm: 70, root: 60,
    prog: [[0, 4, 7, 11], [-3, 0, 4, 9], [-5, -1, 2, 7], [-7, -3, 0, 4]], lead: true,
  },
  {
    file: 'cafe-02-first-light.wav', title: 'First Light', seed: 202, bpm: 76, root: 62,
    prog: [[0, 4, 7, 11], [5, 9, 12, 16], [-3, 0, 4, 7], [-5, -1, 2, 5]], lead: true,
  },
  {
    file: 'cafe-03-slow-lunch.wav', title: 'Slow Lunch', seed: 303, bpm: 82, root: 57,
    prog: [[0, 3, 7, 10], [5, 8, 12, 15], [-2, 2, 5, 9], [-4, 0, 3, 7]], lead: false,
  },
  {
    file: 'cafe-04-golden-hour.wav', title: 'Golden Hour', seed: 404, bpm: 68, root: 55,
    prog: [[0, 4, 7, 11], [-3, 0, 5, 9], [2, 5, 9, 12], [-5, -1, 2, 7]], lead: true,
  },
  {
    file: 'cafe-05-evening-glow.wav', title: 'Evening Glow', seed: 505, bpm: 64, root: 53,
    prog: [[0, 3, 7, 10], [-2, 2, 5, 8], [-4, 0, 3, 7], [5, 8, 12, 15]], lead: false,
  },
  {
    file: 'cafe-06-night-hush.wav', title: 'Night Hush', seed: 606, bpm: 60, root: 50,
    prog: [[0, 3, 7, 10], [-5, -1, 2, 7], [-7, -3, 0, 5], [-2, 2, 5, 9]], lead: true,
  },
];

const PENT = [0, 2, 4, 7, 9]; // major pentatonic for safe melodies

function compose(song) {
  const rnd = mulberry32(song.seed);
  const beat = 60 / song.bpm;
  const bar = beat * 4;
  const bars = 32; // ~ length depends on bpm; ~80-120s
  const dur = bars * bar + 2;
  const N = Math.floor(dur * SR);
  const dry = new Float32Array(N);

  for (let b = 0; b < bars; b++) {
    const t0 = b * bar;
    const chord = song.prog[b % song.prog.length].map((iv) => song.root + iv);
    const rootNote = chord[0];

    // Pad — sustained chord across the bar, soft attack/release.
    for (const m of chord) {
      addNote(dry, t0, bar * 1.02, m, 0.16, (p) => (sine(p) + 0.4 * triangle(p)) / 1.4,
        (t, d) => adsr(t, d, 0.6, 0.3, 0.85, 0.9), 6);
    }

    // Bass — root, one/two octaves down, gentle.
    addNote(dry, t0, beat * 2, rootNote - 24, 0.28, (p) => sine(p) + 0.25 * sine(2 * p) * 0,
      (t, d) => adsr(t, d, 0.02, 0.2, 0.7, 0.4));
    addNote(dry, t0 + beat * 2, beat * 2, rootNote - 12, 0.2, sine,
      (t, d) => adsr(t, d, 0.02, 0.2, 0.7, 0.4));

    // Arpeggio — eighth notes cycling chord tones, plucky.
    const arpNotes = [chord[0] + 12, chord[1] + 12, chord[2] + 12, chord[3] + 12, chord[2] + 12, chord[1] + 12];
    for (let e = 0; e < 8; e++) {
      const m = arpNotes[e % arpNotes.length];
      const g = 0.09 + 0.02 * (e % 2);
      addNote(dry, t0 + e * (beat / 2), beat * 0.7, m, g, softSaw,
        (t, d) => adsr(t, d, 0.005, 0.15, 0.0, 0.2), 4);
    }

    // Lead — sparse pentatonic melody on some bars.
    if (song.lead && b % 2 === 1) {
      let steps = 2 + Math.floor(rnd() * 3);
      let pos = t0 + beat * (rnd() < 0.5 ? 0 : 1);
      for (let s = 0; s < steps && pos < t0 + bar - beat * 0.5; s++) {
        const deg = PENT[Math.floor(rnd() * PENT.length)] + (rnd() < 0.35 ? 12 : 0);
        const m = song.root + 12 + deg;
        const nd = beat * (rnd() < 0.5 ? 1 : 1.5);
        addNote(dry, pos, nd, m, 0.13, (p) => sine(p + 0.02 * Math.sin(p * 0.02)),
          (t, d) => adsr(t, d, 0.03, 0.2, 0.5, 0.35), 3);
        pos += nd;
      }
    }
  }

  // Reverb + master fade + soft limit.
  const [L, R] = reverb(dry, 0.32);
  const fade = Math.floor(1.2 * SR);
  let peak = 0;
  for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  const norm = peak > 0 ? 0.85 / peak : 1;
  for (let i = 0; i < N; i++) {
    let f = 1;
    if (i < fade) f = i / fade;
    else if (i > N - fade) f = (N - i) / fade;
    L[i] = Math.tanh(L[i] * norm * f * 1.1);
    R[i] = Math.tanh(R[i] * norm * f * 1.1);
  }
  writeWav(song.file, L, R);
  return dur;
}

console.log('Composing original, copyright-free background music...\n');
for (const song of SONGS) {
  // Skip if an MP3 of this track already ships in music/ (avoids duplicates).
  const mp3 = path.join(MUSIC_DIR, song.file.replace(/\.wav$/, '.mp3'));
  if (fs.existsSync(mp3)) {
    console.log(`  (skip) ${song.title} — already present as ${path.basename(mp3)}`);
    continue;
  }
  const d = compose(song);
  console.log(`  ${song.file}  (${Math.round(d)}s)  "${song.title}"`);
}
console.log('\nDone. Start the app (npm start) and these appear in the Library.');
