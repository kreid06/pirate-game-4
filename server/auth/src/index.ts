import express from 'express';
import { pruneTokens } from './jwt.js';
import authRouter from './routes/auth.js';

const app  = express();
const PORT = Number(process.env.AUTH_PORT ?? 3001);

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '16kb' }));

// Basic rate-limiting via a simple in-memory counter (no Redis dependency).
// For production, swap this out for the 'express-rate-limit' package.
const requestCounts = new Map<string, { count: number; resetAt: number }>();
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT     = 20; // requests per minute per IP

app.use((req, res, next) => {
  const ip  = req.ip ?? 'unknown';
  const now = Date.now();
  const entry = requestCounts.get(ip);

  if (!entry || entry.resetAt < now) {
    requestCounts.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return next();
  }
  entry.count++;
  if (entry.count > RATE_LIMIT) {
    return res.status(429).json({ error: 'rate_limited' });
  }
  return next();
});

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/auth', authRouter);

app.get('/health', (_req, res) => res.json({ ok: true }));

// ── Token prune job — runs every 6 hours ──────────────────────────────────────
setInterval(pruneTokens, 6 * 60 * 60 * 1000);

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Auth server running on port ${PORT}`);
});

export default app;
