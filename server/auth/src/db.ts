import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.AUTH_DB_PATH ?? path.join(__dirname, '../../data/auth/auth.db');

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id   TEXT    NOT NULL UNIQUE,   -- UUID, stable across all sessions
    username    TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT  NOT NULL,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS refresh_tokens (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash  TEXT    NOT NULL UNIQUE,   -- SHA-256 of the raw token
    player_id   TEXT    NOT NULL,
    is_guest    INTEGER NOT NULL DEFAULT 0,
    display_name TEXT   NOT NULL DEFAULT '',
    expires_at  INTEGER NOT NULL,          -- unix seconds
    created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    revoked     INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_refresh_player ON refresh_tokens (player_id);
  CREATE INDEX IF NOT EXISTS idx_refresh_token  ON refresh_tokens (token_hash);
`);

export default db;
