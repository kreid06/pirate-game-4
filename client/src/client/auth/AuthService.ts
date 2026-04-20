/**
 * AuthService — talks to the pirate-auth-server REST API.
 *
 * Tokens are persisted in localStorage so that a page refresh does not force
 * a fresh login.  The access token is a short-lived JWT (15 min); the refresh
 * token is long-lived (7 days) and is used to silently obtain a new access
 * token when the current one has expired.
 */

const AUTH_URL = (import.meta.env.VITE_AUTH_URL as string | undefined) ?? 'http://localhost:3001';

const LS_ACCESS  = 'pirate_access_token';
const LS_REFRESH = 'pirate_refresh_token';
const LS_DISPLAY = 'pirate_display_name';
const LS_GUEST   = 'pirate_is_guest';

export interface AuthResult {
  accessToken:  string;
  refreshToken: string;
  displayName:  string;
  guest:        boolean;
}

// ── Persistence helpers ───────────────────────────────────────────────────────

export function saveSession(result: AuthResult): void {
  localStorage.setItem(LS_ACCESS,  result.accessToken);
  localStorage.setItem(LS_REFRESH, result.refreshToken);
  localStorage.setItem(LS_DISPLAY, result.displayName);
  localStorage.setItem(LS_GUEST,   result.guest ? '1' : '0');
}

export function clearSession(): void {
  localStorage.removeItem(LS_ACCESS);
  localStorage.removeItem(LS_REFRESH);
  localStorage.removeItem(LS_DISPLAY);
  localStorage.removeItem(LS_GUEST);
}

/** Returns the stored session if the access token is still valid (not expired). */
export function loadSession(): AuthResult | null {
  const accessToken  = localStorage.getItem(LS_ACCESS);
  const refreshToken = localStorage.getItem(LS_REFRESH);
  const displayName  = localStorage.getItem(LS_DISPLAY);
  const guest        = localStorage.getItem(LS_GUEST) === '1';

  if (!accessToken || !refreshToken || !displayName) return null;

  // Quick JWT expiry check (no signature verification — client-side only)
  try {
    const payload = JSON.parse(atob(accessToken.split('.')[1]));
    if (typeof payload.exp === 'number' && payload.exp * 1000 < Date.now()) {
      return null; // expired, caller must refresh
    }
  } catch {
    return null;
  }

  return { accessToken, refreshToken, displayName, guest };
}

// ── API requests ──────────────────────────────────────────────────────────────

async function post(path: string, body: unknown): Promise<Response> {
  const res = await fetch(`${AUTH_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res;
}

export async function registerAccount(username: string, password: string): Promise<AuthResult> {
  const res = await post('/auth/register', { username, password });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? 'register_failed');
  return {
    accessToken:  data.access_token,
    refreshToken: data.refresh_token,
    displayName:  username,
    guest:        false,
  };
}

export async function loginAccount(username: string, password: string): Promise<AuthResult> {
  const res = await post('/auth/login', { username, password });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? 'login_failed');
  return {
    accessToken:  data.access_token,
    refreshToken: data.refresh_token,
    displayName:  username,
    guest:        false,
  };
}

export async function loginGuest(displayName?: string): Promise<AuthResult> {
  const res = await post('/auth/guest', displayName ? { display_name: displayName } : {});
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? 'guest_failed');
  return {
    accessToken:  data.access_token,
    refreshToken: data.refresh_token,
    displayName:  data.display_name as string,
    guest:        true,
  };
}

export async function refreshSession(refreshToken: string): Promise<AuthResult> {
  const res = await post('/auth/refresh', { refresh_token: refreshToken });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? 'refresh_failed');

  // Decode display_name from the new access token payload
  let displayName = localStorage.getItem(LS_DISPLAY) ?? 'Player';
  let guest = localStorage.getItem(LS_GUEST) === '1';
  try {
    const payload = JSON.parse(atob(data.access_token.split('.')[1]));
    if (payload.display_name) displayName = payload.display_name;
    if (typeof payload.guest === 'boolean') guest = payload.guest;
  } catch { /* keep stored values */ }

  return {
    accessToken:  data.access_token,
    refreshToken: data.refresh_token,
    displayName,
    guest,
  };
}

/**
 * Try to restore an existing session, silently refreshing if the access token
 * has expired but the refresh token is still valid.
 * Returns null if the player must log in again.
 */
export async function restoreSession(): Promise<AuthResult | null> {
  const stored = loadSession();
  if (stored) return stored;

  // Access token expired — try to refresh
  const rt = localStorage.getItem(LS_REFRESH);
  if (!rt) return null;

  try {
    const refreshed = await refreshSession(rt);
    saveSession(refreshed);
    return refreshed;
  } catch {
    clearSession();
    return null;
  }
}

/**
 * Revoke the stored refresh token on the auth server, then clear local storage.
 * Fire-and-forget safe — if the server call fails we still clear locally.
 */
export async function logout(): Promise<void> {
  const refreshToken = localStorage.getItem(LS_REFRESH);
  if (refreshToken) {
    try {
      await post('/auth/logout', { refresh_token: refreshToken });
    } catch {
      // Network failure — token will expire on its own; proceed with local clear.
    }
  }
  clearSession();
}
