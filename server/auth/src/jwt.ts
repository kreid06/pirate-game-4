import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import db from './db.js';

// ── Config ────────────────────────────────────────────────────────────────────
// JWT_SECRET must be set in the environment (shared with the game server for
// local verification). Minimum 32 bytes of entropy recommended.
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error('JWT_SECRET environment variable is required');

const ACCESS_TOKEN_TTL  = 15 * 60;       // 15 minutes (seconds)
const REFRESH_TOKEN_TTL = 7 * 24 * 3600; // 7 days (seconds)

// ── Types ─────────────────────────────────────────────────────────────────────
export interface AccessTokenPayload {
  player_id:    string;
  display_name: string;
  guest:        boolean;
}

// ── Access token ──────────────────────────────────────────────────────────────
export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: ACCESS_TOKEN_TTL,
  });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  return jwt.verify(token, JWT_SECRET) as AccessTokenPayload;
}

// ── Refresh token ─────────────────────────────────────────────────────────────

/** Issue a new opaque refresh token, store its hash in DB, return raw value. */
export function issueRefreshToken(
  player_id: string,
  display_name: string,
  is_guest: boolean,
): string {
  const raw = crypto.randomBytes(40).toString('hex');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  const expires_at = Math.floor(Date.now() / 1000) + REFRESH_TOKEN_TTL;

  db.prepare(`
    INSERT INTO refresh_tokens (token_hash, player_id, is_guest, display_name, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(hash, player_id, is_guest ? 1 : 0, display_name, expires_at);

  return raw;
}

export interface RefreshResult {
  access_token:  string;
  refresh_token: string; // rotated — old one is revoked
}

/**
 * Consume a refresh token (rotate) and return a fresh access + refresh pair.
 * Throws a string error message on any failure.
 */
export function consumeRefreshToken(raw: string): RefreshResult {
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  const now  = Math.floor(Date.now() / 1000);

  const row = db.prepare(`
    SELECT * FROM refresh_tokens WHERE token_hash = ? AND revoked = 0
  `).get(hash) as {
    id: number; player_id: string; is_guest: number;
    display_name: string; expires_at: number;
  } | undefined;

  if (!row)             throw 'invalid_token';
  if (row.expires_at < now) {
    // Revoke it anyway to clean up
    db.prepare('UPDATE refresh_tokens SET revoked = 1 WHERE id = ?').run(row.id);
    throw 'token_expired';
  }

  // Revoke old token (rotation — prevents replay)
  db.prepare('UPDATE refresh_tokens SET revoked = 1 WHERE id = ?').run(row.id);

  const is_guest = Boolean(row.is_guest);
  const payload: AccessTokenPayload = {
    player_id:    row.player_id,
    display_name: row.display_name,
    guest:        is_guest,
  };

  return {
    access_token:  signAccessToken(payload),
    refresh_token: issueRefreshToken(row.player_id, row.display_name, is_guest),
  };
}

/** Revoke all refresh tokens for a player (logout / account deletion). */
export function revokeAllTokens(player_id: string): void {
  db.prepare('UPDATE refresh_tokens SET revoked = 1 WHERE player_id = ?').run(player_id);
}

/** Purge expired/revoked tokens older than 30 days (call periodically). */
export function pruneTokens(): void {
  const cutoff = Math.floor(Date.now() / 1000) - 30 * 24 * 3600;
  db.prepare('DELETE FROM refresh_tokens WHERE revoked = 1 AND created_at < ?').run(cutoff);
}
