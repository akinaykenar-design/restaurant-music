'use strict';

// ---- state -----------------------------------------------------------------
let state = { blocks: [], days: [], schedule: {}, playlists: {}, autoPlaylists: [], ratings: {}, settings: {} };
let library = [];
let editing = null;

let queue = [];          // filenames in play order
let queueIndex = 0;
let history = [];         // recently played (newest first)
let currentBlockKey = null;
let activeScene = null;   // active manager "scene" override (or null = schedule/manual)
let libFilter = '';       // library search term
let libGenre = '';        // library genre filter
let libVibe = '';         // library vibe filter (Chill/Lively)
let libRating = '';       // library rating filter (like/dislike/rated/none)
let libSort = 'title';    // library sort key
let libSelect = false;    // multi-select (long-press) mode in the library
const libSelected = new Set(); // files currently selected

// dual-deck crossfade player
const decks = [new Audio(), new Audio()];
decks.forEach((d) => { d.preload = 'auto'; });
let active = 0;
let crossing = false;
let userVolume = 0.8;

// ---- venue mode ------------------------------------------------------------
// When the server runs the headless player (PLAYER=1 on the venue box), this
// app IS the remote control for the room — every device that opens it drives
// the one player on the box, not a local browser deck. venueMode is turned on
// once at boot from /api/player/state.enabled; while it's on, transport,
// scenes, volume and ratings all talk to the box and the local decks stay
// silent (so an iPad in the room never echoes the speakers).
let venueMode = false;
let venueState = null;
let venuePollTimer = null;
let venueVolPending = null; // debounce for volume writes to the box
const venuePost = (path, body) =>
  fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
    .then((r) => r.json()).catch(() => null);

const $ = (id) => document.getElementById(id);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v); // HTMLMediaElement.volume must be in [0,1]
const api = (url, opts) => fetch(url, opts).then((r) => r.json());
const titleOf = (file) => {
  const t = library.find((x) => x.file === file);
  return t ? t.title : file.replace(/\.[^.]+$/, '');
};
const ratingOf = (file) => (state.ratings || {})[file];
const durOf = (file) => { const t = library.find((x) => x.file === file); return t ? (t.duration || 0) : 0; };
function fmtDur(s) { return s ? Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0') : ''; }
function fmtTotal(sec) { if (!sec) return ''; const m = Math.round(sec / 60); return m < 60 ? m + ' min' : Math.floor(m / 60) + 'h ' + (m % 60) + 'm'; }
const activeDeck = () => decks[active];
const otherDeck = () => decks[1 - active];

function dayKey(d) {
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
}
function currentBlock(now) {
  const mins = now.getHours() * 60 + now.getMinutes();
  const parsed = state.blocks
    .map((b) => { const [h, m] = b.start.split(':').map(Number); return { id: b.id, at: h * 60 + m }; })
    .sort((a, b) => a.at - b.at);
  let hit = parsed[parsed.length - 1];
  for (const b of parsed) if (mins >= b.at) hit = b;
  return hit ? hit.id : null;
}

// ---- tabs ------------------------------------------------------------------
document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    $('tab-' + btn.dataset.tab).classList.add('active');
  });
});

// ---- queue building (smart rotation: like more, less fewer, ban never) -----
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
// Weight each track by rating: liked plays more, "less" plays less (but still
// reappears), neutral in between. Banned (dislike) tracks are excluded.
const weightOf = (r) => (r === 'like' ? 3 : r === 'less' ? 1 : 2);
function buildQueue(files) {
  const ratings = state.ratings || {};
  let pool = files.filter((f) => ratings[f] !== 'dislike');
  if (!pool.length) pool = files.slice();
  const weighted = [];
  for (const f of pool) { const w = weightOf(ratings[f]); for (let k = 0; k < w; k++) weighted.push(f); }
  if (state.settings.shuffle !== false) shuffle(weighted);
  return weighted;
}

// ---- playback --------------------------------------------------------------
function setPlayingUI(on) {
  const p = document.querySelector('.player');
  if (p) p.classList.toggle('playing', on); // CSS swaps play/pause icon
  const mp = $('miniplayer');
  if (mp) mp.classList.toggle('playing', on);
}

// Show the current track's embedded cover art as a soft background behind the
// player (the meter stays). Only applies if the file actually has art.
function setNowArt(file) {
  const bg = $('player-bg'); const player = document.querySelector('.player');
  if (!bg || !player) return;
  if (!file) { player.classList.remove('has-art'); bg.style.backgroundImage = ''; return; }
  const url = '/api/art?file=' + encodeURIComponent(file);
  const probe = new Image();
  probe.onload = () => { bg.style.backgroundImage = 'url("' + url + '")'; player.classList.add('has-art'); };
  probe.onerror = () => { player.classList.remove('has-art'); bg.style.backgroundImage = ''; };
  probe.src = url;
}

// ---- LED spectrum analyser (old-school hi-fi meter on Now Playing) ----------
// Glowing green→amber→red LED columns that react to the actual audio level.
// Taps the live output through a Web Audio AnalyserNode; if that isn't
// available (or routing is blocked) it falls back to a synthetic animation and
// never interferes with playback.
const vizEq = (() => {
  const canvas = $('viz-eq');
  if (!canvas || !canvas.getContext) return { onPlay() {} };
  const g = canvas.getContext('2d');
  const COLS = 13, ROWS = 16;
  const levels = new Array(COLS).fill(0); // smoothed audio target 0..1
  const shown = new Array(COLS).fill(0);  // integer segments currently lit
  const nextAt = new Array(COLS).fill(0); // when this column may step again
  const bandMax = new Array(COLS).fill(0.35); // per-band running peak, for auto-gain
  const RISE_MS = 22, FALL_MS = 60;       // climb one segment, then wait; fall slower
  let W = 1, H = 1;
  let audioCtx = null, analyser = null, freq = null, wired = false;

  const host = canvas.parentElement || canvas; // the .art box
  function resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const box = host.getBoundingClientRect();
    const inset = 13; // matches the CSS inset on .viz-eq
    const w = Math.max(1, Math.round(box.width - inset * 2));
    const h = Math.max(1, Math.round(box.height - inset * 2));
    if (w === W && h === H && canvas.width) return; // nothing changed
    W = w; H = h;
    canvas.width = W * dpr; canvas.height = H * dpr;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize();
  window.addEventListener('resize', resize);
  window.addEventListener('load', resize);
  // Re-measure whenever the art box changes (tab switch, breakpoint,
  // orientation, late font/layout). Observe the parent, not the canvas, so
  // sizing the canvas can never feed back into another resize.
  if (window.ResizeObserver) { try { new ResizeObserver(resize).observe(host); } catch (e) { /* ignore */ } }

  function wireAudio() {
    if (wired) return; // createMediaElementSource is one-shot per element
    wired = true;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      audioCtx = new AC();
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512; // finer bins so the log band-split has resolution
      analyser.smoothingTimeConstant = 0.6; // less smoothing = snappier, more alive
      freq = new Uint8Array(analyser.frequencyBinCount);
      analyser.connect(audioCtx.destination);
      decks.forEach((d) => {
        try { audioCtx.createMediaElementSource(d).connect(analyser); } catch (e) { /* leave it */ }
      });
    } catch (e) { analyser = null; }
  }
  function onPlay() {
    wireAudio();
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  }
  // Share the audio context (create it on demand) and let callers swap in a
  // different analyser — the venue "room stream" feeds a silent analyser so the
  // meter reads the REAL song even though this device isn't the player.
  function ensureCtx() { wireAudio(); return audioCtx; }
  function setAnalyser(a) { analyser = a; freq = new Uint8Array(a.frequencyBinCount); }

  function sample(playing, t) {
    // Scale the meter by the actual output volume — the analyser reads the raw
    // spectrum (which the volume control doesn't touch), so without this the
    // bars sit near full even when the room is quiet. Mute -> flat.
    // gentle curve: stays lively at normal listening levels but still drops
    // right down when the volume is low (and flat at mute).
    const volScale = Math.pow(Math.max(0, Math.min(1, userVolume)), 0.6);
    if (analyser && playing) {
      analyser.getByteFrequencyData(freq);
      // Split the spectrum into COLS *logarithmic* bands (like a real graphic
      // EQ). Each band is normalised to its OWN recent peak (auto-gain) so
      // every column swings across the full height and dances to the music,
      // instead of the whole meter sitting flat at one level.
      const bins = freq.length;
      const minBin = 1, maxBin = Math.floor(bins * 0.85);
      const ratio = maxBin / minBin;
      for (let i = 0; i < COLS; i++) {
        const lo = Math.floor(minBin * Math.pow(ratio, i / COLS));
        const hi = Math.max(lo + 1, Math.floor(minBin * Math.pow(ratio, (i + 1) / COLS)));
        let peak = 0; for (let j = lo; j < hi && j < bins; j++) { if (freq[j] > peak) peak = freq[j]; }
        const raw = peak / 255;
        // track this band's recent maximum (fast up, slow decay) and scale to it
        bandMax[i] = Math.max(raw, bandMax[i] * 0.992, 0.12);
        const v = (raw / bandMax[i]) * volScale;
        // fast attack, slower release — punchy on the beat, graceful fall
        const k = v > levels[i] ? 0.7 : 0.22;
        levels[i] += (v - levels[i]) * k;
      }
    } else if (playing) { // synthetic fallback — evenly lively across all bars
      for (let i = 0; i < COLS; i++) {
        const v = (0.45 + Math.sin(t * 2.3 + i * 0.9) * 0.28 + Math.sin(t * 5.1 + i * 1.7) * 0.18) * volScale;
        levels[i] += (Math.max(0, v) - levels[i]) * 0.25;
      }
    } else {
      for (let i = 0; i < COLS; i++) levels[i] += (0 - levels[i]) * 0.2;
    }
  }

  function rr(x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  function draw() {
    g.clearRect(0, 0, W, H);
    g.fillStyle = '#0a0a0a'; rr(0, 0, W, H, 9); g.fill(); // near-black panel
    const padX = W * 0.06, padTop = H * 0.08, padBot = H * 0.08;
    const pitchX = (W - padX * 2) / COLS;
    const barW = pitchX * 0.8;              // wide bars, thin gaps between columns
    const insetX = (pitchX - barW) / 2;
    const areaH = H - padTop - padBot;
    const pitchY = areaH / ROWS;
    const segH = Math.max(1, pitchY * 0.68); // short segment + thin gap above it
    const baseY = H - padBot;
    for (let i = 0; i < COLS; i++) {
      const lit = shown[i];
      const x = padX + i * pitchX + insetX;
      for (let r = 0; r < ROWS; r++) {
        const frac = r / (ROWS - 1);
        const on = r < lit;
        // fixed colour zones: green low, amber mid, red top; unlit = dim version
        const c = frac < 0.58 ? (on ? [46, 210, 70] : [12, 44, 18])
          : frac < 0.82 ? (on ? [245, 224, 20] : [44, 40, 4])
            : (on ? [255, 46, 46] : [52, 12, 12]);
        const y = baseY - (r + 1) * pitchY + (pitchY - segH) / 2;
        g.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
        g.fillRect(x, y, barW, segH);
      }
    }
  }

  // Step each column toward its target one segment at a time, pausing between
  // steps, so bars climb rung-by-rung like a hardware VU meter (not a smooth
  // slide).
  function step(now) {
    for (let i = 0; i < COLS; i++) {
      const target = Math.round(Math.max(0.06, levels[i]) * ROWS); // >=1, no dead column
      if (now < nextAt[i]) continue;
      if (shown[i] < target) { shown[i]++; nextAt[i] = now + RISE_MS; }
      else if (shown[i] > target) { shown[i]--; nextAt[i] = now + FALL_MS; }
    }
  }
  function loop(now) {
    const playing = !!(document.querySelector('.player') || {}).classList &&
      document.querySelector('.player').classList.contains('playing');
    sample(playing, now / 1000);
    step(now);
    draw();
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
  return { onPlay, ensureCtx, setAnalyser };
})();

const fmt = (s) => (!s || isNaN(s)) ? '0:00' : Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
function updateProgress(d) {
  const dur = d.duration;
  const pct = dur ? (d.currentTime / dur) * 100 : 0;
  $('pfill').style.width = pct + '%';
  $('t-cur').textContent = fmt(d.currentTime);
  $('t-dur').textContent = fmt(dur);
}
// Progress bar seeking — enabled ONLY when playing on this device (Play here /
// management), so you can scrub to test a track quickly. Never in venue mode:
// you can't scrub a live room, so there the bar stays a display-only "Live".
(function setupSeek() {
  const pbar = $('pbar'); if (!pbar) return;
  let seeking = false;
  const seekTo = (clientX) => {
    if (venueMode) return;
    const d = activeDeck(); if (!d || !d.duration || isNaN(d.duration)) return;
    const rect = pbar.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    d.currentTime = frac * d.duration;
    updateProgress(d);
  };
  pbar.addEventListener('pointerdown', (e) => {
    if (venueMode) return;
    seeking = true;
    try { pbar.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    seekTo(e.clientX);
  });
  pbar.addEventListener('pointermove', (e) => { if (seeking) seekTo(e.clientX); });
  pbar.addEventListener('pointerup', () => { seeking = false; });
  pbar.addEventListener('pointercancel', () => { seeking = false; });
})();

// Toast pop-ups disabled — kept as a no-op so call sites stay harmless.
function toast(_msg) { /* popups removed */ }

// mute / unmute (remembers previous level)
let preMuteVol = 0.8;
function updateMuteIcon() {
  const m = userVolume === 0;
  $('mute').classList.toggle('on', m);
  $('mute').title = m ? 'Unmute' : 'Mute';
  $('mute').setAttribute('aria-label', m ? 'Unmute' : 'Mute');
}
$('mute').addEventListener('click', () => {
  if (userVolume > 0) { preMuteVol = userVolume; userVolume = 0; }
  else userVolume = preMuteVol || 0.8;
  $('volume').value = userVolume;
  updateMuteIcon();
  if (venueMode) { setVenueVolume(userVolume); return; }
  if (!crossing) activeDeck().volume = userVolume;
  saveSettings({ volume: userVolume });
});

// show the get-started card only when the library is empty
function updateOnboard() { const o = $('onboard'); if (o) o.hidden = library.length > 0; }

function onTrackChanged(file) {
  $('now-title').textContent = titleOf(file);
  $('mini-title').textContent = titleOf(file);
  $('miniplayer').hidden = false;
  document.title = (file ? titleOf(file) + ' · ' : '') + 'Watermans Music';
  setNowArt(file);
  updateRateButtons(file);
  pushHistory(file);
  renderQueue();
  setPlayingUI(!activeDeck().paused);
}
$('mini-play').addEventListener('click', () => $('playpause').click());
$('mini-next').addEventListener('click', () => skip(1));

function loadQueue(files, autoplay) {
  queue = buildQueue(files);
  queueIndex = 0;
  crossing = false;
  otherDeck().pause();
  if (queue.length) startTrack(0, autoplay);
  else {
    activeDeck().removeAttribute('src');
    $('now-title').textContent = 'Nothing playing';
    $('now-sub').textContent = 'This playlist is empty';
    setNowArt(null);
    setPlayingUI(false);
    renderQueue();
  }
}

// Ramp a deck's volume to a target over ms (skips if a crossfade takes over).
function fadeVol(deck, to, ms) {
  const from = deck.volume;
  const t0 = performance.now();
  (function step(now) {
    if (crossing) return;
    const t = Math.min(1, (now - t0) / ms);
    deck.volume = clamp01(from + (to - from) * t);
    if (t < 1) requestAnimationFrame(step);
  })(t0);
}

function startTrack(i, autoplay) {
  if (i < 0 || i >= queue.length) return;
  queueIndex = i;
  crossing = false;
  const d = activeDeck();
  d.src = '/audio/' + encodeURIComponent(queue[i]);
  if (autoplay !== false) {
    d.volume = 0;
    d.play().catch(() => {});
    fadeVol(d, userVolume, 700); // gentle fade-in
  } else {
    d.volume = userVolume;
  }
  onTrackChanged(queue[i]);
}

// ---- auto-stop (sleep) timer ----
let sleepTimer = null;
function fadeOutStop() {
  const d = activeDeck();
  fadeVol(d, 0, 1500);
  setTimeout(() => { d.pause(); setPlayingUI(false); }, 1600);
}
$('sleep').addEventListener('change', (e) => {
  const min = Number(e.target.value);
  if (sleepTimer) { clearTimeout(sleepTimer); sleepTimer = null; }
  if (min > 0) {
    sleepTimer = setTimeout(() => { fadeOutStop(); $('sleep').value = '0'; toast('Auto-stopped'); }, min * 60000);
    toast('Music will stop in ' + (min < 60 ? min + ' min' : (min / 60) + ' h'));
  }
});

// "Stop at" a clock time (recurring daily, e.g. close). Fires once per occurrence.
const pad2 = (n) => String(n).padStart(2, '0');
function fmtClock(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return (((h + 11) % 12) + 1) + ':' + pad2(m) + (h < 12 ? ' am' : ' pm');
}
$('stop-at').addEventListener('change', (e) => {
  state.settings.stopAt = e.target.value || '';
  saveSettings({ stopAt: state.settings.stopAt });
  toast(state.settings.stopAt ? 'Will stop daily at ' + fmtClock(state.settings.stopAt) : 'Stop-at cleared');
});
let lastStopFired = '';
setInterval(() => {
  const sa = state.settings && state.settings.stopAt;
  if (!sa) return;
  const now = new Date();
  const cur = pad2(now.getHours()) + ':' + pad2(now.getMinutes());
  if (cur === sa && lastStopFired !== cur && !activeDeck().paused) {
    lastStopFired = cur;
    fadeOutStop();
    toast('Auto-stopped (close time)');
  }
}, 15000);

// Add all shown library tracks to the current playlist
$('add-all').addEventListener('click', () => {
  if (!editing) return;
  const shown = filteredLibrary();
  let added = 0;
  for (const t of shown) if (!state.playlists[editing].includes(t.file)) { state.playlists[editing].push(t.file); added++; }
  markCustom(editing);
  savePlaylists();
  toast('Added ' + added + ' track' + (added === 1 ? '' : 's') + ' to ' + editing);
});

function beginCrossfade(cf) {
  if (crossing || queue.length < 2) return;
  crossing = true;
  const from = activeDeck();
  const to = otherDeck();
  const nextIdx = (queueIndex + 1) % queue.length;
  const nextFile = queue[nextIdx];
  to.src = '/audio/' + encodeURIComponent(nextFile);
  to.volume = 0;
  to.play().catch(() => {});
  const t0 = performance.now();
  const dur = Math.max(0.1, cf) * 1000;
  (function ramp(now) {
    const t = Math.min(1, (now - t0) / dur);
    from.volume = clamp01(userVolume * (1 - t));
    to.volume = clamp01(userVolume * t);
    if (t < 1) requestAnimationFrame(ramp);
    else {
      active = 1 - active;
      queueIndex = nextIdx;
      crossing = false;
      from.pause();
      onTrackChanged(nextFile);
    }
  })(t0);
}

function skip(dir) {
  if (venueMode) { venuePost(dir < 0 ? '/api/player/prev' : '/api/player/skip').then(() => pollVenueSoon()); return; }
  if (!queue.length) return;
  crossing = false;
  otherDeck().pause();
  const ni = (queueIndex + dir + queue.length) % queue.length;
  startTrack(ni, true);
}

// deck events (wired once)
decks.forEach((d, idx) => {
  d.addEventListener('timeupdate', () => {
    if (idx !== active) return;
    updateProgress(d);
    if (crossing) return;
    const cf = Number(state.settings.crossfade ?? 4);
    if (cf <= 0 || !d.duration || isNaN(d.duration)) return;
    if (d.duration - d.currentTime <= cf && queue.length > 1) beginCrossfade(cf);
  });
  d.addEventListener('ended', () => {
    if (idx !== active || crossing) return;
    if (queue.length) startTrack((queueIndex + 1) % queue.length, true);
  });
  d.addEventListener('play', () => { vizEq.onPlay(); if (idx === active) setPlayingUI(true); });
  d.addEventListener('pause', () => { if (idx === active && !crossing) setPlayingUI(false); });
});

// ---- venue remote: reflect the box's player in the Now Playing UI ----------
function updateVenueUI(s) {
  venueState = s;
  const file = s.track;
  $('now-title').textContent = s.title || (file ? titleOf(file) : 'Nothing playing');
  const bits = [];
  if (s.artist) bits.push(s.artist);
  if (s.genre) bits.push(s.genre);
  $('now-sub').textContent = bits.join(' · ') || (s.enabled ? 'Playing to the room' : '');
  $('now-block').textContent = s.onSchedule ? 'On schedule' : (s.mode || 'Playing now');
  if (file) { $('mini-title').textContent = s.title || titleOf(file); $('miniplayer').hidden = false; }
  document.title = (s.title ? s.title + ' · ' : '') + 'Watermans Music';
  setNowArt(file || null);
  if (file) updateRateButtons(file);
  setPlayingUI(!!s.playing);
  // No per-track scrubbing to a live room — show a "live" marker, not a frozen 0:00.
  $('pfill').style.width = s.playing ? '100%' : '0%';
  $('t-cur').textContent = s.playing ? 'Live' : 'Paused';
  $('t-dur').textContent = '';
  // keep the volume slider in step with the box (without writing back)
  if (s.volume != null && document.activeElement !== $('volume') && venueVolPending == null) {
    userVolume = Math.max(0, Math.min(1, s.volume / 100));
    $('volume').value = userVolume;
    updateMuteIcon();
  }
  // Highlight the active scene button to match the box.
  activeScene = s.onSchedule ? null : activeScene;
}

function pollVenueOnce() {
  return api('/api/player/state').then((s) => {
    if (s && s.enabled) { venueMode = true; updateVenueUI(s); }
    return s;
  }).catch(() => null);
}

function pollVenue() {
  pollVenueOnce().finally(() => { venuePollTimer = setTimeout(pollVenue, 3000); });
}
// After an action that triggers a ~500ms fade + track swap on the box, refresh
// the UI both quickly (feels responsive) and once the swap has landed.
function pollVenueSoon() { setTimeout(pollVenueOnce, 250); setTimeout(pollVenueOnce, 850); }

// ---- room audio on THIS device: real visualiser + optional "Listen here" ---
// The box plays to the room; this device can't read that audio directly, so we
// pull the live room stream and route it two ways:
//   stream ─┬─▶ analyser        (silent — drives the REAL visualiser)
//           └─▶ gain ─▶ speakers (gain 0 by default; 1 when "Listen here" is on)
// So the meter always moves to the actual song, and you can also listen on
// demand — without this device ever becoming a second player (no echo unless
// you turn Listen here on next to the speakers).
let roomStream = null;
let roomGain = null;
let roomStarted = false;
let listening = false;

function startRoomAudio() {
  if (roomStarted) return true;
  const ctx = vizEq.ensureCtx();
  if (!ctx) return false;
  try {
    roomStream = new Audio('/stream?_=' + Date.now());
    roomStream.preload = 'auto';
    const src = ctx.createMediaElementSource(roomStream);
    const a = ctx.createAnalyser();
    a.fftSize = 512;
    a.smoothingTimeConstant = 0.6;
    roomGain = ctx.createGain();
    roomGain.gain.value = 0; // silent until Listen here is switched on
    src.connect(a);                       // analysis path (not wired to speakers)
    src.connect(roomGain).connect(ctx.destination); // audible path
    vizEq.setAnalyser(a);                 // meter now reads the real room spectrum
    roomStream.play().catch(() => {});
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    roomStarted = true;
    return true;
  } catch (e) { return false; }
}

function updateListenBtn() {
  const b = $('listen-here'); if (!b) return;
  b.classList.toggle('on', listening);
  b.setAttribute('aria-pressed', listening ? 'true' : 'false');
  b.title = listening ? 'Listening to the room on this device — tap to stop' : "Hear what's playing in the room, on this device";
  const t = b.querySelector('.modebtn-txt'); if (t) t.textContent = listening ? 'Listening' : 'Listen here';
}
// "Play here": make THIS device the player (music out of this browser) instead
// of driving the venue box. Per-device, remembered on the device. Switching
// reloads so playback starts cleanly in the chosen mode.
function setupPlayHere(serverHeadless, playMode) {
  const btn = $('play-here'); if (!btn) return;
  if (!serverHeadless) { btn.hidden = true; return; } // no venue box → app is already a local player
  btn.hidden = false;
  const onDevice = playMode === 'device';
  btn.classList.toggle('on', onDevice);
  btn.setAttribute('aria-pressed', onDevice ? 'true' : 'false');
  btn.title = onDevice ? 'Playing on this device — tap to hand playback back to the venue' : 'Play the music on THIS device instead of the venue box';
  const t = btn.querySelector('.modebtn-txt'); if (t) t.textContent = onDevice ? 'Playing here' : 'Play here';
  btn.addEventListener('click', () => {
    const next = onDevice ? 'venue' : 'device';
    try { localStorage.setItem('wm-playmode', next); } catch (e) { /* ignore */ }
    location.reload();
  });
}

// ---- find royalty-free music (in-app search via the server proxy) ----------
let findPreviewEl = null;

// A search seed for "more like what's playing": prefer the current track's
// genre, then its vibe, then keywords from its title.
function nowPlayingSeed() {
  let file = null, genre = '', vibe = '';
  if (venueMode && venueState) { file = venueState.track; genre = venueState.genre || ''; }
  else { file = queue[queueIndex]; }
  const t = file && library.find((x) => x.file === file);
  if (t) { genre = genre || t.genre || ''; vibe = t.vibe || ''; }
  // clean up genre strings like "Rap/Hip Hop" into a searchable phrase
  genre = genre.replace(/[/,&|]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (genre) return genre;
  const words = (venueState && venueState.title) || (t && t.title) || '';
  const kw = words.replace(/[^a-z0-9 ]/gi, ' ').split(/\s+/).filter((w) => w.length > 3).slice(0, 2).join(' ');
  if (kw) return kw;
  return vibe === 'Lively' ? 'deep house' : 'organic house';
}

// Chips to expand the library: "more like now playing", every genre you
// already have, and a few on-brand starters.
function renderFindChips() {
  const box = $('find-chips'); if (!box) return;
  box.innerHTML = '';
  const chip = (label, q, cls) => {
    const b = document.createElement('button');
    b.className = 'find-chip' + (cls ? ' ' + cls : '');
    b.textContent = label;
    b.addEventListener('click', () => runFind(q));
    box.appendChild(b);
  };
  const seen = new Set();
  // categories you already have in your library first…
  [...new Set(library.filter((t) => !t.licensed).map((t) => t.genre).filter(Boolean))]
    .slice(0, 6).forEach((g) => { const k = g.toLowerCase(); if (!seen.has(k)) { seen.add(k); chip(g, g); } });
  // …then a curated set of venue-friendly categories to search.
  ['organic house', 'deep house', 'melodic house', 'balearic', 'ibiza', 'chillout', 'downtempo', 'nu disco', 'afro house', 'ambient']
    .forEach((c) => { if (!seen.has(c)) { seen.add(c); chip(c, c); } });
}

function runFind(q) {
  const input = $('find-q'); const status = $('find-status'); const list = $('find-results');
  if (!list) return;
  if (input) input.value = q;
  if (!q || !q.trim()) return;
  if (status) status.textContent = 'Searching…';
  list.innerHTML = '';
  const by = ($('find-by') && $('find-by').value) || 'genre';
  api('/api/find?by=' + by + '&q=' + encodeURIComponent(q.trim())).then((d) => {
    if (!d || d.error) { if (status) status.textContent = ((d && d.error) || 'Search failed.') + (d && d.detail ? ' (' + d.detail + ')' : ''); return; }
    const rs = d.results || [];
    if (!rs.length) { if (status) status.textContent = 'Nothing found — try another search.'; return; }
    if (status) status.textContent = rs.length + ' found — preview, then add what you like.';
    rs.forEach((t) => list.appendChild(findRow(t)));
  }).catch(() => { if (status) status.textContent = 'Search unavailable — is the box online?'; });
}

function findRow(t) {
  const li = document.createElement('li');
  const meta = document.createElement('div');
  meta.className = 'find-meta';
  const title = document.createElement('div');
  title.className = 'find-title'; title.textContent = t.title;
  const sub = document.createElement('div');
  sub.className = 'find-sub';
  sub.textContent = [t.artist, t.license, t.duration ? fmtDur(t.duration) : ''].filter(Boolean).join(' · ');
  meta.append(title, sub);

  const prev = document.createElement('button');
  prev.className = 'mini find-prev'; prev.textContent = '▶'; prev.title = 'Preview';
  prev.addEventListener('click', () => {
    if (findPreviewEl && !findPreviewEl.paused && findPreviewEl.src === t.preview) { findPreviewEl.pause(); prev.textContent = '▶'; return; }
    document.querySelectorAll('.find-prev').forEach((b) => { b.textContent = '▶'; });
    if (!findPreviewEl) findPreviewEl = new Audio();
    findPreviewEl.src = t.preview;
    findPreviewEl.play().then(() => {
      prev.textContent = '⏸';
      const player = $('find-player'); if (player) player.hidden = false;
      const np = $('find-np'); if (np) np.textContent = t.title + (t.artist ? ' · ' + t.artist : '');
    }).catch(() => {});
    findPreviewEl.onended = () => { prev.textContent = '▶'; const player = $('find-player'); if (player) player.hidden = true; };
  });

  const add = document.createElement('button');
  add.className = 'ghost find-add'; add.textContent = '+ Add';
  add.addEventListener('click', () => {
    add.disabled = true; add.textContent = 'Adding…';
    fetch('/api/find/add', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: t.preview, title: t.title, artist: t.artist, ext: t.ext, license: t.license, attribution: t.attribution, landing: t.landing }) })
      .then((r) => r.json())
      .then((r) => {
        if (r.error) { add.disabled = false; add.textContent = '+ Add'; if ($('find-status')) $('find-status').textContent = 'Add failed: ' + r.error + (r.detail ? ' (' + r.detail + ')' : ''); return; }
        add.textContent = '✓ Added'; add.classList.add('on');
        reloadLibrary();
      })
      .catch(() => { add.disabled = false; add.textContent = '+ Add'; });
  });

  li.append(meta, prev, add);
  return li;
}

function setupFind() {
  const input = $('find-q'); const go = $('find-go');
  if (!input || !go) return;
  findPreviewEl = new Audio();
  // scrub bar for the preview, so you can jump into a track to test it fast
  const seek = $('find-seek'), tEl = $('find-time');
  findPreviewEl.addEventListener('timeupdate', () => {
    if (!findPreviewEl.duration || !seek) return;
    if (document.activeElement !== seek) seek.value = Math.round((findPreviewEl.currentTime / findPreviewEl.duration) * 1000);
    if (tEl) tEl.textContent = fmtDur(Math.floor(findPreviewEl.currentTime));
  });
  if (seek) seek.addEventListener('input', () => { if (findPreviewEl.duration) findPreviewEl.currentTime = (seek.value / 1000) * findPreviewEl.duration; });
  const run = () => runFind(input.value);
  renderFindChips();
  go.addEventListener('click', run);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
}

function setupListenHere() {
  const btn = $('listen-here'); if (!btn) return;
  btn.addEventListener('click', () => {
    if (!startRoomAudio()) return; // this click is the gesture that unlocks audio
    listening = !listening;
    if (roomGain) {
      try { roomGain.gain.value = listening ? 1 : 0; } catch (e) { /* ignore */ }
    }
    if (listening && roomStream && roomStream.paused) roomStream.play().catch(() => {});
    updateListenBtn();
  });
  updateListenBtn();
}

// Volume in venue mode: write the level (0–100) to the box, debounced.
function setVenueVolume(v01) {
  const pct = Math.round(Math.max(0, Math.min(1, v01)) * 100);
  venueVolPending = pct;
  clearTimeout(setVenueVolume._t);
  setVenueVolume._t = setTimeout(() => {
    venuePost('/api/player/volume', { level: venueVolPending }).finally(() => { venueVolPending = null; });
  }, 250);
}

// ---- transport + toggles ---------------------------------------------------
$('playpause').addEventListener('click', () => {
  if (venueMode) { venuePost('/api/player/pause').then((r) => { if (r) setPlayingUI(!r.paused); }); return; }
  if (!activeDeck().src || !queue.length) {
    const first = Object.keys(state.playlists).find((n) => (state.playlists[n] || []).length);
    if (first) { $('now-block').textContent = 'Playing now'; $('now-sub').textContent = 'Playlist: ' + first; loadQueue(state.playlists[first], true); }
    else $('now-sub').textContent = 'No music yet — add tracks on the Library tab.';
    return;
  }
  const d = activeDeck();
  if (d.paused) d.play().catch(() => {}); else d.pause();
});
$('next').addEventListener('click', () => skip(1));
$('prev').addEventListener('click', () => skip(-1));
$('like').addEventListener('click', () => rate('like'));
$('dislike').addEventListener('click', () => rate('dislike'));

$('volume').addEventListener('input', (e) => {
  userVolume = Number(e.target.value);
  updateMuteIcon();
  if (venueMode) { setVenueVolume(userVolume); return; }
  if (!crossing) activeDeck().volume = userVolume;
});
$('volume').addEventListener('change', () => { if (!venueMode) saveSettings({ volume: userVolume }); });

// (Follow-schedule is now the "Schedule" scene button — no separate toggle.)

// ---- quick blocks (one-tap schedule overrides for the manager) -------------

// The Now Playing quick buttons are the schedule's own time blocks. Tapping
// one plays that block's set for today; "Schedule" hands control back to the
// weekly clock. (Vibe still organises the Library — this is just the override.)
function renderScenes() {
  const box = $('scenes'); if (!box) return;
  box.innerHTML = '';
  const sched = document.createElement('button');
  sched.className = 'scene scene-auto' + (!activeScene && state.settings.followSchedule ? ' on' : '');
  sched.title = 'Follow the weekly schedule automatically';
  sched.innerHTML = '<span class="scene-ic">🗓️</span>Schedule';
  sched.addEventListener('click', () => {
    activeScene = null;
    saveSettings({ followSchedule: true, scene: '' });
    if (venueMode) { venuePost('/api/player/play', { token: 'schedule' }).then(() => pollVenueSoon()); renderScenes(); return; }
    applySchedule(true);
    renderScenes();
  });
  box.appendChild(sched);

  const now = new Date();
  const dk = dayKey(now);
  const nowBlk = currentBlock(now);
  (state.blocks || []).forEach((blk) => {
    const val = (state.schedule[dk] && state.schedule[dk][blk.id]) || '';
    const r = resolveScheduled(val);
    const has = !!(r && r.files.length);
    // Highlight only a manual override — in auto mode the "Schedule" button is
    // lit and the eyebrow shows the current block, so blocks stay un-selected.
    const isActive = activeScene === 'block:' + blk.id;
    const b = document.createElement('button');
    b.className = 'scene' + (isActive ? ' on' : '');
    b.textContent = blk.label;
    b.disabled = !has;
    b.title = has ? 'Play the ' + blk.label + ' set now' : 'Nothing set for ' + blk.label + ' — set it on the Schedule tab';
    if (has) b.addEventListener('click', () => playBlock(blk.id));
    box.appendChild(b);
  });

  // genre quick-picks — every genre present in the library (tag or set by hand)
  const genres = [...new Set(library.filter((t) => !t.licensed).map((t) => t.genre).filter(Boolean))].sort();
  genres.forEach((g) => {
    const b = document.createElement('button');
    b.className = 'scene scene-genre' + (activeScene === 'genre:' + g ? ' on' : '');
    b.title = 'Play ' + g + ' tracks now';
    b.innerHTML = '<span class="scene-ic">♪</span>';
    b.appendChild(document.createTextNode(g));
    b.addEventListener('click', () => playGenre(g));
    box.appendChild(b);
  });
}

// Play a specific time block's music on demand (overrides the schedule until
// the manager taps "Schedule" again).
function playBlock(blockId) {
  const now = new Date();
  const dk = dayKey(now);
  const blk = (state.blocks || []).find((b) => b.id === blockId);
  const val = (state.schedule[dk] && state.schedule[dk][blockId]) || '';
  const r = resolveScheduled(val);
  if (!r || !r.files.length) return;
  activeScene = 'block:' + blockId;
  saveSettings({ followSchedule: false, scene: activeScene });
  $('now-block').textContent = (blk ? blk.label : 'Block') + ' · playing now';
  $('now-sub').textContent = r.label + ' · ' + r.files.length + ' track' + (r.files.length === 1 ? '' : 's');
  if (venueMode) { venuePost('/api/player/play', { token: 'block:' + blockId }).then(() => pollVenueSoon()); renderScenes(); return; }
  loadQueue(r.files, true);
  renderScenes();
}

// Play every track of one genre on demand (overrides the schedule).
function playGenre(g) {
  const files = library.filter((t) => (t.genre || '') === g).map((t) => t.file);
  if (!files.length) return;
  activeScene = 'genre:' + g;
  saveSettings({ followSchedule: false, scene: activeScene });
  $('now-block').textContent = '♪ ' + g + ' · playing now';
  $('now-sub').textContent = g + ' · ' + files.length + ' track' + (files.length === 1 ? '' : 's');
  if (venueMode) { venuePost('/api/player/play', { token: 'genre:' + g }).then(() => pollVenueSoon()); renderScenes(); return; }
  loadQueue(files, true);
  renderScenes();
}

function updateShuffleBtn() {
  const on = state.settings.shuffle !== false;
  const btn = $('shuffle-btn'); if (!btn) return;
  btn.classList.toggle('on', on);
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  btn.title = on ? 'Shuffling — tap to play in order' : 'Playing in order — tap to shuffle';
  const t = btn.querySelector('.modebtn-txt'); if (t) t.textContent = on ? 'Shuffle' : 'In order';
}
$('shuffle-btn').addEventListener('click', () => {
  const on = state.settings.shuffle !== false;
  state.settings.shuffle = !on;
  saveSettings({ shuffle: state.settings.shuffle });
  updateShuffleBtn();
});
$('crossfade').addEventListener('input', (e) => { state.settings.crossfade = Number(e.target.value); $('cf-val').textContent = e.target.value + 's'; });
$('crossfade').addEventListener('change', (e) => saveSettings({ crossfade: Number(e.target.value) }));

// library search + filters + sort
$('lib-search').addEventListener('input', (e) => { libFilter = e.target.value.trim().toLowerCase(); renderEditor(); });
$('lib-genre').addEventListener('change', (e) => { libGenre = e.target.value; renderEditor(); });
$('lib-sort').addEventListener('change', (e) => { libSort = e.target.value; renderEditor(); });

// keyboard shortcuts (ignored while typing in a field)
document.addEventListener('keydown', (e) => {
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
  if (e.code === 'Space') { e.preventDefault(); $('playpause').click(); }
  else if (e.code === 'ArrowRight') skip(1);
  else if (e.code === 'ArrowLeft') skip(-1);
  else if (e.key === 'l' || e.key === 'L') rate('like');
  else if (e.key === 'd' || e.key === 'D') rate('dislike');
});

function rateFile(file, kind) {
  const next = ratingOf(file) === kind ? 'none' : kind;
  return fetch('/api/rate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file, rating: next }) })
    .then((r) => r.json())
    .then((d) => {
      state.ratings = d.ratings || {};
      const cur = queue[queueIndex];
      if (cur) updateRateButtons(cur);
      renderQueue();
      renderEditor();
      toast(next === 'like' ? '♥ Liked — plays more often' : next === 'less' ? '↓ Plays less often (still reappears)' : next === 'dislike' ? '⊘ Banned — won\'t play' : 'Rating cleared');
      if (venueMode) {
        // On the box, a ban/less on the playing track fades off to another one
        // (the box rebuilds its queue without the banned track on the next skip).
        const cur2 = venueState && venueState.track;
        if ((next === 'dislike' || next === 'less') && file === cur2) {
          venuePost('/api/player/skip').then(() => pollVenueSoon());
        }
        return next;
      }
      if (next === 'dislike' && file === cur) {
        // Banned the track that's playing to the room — don't hard-cut it;
        // gently fade across to the next track so guests hear a smooth change.
        const cf = Math.max(3, Number(state.settings.crossfade ?? 4));
        if (queue.length > 1 && !crossing) beginCrossfade(cf); else skip(1);
      } else if (next === 'less' && file === cur) {
        skip(1);
      }
      return next;
    });
}
function rate(kind) { const f = venueMode ? (venueState && venueState.track) : queue[queueIndex]; if (f) rateFile(f, kind); }
function updateRateButtons(file) {
  const r = ratingOf(file);
  $('like').classList.toggle('on', r === 'like');
  $('dislike').classList.toggle('on', r === 'dislike');
}

// ---- queue + history lists -------------------------------------------------
function renderQueue() {
  const ol = $('queue-list');
  if (!ol) return; // Up-next list removed from Now Playing
  ol.innerHTML = '';
  if (!queue.length) { ol.appendChild(emptyRow('Nothing queued yet.')); return; }
  queue.forEach((file, i) => {
    const li = document.createElement('li');
    if (i === queueIndex) li.className = 'current';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = titleOf(file);
    name.addEventListener('click', () => { crossing = false; otherDeck().pause(); startTrack(i, true); });
    li.appendChild(name);
    ol.appendChild(li);
  });
}
function pushHistory(file) {
  if (history[0] === file) return;
  history.unshift(file);
  history = history.slice(0, 15);
  renderHistory();
}
function renderHistory() {
  const ol = $('history-list');
  if (!ol) return; // Recently-played list removed from Now Playing
  ol.innerHTML = '';
  const recent = history.slice(1);
  if (!recent.length) { ol.appendChild(emptyRow('Nothing played yet.')); return; }
  recent.forEach((file) => {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = titleOf(file);
    name.addEventListener('click', () => preview(file));
    li.appendChild(name);
    ol.appendChild(li);
  });
}

// ---- schedule engine -------------------------------------------------------
function applySchedule(force) {
  if (venueMode) return; // the box follows the schedule server-side; UI is fed by pollVenue
  if (!state.settings.followSchedule) return;
  const now = new Date();
  const dk = dayKey(now);
  const bk = currentBlock(now);
  if (!dk || !bk) return;
  const key = dk + '/' + bk;
  if (!force && key === currentBlockKey) return;
  currentBlockKey = key;
  const val = (state.schedule[dk] && state.schedule[dk][bk]) || '';
  const block = state.blocks.find((b) => b.id === bk);
  $('now-block').textContent = block ? `${dk} · ${block.label}` : dk;
  const r = resolveScheduled(val);
  if (r && r.files.length) {
    $('now-sub').textContent = r.label;
    loadQueue(r.files, true);
  } else {
    const any = Object.keys(state.playlists).some((n) => (state.playlists[n] || []).length) || library.some((t) => t.vibe || t.genre);
    $('now-sub').textContent = any
      ? 'Nothing scheduled now — press Play or set one on the Schedule tab.'
      : 'No music yet — add tracks on the Library tab, then press Play.';
  }
}

// Resolve a schedule cell value to a playable track list. Values are one of:
// "style:Chill", "genre:Deep House", or a custom playlist name.
function resolveScheduled(value) {
  if (!value) return null;
  if (value.slice(0, 6) === 'style:') { const s = value.slice(6); return { label: 'Style · ' + s, files: library.filter((t) => t.vibe === s).map((t) => t.file) }; }
  if (value.slice(0, 6) === 'genre:') { const g = value.slice(6); return { label: 'Genre · ' + g, files: library.filter((t) => (t.genre || '') === g).map((t) => t.file) }; }
  const pl = state.playlists[value];
  return pl ? { label: 'Playlist: ' + value, files: pl } : null;
}
setInterval(applySchedule, 30 * 1000);

// ---- schedule tab: editable time blocks ------------------------------------
function renderBlocksEditor() {
  const wrap = $('blocks-editor');
  if (!wrap) return;
  wrap.innerHTML = '';
  state.blocks.forEach((b, i) => {
    const row = document.createElement('div');
    row.className = 'block-row';
    const label = document.createElement('input');
    label.type = 'text'; label.value = b.label; label.className = 'blk-label'; label.placeholder = 'Name (e.g. Lunch)';
    label.addEventListener('change', () => { state.blocks[i].label = label.value; saveBlocks(); });
    const time = document.createElement('input');
    time.type = 'time'; time.value = b.start; time.className = 'blk-time';
    time.addEventListener('change', () => { state.blocks[i].start = time.value; saveBlocks(); });
    const del = document.createElement('button');
    del.textContent = '✕'; del.className = 'del'; del.title = 'Delete block'; del.disabled = state.blocks.length <= 1;
    del.addEventListener('click', () => { if (!confirm('Delete the "' + b.label + '" block?')) return; state.blocks.splice(i, 1); saveBlocks(); });
    row.append(label, time, del);
    wrap.appendChild(row);
  });
}
function saveBlocks() {
  api('/api/blocks', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ blocks: state.blocks }) })
    .then((res) => {
      if (res.blocks) { state.blocks = res.blocks; state.schedule = res.schedule; }
      renderBlocksEditor(); renderSchedule(); applySchedule(true);
    });
}
$('add-block').addEventListener('click', () => {
  state.blocks.push({ id: '', label: 'New block', start: '12:00' });
  saveBlocks();
});

// ---- schedule tab ----------------------------------------------------------
function renderSchedule() {
  const table = $('schedule-table');
  const names = Object.keys(state.playlists);
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const styles = ['Chill', 'Lively'].filter((s) => library.some((t) => t.vibe === s));
  const genres = [...new Set(library.filter((t) => !t.licensed).map((t) => t.genre).filter(Boolean))].sort();
  const optionsFor = (sel) => {
    let o = `<option value="">—</option>`;
    if (styles.length) { o += '<optgroup label="By style">'; for (const s of styles) o += `<option value="style:${s}"${'style:' + s === sel ? ' selected' : ''}>${s}</option>`; o += '</optgroup>'; }
    if (genres.length) { o += '<optgroup label="By genre">'; for (const g of genres) o += `<option value="genre:${esc(g)}"${'genre:' + g === sel ? ' selected' : ''}>${esc(g)}</option>`; o += '</optgroup>'; }
    if (names.length) { o += '<optgroup label="Playlists">'; for (const n of names) o += `<option value="${esc(n)}"${n === sel ? ' selected' : ''}>${esc(n)}</option>`; o += '</optgroup>'; }
    return o;
  };
  let html = '<thead><tr><th></th>';
  for (const b of state.blocks) html += `<th>${b.label}<br><small>${b.start}</small></th>`;
  html += '</tr></thead><tbody>';
  for (const d of state.days) {
    html += `<tr><th><span class="d-name">${d}</span> <button class="copy-row" data-day="${d}" title="Copy ${d} to every day" aria-label="Copy ${d} to every day">⎘</button></th>`;
    for (const b of state.blocks) {
      html += `<td><select data-day="${d}" data-block="${b.id}">${optionsFor(state.schedule[d][b.id] || '')}</select></td>`;
    }
    html += '</tr>';
  }
  table.innerHTML = html + '</tbody>';
  const putSchedule = () => api('/api/schedule', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ schedule: state.schedule }) });
  table.querySelectorAll('select').forEach((sel) => {
    sel.addEventListener('change', () => {
      state.schedule[sel.dataset.day][sel.dataset.block] = sel.value;
      putSchedule().then(() => applySchedule(true));
    });
  });
  table.querySelectorAll('.copy-row').forEach((btn) => {
    btn.addEventListener('click', () => {
      const src = btn.dataset.day;
      for (const d of state.days) if (d !== src) state.schedule[d] = Object.assign({}, state.schedule[src]);
      putSchedule().then(() => { renderSchedule(); applySchedule(true); });
      toast('Copied ' + src + ' to all days');
    });
  });
}

// ---- playlists tab ---------------------------------------------------------
function emptyRow(text) { const li = document.createElement('li'); li.className = 'empty'; li.textContent = text; return li; }

// The library filtered by the search box + genre / vibe / rating filters and
// ordered by the current sort. Shared by the list render and "add all shown".
function filteredLibrary() {
  const vibeRank = { Chill: 0, Lively: 1 };
  const ratingMatch = (t) => {
    if (!libRating) return true;
    const r = ratingOf(t.file);
    if (libRating === 'rated') return !!r;
    if (libRating === 'none') return !r;
    return r === libRating;
  };
  const shown = library.filter((t) =>
    !t.licensed && // licensed after-hours tracks live only in the Admin card, never the trading-hours library
    (!libFilter || t.title.toLowerCase().includes(libFilter) || (t.genre || '').toLowerCase().includes(libFilter) || (t.artist || '').toLowerCase().includes(libFilter)) &&
    (!libGenre || t.genre === libGenre) &&
    (!libVibe || t.vibe === libVibe) &&
    ratingMatch(t));
  return shown.sort((a, b) => {
    if (libSort === 'vibe') return (vibeRank[a.vibe] ?? 9) - (vibeRank[b.vibe] ?? 9) || a.title.localeCompare(b.title);
    if (libSort === 'bpm') return (a.bpm || 999) - (b.bpm || 999) || a.title.localeCompare(b.title);
    if (libSort === 'genre') return (a.genre || '~').localeCompare(b.genre || '~') || a.title.localeCompare(b.title);
    if (libSort === 'duration') return (a.duration || 0) - (b.duration || 0) || a.title.localeCompare(b.title);
    return a.title.localeCompare(b.title);
  });
}

function preview(file) {
  crossing = false; otherDeck().pause();
  queue = [file]; queueIndex = 0;
  $('now-block').textContent = 'Preview';
  $('now-sub').textContent = 'Previewing: ' + titleOf(file);
  const d = activeDeck();
  d.src = '/audio/' + encodeURIComponent(file);
  d.volume = userVolume;
  d.play().catch(() => {});
  $('now-title').textContent = titleOf(file);
  setNowArt(file);
  updateRateButtons(file);
  renderQueue();
}

function renderPlaylistNames() {
  const ul = $('playlist-names');
  ul.innerHTML = '';
  Object.keys(state.playlists).forEach((name) => {
    const li = document.createElement('li');
    li.className = name === editing ? 'active' : '';
    const span = document.createElement('span');
    span.textContent = name + '  ';
    const cnt = document.createElement('span'); cnt.className = 'count'; cnt.textContent = (state.playlists[name] || []).length;
    span.appendChild(cnt);
    if ((state.autoPlaylists || []).includes(name)) {
      const badge = document.createElement('span');
      badge.className = 'pl-auto'; badge.textContent = 'Auto';
      badge.title = 'Auto-generated from your analysed music. Refreshes when you rebuild — edit it and it becomes your own custom playlist.';
      span.appendChild(document.createTextNode(' '));
      span.appendChild(badge);
    }
    span.addEventListener('click', () => { editing = name; renderPlaylistNames(); renderEditor(); });
    const ren = document.createElement('button');
    ren.textContent = '✎'; ren.className = 'mini'; ren.title = 'Rename';
    ren.addEventListener('click', (e) => { e.stopPropagation(); renamePlaylist(name); });
    const dup = document.createElement('button');
    dup.textContent = '⧉'; dup.className = 'mini'; dup.title = 'Duplicate';
    dup.addEventListener('click', (e) => {
      e.stopPropagation();
      let base = name + ' copy', n = base, i = 2;
      while (state.playlists[n]) n = base + ' ' + i++;
      state.playlists[n] = (state.playlists[name] || []).slice();
      savePlaylists();
      toast('Duplicated to "' + n + '"');
    });
    const del = document.createElement('button');
    del.textContent = '✕'; del.className = 'del'; del.title = 'Delete playlist';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!confirm('Delete playlist "' + name + '"?')) return;
      delete state.playlists[name];
      if (editing === name) editing = null;
      savePlaylists();
    });
    li.append(span, ren, dup, del);
    ul.appendChild(li);
  });
}

// ---- library multi-select (long-press → select → bulk delete/ban) ----------
function updateSelBar() {
  const bar = $('lib-selbar'); if (!bar) return;
  bar.hidden = !libSelect;
  const c = $('lib-selcount'); if (c) c.textContent = libSelected.size + ' selected';
}
function exitSelect() {
  libSelect = false; libSelected.clear();
  const ul = $('lib-tracks'); if (ul) { ul.classList.remove('selecting'); ul.querySelectorAll('li.sel').forEach((li) => li.classList.remove('sel')); }
  updateSelBar();
}
function toggleRow(li, file) {
  if (libSelected.has(file)) { libSelected.delete(file); li.classList.remove('sel'); }
  else { libSelected.add(file); li.classList.add('sel'); }
  if (!libSelected.size) return exitSelect();
  updateSelBar();
}
function enterSelect(li, file) {
  libSelect = true;
  const ul = $('lib-tracks'); if (ul) ul.classList.add('selecting');
  libSelected.clear(); libSelected.add(file); li.classList.add('sel');
  updateSelBar();
}
// Long-press (touch or mouse) to start selecting a row.
function attachLongPress(li, file) {
  let timer = null;
  const start = () => { timer = setTimeout(() => { timer = null; li.__lp = true; if (!libSelect) enterSelect(li, file); }, 450); };
  const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
  li.addEventListener('touchstart', start, { passive: true });
  li.addEventListener('touchmove', cancel, { passive: true });
  li.addEventListener('touchend', cancel);
  li.addEventListener('mousedown', start);
  li.addEventListener('mouseup', cancel);
  li.addEventListener('mouseleave', cancel);
}

function renderEditor() {
  if (editing) {
    const tks = state.playlists[editing] || [];
    const total = tks.reduce((a, f) => a + durOf(f), 0);
    $('editing-name').textContent = editing + ' · ' + tks.length + ' track' + (tks.length === 1 ? '' : 's') + (total ? ' · ' + fmtTotal(total) : '');
  } else $('editing-name').textContent = 'Select a playlist';
  const plUl = $('pl-tracks');
  const libUl = $('lib-tracks');
  $('lib-count').textContent = library.filter((t) => !t.licensed).length;
  $('add-all').disabled = !editing || !library.length;
  $('add-all').textContent = editing ? '+ Add all shown to ' + editing : '+ Add all shown to playlist';
  plUl.innerHTML = '';
  libUl.innerHTML = '';

  if (!editing) plUl.appendChild(emptyRow('Create or pick a playlist, then add tracks →'));
  else {
    const tracks = state.playlists[editing] || [];
    if (!tracks.length) plUl.appendChild(emptyRow('Empty — add tracks from the library.'));
    tracks.forEach((file, i) => {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.className = 'name'; name.textContent = titleOf(file);
      name.addEventListener('click', () => preview(file));
      const up = document.createElement('button');
      up.textContent = '↑'; up.className = 'mini'; up.title = 'Move up'; up.disabled = i === 0;
      up.addEventListener('click', () => { [tracks[i - 1], tracks[i]] = [tracks[i], tracks[i - 1]]; markCustom(editing); savePlaylists(); });
      const down = document.createElement('button');
      down.textContent = '↓'; down.className = 'mini'; down.title = 'Move down'; down.disabled = i === tracks.length - 1;
      down.addEventListener('click', () => { [tracks[i + 1], tracks[i]] = [tracks[i], tracks[i + 1]]; markCustom(editing); savePlaylists(); });
      const rm = document.createElement('button');
      rm.textContent = '−'; rm.className = 'del'; rm.title = 'Remove';
      rm.addEventListener('click', () => { tracks.splice(i, 1); markCustom(editing); savePlaylists(); });
      const dur = document.createElement('span'); dur.className = 'dur'; dur.textContent = fmtDur(durOf(file));
      li.append(name, dur, up, down, rm);
      plUl.appendChild(li);
    });
  }

  syncGenreOptions();
  const analysedCount = library.filter((t) => t.vibe).length;
  $('auto-vibe').disabled = !analysedCount;

  if (!library.length) { libUl.appendChild(emptyRow('No music yet — drop files above.')); return; }
  const shown = filteredLibrary();
  if (!shown.length) { libUl.appendChild(emptyRow('No tracks match those filters.')); return; }
  shown.forEach((t) => {
    const li = document.createElement('li');
    const rt = ratingOf(t.file);

    const art = document.createElement('div');
    art.className = 'row-art' + (t.vibe ? ' vibe-' + t.vibe.toLowerCase() : '');
    const aimg = document.createElement('img'); aimg.alt = ''; aimg.loading = 'lazy';
    aimg.addEventListener('error', () => aimg.remove()); // no embedded art → coloured tile
    aimg.src = '/api/art?file=' + encodeURIComponent(t.file);
    art.appendChild(aimg);

    // title + artist always lead the row and truncate before anything else
    const meta = document.createElement('div');
    meta.className = 'row-meta';
    const title = document.createElement('div');
    title.className = 'row-title'; title.textContent = t.title;
    const artist = document.createElement('div');
    artist.className = 'row-artist'; artist.textContent = t.artist || '—';
    meta.append(title, artist);
    meta.title = t.title + (t.artist ? ' — ' + t.artist : '');
    meta.addEventListener('click', () => { if (!libSelect) preview(t.file); });

    attachLongPress(li, t.file);
    li.addEventListener('click', () => {
      if (li.__lp) { li.__lp = false; return; } // swallow the click that ends a long-press
      if (libSelect) toggleRow(li, t.file);
    });
    if (libSelected.has(t.file)) li.classList.add('sel');

    // badges: one vibe chip + one genre chip (rating shows on the buttons)
    const badges = document.createElement('div');
    badges.className = 'row-badges';
    if (t.vibe) { const v = document.createElement('span'); v.className = 'tag vibe-' + t.vibe.toLowerCase(); v.textContent = t.vibe; badges.appendChild(v); }
    if (t.genre) { const g = document.createElement('span'); g.className = 'tag tag-genre'; g.textContent = t.genre; badges.appendChild(g); }

    // The Library is for organising, so rows get Categorise + Delete.
    // (Like / ban live on Now Playing, for reacting to what's in the room.)
    const acts = document.createElement('div');
    acts.className = 'row-acts';

    const mItem = (menu, label, cls, fn) => { const b = document.createElement('button'); b.className = 'row-menu-item' + (cls ? ' ' + cls : ''); b.textContent = label; b.addEventListener('click', (e) => { e.stopPropagation(); menu.hidden = true; fn(); }); return b; };
    const setVibe = (v) => fetch('/api/vibe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file: t.file, vibe: v }) }).then(() => reloadLibrary());

    // Categorise — set vibe / genre / add to a playlist
    const catWrap = document.createElement('div');
    catWrap.className = 'row-menu-wrap';
    const cat = document.createElement('button');
    cat.className = 'iact'; cat.title = 'Categorise'; cat.setAttribute('aria-label', 'Categorise');
    cat.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.6 13.4 12 22l-9-9V3h10z"/><circle cx="7.5" cy="7.5" r="1.3" fill="currentColor" stroke="none"/></svg>';
    const catMenu = document.createElement('div');
    catMenu.className = 'row-menu'; catMenu.hidden = true;
    catMenu.appendChild(mItem(catMenu, (t.vibe === 'Chill' ? '✓ ' : '') + '🌙 Chill', '', () => setVibe('Chill')));
    catMenu.appendChild(mItem(catMenu, (t.vibe === 'Lively' ? '✓ ' : '') + '⚡ Lively', '', () => setVibe('Lively')));
    catMenu.appendChild(mItem(catMenu, t.genre ? '♪ Genre: ' + t.genre : '♪ Set genre…', '', () => setTrackGenre(t)));
    if (editing) catMenu.appendChild(mItem(catMenu, '+ Add to “' + editing + '”', '', () => { if (!state.playlists[editing].includes(t.file)) state.playlists[editing].push(t.file); markCustom(editing); savePlaylists(); }));
    cat.addEventListener('click', (e) => { e.stopPropagation(); const willOpen = catMenu.hidden; closeRowMenus(); catMenu.hidden = !willOpen; });
    catWrap.append(cat, catMenu);

    // Delete
    const del = document.createElement('button');
    del.className = 'iact iact-del'; del.title = 'Delete from library'; del.setAttribute('aria-label', 'Delete');
    del.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!confirm('Delete "' + t.title + '" from the library?')) return;
      fetch('/api/track?name=' + encodeURIComponent(t.file), { method: 'DELETE' }).then((r) => r.json()).then(() => reloadLibrary());
    });

    acts.append(catWrap, del);
    li.append(art, meta, badges, acts);
    libUl.appendChild(li);
  });
}

// close any open row "⋯" menu when clicking elsewhere
function closeRowMenus() { document.querySelectorAll('.row-menu:not([hidden])').forEach((m) => { m.hidden = true; }); }
document.addEventListener('click', closeRowMenus);

function reloadLibrary() {
  return api('/api/library').then((lib) => { library = lib.tracks; renderEditor(); renderQueue(); renderHistory(); updateOnboard(); renderScenes(); renderLicensed(); renderFindChips(); });
}

// ---- venue name (editable, shown in the header + poster) -------------------
function applyVenueName() {
  const name = ((state.settings && state.settings.venueName) || 'Watermans').trim() || 'Watermans';
  const el = $('brand-name'); if (el) el.textContent = name;
  const pn = $('poster-name'); if (pn) pn.textContent = name;
  document.title = name + ' Music';
  const inp = $('venue-name'); if (inp && document.activeElement !== inp) inp.value = name;
}
(function wireVenueName() {
  const save = $('venue-save'); const inp = $('venue-name'); const status = $('venue-status');
  if (!save || !inp) return;
  const doSave = () => {
    const v = (inp.value || '').trim();
    if (!v) { if (status) status.textContent = 'Name can’t be empty'; return; }
    state.settings = state.settings || {};
    state.settings.venueName = v;
    saveSettings({ venueName: v });
    applyVenueName();
    if (status) { status.textContent = 'Saved ✓'; setTimeout(() => { status.textContent = ''; }, 2000); }
  };
  save.addEventListener('click', doSave);
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSave(); });
})();

// Prompt for a genre, listing the genres already in use so you can reuse the
// exact spelling instead of remembering or looking it up.
function promptGenre(message, current) {
  const existing = [...new Set(library.map((t) => t.genre).filter(Boolean))].sort();
  const hint = existing.length ? '\n\nGenres you already use:\n' + existing.join('   ·   ') : '';
  return prompt(message + hint, current || '');
}

// Manually set (or clear) a track's genre — for tracks with no embedded tag
// (e.g. Pixabay downloads). Stored server-side; drives the genre buttons.
function setTrackGenre(t) {
  const g = promptGenre('Genre for “' + t.title + '” (leave blank to clear):', t.genre || '');
  if (g === null) return; // cancelled
  fetch('/api/genre', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file: t.file, genre: g.trim() }) })
    .then((r) => r.json()).then(() => reloadLibrary());
}

// Keep the genre filter dropdown in sync with the genres present in the library,
// preserving the current selection.
function syncGenreOptions() {
  const sel = $('lib-genre');
  const genres = [...new Set(library.map((t) => t.genre).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const want = ['', ...genres].join('|');
  if (sel.dataset.sig === want) return;
  sel.dataset.sig = want;
  const cur = libGenre;
  sel.innerHTML = '<option value="">All genres</option>' + genres.map((g) => `<option value="${g.replace(/"/g, '&quot;')}">${g}</option>`).join('');
  if (genres.includes(cur)) sel.value = cur; else { sel.value = ''; libGenre = ''; }
}

// ---- audio analysis (genre is read server-side; tempo + energy here) --------
// Decode each track in the browser and measure loudness (RMS) and tempo, then
// POST the result so the server can bucket it into a Chill / Lively vibe.
async function analyzeLibrary() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) { toast('This browser can’t analyse audio'); return; }
  const todo = library.filter((t) => !t.vibe);
  const btn = $('analyze-btn'); const status = $('analyze-status');
  if (!todo.length) { status.textContent = 'Every track is already analysed.'; setTimeout(() => (status.textContent = ''), 4000); return; }
  btn.disabled = true;
  let done = 0; let failed = 0;
  for (const t of todo) {
    status.textContent = `Analysing ${done + failed + 1}/${todo.length}: ${t.title}…`;
    try {
      const r = await analyzeTrack(t.file, AC);
      await api('/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file: t.file, energy: r.energy, bpm: r.bpm }) });
      done++;
    } catch (e) { failed++; }
  }
  status.textContent = `Tagged ${done} track${done === 1 ? '' : 's'}${failed ? `, ${failed} skipped` : ''}.`;
  btn.disabled = false;
  await reloadLibrary();
  toast(`Analysed ${done} track${done === 1 ? '' : 's'}`);
  setTimeout(() => (status.textContent = ''), 6000);
}

async function analyzeTrack(file, AC) {
  const resp = await fetch('/audio/' + encodeURIComponent(file));
  if (!resp.ok) throw new Error('fetch failed');
  const buf = await resp.arrayBuffer();
  const ctx = new AC();
  try {
    const audio = await ctx.decodeAudioData(buf);
    const ch = audio.getChannelData(0);
    const sr = audio.sampleRate;
    // RMS loudness over the whole track (sampled to cap work on long files).
    const step = Math.max(1, Math.floor(ch.length / 2000000));
    let sum = 0; let cnt = 0;
    for (let i = 0; i < ch.length; i += step) { const v = ch[i]; sum += v * v; cnt++; }
    const energy = Math.sqrt(sum / Math.max(1, cnt));
    const bpm = estimateBpm(ch, sr);
    return { energy, bpm };
  } finally { if (ctx.close) ctx.close(); }
}

// Rough tempo estimate: build a ~100 Hz energy envelope, take positive onsets,
// and autocorrelate to find the strongest beat period in 70–160 BPM.
function estimateBpm(ch, sr) {
  const hop = Math.floor(sr / 100) || 441;
  const env = [];
  for (let i = 0; i + hop < ch.length; i += hop) {
    let s = 0; for (let j = 0; j < hop; j++) { const v = ch[i + j]; s += v * v; }
    env.push(Math.sqrt(s / hop));
  }
  if (env.length < 64) return null;
  const on = [];
  for (let i = 1; i < env.length; i++) { const d = env[i] - env[i - 1]; on.push(d > 0 ? d : 0); }
  const mean = on.reduce((a, b) => a + b, 0) / on.length;
  for (let i = 0; i < on.length; i++) on[i] -= mean;
  const fps = sr / hop;
  const minLag = Math.floor((fps * 60) / 160); const maxLag = Math.floor((fps * 60) / 70);
  let best = 0; let bestLag = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0; for (let i = 0; i + lag < on.length; i++) s += on[i] * on[i + lag];
    if (s > best) { best = s; bestLag = lag; }
  }
  if (!bestLag) return null;
  let bpm = (fps * 60) / bestLag;
  while (bpm < 70) bpm *= 2; while (bpm > 160) bpm /= 2;
  return Math.round(bpm);
}

// Group every analysed track into Chill / Lively playlists in one click.
function buildVibePlaylists() {
  const analysed = library.filter((t) => t.vibe);
  if (!analysed.length) { toast('Run “✨ Analyse audio” first'); return; }
  const buckets = { Chill: [], Lively: [] };
  analysed.forEach((t) => { if (buckets[t.vibe]) buckets[t.vibe].push(t.file); });
  state.autoPlaylists = state.autoPlaylists || [];
  let made = 0; let kept = 0;
  for (const v of ['Chill', 'Lively']) {
    if (!buckets[v].length) continue;
    // Don't overwrite a same-named playlist you've customised.
    if (state.playlists[v] && !state.autoPlaylists.includes(v)) { kept++; continue; }
    state.playlists[v] = buckets[v];
    if (!state.autoPlaylists.includes(v)) state.autoPlaylists.push(v);
    made++;
  }
  if (!made && !kept) { toast('Nothing to group yet'); return; }
  savePlaylists();
  toast(made ? `Built ${made} vibe playlist${made === 1 ? '' : 's'}${kept ? ` · kept ${kept} custom` : ''}` : `Kept your ${kept} custom playlist${kept === 1 ? '' : 's'}`);
}

// Fill the schedule with STYLE tokens by time of day — chill through the day,
// warmer in the afternoon, livelier into dinner. Tokens are resolved to
// matching tracks live, so no playlists get built.
function autoScheduleByVibe() {
  const analysed = library.filter((t) => t.vibe);
  if (!analysed.length) { toast('Categorise your music in the Library first'); return; }
  const has = { Chill: 0, Lively: 0 };
  analysed.forEach((t) => { if (has[t.vibe] != null) has[t.vibe]++; });
  const pref = { Chill: ['Chill', 'Lively'], Lively: ['Lively', 'Chill'] };
  const pick = (want) => { for (const s of pref[want]) if (has[s]) return s; return ''; };
  const wantFor = (h) => (h < 17 ? 'Chill' : 'Lively');
  for (const d of state.days) {
    for (const b of state.blocks) {
      const h = parseInt((b.start || '0:0').split(':')[0], 10) || 0;
      const s = pick(wantFor(h));
      if (s) state.schedule[d][b.id] = 'style:' + s;
    }
  }
  api('/api/schedule', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ schedule: state.schedule }) })
    .then(() => { renderSchedule(); applySchedule(true); });
}

$('add-playlist').addEventListener('click', () => {
  const name = $('new-playlist').value.trim();
  if (!name) return;
  if (state.playlists[name]) return alert('That playlist already exists.');
  state.playlists[name] = [];
  editing = name;
  $('new-playlist').value = '';
  savePlaylists();
});

function renamePlaylist(name) {
  const nn = (prompt('Rename playlist', name) || '').trim();
  if (!nn || nn === name) return;
  if (state.playlists[nn]) return alert('A playlist with that name already exists.');
  state.playlists[nn] = state.playlists[name];
  delete state.playlists[name];
  markCustom(name); // a renamed vibe list is now the user's own
  // keep schedule assignments pointing at the renamed playlist
  for (const d of state.days) for (const b of state.blocks) if (state.schedule[d][b.id] === name) state.schedule[d][b.id] = nn;
  if (editing === name) editing = nn;
  api('/api/schedule', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ schedule: state.schedule }) })
    .then(() => savePlaylists());
  toast('Renamed to "' + nn + '"');
}

// A playlist stops being "auto" the moment it's hand-edited — so the vibe
// rebuild won't overwrite your custom version.
function markCustom(name) {
  state.autoPlaylists = (state.autoPlaylists || []).filter((n) => n !== name);
}

function savePlaylists() {
  api('/api/playlists', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ playlists: state.playlists, auto: state.autoPlaylists || [] }) })
    .then((res) => {
      if (res.schedule) state.schedule = res.schedule;
      if (res.autoPlaylists) state.autoPlaylists = res.autoPlaylists;
      renderPlaylistNames(); renderEditor(); renderSchedule(); refreshAhPlaylists();
    });
}
function saveSettings(patch) {
  Object.assign(state.settings, patch);
  api('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
}

// ---- upload ----------------------------------------------------------------
function setupUpload() {
  const zone = $('dropzone'), input = $('file-input'), status = $('upload-status');
  if (!zone) return;
  async function uploadFiles(files) {
    const list = [...files].filter((f) => /\.(mp3|m4a|aac|ogg|oga|wav|flac|webm)$/i.test(f.name));
    if (!list.length) { status.textContent = 'Please choose audio files.'; return; }
    let done = 0;
    for (const f of list) {
      status.textContent = `Uploading ${f.name} (${done + 1}/${list.length})…`;
      try {
        const res = await fetch('/api/upload?name=' + encodeURIComponent(f.name), { method: 'POST', body: f });
        if (!res.ok) throw new Error((await res.json()).error || 'failed');
        done++;
      } catch (e) { status.textContent = `Couldn't upload ${f.name}: ${e.message}`; return; }
    }
    status.textContent = `Added ${done} track${done === 1 ? '' : 's'}.`;
    toast(`Added ${done} track${done === 1 ? '' : 's'} to the library`);
    await reloadLibrary();
    setTimeout(() => (status.textContent = ''), 4000);
  }
  // Recursively pull every file out of a dropped folder (or files).
  function readEntry(entry, out) {
    return new Promise((resolve) => {
      if (!entry) return resolve();
      if (entry.isFile) { entry.file((f) => { out.push(f); resolve(); }, () => resolve()); }
      else if (entry.isDirectory) {
        const reader = entry.createReader();
        const readBatch = () => reader.readEntries((entries) => {
          if (!entries.length) return resolve();
          Promise.all(entries.map((en) => readEntry(en, out))).then(readBatch);
        }, () => resolve());
        readBatch();
      } else resolve();
    });
  }
  async function filesFromDrop(dt) {
    // Grab the directory entries synchronously (the items list is only valid
    // during the drop event), then read them recursively.
    const items = dt && dt.items;
    if (items && items.length && items[0].webkitGetAsEntry) {
      const entries = [...items].map((it) => it.webkitGetAsEntry && it.webkitGetAsEntry()).filter(Boolean);
      if (entries.length) { const out = []; await Promise.all(entries.map((en) => readEntry(en, out))); return out; }
    }
    return [...((dt && dt.files) || [])];
  }

  input.addEventListener('change', () => uploadFiles(input.files));
  const folderInput = $('folder-input');
  if (folderInput) folderInput.addEventListener('change', () => uploadFiles(folderInput.files));
  // Tap / click anywhere in the dashed box to add files (touch-friendly).
  zone.addEventListener('click', (e) => { if (e.target.tagName !== 'INPUT') input.click(); });
  zone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  ['dragenter', 'dragover'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove('drag'); }));
  zone.addEventListener('drop', (e) => { filesFromDrop(e.dataTransfer).then(uploadFiles); });
}

// ---- venue stream + headless player ----------------------------------------
function loadStreamInfo() {
  api('/api/stream-info').then((info) => {
    if (!info || !info.urls || !info.urls.length) return;
    const box = $('stream-urls'); box.innerHTML = '';
    info.urls.forEach((u) => {
      const row = document.createElement('div'); row.className = 'stream-url';
      const code = document.createElement('code'); code.textContent = u;
      const copy = document.createElement('button'); copy.textContent = 'Copy';
      copy.addEventListener('click', () => { navigator.clipboard && navigator.clipboard.writeText(u); copy.textContent = 'Copied'; setTimeout(() => (copy.textContent = 'Copy'), 1500); });
      row.append(code, copy); box.appendChild(row);
    });
    $('stream-card').hidden = false;
    const dev = $('device-info');
    if (dev) {
      dev.innerHTML = info.urls.map((u) => {
        const base = u.replace(/\/stream$/, '');
        return `<div class="dev-row"><span>App address</span><code>${base}</code></div>`;
      }).join('') + `<div class="dev-row"><span>Venue stream</span><code>${info.urls[0]}</code></div>`;
    }
    // "Open on your devices" share card: address + scannable QR
    const appUrl = info.urls[0].replace(/\/stream$/, '');
    const big = $('big-addr');
    if (big) {
      big.textContent = appUrl;
      $('qr-img').src = '/api/qr?text=' + encodeURIComponent(appUrl);
      $('copy-addr').onclick = () => {
        navigator.clipboard && navigator.clipboard.writeText(appUrl);
        $('copy-addr').textContent = 'Copied ✓';
        setTimeout(() => ($('copy-addr').textContent = 'Copy address'), 1500);
      };
      // printable poster
      $('poster-qr').src = '/api/qr?text=' + encodeURIComponent(appUrl);
      $('poster-addr').textContent = appUrl;
      $('print-poster').onclick = () => window.print();
      $('share-card').hidden = false;
    }
  }).catch(() => {});
}
function setupVenuePlayer() {
  const card = $('player-card'); if (!card) return;
  const refresh = () => api('/api/player/state').then((s) => {
    if (!s || !s.enabled) return;
    card.hidden = false;
    $('player-now').textContent = s.broken ? 'Audio player not installed (sudo apt install mpg123)' : (s.title || '—') + (s.paused ? '  (paused)' : '');
    $('player-pause').textContent = s.paused ? 'Play' : 'Pause';
  }).catch(() => {});
  $('player-pause').addEventListener('click', () => fetch('/api/player/pause', { method: 'POST' }).then(refresh));
  $('player-skip').addEventListener('click', () => fetch('/api/player/skip', { method: 'POST' }).then(() => setTimeout(refresh, 300)));
  refresh(); setInterval(refresh, 5000);
  setupAudioOutput();
}

// Pick which physical output the box plays out of (3.5mm / HDMI / USB DAC).
function setupAudioOutput() {
  const sel = $('audio-out'); if (!sel) return;
  const status = $('audio-out-status');
  api('/api/audio/devices').then((d) => {
    if (!d || !d.enabled) return; // only meaningful on the venue box
    const opts = [{ dev: '', label: 'System default' }].concat(d.devices || []);
    sel.innerHTML = opts.map((o) => `<option value="${o.dev}"${o.dev === (d.current || '') ? ' selected' : ''}>${o.label}${o.dev ? ' (' + o.dev + ')' : ''}</option>`).join('');
    if (!d.devices || !d.devices.length) { if (status) status.textContent = 'No output devices detected.'; }
  }).catch(() => {});
  const save = $('audio-out-save');
  if (save) save.addEventListener('click', () => {
    if (status) status.textContent = 'Switching…';
    fetch('/api/audio/output', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device: sel.value, password: adminPass }) })
      .then((r) => r.json())
      .then((r) => {
        if (r.error) { if (status) status.textContent = r.error === 'wrong password' ? 'Unlock admin first.' : ('Failed: ' + r.error); return; }
        if (status) status.textContent = 'Output set' + (r.control ? ' · volume via ' + r.control : '') + '.';
      })
      .catch(() => { if (status) status.textContent = 'Failed to switch.'; });
  });
}

// ---- after-hours licensed music (staff, off-schedule) ----------------------
// Commercial/licensed tracks staff add for after close. Kept out of the
// trading-hours rotation on the server; only played via the admin-gated
// "afterhours" token so they never reach guests.
function renderLicensed() {
  const ul = $('licensed-list'); if (!ul) return;
  const items = library.filter((t) => t.licensed);
  if (!items.length) { ul.innerHTML = '<li class="hint">No licensed tracks yet — add some above.</li>'; return; }
  ul.innerHTML = '';
  items.forEach((t) => {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.className = 'lic-name';
    span.textContent = t.title + (t.artist ? ' — ' + t.artist : '');
    const rm = document.createElement('button');
    rm.className = 'ghost';
    rm.textContent = 'Remove';
    rm.addEventListener('click', () => {
      if (!confirm('Remove “' + t.title + '” from the box?')) return;
      fetch('/api/track?name=' + encodeURIComponent(t.file), { method: 'DELETE' })
        .then((r) => r.json()).then(() => reloadLibrary());
    });
    li.appendChild(span);
    li.appendChild(rm);
    ul.appendChild(li);
  });
}

async function uploadLicensed(files) {
  const list = Array.from(files || []).filter((f) => /\.(mp3|m4a|aac|ogg|oga|wav|flac|webm)$/i.test(f.name));
  const st = $('licensed-status');
  if (!list.length) { if (st) st.textContent = 'Please choose audio files.'; return; }
  let done = 0;
  if (st) st.textContent = 'Adding…';
  for (const f of list) {
    try {
      await fetch('/api/upload?licensed=1&name=' + encodeURIComponent(f.name), { method: 'POST', body: f });
      done += 1;
      if (st) st.textContent = 'Adding ' + done + '/' + list.length + '…';
    } catch { /* skip this file */ }
  }
  if (st) st.textContent = 'Added ' + done + ' track' + (done === 1 ? '' : 's') + '.';
  await reloadLibrary();
}
function setupLicensed() {
  const input = $('licensed-file');
  if (input) input.addEventListener('change', (e) => { uploadLicensed(e.target.files); input.value = ''; });
  // dashed dropzone (same as the Library +music box): click / Enter / drag-drop
  const zone = $('licensed-drop');
  if (zone && input) {
    zone.addEventListener('click', (e) => { if (e.target.tagName !== 'INPUT') input.click(); });
    zone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
    ['dragenter', 'dragover'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add('drag'); }));
    ['dragleave', 'drop'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove('drag'); }));
    zone.addEventListener('drop', (e) => { uploadLicensed((e.dataTransfer && e.dataTransfer.files) || []); });
  }

  const play = $('licensed-play');
  if (play) play.addEventListener('click', () => {
    const st = $('licensed-status');
    if (!library.some((t) => t.licensed)) { if (st) st.textContent = 'Add some licensed tracks first.'; return; }
    if (!confirm('Play licensed music now?\n\nOnly do this AFTER CLOSE — it must not play while guests are in.')) return;
    venuePost('/api/player/play', { token: 'afterhours', password: adminPass }).then((r) => {
      if (!r || r.ok === false) { if (st) st.textContent = (r && r.error) || 'Could not start.'; return; }
      if (st) st.textContent = 'Playing licensed music (after hours).';
      pollVenueSoon();
    });
  });

  const sched = $('licensed-schedule');
  if (sched) sched.addEventListener('click', () => {
    venuePost('/api/player/play', { token: 'schedule' }).then(() => {
      const st = $('licensed-status'); if (st) st.textContent = 'Back on the schedule.';
      pollVenueSoon();
    });
  });
}

// ---- after-hours staff mode ------------------------------------------------
function refreshAhPlaylists() {
  const sel = $('ah-playlist'); if (!sel) return;
  const names = Object.keys(state.playlists);
  sel.innerHTML = names.map((n) => `<option${/after|staff/i.test(n) ? ' selected' : ''}>${n}</option>`).join('');
}
// The whole Admin tab is password-gated (session-only; relocks on reload).
let adminUnlocked = false;
let adminPass = '';
function setupAdmin() {
  const showLocked = () => {
    adminUnlocked = false; adminPass = '';
    $('admin-content').hidden = true; $('admin-lock').hidden = false;
    $('admin-pass').value = '';
  };
  const showUnlocked = () => {
    adminUnlocked = true;
    $('admin-lock').hidden = true; $('admin-content').hidden = false;
    const lt = $('admin-lock-toggle'); if (lt) lt.checked = (state.settings.adminLock !== false);
    refreshAhPlaylists();
    renderLicensed();
  };
  const tryUnlock = () => {
    const password = $('admin-pass').value;
    fetch('/api/afterhours/unlock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) })
      .then((r) => r.json()).then((d) => { if (d.ok) { adminPass = password; showUnlocked(); } else alert('Wrong password.'); });
  };

  // Lock disabled on this box? Open Admin straight away, no prompt.
  if (state.settings && state.settings.adminLock === false) showUnlocked();

  $('admin-unlock').addEventListener('click', tryUnlock);
  $('admin-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') tryUnlock(); });
  $('admin-relock').addEventListener('click', showLocked);

  const lockToggle = $('admin-lock-toggle');
  if (lockToggle) lockToggle.addEventListener('change', () => {
    const enabled = lockToggle.checked;
    fetch('/api/admin/lock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled, password: adminPass }) })
      .then((r) => r.json())
      .then((d) => {
        if (d.error) { lockToggle.checked = !enabled; alert('Could not change: ' + d.error); return; }
        state.settings.adminLock = d.adminLock;
        toast(d.adminLock ? 'Admin password on' : 'Admin password off');
      })
      .catch(() => { lockToggle.checked = !enabled; });
  });

  function powerAction(action) {
    const st = $('power-status');
    const msg = action === 'shutdown'
      ? 'Shut down the music box now? It goes silent until someone powers it back on.'
      : 'Restart the music box now? Music stops for about 30 seconds.';
    if (!confirm(msg)) return;
    // Use the unlocked admin password, or ask for it (the header button works
    // without opening the Admin tab first).
    let pass = adminPass;
    if (!pass) { pass = prompt('Enter the admin password to ' + (action === 'shutdown' ? 'shut down' : 'restart') + ' the box:'); if (!pass) return; }
    if (st) st.textContent = action === 'shutdown' ? 'Shutting down…' : 'Restarting…';
    fetch('/api/power', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pass, action }) })
      .then((r) => r.json())
      .then((d) => {
        const ok = action === 'shutdown' ? 'Shutting down — you can close this now.' : 'Restarting — reconnect in ~30s.';
        if (st) st.textContent = d.error ? 'Failed: ' + d.error : ok;
        if (d.error) alert(d.error === 'wrong password' ? 'Wrong admin password.' : d.error);
      })
      .catch(() => { if (st) st.textContent = action === 'shutdown' ? 'Shutting down…' : 'Restarting — reconnect in ~30s.'; });
  }
  const powerOff = $('power-off'); if (powerOff) powerOff.addEventListener('click', () => powerAction('shutdown'));
  const powerRestart = $('power-restart'); if (powerRestart) powerRestart.addEventListener('click', () => powerAction('reboot'));
  const headerPower = $('header-power'); if (headerPower) headerPower.addEventListener('click', () => powerAction('shutdown'));

  const updateBtn = $('app-update');
  if (updateBtn) updateBtn.addEventListener('click', () => {
    const st = $('update-status'); const b = updateBtn;
    b.disabled = true; st.textContent = 'Updating…';
    fetch('/api/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: adminPass }) })
      .then((r) => r.json())
      .then((d) => {
        if (d.error) { st.textContent = 'Failed: ' + d.error; b.disabled = false; return; }
        if (!d.updated) { st.textContent = 'Already up to date.'; b.disabled = false; return; }
        st.textContent = 'Updated — restarting, reloading in 6s…';
        setTimeout(() => location.reload(), 6000);
      })
      .catch(() => { st.textContent = 'Restarting… reloading in 6s'; setTimeout(() => location.reload(), 6000); });
  });

  $('ah-play').addEventListener('click', () => {
    const name = $('ah-playlist').value;
    if (!name || !state.playlists[name] || !state.playlists[name].length) return alert('That playlist is empty.');
    activeScene = null; saveSettings({ followSchedule: false, scene: '' }); renderScenes();
    $('now-block').textContent = 'After hours'; $('now-sub').textContent = 'Staff: ' + name;
    loadQueue(state.playlists[name], true);
    toast('Playing (after hours): ' + name);
  });

  $('admin-setpass').addEventListener('click', () => {
    const next = $('admin-newpass').value;
    if (!next) return alert('Enter a new password.');
    fetch('/api/afterhours/password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ current: adminPass, next }) })
      .then((r) => r.json()).then((d) => { if (d.ok) { adminPass = next; $('admin-newpass').value = ''; toast('Admin password changed'); } else alert('Could not change password.'); });
  });

  $('backup-dl').addEventListener('click', () => { window.location.href = '/api/backup'; });
  $('restore-file').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      let obj;
      try { obj = JSON.parse(rd.result); } catch { return alert('That is not a valid backup file.'); }
      if (!confirm('Restore this backup? It replaces your current playlists, schedule and settings.')) return;
      fetch('/api/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) })
        .then((r) => r.json()).then((d) => { if (d.ok) { toast('Restored — reloading…'); setTimeout(() => location.reload(), 800); } else alert('Restore failed: ' + (d.error || 'invalid file')); });
    };
    rd.readAsText(f);
  });
}

// ---- theme (manual light/dark override, remembered on this device) ---------
function setupTheme() {
  const saved = localStorage.getItem('wm-theme');
  if (saved === 'dark' || saved === 'light') document.documentElement.dataset.theme = saved;
  const btn = $('theme');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const effective = document.documentElement.dataset.theme
      || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = effective === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('wm-theme', next);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', next === 'dark' ? '#0f1113' : '#10917b');
  });
}
setupTheme();

// ---- boot ------------------------------------------------------------------
async function boot() {
  const [st, lib] = await Promise.all([api('/api/state'), api('/api/library')]);
  state = st; library = lib.tracks;
  state.settings = state.settings || {};
  state.autoPlaylists = state.autoPlaylists || [];

  userVolume = state.settings.volume ?? 0.8;
  if (userVolume > 0) preMuteVol = userVolume;
  decks.forEach((d) => { d.volume = userVolume; });
  $('volume').value = userVolume;
  updateMuteIcon();
  updateShuffleBtn();
  applyVenueName();
  const cf = state.settings.crossfade ?? 4;
  $('crossfade').value = cf; $('cf-val').textContent = cf + 's';
  $('stop-at').value = state.settings.stopAt || '';

  renderBlocksEditor();
  renderSchedule();
  renderPlaylistNames();
  renderEditor();
  updateOnboard();
  renderQueue();
  renderHistory();
  renderScenes();

  // Is the server running the room (headless player)? If so this app is the
  // remote control by default — unless THIS device is set to "Play here",
  // which makes it a local player (music out of this browser instead).
  const pstate = await pollVenueOnce();
  const serverHeadless = !!(pstate && pstate.enabled);
  let playMode = 'venue';
  try { playMode = localStorage.getItem('wm-playmode') || 'venue'; } catch (e) { /* ignore */ }
  venueMode = serverHeadless && playMode !== 'device';
  setupPlayHere(serverHeadless, playMode);

  if (venueMode) {
    venuePollTimer = setTimeout(pollVenue, 3000);
    // Feed the visualiser the REAL room audio. Browsers require a user gesture
    // before audio can start, so arm it on the first tap/keypress.
    const armRoomViz = () => { startRoomAudio(); };
    window.addEventListener('pointerdown', armRoomViz, { once: true });
    window.addEventListener('keydown', armRoomViz, { once: true });
  } else {
    const pb = $('pbar'); if (pb) pb.classList.add('seekable'); // scrubbing OK when playing on this device
    applySchedule(true);
    // Re-apply a saved override (e.g. the venue box rebooted mid-service).
    const savedScene = String(state.settings.scene || '');
    if (!state.settings.followSchedule && savedScene.slice(0, 6) === 'block:') {
      const bid = savedScene.slice(6);
      if ((state.blocks || []).some((b) => b.id === bid)) playBlock(bid);
    } else if (!state.settings.followSchedule && savedScene.slice(0, 6) === 'genre:') {
      playGenre(savedScene.slice(6));
    }
  }
  loadStreamInfo();
  setupUpload();
  $('analyze-btn').addEventListener('click', analyzeLibrary);
  $('auto-vibe').addEventListener('click', buildVibePlaylists);
  $('auto-schedule').addEventListener('click', () => {
    const st = $('sched-status');
    const categorised = library.filter((t) => t.vibe).length;
    if (!categorised) { if (st) st.textContent = 'Categorise your music first — tap “✨ Auto-categorise” on the Library tab.'; return; }
    autoScheduleByVibe(); // assign style tokens across the week by time of day
    if (st) st.textContent = `Scheduled by style — ${categorised} track${categorised === 1 ? '' : 's'} spread across the week. ✅`;
  });
  const autoAll = $('auto-all');
  if (autoAll) autoAll.addEventListener('click', async () => {
    const st = $('analyze-status');
    if (!library.length) { if (st) st.textContent = 'Add some music first ↑'; return; }
    autoAll.disabled = true;
    try {
      await analyzeLibrary();  // categorise only: tag each track's style (vibe)
      if (st) st.textContent = 'Done — every track tagged by style. ✅ Now set up the Schedule tab.';
    } catch (e) { if (st) st.textContent = 'Something went wrong — try again.'; }
    finally { autoAll.disabled = false; }
  });

  const selCancel = $('lib-selcancel'); if (selCancel) selCancel.addEventListener('click', exitSelect);
  const selDel = $('lib-seldel');
  if (selDel) selDel.addEventListener('click', async () => {
    const files = [...libSelected]; if (!files.length) return;
    if (!confirm('Delete ' + files.length + ' track' + (files.length === 1 ? '' : 's') + ' from the library?')) return;
    selDel.disabled = true;
    for (const f of files) { try { await fetch('/api/track?name=' + encodeURIComponent(f), { method: 'DELETE' }); } catch (e) { /* ignore */ } }
    selDel.disabled = false;
    exitSelect();
    reloadLibrary();
  });
  const selBan = $('lib-selban');
  if (selBan) selBan.addEventListener('click', async () => {
    const files = [...libSelected]; if (!files.length) return;
    let last;
    for (const f of files) {
      try { const r = await fetch('/api/rate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file: f, rating: 'dislike' }) }); last = await r.json(); } catch (e) { /* ignore */ }
    }
    if (last && last.ratings) state.ratings = last.ratings;
    exitSelect();
    renderEditor();
  });
  const selGenre = $('lib-selgenre');
  if (selGenre) selGenre.addEventListener('click', async () => {
    const files = [...libSelected]; if (!files.length) return;
    const g = promptGenre('Set genre for ' + files.length + ' track' + (files.length === 1 ? '' : 's') + ' (leave blank to clear):', '');
    if (g === null) return;
    selGenre.disabled = true;
    for (const f of files) { try { await fetch('/api/genre', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file: f, genre: g.trim() }) }); } catch (e) { /* ignore */ } }
    selGenre.disabled = false;
    exitSelect();
    reloadLibrary();
  });
  setupVenuePlayer();
  setupAdmin();
  setupLicensed();
  setupListenHere();
  setupFind();
  refreshAhPlaylists();
}
boot();
