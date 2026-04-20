/**
 * AuthScreen — full-screen overlay shown before the game loads.
 *
 * Three panels:
 *   • Login   – existing account
 *   • Register – create account
 *   • Guest   – play without an account
 *
 * Resolves with an AuthResult once the player is authenticated.
 */

import {
  AuthResult,
  loginAccount,
  registerAccount,
  loginGuest,
  saveSession,
} from './AuthService.js';

type Panel = 'login' | 'register' | 'guest';

export class AuthScreen {
  private container: HTMLDivElement;
  private resolve!: (result: AuthResult) => void;

  constructor() {
    this.container = document.createElement('div');
    this.container.id = 'auth-screen';
    this.container.innerHTML = this.buildHTML();
    this.applyStyles();
    document.body.appendChild(this.container);
    this.bindEvents();
    this.showPanel('login');
  }

  /** Returns a promise that resolves once the player is authenticated. */
  waitForAuth(): Promise<AuthResult> {
    return new Promise((res) => { this.resolve = res; });
  }

  private buildHTML(): string {
    return /* html */ `
      <div class="auth-card">
        <div class="auth-logo">🏴‍☠️ Pirate Game</div>

        <!-- Tab bar -->
        <div class="auth-tabs">
          <button class="auth-tab" data-panel="login">Login</button>
          <button class="auth-tab" data-panel="register">Register</button>
          <button class="auth-tab" data-panel="guest">Guest</button>
        </div>

        <!-- Login panel -->
        <div class="auth-panel" id="panel-login">
          <input class="auth-input" id="login-username" type="text"
                 placeholder="Username" autocomplete="username" />
          <input class="auth-input" id="login-password" type="password"
                 placeholder="Password" autocomplete="current-password" />
          <div class="auth-error" id="login-error"></div>
          <button class="auth-btn primary" id="login-submit">Set Sail</button>
        </div>

        <!-- Register panel -->
        <div class="auth-panel" id="panel-register">
          <input class="auth-input" id="reg-username" type="text"
                 placeholder="Username (3–24 chars, a-z 0-9 _ -)"
                 autocomplete="username" />
          <input class="auth-input" id="reg-password" type="password"
                 placeholder="Password (min 8 chars)"
                 autocomplete="new-password" />
          <input class="auth-input" id="reg-confirm" type="password"
                 placeholder="Confirm password"
                 autocomplete="new-password" />
          <div class="auth-error" id="reg-error"></div>
          <button class="auth-btn primary" id="reg-submit">Create Account</button>
        </div>

        <!-- Guest panel -->
        <div class="auth-panel" id="panel-guest">
          <p class="auth-hint">Play without an account. Your progress won't be saved.</p>
          <input class="auth-input" id="guest-name" type="text"
                 placeholder="Display name (optional)" />
          <div class="auth-error" id="guest-error"></div>
          <button class="auth-btn primary" id="guest-submit">Play as Guest</button>
        </div>
      </div>
    `;
  }

  private applyStyles(): void {
    const style = document.createElement('style');
    style.textContent = `
      #auth-screen {
        position: fixed; inset: 0; z-index: 9999;
        background: radial-gradient(ellipse at 50% 60%, #0a1a2e 0%, #000510 100%);
        display: flex; align-items: center; justify-content: center;
        font-family: 'Segoe UI', Arial, sans-serif;
      }
      .auth-card {
        background: rgba(255,255,255,0.06);
        border: 1px solid rgba(255,255,255,0.15);
        border-radius: 16px;
        padding: 36px 40px 32px;
        width: 360px;
        backdrop-filter: blur(12px);
        box-shadow: 0 8px 40px rgba(0,0,0,0.6);
        color: #e8e8e8;
      }
      .auth-logo {
        font-size: 28px; font-weight: 700; text-align: center;
        margin-bottom: 24px; letter-spacing: 1px;
        color: #f5c842;
        text-shadow: 0 2px 12px rgba(245,200,66,0.4);
      }
      .auth-tabs {
        display: flex; gap: 4px; margin-bottom: 22px;
        background: rgba(0,0,0,0.3); border-radius: 8px; padding: 4px;
      }
      .auth-tab {
        flex: 1; padding: 8px 0; border: none; border-radius: 6px;
        background: transparent; color: #aaa; cursor: pointer;
        font-size: 14px; font-weight: 600; transition: all 0.15s;
      }
      .auth-tab:hover { color: #fff; background: rgba(255,255,255,0.08); }
      .auth-tab.active {
        background: rgba(245,200,66,0.2); color: #f5c842;
      }
      .auth-panel { display: none; flex-direction: column; gap: 12px; }
      .auth-panel.visible { display: flex; }
      .auth-input {
        background: rgba(255,255,255,0.08);
        border: 1px solid rgba(255,255,255,0.18);
        border-radius: 8px; padding: 11px 14px;
        color: #fff; font-size: 14px; outline: none;
        transition: border-color 0.15s;
      }
      .auth-input:focus { border-color: rgba(245,200,66,0.6); }
      .auth-input::placeholder { color: #666; }
      .auth-btn {
        padding: 12px; border: none; border-radius: 8px;
        font-size: 15px; font-weight: 700; cursor: pointer;
        transition: opacity 0.15s, transform 0.1s;
        margin-top: 4px;
      }
      .auth-btn:active { transform: scale(0.98); }
      .auth-btn.primary {
        background: linear-gradient(135deg, #f5c842, #e09b10);
        color: #1a1000;
      }
      .auth-btn.primary:hover { opacity: 0.9; }
      .auth-btn:disabled { opacity: 0.5; cursor: not-allowed; }
      .auth-error {
        min-height: 18px; font-size: 13px;
        color: #ff7070; text-align: center;
      }
      .auth-hint {
        margin: 0; font-size: 13px; color: #999; text-align: center;
        line-height: 1.5;
      }
    `;
    document.head.appendChild(style);
  }

  private showPanel(panel: Panel): void {
    const panels: Panel[] = ['login', 'register', 'guest'];
    for (const p of panels) {
      this.container.querySelector(`#panel-${p}`)?.classList.toggle('visible', p === panel);
      const tab = this.container.querySelector<HTMLButtonElement>(`.auth-tab[data-panel="${p}"]`);
      if (tab) tab.classList.toggle('active', p === panel);
    }
  }

  private setError(id: string, msg: string): void {
    const el = this.container.querySelector<HTMLDivElement>(`#${id}`);
    if (el) el.textContent = msg;
  }

  private clearErrors(): void {
    this.container.querySelectorAll('.auth-error').forEach((el) => { el.textContent = ''; });
  }

  private setLoading(btn: HTMLButtonElement, loading: boolean): void {
    btn.disabled = loading;
    btn.textContent = loading ? 'Loading…' : btn.dataset.label ?? btn.textContent;
  }

  private bindEvents(): void {
    // Tab switching
    this.container.querySelectorAll('.auth-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        this.clearErrors();
        this.showPanel((tab as HTMLElement).dataset.panel as Panel);
      });
    });

    // Enter key in inputs submits current panel
    this.container.querySelectorAll('.auth-input').forEach((input) => {
      input.addEventListener('keydown', (e) => {
        if ((e as KeyboardEvent).key === 'Enter') {
          const panel = this.container.querySelector('.auth-panel.visible');
          panel?.querySelector<HTMLButtonElement>('.auth-btn.primary')?.click();
        }
      });
    });

    // ── Login ────────────────────────────────────────────────────────────────
    const loginBtn = this.container.querySelector<HTMLButtonElement>('#login-submit')!;
    loginBtn.dataset.label = 'Set Sail';
    loginBtn.addEventListener('click', async () => {
      this.clearErrors();
      const username = (this.container.querySelector<HTMLInputElement>('#login-username')!).value.trim();
      const password = (this.container.querySelector<HTMLInputElement>('#login-password')!).value;
      if (!username || !password) {
        this.setError('login-error', 'Please fill in all fields.');
        return;
      }
      this.setLoading(loginBtn, true);
      try {
        const result = await loginAccount(username, password);
        saveSession(result);
        this.finish(result);
      } catch (err) {
        const msg = (err as Error).message;
        this.setError('login-error', this.friendlyError(msg));
      } finally {
        this.setLoading(loginBtn, false);
      }
    });

    // ── Register ─────────────────────────────────────────────────────────────
    const regBtn = this.container.querySelector<HTMLButtonElement>('#reg-submit')!;
    regBtn.dataset.label = 'Create Account';
    regBtn.addEventListener('click', async () => {
      this.clearErrors();
      const username = (this.container.querySelector<HTMLInputElement>('#reg-username')!).value.trim();
      const password = (this.container.querySelector<HTMLInputElement>('#reg-password')!).value;
      const confirm  = (this.container.querySelector<HTMLInputElement>('#reg-confirm')!).value;
      if (!username || !password) {
        this.setError('reg-error', 'Please fill in all fields.');
        return;
      }
      if (password !== confirm) {
        this.setError('reg-error', 'Passwords do not match.');
        return;
      }
      this.setLoading(regBtn, true);
      try {
        const result = await registerAccount(username, password);
        saveSession(result);
        this.finish(result);
      } catch (err) {
        const msg = (err as Error).message;
        this.setError('reg-error', this.friendlyError(msg));
      } finally {
        this.setLoading(regBtn, false);
      }
    });

    // ── Guest ────────────────────────────────────────────────────────────────
    const guestBtn = this.container.querySelector<HTMLButtonElement>('#guest-submit')!;
    guestBtn.dataset.label = 'Play as Guest';
    guestBtn.addEventListener('click', async () => {
      this.clearErrors();
      const name = (this.container.querySelector<HTMLInputElement>('#guest-name')!).value.trim();
      this.setLoading(guestBtn, true);
      try {
        const result = await loginGuest(name || undefined);
        saveSession(result);
        this.finish(result);
      } catch (err) {
        const msg = (err as Error).message;
        this.setError('guest-error', this.friendlyError(msg));
      } finally {
        this.setLoading(guestBtn, false);
      }
    });
  }

  private finish(result: AuthResult): void {
    this.container.style.transition = 'opacity 0.4s';
    this.container.style.opacity = '0';
    setTimeout(() => this.container.remove(), 420);
    this.resolve(result);
  }

  private friendlyError(code: string): string {
    const map: Record<string, string> = {
      invalid_credentials:    'Invalid username or password.',
      username_taken:         'That username is already taken.',
      username_too_short:     'Username must be at least 3 characters.',
      username_invalid_chars: 'Username can only contain letters, numbers, _ and -.',
      password_too_short:     'Password must be at least 8 characters.',
      rate_limited:           'Too many attempts. Please wait a minute.',
    };
    return map[code] ?? `Error: ${code}`;
  }
}
