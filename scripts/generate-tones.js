'use strict';

// Generates a handful of short, gentle CC0 test tones into music/ so the app
// is playable out of the box. These are pure sine pads — not real music, just
// enough to verify scheduling and playback. Replace them with your own
// royalty-free tracks (see music/README.md).

const fs = require('fs');
const path = require('path');

const MUSIC_DIR = path.join(__dirname, '..', 'music');
fs.mkdirSync(MUSIC_DIR, { recursive: true });

const SAMPLE_RATE = 44100;

function writeWav(filename, seconds, freqs) {
  const n = Math.floor(SAMPLE_RATE * seconds);
  const bytesPerSample = 2;
  const dataSize = n * bytesPerSample;
  const buf = Buffer.alloc(44 + dataSize);

  // RIFF header
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(SAMPLE_RATE * bytesPerSample, 28);
  buf.writeUInt16LE(bytesPerSample, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    // soft attack/release envelope
    const env = Math.min(1, t / 0.5) * Math.min(1, (seconds - t) / 0.5);
    let s = 0;
    for (const f of freqs) s += Math.sin(2 * Math.PI * f * t);
    s = (s / freqs.length) * env * 0.25;
    buf.writeInt16LE(Math.max(-1, Math.min(1, s)) * 32767, 44 + i * bytesPerSample);
  }
  fs.writeFileSync(path.join(MUSIC_DIR, filename), buf);
  console.log('wrote', filename);
}

// A few pleasant chords in different moods.
writeWav('tone-morning-calm.wav', 6, [261.63, 329.63, 392.0]); // C major
writeWav('tone-lunch-bright.wav', 6, [293.66, 369.99, 440.0]); // D major
writeWav('tone-afternoon-warm.wav', 6, [220.0, 277.18, 329.63]); // A major
writeWav('tone-evening-mellow.wav', 6, [196.0, 246.94, 293.66]); // G major
writeWav('tone-night-deep.wav', 6, [164.81, 207.65, 246.94]); // E major

console.log('\nDone. Start the app with `npm start` and these will appear in the library.');
