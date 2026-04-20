import { Router, Request, Response } from 'express';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import db from '../db.js';
import {
  signAccessToken,
  issueRefreshToken,
  consumeRefreshToken,
  revokeAllTokens,
} from '../jwt.js';

const router = Router();
const BCRYPT_ROUNDS = 12;

// ── POST /auth/register ───────────────────────────────────────────────────────
// Body: { username, password }
// Returns: { access_token, refresh_token }
router.post('/register', async (req: Request, res: Response) => {
  const { username, password } = req.body ?? {};

  if (typeof username !== 'string' || username.trim().length < 3) {
    return res.status(400).json({ error: 'username_too_short' });
  }
  if (typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'password_too_short' });
  }

  // Sanitise username — alphanumeric + underscore/hyphen, max 24 chars
  const clean = username.trim().slice(0, 24);
  if (!/^[a-zA-Z0-9_-]+$/.test(clean)) {
    return res.status(400).json({ error: 'username_invalid_chars' });
  }

  const existing = db.prepare('SELECT id FROM accounts WHERE username = ?').get(clean);
  if (existing) return res.status(409).json({ error: 'username_taken' });

  const player_id    = crypto.randomUUID();
  const password_hash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  db.prepare(`
    INSERT INTO accounts (player_id, username, password_hash) VALUES (?, ?, ?)
  `).run(player_id, clean, password_hash);

  const access_token  = signAccessToken({ player_id, display_name: clean, guest: false });
  const refresh_token = issueRefreshToken(player_id, clean, false);

  return res.status(201).json({ access_token, refresh_token });
});

// ── POST /auth/login ──────────────────────────────────────────────────────────
// Body: { username, password }
// Returns: { access_token, refresh_token }
router.post('/login', async (req: Request, res: Response) => {
  const { username, password } = req.body ?? {};

  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'missing_fields' });
  }

  const row = db.prepare('SELECT * FROM accounts WHERE username = ?').get(username.trim()) as {
    player_id: string; username: string; password_hash: string;
  } | undefined;

  // Use constant-time compare for the not-found case to avoid user enumeration
  const hash = row?.password_hash ?? '$2b$12$invalidhashpadding000000000000000000000000000000000000';
  const match = await bcrypt.compare(password, hash);

  if (!row || !match) {
    return res.status(401).json({ error: 'invalid_credentials' });
  }

  // Revoke all old refresh tokens on login (single-session policy — adjust if needed)
  revokeAllTokens(row.player_id);

  const access_token  = signAccessToken({ player_id: row.player_id, display_name: row.username, guest: false });
  const refresh_token = issueRefreshToken(row.player_id, row.username, false);

  return res.json({ access_token, refresh_token });
});

// ── POST /auth/guest ──────────────────────────────────────────────────────────
// Body: { display_name? }   (optional; random pirate name assigned if omitted)
// Returns: { access_token, refresh_token }
const PIRATE_NAMES = [
  'Saltbeard', 'IronHook', 'StormEye', 'BlackWave', 'CopperClaw',
  'DriftKeel', 'FoulWind', 'GaleRider', 'HarbourGhost', 'JollyRot',
];

router.post('/guest', (req: Request, res: Response) => {
  const raw = req.body?.display_name;
  let display_name: string;

  if (typeof raw === 'string' && raw.trim().length >= 2) {
    display_name = raw.trim().slice(0, 24);
    if (!/^[a-zA-Z0-9_\- ]+$/.test(display_name)) {
      display_name = PIRATE_NAMES[Math.floor(Math.random() * PIRATE_NAMES.length)];
    }
  } else {
    const suffix = Math.floor(Math.random() * 9000) + 1000;
    display_name = `${PIRATE_NAMES[Math.floor(Math.random() * PIRATE_NAMES.length)]}${suffix}`;
  }

  const player_id = crypto.randomUUID();

  const access_token  = signAccessToken({ player_id, display_name, guest: true });
  const refresh_token = issueRefreshToken(player_id, display_name, true);

  return res.status(201).json({ access_token, refresh_token, display_name });
});

// ── POST /auth/refresh ────────────────────────────────────────────────────────
// Body: { refresh_token }
// Returns: { access_token, refresh_token }  (old refresh_token is revoked)
router.post('/refresh', (req: Request, res: Response) => {
  const { refresh_token } = req.body ?? {};

  if (typeof refresh_token !== 'string' || !refresh_token) {
    return res.status(400).json({ error: 'missing_token' });
  }

  try {
    const result = consumeRefreshToken(refresh_token);
    return res.json(result);
  } catch (err) {
    return res.status(401).json({ error: err });
  }
});

// ── POST /auth/logout ─────────────────────────────────────────────────────────
// Body: { refresh_token }
router.post('/logout', (req: Request, res: Response) => {
  const { refresh_token } = req.body ?? {};
  if (typeof refresh_token !== 'string') {
    return res.status(400).json({ error: 'missing_token' });
  }

  // We don't need to verify the token to revoke it —
  // just hash it and mark as revoked if it exists.
  const hash = crypto.createHash('sha256').update(refresh_token).digest('hex');
  db.prepare('UPDATE refresh_tokens SET revoked = 1 WHERE token_hash = ?').run(hash);

  return res.json({ ok: true });
});

export default router;
