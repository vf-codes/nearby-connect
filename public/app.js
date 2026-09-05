const $ = sel => document.querySelector(sel);
let me = null;
let ws = null;
let activeConnectionId = null;
let activeOtherName = null;

// ---------- auth ----------
let authMode = 'login';
$('#tab-login').onclick = () => setAuthMode('login');
$('#tab-register').onclick = () => setAuthMode('register');
function setAuthMode(mode) {
  authMode = mode;
  $('#tab-login').classList.toggle('active', mode === 'login');
  $('#tab-register').classList.toggle('active', mode === 'register');
  $('#auth-submit').textContent = mode === 'login' ? 'Log in' : 'Sign up';
}

$('#form-auth').onsubmit = async e => {
  e.preventDefault();
  $('#auth-error').textContent = '';
  const username = $('#auth-username').value.trim();
  const password = $('#auth-password').value;
  const res = await fetch(`/api/${authMode}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  const data = await res.json();
  if (!res.ok) { $('#auth-error').textContent = data.error; return; }
  me = data;
  enterApp();
};

$('#btn-logout').onclick = async () => {
  await fetch('/api/logout', { method: 'POST' });
  location.reload();
};

// ---------- boot ----------
(async function boot() {
  const res = await fetch('/api/me');
  if (res.ok) { me = await res.json(); enterApp(); }
})();

function enterApp() {
  $('#screen-auth').classList.add('hidden');
  $('#screen-main').classList.remove('hidden');
  connectWS();
  startScan();
  loadConnections();
  showView('nearby');
}

$('#btn-refresh').onclick = startScan;

// ---------- nav ----------
$('#nav-nearby').onclick = () => showView('nearby');
$('#nav-connections').onclick = () => { showView('connections'); loadConnections(); };
$('#btn-back-chat').onclick = () => showView('connections');

function showView(view) {
  ['nearby', 'connections', 'chat'].forEach(v => {
    $(`#view-${v}`).classList.toggle('hidden', v !== view);
  });
  $('#nav-nearby').classList.toggle('active', view === 'nearby');
  $('#nav-connections').classList.toggle('active', view === 'connections');
}

// ---------- geolocation + nearby (scan on demand, not continuously) ----------
let scanTimer = null;
const MAX_SCAN_ATTEMPTS = 6;   // stops after ~30s if no one is found
const SCAN_INTERVAL_MS = 5000;

function startScan() {
  clearTimeout(scanTimer);
  const btn = $('#btn-refresh');
  btn.disabled = true;
  btn.textContent = 'Scanning…';
  btn.classList.add('scanning');
  $('#location-status').textContent = 'Scanning for people nearby…';
  $('#nearby-list').innerHTML = ''; // clear immediately — no stale "Try again" button lingering
  scanAttempt(0);
}

function stopScan() {
  const btn = $('#btn-refresh');
  btn.disabled = false;
  btn.textContent = '⟳';
  btn.classList.remove('scanning');
}

function scanAttempt(attempt) {
  if (!navigator.geolocation) {
    $('#location-status').textContent = 'Geolocation not supported on this device.';
    stopScan();
    return;
  }
  navigator.geolocation.getCurrentPosition(async pos => {
    await fetch('/api/location', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lat: pos.coords.latitude, lng: pos.coords.longitude })
    });
    const count = await loadNearby();
    if (count > 0 || attempt + 1 >= MAX_SCAN_ATTEMPTS) {
      stopScan();
      if (count === 0) showNoOneFound();
    } else {
      $('#location-status').textContent = `Scanning for people nearby… (${attempt + 2}/${MAX_SCAN_ATTEMPTS})`;
      scanTimer = setTimeout(() => scanAttempt(attempt + 1), SCAN_INTERVAL_MS);
    }
  }, () => {
    $('#location-status').textContent = 'Location permission denied — turn it on to see nearby people.';
    stopScan();
  }, { enableHighAccuracy: true, maximumAge: 10000, timeout: 10000 });
}

function showNoOneFound() {
  $('#location-status').textContent = 'No one nearby right now.';
  $('#nearby-list').innerHTML = `
    <li class="empty-state">
      <p class="muted">No one within 1km right now.</p>
      <button id="btn-retry-scan" class="small-btn">Try again</button>
    </li>`;
  $('#btn-retry-scan').onclick = startScan;
}

// Fetches and renders the current nearby list. Returns how many were found.
// Does NOT update location on the server — call startScan() for that.
async function loadNearby() {
  const res = await fetch('/api/nearby');
  if (!res.ok) return 0;
  const list = await res.json();
  const ul = $('#nearby-list');
  ul.innerHTML = '';
  if (list.length === 0) return 0;

  $('#location-status').textContent = `${list.length} people within 1km of you`;
  for (const u of list) {
    const li = document.createElement('li');
    li.className = 'person-row';
    let actionHtml;
    if (u.status === 'none') {
      actionHtml = `<button class="small-btn" data-connect="${u.id}">Connect</button>`;
    } else if (u.status === 'pending' && u.iRequested) {
      actionHtml = `<span class="status-pill">Requested</span>`;
    } else if (u.status === 'pending' && !u.iRequested) {
      actionHtml = `<span class="status-pill">Check Connections</span>`;
    } else if (u.status === 'accepted') {
      actionHtml = `<span class="status-pill accepted">Connected</span>`;
    } else {
      actionHtml = `<span class="status-pill">—</span>`;
    }
    li.innerHTML = `
      ${avatarHtml(u.username)}
      <div class="meta"><strong>${escapeHtml(u.username)}</strong><span class="dist">${u.distanceM} m away</span></div>
      ${actionHtml}
    `;
    ul.appendChild(li);
  }
  ul.querySelectorAll('[data-connect]').forEach(btn => {
    btn.onclick = async () => {
      await fetch(`/api/connect/${btn.dataset.connect}`, { method: 'POST' });
      loadNearby();
    };
  });
  return list.length;
}

// ---------- connections ----------
async function loadConnections() {
  const res = await fetch('/api/connections');
  if (!res.ok) return;
  const list = await res.json();
  const ul = $('#connections-list');
  ul.innerHTML = '';
  const incoming = list.filter(c => c.incoming);
  $('#badge-requests').classList.toggle('hidden', incoming.length === 0);
  $('#badge-requests').textContent = incoming.length;

  if (list.length === 0) {
    ul.innerHTML = '<li class="muted">No connections yet. Go find people nearby.</li>';
    return;
  }

  for (const c of list) {
    const li = document.createElement('li');
    li.className = 'person-row';
    let actionHtml;
    if (c.incoming) {
      actionHtml = `
        <div style="display:flex;gap:6px;">
          <button class="small-btn" data-accept="${c.id}">Accept</button>
          <button class="small-btn ghost" data-reject="${c.id}">Ignore</button>
        </div>`;
    } else if (c.status === 'accepted') {
      actionHtml = `<button class="small-btn" data-chat="${c.id}" data-name="${escapeHtml(c.otherUser)}">Chat</button>`;
    } else {
      actionHtml = `<span class="status-pill">${c.status}</span>`;
    }
    li.innerHTML = `${avatarHtml(c.otherUser)}<div class="meta"><strong>${escapeHtml(c.otherUser)}</strong></div>${actionHtml}`;
    ul.appendChild(li);
  }

  ul.querySelectorAll('[data-accept]').forEach(btn => btn.onclick = async () => {
    await respondConnection(btn.dataset.accept, 'accept');
  });
  ul.querySelectorAll('[data-reject]').forEach(btn => btn.onclick = async () => {
    await respondConnection(btn.dataset.reject, 'reject');
  });
  ul.querySelectorAll('[data-chat]').forEach(btn => btn.onclick = () => {
    openChat(btn.dataset.chat, btn.dataset.name);
  });
}

async function respondConnection(id, action) {
  await fetch(`/api/connect/${id}/respond`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action })
  });
  loadConnections();
}

// ---------- chat ----------
async function openChat(connectionId, otherName) {
  activeConnectionId = connectionId;
  activeOtherName = otherName;
  $('#chat-with').textContent = otherName;
  const avatarEl = $('#chat-avatar');
  avatarEl.textContent = initialsForName(otherName);
  avatarEl.style.background = colorForName(otherName);
  showView('chat');
  const res = await fetch(`/api/messages/${connectionId}`);
  const msgs = await res.json();
  const ul = $('#chat-messages');
  ul.innerHTML = '';
  msgs.forEach(renderMessage);
  ul.scrollTop = ul.scrollHeight;
}

function renderMessage(m) {
  const ul = $('#chat-messages');
  const li = document.createElement('li');
  li.className = 'msg' + (m.sender_id === me.id ? ' mine' : '');
  if (m.type === 'image') {
    li.innerHTML = `<img src="${m.content}" alt="shared image">`;
  } else {
    li.textContent = m.content;
  }
  ul.appendChild(li);
  ul.scrollTop = ul.scrollHeight;
}

$('#form-chat').onsubmit = async e => {
  e.preventDefault();
  const text = $('#chat-text').value.trim();
  if (!text || !activeConnectionId) return;
  $('#chat-text').value = '';
  const res = await fetch(`/api/messages/${activeConnectionId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: text })
  });
  const msg = await res.json();
  renderMessage(msg);
};

$('#chat-image').onchange = async e => {
  const file = e.target.files[0];
  if (!file || !activeConnectionId) return;
  const form = new FormData();
  form.append('image', file);
  const res = await fetch(`/api/messages/${activeConnectionId}/image`, { method: 'POST', body: form });
  const msg = await res.json();
  renderMessage(msg);
  e.target.value = '';
};

// ---------- websocket (live updates) ----------
async function connectWS() {
  const res = await fetch('/api/ws-token');
  if (!res.ok) return;
  const { token } = await res.json();
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws?token=${token}`);
  ws.onmessage = evt => {
    const data = JSON.parse(evt.data);
    if (data.type === 'message' && data.message.connection_id == activeConnectionId) {
      renderMessage(data.message);
    }
    if (data.type === 'connection_request' || data.type === 'connection_response') {
      loadConnections();
    }
  };
  ws.onclose = () => setTimeout(connectWS, 3000);
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

// ---------- avatars ----------
const AVATAR_COLORS = ['#ff6b81', '#ffa43d', '#4fc3f7', '#8b5cf6', '#17d9a3', '#f472b6'];
function colorForName(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}
function initialsForName(name) {
  return name.trim().slice(0, 1).toUpperCase();
}
function avatarHtml(name) {
  return `<span class="avatar" style="background:${colorForName(name)}">${initialsForName(name)}</span>`;
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
