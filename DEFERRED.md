# Deferred Work

Items intentionally deferred — not forgotten. Each entry notes why it was deferred and what's needed to implement it.

---

## Auth: Upgrade to RS256 (asymmetric JWT signing)

**Why deferred**: HS256 shared-secret is acceptable at current scale. Low risk given 15-min token expiry.

**Current state**: Game server verifies JWTs locally using `server/include/net/jwt_verify.h` with HMAC-SHA256. Both auth server (`JWT_SECRET` env var) and game server share the same secret.

**What to do when ready**:
1. Generate an RSA or EC key pair (e.g. `openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256`)
2. Auth server (`server/auth/src/jwt.ts`): switch `jsonwebtoken` sign algorithm from `HS256` to `ES256`, sign with private key
3. Game server (`server/include/net/jwt_verify.h`): replace HMAC verify with `EVP_DigestVerify` using the public key (OpenSSL already linked)
4. Remove `JWT_SECRET` from game server env — only the auth server needs the private key

**Why it's better**: Private key never leaves auth server. Public key is safe to embed in game server. No shared secret sprawl.

---

## Auth: Server-to-server token revocation

**Why deferred**: Adds latency on every connect + makes auth server a hard dependency.

**Current state**: Tokens expire after 15 min; revocation only works at refresh time (refresh tokens are revoked in DB). A banned player can keep playing until their access token expires.

**What to do when ready**:
1. Add a `POST /auth/verify` endpoint to auth server that checks token signature + revocation list
2. On WebSocket handshake, game server POSTs the token to auth server before admitting the player
3. Consider a short-lived in-memory revocation cache (e.g. 30s TTL) on game server to avoid hammering auth on every reconnect

---

## Client: Background token refresh

**Why deferred**: Sessions are short enough that the 15-min access token rarely expires mid-session.

**Current state**: `AuthService.restoreSession()` refreshes on page load if expired, but there is no proactive in-session refresh.

**What to do when ready**:
- In `client/src/client/auth/AuthService.ts`, export a `startRefreshLoop()` that sets a `setInterval` firing every ~14 min
- On each tick: check `exp` from stored access token; if within 2 min of expiry, call `refreshSession()`
- Call `startRefreshLoop()` from `client/src/client/main.ts` after a successful auth
