/**
 * PauseMenu.ts
 *
 * DOM overlay shown when the player presses Escape, `, or P while no other
 * menu is open.  Provides Resume, Settings (stub), and Disconnect buttons.
 */

export class PauseMenu {
  public visible = false;

  private container: HTMLDivElement;
  private styleEl: HTMLStyleElement;
  private isGuest = false;
  private convertFormVisible = false;

  /** Called when the player clicks "Logout". */
  public onLogout: (() => void) | null = null;
  /**
   * Called after a guest successfully converts to a permanent account.
   * Receives the new display name.
   */
  public onAccountCreated: ((displayName: string) => void) | null = null;

  constructor() {
    this.styleEl = this.buildStyles();
    document.head.appendChild(this.styleEl);

    this.container = document.createElement('div');
    this.container.id = 'pause-menu';
    this.container.setAttribute('aria-modal', 'true');
    this.container.setAttribute('role', 'dialog');
    this.container.innerHTML = this.buildHTML();
    document.body.appendChild(this.container);

    this.bindEvents();
    this.syncVisibility();
  }

  /**
   * Show or hide the "Create Account" button depending on whether the current
   * player is a guest.  Call this right after the session is established.
   */
  setGuest(guest: boolean): void {
    this.isGuest = guest;
    const btn = this.container.querySelector<HTMLElement>('#pm-create-account');
    if (btn) btn.style.display = guest ? '' : 'none';
    if (!guest) this.hideConvertForm();
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  open(): void {
    if (this.visible) return;
    this.visible = true;
    this.syncVisibility();
  }

  close(): void {
    if (!this.visible) return;
    this.visible = false;
    this.syncVisibility();
  }

  toggle(): void {
    this.visible ? this.close() : this.open();
  }

  destroy(): void {
    this.container.remove();
    this.styleEl.remove();
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private syncVisibility(): void {
    this.container.style.display = this.visible ? 'flex' : 'none';
  }

  private buildHTML(): string {
    return /* html */ `
      <div class="pm-backdrop"></div>
      <div class="pm-card">
        <div class="pm-title">Paused</div>
        <div class="pm-divider"></div>
        <button class="pm-btn primary" id="pm-resume">Resume</button>
        <button class="pm-btn pm-guest-only" id="pm-create-account" style="display:none">Create Account</button>
        <button class="pm-btn" id="pm-logout">Logout</button>

        <div id="pm-convert-form" class="pm-convert-form" style="display:none">
          <div class="pm-convert-title">Save your progress</div>
          <input id="pm-username" class="pm-input" type="text" placeholder="Username" maxlength="24" autocomplete="off" />
          <input id="pm-password" class="pm-input" type="password" placeholder="Password (min 8 chars)" autocomplete="new-password" />
          <div id="pm-convert-error" class="pm-error" style="display:none"></div>
          <button class="pm-btn primary" id="pm-convert-submit">Save Account</button>
          <button class="pm-btn" id="pm-convert-cancel">Cancel</button>
        </div>
      </div>
    `;
  }

  private buildStyles(): HTMLStyleElement {
    const style = document.createElement('style');
    style.textContent = `
      #pause-menu {
        display: none;
        position: fixed;
        inset: 0;
        z-index: 8000;
        align-items: center;
        justify-content: center;
        font-family: 'Segoe UI', Arial, sans-serif;
      }
      #pause-menu .pm-backdrop {
        position: absolute;
        inset: 0;
        background: rgba(0, 0, 0, 0.55);
        backdrop-filter: blur(3px);
      }
      #pause-menu .pm-card {
        position: relative;
        background: rgba(12, 22, 40, 0.96);
        border: 1px solid rgba(255, 255, 255, 0.14);
        border-radius: 14px;
        padding: 36px 48px 32px;
        min-width: 260px;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 12px;
        box-shadow: 0 12px 48px rgba(0, 0, 0, 0.7);
        color: #e8e8e8;
      }
      #pause-menu .pm-title {
        font-size: 26px;
        font-weight: 700;
        letter-spacing: 2px;
        color: #f5c842;
        text-shadow: 0 2px 12px rgba(245, 200, 66, 0.35);
        text-transform: uppercase;
      }
      #pause-menu .pm-divider {
        width: 80%;
        height: 1px;
        background: rgba(255, 255, 255, 0.1);
        margin: 2px 0 6px;
      }
      #pause-menu .pm-btn {
        width: 100%;
        padding: 11px 0;
        border: 1px solid rgba(255, 255, 255, 0.15);
        border-radius: 8px;
        background: rgba(255, 255, 255, 0.06);
        color: #e8e8e8;
        font-size: 15px;
        font-weight: 600;
        cursor: pointer;
        transition: background 0.15s, border-color 0.15s;
        letter-spacing: 0.5px;
      }
      #pause-menu .pm-btn:hover {
        background: rgba(255, 255, 255, 0.12);
        border-color: rgba(255, 255, 255, 0.28);
      }
      #pause-menu .pm-btn:active {
        transform: scale(0.98);
      }
      #pause-menu .pm-btn.primary {
        background: linear-gradient(135deg, #f5c842, #e09b10);
        border-color: transparent;
        color: #1a1000;
      }
      #pause-menu .pm-btn.primary:hover {
        opacity: 0.88;
      }
      #pause-menu .pm-convert-form {
        width: 100%;
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding-top: 6px;
        border-top: 1px solid rgba(255,255,255,0.1);
        margin-top: 4px;
      }
      #pause-menu .pm-convert-title {
        font-size: 13px;
        color: rgba(255,255,255,0.55);
        text-align: center;
        letter-spacing: 0.3px;
        margin-bottom: 2px;
      }
      #pause-menu .pm-input {
        width: 100%;
        box-sizing: border-box;
        padding: 9px 12px;
        border: 1px solid rgba(255,255,255,0.18);
        border-radius: 7px;
        background: rgba(255,255,255,0.07);
        color: #e8e8e8;
        font-size: 14px;
        outline: none;
        transition: border-color 0.15s;
      }
      #pause-menu .pm-input:focus {
        border-color: rgba(245,200,66,0.6);
      }
      #pause-menu .pm-error {
        font-size: 13px;
        color: #ff6b6b;
        text-align: center;
      }
    `;
    return style;
  }

  private bindEvents(): void {
    // Click backdrop → resume
    this.container.querySelector('.pm-backdrop')!.addEventListener('click', () => this.close());

    // Resume button
    this.container.querySelector('#pm-resume')!.addEventListener('click', () => this.close());

    // Logout button
    this.container.querySelector('#pm-logout')!.addEventListener('click', () => {
      this.close();
      this.onLogout?.();
    });

    // "Create Account" — reveal inline form
    this.container.querySelector('#pm-create-account')!.addEventListener('click', () => {
      this.showConvertForm();
    });

    // Cancel form
    this.container.querySelector('#pm-convert-cancel')!.addEventListener('click', () => {
      this.hideConvertForm();
    });

    // Submit form
    this.container.querySelector('#pm-convert-submit')!.addEventListener('click', () => {
      this.submitConvert();
    });

    // Allow Enter key inside form inputs to submit
    this.container.querySelector('#pm-username')!.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') this.submitConvert();
    });
    this.container.querySelector('#pm-password')!.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') this.submitConvert();
    });
  }

  private showConvertForm(): void {
    this.convertFormVisible = true;
    const form = this.container.querySelector<HTMLElement>('#pm-convert-form')!;
    form.style.display = '';
    this.container.querySelector<HTMLInputElement>('#pm-username')!.value = '';
    this.container.querySelector<HTMLInputElement>('#pm-password')!.value = '';
    this.setConvertError('');
    this.container.querySelector<HTMLElement>('#pm-create-account')!.style.display = 'none';
    this.container.querySelector<HTMLInputElement>('#pm-username')!.focus();
  }

  private hideConvertForm(): void {
    this.convertFormVisible = false;
    this.container.querySelector<HTMLElement>('#pm-convert-form')!.style.display = 'none';
    if (this.isGuest) {
      this.container.querySelector<HTMLElement>('#pm-create-account')!.style.display = '';
    }
  }

  private setConvertError(msg: string): void {
    const el = this.container.querySelector<HTMLElement>('#pm-convert-error')!;
    el.textContent = msg;
    el.style.display = msg ? '' : 'none';
  }

  private async submitConvert(): Promise<void> {
    const username = (this.container.querySelector<HTMLInputElement>('#pm-username')!.value ?? '').trim();
    const password = this.container.querySelector<HTMLInputElement>('#pm-password')!.value ?? '';

    if (username.length < 3) {
      this.setConvertError('Username must be at least 3 characters.');
      return;
    }
    if (password.length < 8) {
      this.setConvertError('Password must be at least 8 characters.');
      return;
    }

    const submitBtn = this.container.querySelector<HTMLButtonElement>('#pm-convert-submit')!;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Saving…';
    this.setConvertError('');

    try {
      // Dynamically imported to avoid circular dep at module load time
      const { convertAccount } = await import('../auth/AuthService');
      await convertAccount(username, password);
      this.hideConvertForm();
      this.onAccountCreated?.(username);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'convert_failed';
      const friendly: Record<string, string> = {
        username_taken:       'That username is already taken.',
        username_too_short:   'Username must be at least 3 characters.',
        username_invalid_chars: 'Only letters, numbers, _ and - are allowed.',
        password_too_short:   'Password must be at least 8 characters.',
        invalid_token:        'Session expired — please log in again.',
        not_a_guest:          'Your account is already permanent.',
      };
      this.setConvertError(friendly[msg] ?? 'Something went wrong. Please try again.');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Save Account';
    }
  }
}
