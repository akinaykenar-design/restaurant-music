'use strict';

// ---- state -----------------------------------------------------------------
let state = { blocks: [], days: [], schedule: {}, playlists: {}, ratings: {}, settings: {} };
let library = [];
let editing = null;

let queue = [];          // filenames in play order
let queueIndex = 0;
let history = [];         // recently played (newest first)
let currentBlockKey = null;

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
  if (p) p.classList.toggle('playing', on);
  const b = $('playpause');
  b.querySelector('.ic-play').hidden = on;
  b.querySelector('.ic-pause').hidden = !on;
}

function onTrackChanged(file) {
  $('now-title').textContent = titleOf(file);
  updateRateButtons(file);
  pushHistory(file);
  renderQueue();
  setPlayingUI(!activeDeck().paused);
}

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

function startTrack(i, autoplay) {
  if (i < 0 || i >= queue.length) return;
  queueIndex = i;
  crossing = false;
  const d = activeDeck();
  d.src = '/audio/' + encodeURIComponent(queue[i]);
  d.volume = userVolume;
  if (autoplay !== false) d.play().catch(() => {});
  onTrackChanged(queue[i]);
}

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
    if (idx !== active || crossing) return;
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

$('volume').addEventListener('input', (e) => { userVolume = Number(e.target.value); if (!crossing) activeDeck().volume = userVolume; });
$('volume').addEventListener('change', () => saveSettings({ volume: userVolume }));

$('follow').addEventListener('change', (e) => { saveSettings({ followSchedule: e.target.checked }); if (e.target.checked) applySchedule(true); });
$('shuffle').addEventListener('change', (e) => { state.settings.shuffle = e.target.checked; saveSettings({ shuffle: e.target.checked }); });
$('crossfade').addEventListener('input', (e) => { state.settings.crossfade = Number(e.target.value); $('cf-val').textContent = e.target.value + 's'; });
$('crossfade').addEventListener('change', (e) => saveSettings({ crossfade: Number(e.target.value) }));

function rate(kind) {
  const file = queue[queueIndex];
  if (!file) return;
  const next = ratingOf(file) === kind ? 'none' : kind;
  fetch('/api/rate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file, rating: next }) })
    .then((r) => r.json())
    .then((d) => {
      state.ratings = d.ratings || {};
      updateRateButtons(file);
      renderQueue();
      if (next === 'dislike') skip(1);
    });
}
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

// ---- schedule tab ----------------------------------------------------------
function renderSchedule() {
  const table = $('schedule-table');
  const names = Object.keys(state.playlists);
  let html = '<thead><tr><th></th>';
  for (const b of state.blocks) html += `<th>${b.label}<br><small>${b.start}</small></th>`;
  html += '</tr></thead><tbody>';
  for (const d of state.days) {
    html += `<tr><th>${d}</th>`;
    for (const b of state.blocks) {
      const sel = state.schedule[d][b.id] || '';
      let opts = `<option value="">—</option>`;
      for (const n of names) opts += `<option value="${n}"${n === sel ? ' selected' : ''}>${n}</option>`;
      html += `<td><select data-day="${d}" data-block="${b.id}">${opts}</select></td>`;
    }
    html += '</tr>';
  }
  table.innerHTML = html + '</tbody>';
  table.querySelectorAll('select').forEach((sel) => {
    sel.addEventListener('change', () => {
      state.schedule[sel.dataset.day][sel.dataset.block] = sel.value;
      api('/api/schedule', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ schedule: state.schedule }) })
        .then(() => applySchedule(true));
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
    span.textContent = name;
    span.addEventListener('click', () => { editing = name; renderPlaylistNames(); renderEditor(); });
    const del = document.createElement('button');
    del.textContent = '✕'; del.className = 'del'; del.title = 'Delete playlist';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!confirm('Delete playlist "' + name + '"?')) return;
      delete state.playlists[name];
      if (editing === name) editing = null;
      savePlaylists();
    });
    li.append(span, del);
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
      const rm = document.createElement('button');
      rm.textContent = '−'; rm.className = 'del'; rm.title = 'Remove';
      rm.addEventListener('click', () => { tracks.splice(i, 1); savePlaylists(); });
      li.append(name, rm);
      plUl.appendChild(li);
    });
  }

  if (!library.length) { libUl.appendChild(emptyRow('No music yet — drop files above.')); return; }
  library.forEach((t) => {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'name'; name.textContent = t.title; name.title = 'Click to preview';
    name.addEventListener('click', () => preview(t.file));
    const add = document.createElement('button');
    add.textContent = '+'; add.disabled = !editing; add.title = editing ? 'Add to ' + editing : 'Select a playlist first';
    add.addEventListener('click', () => { if (!editing) return; state.playlists[editing].push(t.file); savePlaylists(); });
    const del = document.createElement('button');
    del.textContent = '🗑'; del.className = 'del'; del.title = 'Delete from library';
    del.addEventListener('click', () => {
      if (!confirm('Delete "' + t.title + '" from the library?')) return;
      fetch('/api/track?name=' + encodeURIComponent(t.file), { method: 'DELETE' }).then((r) => r.json()).then(() => reloadLibrary());
    });
    li.append(name, add, del);
    libUl.appendChild(li);
  });
}

function reloadLibrary() {
  return api('/api/library').then((lib) => { library = lib.tracks; renderEditor(); renderQueue(); renderHistory(); });
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
function setupAfterHours() {
  $('lock').addEventListener('click', () => {
    const card = $('ah-card');
    card.hidden = !card.hidden;
    if (!card.hidden) { card.scrollIntoView({ behavior: 'smooth', block: 'center' }); $('ah-pass').focus(); }
  });
  $('ah-unlock').addEventListener('click', () => {
    const password = $('ah-pass').value;
    fetch('/api/afterhours/unlock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) })
      .then((r) => r.json()).then((d) => {
        if (d.ok) { $('ah-locked').hidden = true; $('ah-unlocked').hidden = false; $('lock').classList.add('on'); refreshAhPlaylists(); }
        else alert('Wrong password.');
      });
  });
  $('ah-play').addEventListener('click', () => {
    const name = $('ah-playlist').value;
    if (!name || !state.playlists[name] || !state.playlists[name].length) return alert('That playlist is empty.');
    $('follow').checked = false; saveSettings({ followSchedule: false });
    $('now-block').textContent = 'After hours'; $('now-sub').textContent = 'Staff: ' + name;
    loadQueue(state.playlists[name], true);
  });
  $('ah-relock').addEventListener('click', () => {
    $('ah-unlocked').hidden = true; $('ah-locked').hidden = false; $('ah-pass').value = '';
    $('lock').classList.remove('on'); $('ah-card').hidden = true;
  });
  $('ah-setpass').addEventListener('click', () => {
    const current = $('ah-pass').value, next = $('ah-newpass').value;
    if (!next) return alert('Enter a new password.');
    fetch('/api/afterhours/password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ current, next }) })
      .then((r) => r.json()).then((d) => { if (d.ok) { alert('Staff password updated.'); $('ah-pass').value = next; $('ah-newpass').value = ''; } else alert('Could not change password.'); });
  });
}

// ---- boot ------------------------------------------------------------------
async function boot() {
  const [st, lib] = await Promise.all([api('/api/state'), api('/api/library')]);
  state = st; library = lib.tracks;
  state.settings = state.settings || {};

  userVolume = state.settings.volume ?? 0.8;
  decks.forEach((d) => { d.volume = userVolume; });
  $('volume').value = userVolume;
  $('follow').checked = !!state.settings.followSchedule;
  $('shuffle').checked = state.settings.shuffle !== false;
  const cf = state.settings.crossfade ?? 4;
  $('crossfade').value = cf; $('cf-val').textContent = cf + 's';

  renderSchedule();
  renderPlaylistNames();
  renderEditor();
  renderQueue();
  renderHistory();
  applySchedule(true);
  loadStreamInfo();
  setupUpload();
  setupVenuePlayer();
  setupAfterHours();
  refreshAhPlaylists();
}
boot();
