// Uses Node's built-in sqlite module (no native compilation required —
// this is what makes it work on Termux/Android without a build toolchain).
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const db = new DatabaseSync(path.join(__dirname, 'data.sqlite'));
db.exec('PRAGMA journal_mode = WAL;');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    lat REAL,
    lng REAL,
    last_seen INTEGER,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS connections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    requester_id INTEGER NOT NULL,
    target_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', -- pending | accepted | rejected
    created_at INTEGER NOT NULL,
    UNIQUE(requester_id, target_id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    connection_id INTEGER NOT NULL,
    sender_id INTEGER NOT NULL,
    type TEXT NOT NULL DEFAULT 'text', -- text | image
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`);

module.exports = db;
