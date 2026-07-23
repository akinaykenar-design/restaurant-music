'use strict';

// ---- state -----------------------------------------------------------------

let state = { blocks: [], days: [], schedule: {}, playlists: {}, settings: {} };
let library = [];
let editing = null; // playlist name being edited

let queue = []; // array of track filenames
let queueIndex = 0;
let currentBlockKey = null; // `${day}/${blockId}` currently loaded

const player = document.getElementById('player');

// ---- helpers ---------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const api = (url, opts) => fetch(url, opts).then((r) => r.json());
const titleOf = (file) => {
  const t = library.find((x) => x.file === file);
  return t ? t.title : file.replace(/\.[^.]+$/, '');
};

function dayKey(d) {
  // JS getDay(): 0=Sun..6=Sat  ->  our days array is Mon..Sun
  const map = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return map[d.getDay()];
}

// Which block is active right now, given HH:MM start times.
function currentBlock(now) {
  const mins = now.getHours() * 60 + now.getMinutes();
  const parsed = state.blocks
    .map((b) => {
      const [h, m] = b.start.split(':').map(Number);
      return { id: b.id, at: h * 60 + m };
    })
    .sort((a, b) => a.at - b.at);
  let active = parsed[parsed.length - 1]; // wraps past midnight
  for (const b of parsed) {
    if (mins >= b.at) active = b;
  }
  return active ? active.id : null;
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

// ---- now playing -----------------------------------------------------------

function loadQueue(files, autoplay) {
  queue = files.slice();
  queueIndex = 0;
  if (queue.length) {
    playIndex(0, autoplay);
  } else {
    player.removeAttribute('src');
    $('now-title').textContent = 'Nothing playing';
    $('now-sub').textContent = 'This playlist is empty';
  }
  renderQueue();
}

function playIndex(i, autoplay) {
  if (i < 0 || i >= queue.length) return;
  queueIndex = i;
  const file = queue[i];
  player.src = '/audio/' + encodeURIComponent(file);
  $('now-title').textContent = titleOf(file);
  if (autoplay !== false) player.play().catch(() => {});
  renderQueue();
}

player.addEventListener('ended', () => {
  if (queueIndex + 1 < queue.length) playIndex(queueIndex + 1);
  else if (queue.length) playIndex(0); // loop the block's playlist
});

player.addEventListener('play', () => ($('playpause').textContent = '⏸'));
player.addEventListener('pause', () => ($('playpause').textContent = '▶'));

$('playpause').addEventListener('click', () => {
  if (!player.src) return;
  if (player.paused) player.play().catch(() => {});
  else player.pause();
});
$('next').addEventListener('click', () => queue.length && playIndex((queueIndex + 1) % queue.length));
$('prev').addEventListener('click', () => queue.length && playIndex((queueIndex - 1 + queue.length) % queue.length));

$('volume').addEventListener('input', (e) => {
  player.volume = Number(e.target.value);
});
$('volume').addEventListener('change', (e) => {
  saveSettings({ volume: Number(e.target.value) });
});

$('follow').addEventListener('change', (e) => {
  saveSettings({ followSchedule: e.target.checked });
  if (e.target.checked) applySchedule(true);
});

function renderQueue() {
  const ol = $('queue-list');
  ol.innerHTML = '';
  queue.forEach((file, i) => {
    const li = document.createElement('li');
    li.textContent = titleOf(file);
    if (i === queueIndex) li.className = 'current';
    li.addEventListener('click', () => playIndex(i));
    ol.appendChild(li);
  });
}

// Apply the scheduled playlist for the current time block.
function applySchedule(force) {
  if (!state.settings.followSchedule) return;
  const now = new Date();
  const dk = dayKey(now);
  const bk = currentBlock(now);
  if (!dk || !bk) return;
  const key = dk + '/' + bk;
  if (!force && key === currentBlockKey) return;

  const plName = (state.schedule[dk] && state.schedule[dk][bk]) || '';
  const block = state.blocks.find((b) => b.id === bk);
  $('now-block').textContent = block ? `${dk} · ${block.label}` : dk;

  if (plName && state.playlists[plName]) {
    currentBlockKey = key;
    $('now-sub').textContent = 'Playlist: ' + plName;
    loadQueue(state.playlists[plName], true);
  } else {
    currentBlockKey = key;
    $('now-sub').textContent = 'No playlist scheduled for this block';
  }
}

// Check every 30s whether the block changed.
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
  html += '</tbody>';
  table.innerHTML = html;

  table.querySelectorAll('select').forEach((sel) => {
    sel.addEventListener('change', () => {
      state.schedule[sel.dataset.day][sel.dataset.block] = sel.value;
      api('/api/schedule', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schedule: state.schedule }),
      }).then(() => applySchedule(true));
    });
  });
}

// ---- playlists tab ---------------------------------------------------------

function renderPlaylistNames() {
  const ul = $('playlist-names');
  ul.innerHTML = '';
  Object.keys(state.playlists).forEach((name) => {
    const li = document.createElement('li');
    li.className = name === editing ? 'active' : '';
    const span = document.createElement('span');
    span.textContent = name;
    span.addEventListener('click', () => {
      editing = name;
      renderPlaylistNames();
      renderEditor();
    });
    const del = document.createElement('button');
    del.textContent = '✕';
    del.className = 'del';
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
  $('editing-name').textContent = editing ? editing : 'Select a playlist';
  const plUl = $('pl-tracks');
  const libUl = $('lib-tracks');
  $('lib-count').textContent = library.length;
  plUl.innerHTML = '';
  libUl.innerHTML = '';
  if (!editing) return;

  const tracks = state.playlists[editing] || [];
  tracks.forEach((file, i) => {
    const li = document.createElement('li');
    li.textContent = titleOf(file);
    const btn = document.createElement('button');
    btn.textContent = '−';
    btn.className = 'del';
    btn.addEventListener('click', () => {
      tracks.splice(i, 1);
      savePlaylists();
    });
    li.appendChild(btn);
    plUl.appendChild(li);
  });

  library.forEach((t) => {
    const li = document.createElement('li');
    li.textContent = t.title;
    const btn = document.createElement('button');
    btn.textContent = '+';
    btn.addEventListener('click', () => {
      state.playlists[editing].push(t.file);
      savePlaylists();
    });
    li.appendChild(btn);
    libUl.appendChild(li);
  });
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
  api('/api/playlists', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playlists: state.playlists }),
  }).then((res) => {
    if (res.schedule) state.schedule = res.schedule;
    renderPlaylistNames();
    renderEditor();
    renderSchedule();
  });
}

function saveSettings(patch) {
  Object.assign(state.settings, patch);
  api('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

// ---- boot ------------------------------------------------------------------

async function boot() {
  const [st, lib] = await Promise.all([api('/api/state'), api('/api/library')]);
  state = st;
  library = lib.tracks;

  player.volume = state.settings.volume ?? 0.8;
  $('volume').value = player.volume;
  $('follow').checked = !!state.settings.followSchedule;

  renderSchedule();
  renderPlaylistNames();
  renderEditor();
  applySchedule(true);
}

boot();
