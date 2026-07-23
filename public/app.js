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

// library search
$('lib-search').addEventListener('input', (e) => { libFilter = e.target.value.trim().toLowerCase(); renderEditor(); });

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
  $('editing-name').textContent = editing || 'Select a playlist';
  const plUl = $('pl-tracks');
  const libUl = $('lib-tracks');
  $('lib-count').textContent = library.length;
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
      li.append(name, up, down, rm);
      plUl.appendChild(li);
    });
  }

  if (!library.length) { libUl.appendChild(emptyRow('No music yet — drop files above.')); return; }
  const shown = library.filter((t) => !libFilter || t.title.toLowerCase().includes(libFilter));
  if (!shown.length) { libUl.appendChild(emptyRow('No matches for "' + libFilter + '".')); return; }
  shown.forEach((t) => {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'name'; name.textContent = t.title; name.title = 'Click to preview';
    name.addEventListener('click', () => preview(t.file));
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
    li.append(name, like, dislike, add, del);
    libUl.appendChild(li);
  });
}

function reloadLibrary() {
  return api('/api/library').then((lib) => { library = lib.tracks; renderEditor(); renderQueue(); renderHistory(); updateOnboard(); });
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
  setupVenuePlayer();
  setupAdmin();
  refreshAhPlaylists();
}
boot();
