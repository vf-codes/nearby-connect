const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { WebSocketServer } = require('ws');
const db = require('./db');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-this-in-production';
const RADIUS_KM = 1;
const ONLINE_WINDOW_MS = 5 * 60 * 1000; // consider "nearby" only if seen in last 5 min

app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- uploads ----------
const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).slice(0, 10);
      cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
    }
  }),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('Images only'));
    cb(null, true);
  }
});

// ---------- auth helpers ----------
function auth(req, res, next) {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: 'Not logged in' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired session' });
  }
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

// ---------- auth routes ----------
app.post('/api/register', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password || password.length < 6) {
    return res.status(400).json({ error: 'Username and a password of 6+ chars are required' });
  }
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (exists) return res.status(409).json({ error: 'Username already taken' });

  const hash = bcrypt.hashSync(password, 10);
  const info = db.prepare(
    'INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)'
  ).run(username, hash, Date.now());

  const token = jwt.sign({ id: info.lastInsertRowid, username }, JWT_SECRET, { expiresIn: '30d' });
  res.cookie('token', token, { httpOnly: true, sameSite: 'lax' });
  res.json({ id: info.lastInsertRowid, username });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
  res.cookie('token', token, { httpOnly: true, sameSite: 'lax' });
  res.json({ id: user.id, username: user.username });
});

// Logging out permanently deletes this user's connections (and the chat
// history that goes with them) for both sides. This is destructive and
// cannot be undone — the other person's messages with this user disappear
// too, not just this user's view of them.
app.post('/api/logout', auth, (req, res) => {
  const userId = req.user.id;
  const conns = db.prepare(
    'SELECT id FROM connections WHERE requester_id = ? OR target_id = ?'
  ).all(userId, userId);

  if (conns.length > 0) {
    const ids = conns.map(c => c.id);
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`DELETE FROM messages WHERE connection_id IN (${placeholders})`).run(...ids);
    db.prepare(`DELETE FROM connections WHERE id IN (${placeholders})`).run(...ids);
  }

  res.clearCookie('token');
  res.json({ ok: true, deletedConnections: conns.length });
});

app.get('/api/me', auth, (req, res) => res.json(req.user));

// Returns the same JWT for use in the WebSocket handshake only.
// Safe because it requires the httpOnly auth cookie to already be valid.
app.get('/api/ws-token', auth, (req, res) => res.json({ token: req.cookies.token }));

// ---------- location + nearby ----------
app.post('/api/location', auth, (req, res) => {
  const { lat, lng } = req.body || {};
  if (typeof lat !== 'number' || typeof lng !== 'number') {
    return res.status(400).json({ error: 'lat and lng must be numbers' });
  }
  db.prepare('UPDATE users SET lat = ?, lng = ?, last_seen = ? WHERE id = ?')
    .run(lat, lng, Date.now(), req.user.id);
  res.json({ ok: true });
});

app.get('/api/nearby', auth, (req, res) => {
  const me = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (me.lat == null || me.lng == null) {
    return res.status(400).json({ error: 'Share your location first' });
  }
  const cutoff = Date.now() - ONLINE_WINDOW_MS;
  const others = db.prepare(
    'SELECT id, username, lat, lng FROM users WHERE id != ? AND lat IS NOT NULL AND last_seen > ?'
  ).all(req.user.id, cutoff);

  const existing = db.prepare(
    `SELECT * FROM connections WHERE requester_id = ? OR target_id = ?`
  ).all(req.user.id, req.user.id);

  const nearby = others
    .map(u => ({ ...u, distanceKm: haversineKm(me.lat, me.lng, u.lat, u.lng) }))
    .filter(u => u.distanceKm <= RADIUS_KM)
    .map(u => {
      const conn = existing.find(c => c.requester_id === u.id || c.target_id === u.id);
      return {
        id: u.id,
        username: u.username,
        distanceM: Math.round(u.distanceKm * 1000),
        status: conn ? conn.status : 'none',
        connectionId: conn ? conn.id : null,
        iRequested: conn ? conn.requester_id === req.user.id : null
      };
    })
    .sort((a, b) => a.distanceM - b.distanceM);

  res.json(nearby);
});

// ---------- connections ----------
app.post('/api/connect/:userId', auth, (req, res) => {
  const targetId = Number(req.params.userId);
  if (targetId === req.user.id) return res.status(400).json({ error: "Can't connect to yourself" });
  const target = db.prepare('SELECT id FROM users WHERE id = ?').get(targetId);
  if (!target) return res.status(404).json({ error: 'User not found' });

  try {
    const info = db.prepare(
      'INSERT INTO connections (requester_id, target_id, status, created_at) VALUES (?, ?, ?, ?)'
    ).run(req.user.id, targetId, 'pending', Date.now());
    notifyUser(targetId, { type: 'connection_request', from: req.user.username });
    res.json({ id: info.lastInsertRowid, status: 'pending' });
  } catch {
    res.status(409).json({ error: 'A connection already exists with this user' });
  }
});

app.post('/api/connect/:connectionId/respond', auth, (req, res) => {
  const { action } = req.body || {}; // 'accept' | 'reject'
  const conn = db.prepare('SELECT * FROM connections WHERE id = ?').get(req.params.connectionId);
  if (!conn || conn.target_id !== req.user.id) return res.status(404).json({ error: 'Request not found' });
  if (!['accept', 'reject'].includes(action)) return res.status(400).json({ error: 'Invalid action' });

  const status = action === 'accept' ? 'accepted' : 'rejected';
  db.prepare('UPDATE connections SET status = ? WHERE id = ?').run(status, conn.id);

  if (status === 'accepted') {
    // sender_id 0 marks this as a system message, not from either real user.
    db.prepare(
      'INSERT INTO messages (connection_id, sender_id, type, content, created_at) VALUES (?, 0, ?, ?, ?)'
    ).run(conn.id, 'system', 'connected', Date.now());
  }

  notifyUser(conn.requester_id, { type: 'connection_response', status, connectionId: conn.id });
  res.json({ status });
});

app.get('/api/connections', auth, (req, res) => {
  const rows = db.prepare(`
    SELECT c.*, 
      u1.username AS requester_name, u2.username AS target_name
    FROM connections c
    JOIN users u1 ON u1.id = c.requester_id
    JOIN users u2 ON u2.id = c.target_id
    WHERE c.requester_id = ? OR c.target_id = ?
    ORDER BY c.created_at DESC
  `).all(req.user.id, req.user.id);

  res.json(rows.map(r => ({
    id: r.id,
    status: r.status,
    otherUser: r.requester_id === req.user.id ? r.target_name : r.requester_name,
    incoming: r.target_id === req.user.id && r.status === 'pending'
  })));
});

// ---------- chat ----------
function assertParticipant(connectionId, userId) {
  const conn = db.prepare('SELECT * FROM connections WHERE id = ? AND status = ?').get(connectionId, 'accepted');
  if (!conn) return null;
  if (conn.requester_id !== userId && conn.target_id !== userId) return null;
  return conn;
}

app.get('/api/messages/:connectionId', auth, (req, res) => {
  const conn = assertParticipant(req.params.connectionId, req.user.id);
  if (!conn) return res.status(403).json({ error: 'Not part of this connection' });
  const msgs = db.prepare(
    'SELECT * FROM messages WHERE connection_id = ? ORDER BY created_at ASC'
  ).all(conn.id);
  res.json(msgs);
});

app.post('/api/messages/:connectionId', auth, (req, res) => {
  const conn = assertParticipant(req.params.connectionId, req.user.id);
  if (!conn) return res.status(403).json({ error: 'Not part of this connection' });
  const { content } = req.body || {};
  if (!content || !content.trim()) return res.status(400).json({ error: 'Message is empty' });

  const info = db.prepare(
    'INSERT INTO messages (connection_id, sender_id, type, content, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(conn.id, req.user.id, 'text', content.trim(), Date.now());

  const msg = { id: info.lastInsertRowid, connection_id: conn.id, sender_id: req.user.id, type: 'text', content, created_at: Date.now() };
  const otherId = conn.requester_id === req.user.id ? conn.target_id : conn.requester_id;
  notifyUser(otherId, { type: 'message', message: msg });
  res.json(msg);
});

app.post('/api/messages/:connectionId/image', auth, upload.single('image'), (req, res) => {
  const conn = assertParticipant(req.params.connectionId, req.user.id);
  if (!conn) return res.status(403).json({ error: 'Not part of this connection' });
  if (!req.file) return res.status(400).json({ error: 'No image uploaded' });

  const content = `/uploads/${req.file.filename}`;
  const info = db.prepare(
    'INSERT INTO messages (connection_id, sender_id, type, content, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(conn.id, req.user.id, 'image', content, Date.now());

  const msg = { id: info.lastInsertRowid, connection_id: conn.id, sender_id: req.user.id, type: 'image', content, created_at: Date.now() };
  const otherId = conn.requester_id === req.user.id ? conn.target_id : conn.requester_id;
  notifyUser(otherId, { type: 'message', message: msg });
  res.json(msg);
});

// ---------- websocket (real-time push) ----------
const wss = new WebSocketServer({ noServer: true });
const sockets = new Map(); // userId -> Set of ws

function notifyUser(userId, payload) {
  const set = sockets.get(userId);
  if (!set) return;
  const data = JSON.stringify(payload);
  for (const ws of set) {
    if (ws.readyState === 1) ws.send(data);
  }
}

server.on('upgrade', (req, socket, head) => {
  if (!req.url.startsWith('/ws')) return socket.destroy();
  const token = new URLSearchParams(req.url.split('?')[1]).get('token');
  try {
    const user = jwt.verify(token, JWT_SECRET);
    wss.handleUpgrade(req, socket, head, ws => {
      ws.userId = user.id;
      if (!sockets.has(user.id)) sockets.set(user.id, new Set());
      sockets.get(user.id).add(ws);
      ws.on('close', () => sockets.get(user.id)?.delete(ws));
    });
  } catch {
    socket.destroy();
  }
});

server.listen(PORT, () => console.log(`nearby-connect running on http://localhost:${PORT}`));
