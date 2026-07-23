'use strict';

// ---- state -----------------------------------------------------------------
let state = { blocks: [], days: [], schedule: {}, playlists: {}, ratings: {}, settings: {} };
let library = [];
let editing = null;

let queue = [];          // filenames in play order
let queueIndex = 0;
let history = [];         // recently played (newest first)
let currentBlockKey = null;
let libFilter = '';       // library search term
let libGenre = '';        // library genre filter
let libVibe = '';         // library vibe filter (Chill/Warm/Upbeat)
let libSort = 'title';    // library sort key

// dual-deck crossfade player
const decks = [new Audio(), new Audio()];
decks.forEach((d) => { d.preload = 'auto'; });
let active = 0;
let crossing = false;
let userVolume = 0.8;

const $ = (id) => document.getElementById(id);
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

// ---- queue building (smart rotation: likes more, dislikes never) -----------
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function buildQueue(files) {
  const ratings = state.ratings || {};
  let pool = files.filter((f) => ratings[f] !== 'dislike');
  if (!pool.length) pool = files.slice();
  const weighted = [];
  for (const f of pool) { weighted.push(f); if (ratings[f] === 'like') weighted.push(f); }
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

const fmt = (s) => (!s || isNaN(s)) ? '0:00' : Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
function updateProgress(d) {
  const dur = d.duration;
  const pct = dur ? (d.currentTime / dur) * 100 : 0;
  $('pfill').style.width = pct + '%';
  $('t-cur').textContent = fmt(d.currentTime);
  $('t-dur').textContent = fmt(dur);
}
$('pbar').addEventListener('click', (e) => {
  const d = activeDeck();
  if (!d.duration || crossing) return;
  const r = $('pbar').getBoundingClientRect();
  d.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * d.duration;
});

// toast notifications
let toastTimer;
function toast(msg) {
  const t = $('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

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
  if (!crossing) activeDeck().volume = userVolume;
  $('volume').value = userVolume;
  updateMuteIcon();
  saveSettings({ volume: userVolume });
});

// show the get-started card only when the library is empty
function updateOnboard() { const o = $('onboard'); if (o) o.hidden = library.length > 0; }

function onTrackChanged(file) {
  $('now-title').textContent = titleOf(file);
  $('mini-title').textContent = titleOf(file);
  $('miniplayer').hidden = false;
  document.title = (file ? titleOf(file) + ' · ' : '') + 'Watermans Music';
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
    deck.volume = from + (to - from) * t;
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
  const shown = library.filter((t) => !libFilter || t.title.toLowerCase().includes(libFilter));
  let added = 0;
  for (const t of shown) if (!state.playlists[editing].includes(t.file)) { state.playlists[editing].push(t.file); added++; }
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
    from.volume = userVolume * (1 - t);
    to.volume = userVolume * t;
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
  d.addEventListener('play', () => { if (idx === active) setPlayingUI(true); });
  d.addEventListener('pause', () => { if (idx === active && !crossing) setPlayingUI(false); });
});

// ---- transport + toggles ---------------------------------------------------
$('playpause').addEventListener('click', () => {
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

$('volume').addEventListener('input', (e) => { userVolume = Number(e.target.value); if (!crossing) activeDeck().volume = userVolume; updateMuteIcon(); });
$('volume').addEventListener('change', () => saveSettings({ volume: userVolume }));

$('follow').addEventListener('change', (e) => { saveSettings({ followSchedule: e.target.checked }); if (e.target.checked) applySchedule(true); });
$('shuffle').addEventListener('change', (e) => { state.settings.shuffle = e.target.checked; saveSettings({ shuffle: e.target.checked }); });
$('crossfade').addEventListener('input', (e) => { state.settings.crossfade = Number(e.target.value); $('cf-val').textContent = e.target.value + 's'; });
$('crossfade').addEventListener('change', (e) => saveSettings({ crossfade: Number(e.target.value) }));

// library search + filters + sort
$('lib-search').addEventListener('input', (e) => { libFilter = e.target.value.trim().toLowerCase(); renderEditor(); });
$('lib-genre').addEventListener('change', (e) => { libGenre = e.target.value; renderEditor(); });
$('lib-vibe').addEventListener('change', (e) => { libVibe = e.target.value; renderEditor(); });
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
      toast(next === 'like' ? '♥ Liked — plays more often' : next === 'dislike' ? '⊘ Disliked — won\'t play again' : 'Rating cleared');
      if (next === 'dislike' && file === cur) skip(1);
      return next;
    });
}
function rate(kind) { const f = queue[queueIndex]; if (f) rateFile(f, kind); }
function updateRateButtons(file) {
  const r = ratingOf(file);
  $('like').classList.toggle('on', r === 'like');
  $('dislike').classList.toggle('on', r === 'dislike');
}

// ---- queue + history lists -------------------------------------------------
function renderQueue() {
  const ol = $('queue-list');
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
  if (!state.settings.followSchedule) return;
  const now = new Date();
  const dk = dayKey(now);
  const bk = currentBlock(now);
  if (!dk || !bk) return;
  const key = dk + '/' + bk;
  if (!force && key === currentBlockKey) return;
  currentBlockKey = key;
  const plName = (state.schedule[dk] && state.schedule[dk][bk]) || '';
  const block = state.blocks.find((b) => b.id === bk);
  $('now-block').textContent = block ? `${dk} · ${block.label}` : dk;
  if (plName && state.playlists[plName] && state.playlists[plName].length) {
    $('now-sub').textContent = 'Playlist: ' + plName;
    loadQueue(state.playlists[plName], true);
  } else {
    const any = Object.keys(state.playlists).some((n) => (state.playlists[n] || []).length);
    $('now-sub').textContent = any
      ? 'Nothing scheduled now — press Play or set one on the Schedule tab.'
      : 'No music yet — add tracks on the Library tab, then press Play.';
  }
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
  let html = '<thead><tr><th></th>';
  for (const b of state.blocks) html += `<th>${b.label}<br><small>${b.start}</small></th>`;
  html += '</tr></thead><tbody>';
  for (const d of state.days) {
    html += `<tr><th><span class="d-name">${d}</span> <button class="copy-row" data-day="${d}" title="Copy ${d} to every day" aria-label="Copy ${d} to every day">⎘</button></th>`;
    for (const b of state.blocks) {
      const sel = state.schedule[d][b.id] || '';
      let opts = `<option value="">—</option>`;
      for (const n of names) opts += `<option value="${n}"${n === sel ? ' selected' : ''}>${n}</option>`;
      html += `<td><select data-day="${d}" data-block="${b.id}">${opts}</select></td>`;
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

function renderEditor() {
  if (editing) {
    const tks = state.playlists[editing] || [];
    const total = tks.reduce((a, f) => a + durOf(f), 0);
    $('editing-name').textContent = editing + ' · ' + tks.length + ' track' + (tks.length === 1 ? '' : 's') + (total ? ' · ' + fmtTotal(total) : '');
  } else $('editing-name').textContent = 'Select a playlist';
  const plUl = $('pl-tracks');
  const libUl = $('lib-tracks');
  $('lib-count').textContent = library.length;
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
      up.addEventListener('click', () => { [tracks[i - 1], tracks[i]] = [tracks[i], tracks[i - 1]]; savePlaylists(); });
      const down = document.createElement('button');
      down.textContent = '↓'; down.className = 'mini'; down.title = 'Move down'; down.disabled = i === tracks.length - 1;
      down.addEventListener('click', () => { [tracks[i + 1], tracks[i]] = [tracks[i], tracks[i + 1]]; savePlaylists(); });
      const rm = document.createElement('button');
      rm.textContent = '−'; rm.className = 'del'; rm.title = 'Remove';
      rm.addEventListener('click', () => { tracks.splice(i, 1); savePlaylists(); });
      const dur = document.createElement('span'); dur.className = 'dur'; dur.textContent = fmtDur(durOf(file));
      li.append(name, dur, up, down, rm);
      plUl.appendChild(li);
    });
  }

  syncGenreOptions();
  const analysedCount = library.filter((t) => t.vibe).length;
  $('auto-vibe').disabled = !analysedCount;

  if (!library.length) { libUl.appendChild(emptyRow('No music yet — drop files above.')); return; }
  const vibeRank = { Chill: 0, Warm: 1, Upbeat: 2 };
  let shown = library.filter((t) =>
    (!libFilter || t.title.toLowerCase().includes(libFilter) || (t.genre || '').toLowerCase().includes(libFilter) || (t.artist || '').toLowerCase().includes(libFilter)) &&
    (!libGenre || t.genre === libGenre) &&
    (!libVibe || t.vibe === libVibe));
  shown = shown.slice().sort((a, b) => {
    if (libSort === 'vibe') return (vibeRank[a.vibe] ?? 9) - (vibeRank[b.vibe] ?? 9) || a.title.localeCompare(b.title);
    if (libSort === 'bpm') return (a.bpm || 999) - (b.bpm || 999) || a.title.localeCompare(b.title);
    if (libSort === 'genre') return (a.genre || '~').localeCompare(b.genre || '~') || a.title.localeCompare(b.title);
    if (libSort === 'duration') return (a.duration || 0) - (b.duration || 0) || a.title.localeCompare(b.title);
    return a.title.localeCompare(b.title);
  });
  if (!shown.length) { libUl.appendChild(emptyRow('No tracks match those filters.')); return; }
  shown.forEach((t) => {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'name'; name.textContent = t.title; name.title = t.artist ? t.artist + ' — click to preview' : 'Click to preview';
    name.addEventListener('click', () => preview(t.file));
    if (t.genre || t.vibe) {
      const tags = document.createElement('span');
      tags.className = 'tags';
      if (t.vibe) { const v = document.createElement('span'); v.className = 'tag vibe-' + t.vibe.toLowerCase(); v.textContent = t.vibe; tags.appendChild(v); }
      if (t.genre) { const g = document.createElement('span'); g.className = 'tag tag-genre'; g.textContent = t.genre; tags.appendChild(g); }
      name.appendChild(tags);
    }
    const like = document.createElement('button');
    like.textContent = '♥'; like.title = 'Like — play more often';
    like.className = ratingOf(t.file) === 'like' ? 'liked' : '';
    like.addEventListener('click', () => rateFile(t.file, 'like'));
    const dislike = document.createElement('button');
    dislike.textContent = '⊘'; dislike.title = 'Dislike — never play (ban)';
    dislike.className = ratingOf(t.file) === 'dislike' ? 'disliked' : '';
    dislike.addEventListener('click', () => rateFile(t.file, 'dislike'));
    const add = document.createElement('button');
    add.textContent = '+'; add.disabled = !editing; add.title = editing ? 'Add to ' + editing : 'Select a playlist first';
    add.addEventListener('click', () => { if (!editing) return; if (!state.playlists[editing].includes(t.file)) state.playlists[editing].push(t.file); savePlaylists(); });
    const del = document.createElement('button');
    del.textContent = '🗑'; del.className = 'del'; del.title = 'Delete from library';
    del.addEventListener('click', () => {
      if (!confirm('Delete "' + t.title + '" from the library?')) return;
      fetch('/api/track?name=' + encodeURIComponent(t.file), { method: 'DELETE' }).then((r) => r.json()).then(() => reloadLibrary());
    });
    const dur = document.createElement('span'); dur.className = 'dur'; dur.textContent = fmtDur(t.duration);
    li.append(name, dur, like, dislike, add, del);
    libUl.appendChild(li);
  });
}

function reloadLibrary() {
  return api('/api/library').then((lib) => { library = lib.tracks; renderEditor(); renderQueue(); renderHistory(); updateOnboard(); });
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
// POST the result so the server can bucket it into a Chill / Warm / Upbeat vibe.
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

// Group every analysed track into Chill / Warm / Upbeat playlists in one click.
function buildVibePlaylists() {
  const analysed = library.filter((t) => t.vibe);
  if (!analysed.length) { toast('Run “✨ Analyse audio” first'); return; }
  const buckets = { Chill: [], Warm: [], Upbeat: [] };
  analysed.forEach((t) => { if (buckets[t.vibe]) buckets[t.vibe].push(t.file); });
  let made = 0;
  for (const v of ['Chill', 'Warm', 'Upbeat']) { if (buckets[v].length) { state.playlists[v] = buckets[v]; made++; } }
  if (!made) { toast('Nothing to group yet'); return; }
  savePlaylists();
  toast(`Built ${made} vibe playlist${made === 1 ? '' : 's'}`);
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
  // keep schedule assignments pointing at the renamed playlist
  for (const d of state.days) for (const b of state.blocks) if (state.schedule[d][b.id] === name) state.schedule[d][b.id] = nn;
  if (editing === name) editing = nn;
  api('/api/schedule', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ schedule: state.schedule }) })
    .then(() => savePlaylists());
  toast('Renamed to "' + nn + '"');
}

function savePlaylists() {
  api('/api/playlists', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ playlists: state.playlists }) })
    .then((res) => {
      if (res.schedule) state.schedule = res.schedule;
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
  input.addEventListener('change', () => uploadFiles(input.files));
  ['dragenter', 'dragover'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove('drag'); }));
  zone.addEventListener('drop', (e) => { if (e.dataTransfer && e.dataTransfer.files) uploadFiles(e.dataTransfer.files); });
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
    $('admin-pass').value = ''; $('lock').classList.remove('on');
  };
  const showUnlocked = () => {
    adminUnlocked = true;
    $('admin-lock').hidden = true; $('admin-content').hidden = false;
    $('lock').classList.add('on'); refreshAhPlaylists();
  };
  const tryUnlock = () => {
    const password = $('admin-pass').value;
    fetch('/api/afterhours/unlock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) })
      .then((r) => r.json()).then((d) => { if (d.ok) { adminPass = password; showUnlocked(); } else alert('Wrong password.'); });
  };

  $('lock').addEventListener('click', () => {
    document.querySelector('.tab[data-tab="admin"]').click();
    if (!adminUnlocked) setTimeout(() => $('admin-pass').focus(), 60);
  });
  $('admin-unlock').addEventListener('click', tryUnlock);
  $('admin-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') tryUnlock(); });
  $('admin-relock').addEventListener('click', showLocked);

  $('ah-play').addEventListener('click', () => {
    const name = $('ah-playlist').value;
    if (!name || !state.playlists[name] || !state.playlists[name].length) return alert('That playlist is empty.');
    $('follow').checked = false; saveSettings({ followSchedule: false });
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

  userVolume = state.settings.volume ?? 0.8;
  if (userVolume > 0) preMuteVol = userVolume;
  decks.forEach((d) => { d.volume = userVolume; });
  $('volume').value = userVolume;
  updateMuteIcon();
  $('follow').checked = !!state.settings.followSchedule;
  $('shuffle').checked = state.settings.shuffle !== false;
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
  applySchedule(true);
  loadStreamInfo();
  setupUpload();
  $('analyze-btn').addEventListener('click', analyzeLibrary);
  $('auto-vibe').addEventListener('click', buildVibePlaylists);
  setupVenuePlayer();
  setupAdmin();
  refreshAhPlaylists();
}
boot();
