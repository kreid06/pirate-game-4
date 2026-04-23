/**
 * PauseMenu.ts
 *
 * DOM overlay shown when the player presses Escape, `, or P while no other
 * menu is open.  Provides Resume, Settings, and Disconnect buttons.
 */

import { ClientConfig, ClientConfigManager } from '../ClientConfig.js';

/** Subset of settings the pause menu exposes and the app can react to live. */
export interface GameSettings {
  masterVolume: number;
  sfxVolume: number;
  musicVolume: number;
  antialiasing: boolean;
  particleQuality: 'low' | 'medium' | 'high';
  targetFPS: number;
  mouseSensitivity: number;
  invertMouseY: boolean;
  keyBindings: Map<string, string>;
}

export class PauseMenu {
  public visible = false;

  private container: HTMLDivElement;
  private styleEl: HTMLStyleElement;
  private isGuest = false;
  private convertFormVisible = false;
  private settingsVisible = false;
  /** Action currently waiting for a key press, or null. */
  private listeningAction: string | null = null;
  private boundKeyListener: ((e: KeyboardEvent) => void) | null = null;

  /** Called when the player clicks "Logout". */
  public onLogout: (() => void) | null = null;
  /**
   * Called after a guest successfully converts to a permanent account.
   * Receives the new display name.
   */
  public onAccountCreated: ((displayName: string) => void) | null = null;
  /** Called whenever a setting changes — apply the values live. */
  public onSettingsChange: ((settings: GameSettings) => void) | null = null;
  /** Called whenever the menu closes (Resume, backdrop click, Escape). */
  public onClose: (() => void) | null = null;

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
    this.stopListening(false);
    if (this.settingsVisible) this.hideSettingsPanel();
    this.syncVisibility();
    this.onClose?.();
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
        <div id="pm-main">
          <div class="pm-title">Paused</div>
          <div class="pm-divider"></div>
          <button class="pm-btn primary" id="pm-resume">Resume</button>
          <button class="pm-btn" id="pm-settings">Settings</button>
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

        <div id="pm-settings-panel" style="display:none">
          <div class="pm-title">Settings</div>
          <div class="pm-divider"></div>

          <div class="pm-tabs">
            <button class="pm-tab active" data-tab="audio">Audio</button>
            <button class="pm-tab" data-tab="display">Display</button>
            <button class="pm-tab" data-tab="controls">Controls</button>
          </div>

          <!-- Audio tab -->
          <div class="pm-settings-body" id="ps-tab-audio">

            <label class="pm-setting-row">
              <span class="pm-setting-label">Master Volume</span>
              <div class="pm-slider-wrap">
                <input class="pm-slider" id="ps-master-vol" type="range" min="0" max="100" step="1" />
                <span class="pm-slider-val" id="ps-master-vol-val">100</span>
              </div>
            </label>

            <label class="pm-setting-row">
              <span class="pm-setting-label">SFX Volume</span>
              <div class="pm-slider-wrap">
                <input class="pm-slider" id="ps-sfx-vol" type="range" min="0" max="100" step="1" />
                <span class="pm-slider-val" id="ps-sfx-vol-val">80</span>
              </div>
            </label>

            <label class="pm-setting-row">
              <span class="pm-setting-label">Music Volume</span>
              <div class="pm-slider-wrap">
                <input class="pm-slider" id="ps-music-vol" type="range" min="0" max="100" step="1" />
                <span class="pm-slider-val" id="ps-music-vol-val">70</span>
              </div>
            </label>

          </div>

          <!-- Display tab -->
          <div class="pm-settings-body" id="ps-tab-display" style="display:none">

            <label class="pm-setting-row">
              <span class="pm-setting-label">Antialiasing</span>
              <input class="pm-toggle" id="ps-antialiasing" type="checkbox" />
            </label>

            <label class="pm-setting-row">
              <span class="pm-setting-label">Particle Quality</span>
              <select class="pm-select" id="ps-particle-quality">
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </label>

            <label class="pm-setting-row">
              <span class="pm-setting-label">Frame Rate Cap</span>
              <select class="pm-select" id="ps-fps-cap">
                <option value="30">30 FPS</option>
                <option value="60">60 FPS</option>
                <option value="120">120 FPS</option>
                <option value="144">144 FPS</option>
                <option value="240">240 FPS</option>
              </select>
            </label>

          </div>

          <!-- Controls tab -->
          <div class="pm-settings-body" id="ps-tab-controls" style="display:none">

            <label class="pm-setting-row">
              <span class="pm-setting-label">Mouse Sensitivity</span>
              <div class="pm-slider-wrap">
                <input class="pm-slider" id="ps-mouse-sens" type="range" min="10" max="300" step="5" />
                <span class="pm-slider-val" id="ps-mouse-sens-val">100</span>
              </div>
            </label>

            <label class="pm-setting-row">
              <span class="pm-setting-label">Invert Mouse Y</span>
              <input class="pm-toggle" id="ps-invert-y" type="checkbox" />
            </label>

            <div class="pm-keybind-header">Key Bindings</div>
            <div id="ps-keybinds"></div>

          </div>

          <div class="pm-divider"></div>
          <button class="pm-btn primary" id="pm-settings-back">← Back</button>
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
        min-width: 340px;
        max-width: 420px;
        width: 90vw;
        display: flex;
        flex-direction: column;
        align-items: center;
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
      #pause-menu #pm-main,
      #pause-menu #pm-settings-panel {
        width: 100%;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 12px;
      }
      #pause-menu .pm-tabs {
        display: flex;
        width: 100%;
        gap: 4px;
        background: rgba(255,255,255,0.05);
        border-radius: 8px;
        padding: 4px;
      }
      #pause-menu .pm-tab {
        flex: 1;
        padding: 7px 0;
        border: none;
        border-radius: 6px;
        background: transparent;
        color: rgba(255,255,255,0.5);
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        transition: background 0.15s, color 0.15s;
        letter-spacing: 0.3px;
      }
      #pause-menu .pm-tab:hover {
        color: rgba(255,255,255,0.8);
      }
      #pause-menu .pm-tab.active {
        background: rgba(245,200,66,0.18);
        color: #f5c842;
      }
      #pause-menu .pm-settings-body {
        width: 100%;
        display: flex;
        flex-direction: column;
        gap: 4px;
        max-height: 380px;
        overflow-x: hidden;
        overflow-y: auto;
        padding-right: 6px;
        scrollbar-width: thin;
        scrollbar-color: rgba(245,200,66,0.35) rgba(255,255,255,0.05);
      }
      #pause-menu .pm-settings-body::-webkit-scrollbar {
        width: 5px;
      }
      #pause-menu .pm-settings-body::-webkit-scrollbar-track {
        background: rgba(255,255,255,0.05);
        border-radius: 99px;
      }
      #pause-menu .pm-settings-body::-webkit-scrollbar-thumb {
        background: rgba(245,200,66,0.35);
        border-radius: 99px;
      }
      #pause-menu .pm-settings-body::-webkit-scrollbar-thumb:hover {
        background: rgba(245,200,66,0.65);
      }
      #pause-menu .pm-setting-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 7px 10px;
        border-radius: 7px;
        background: rgba(255,255,255,0.04);
        cursor: default;
      }
      #pause-menu .pm-setting-label {
        font-size: 13px;
        color: #ccc;
        white-space: nowrap;
        flex-shrink: 0;
      }
      #pause-menu .pm-slider-wrap {
        display: flex;
        align-items: center;
        gap: 8px;
        flex: 1;
        justify-content: flex-end;
      }
      #pause-menu .pm-slider {
        -webkit-appearance: none;
        appearance: none;
        width: 120px;
        height: 4px;
        background: rgba(255,255,255,0.18);
        border-radius: 4px;
        outline: none;
        cursor: pointer;
        accent-color: #f5c842;
      }
      #pause-menu .pm-slider-val {
        font-size: 12px;
        color: #f5c842;
        width: 28px;
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      #pause-menu .pm-toggle {
        width: 18px;
        height: 18px;
        accent-color: #f5c842;
        cursor: pointer;
      }
      #pause-menu .pm-select {
        background: rgba(255,255,255,0.08);
        border: 1px solid rgba(255,255,255,0.18);
        border-radius: 6px;
        color: #e8e8e8;
        font-size: 13px;
        padding: 4px 8px;
        cursor: pointer;
        outline: none;
      }
      #pause-menu .pm-select:focus {
        border-color: rgba(245,200,66,0.6);
      }
      #pause-menu .pm-keybind-header {
        width: 100%;
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 1.5px;
        text-transform: uppercase;
        color: rgba(245,200,66,0.7);
        margin-top: 10px;
        padding: 0 2px;
      }
      #pause-menu .pm-bind-group-header {
        width: 100%;
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 1.2px;
        text-transform: uppercase;
        color: rgba(255,255,255,0.35);
        margin-top: 10px;
        margin-bottom: 1px;
        padding: 0 2px;
        border-bottom: 1px solid rgba(255,255,255,0.08);
        padding-bottom: 4px;
      }
      #pause-menu .pm-bind-group-header:first-child {
        margin-top: 4px;
      }
      #pause-menu #ps-keybinds {
        width: 100%;
        display: flex;
        flex-direction: column;
        gap: 3px;
      }
      #pause-menu .pm-bind-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 6px 10px;
        border-radius: 7px;
        background: rgba(255,255,255,0.04);
      }
      #pause-menu .pm-bind-label {
        font-size: 13px;
        color: #ccc;
      }
      #pause-menu .pm-bind-btn {
        min-width: 90px;
        padding: 5px 10px;
        border: 1px solid rgba(255,255,255,0.2);
        border-radius: 6px;
        background: rgba(255,255,255,0.07);
        color: #e8e8e8;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        text-align: center;
        transition: background 0.12s, border-color 0.12s;
        font-family: monospace;
        letter-spacing: 0.5px;
      }
      #pause-menu .pm-bind-btn:hover {
        background: rgba(255,255,255,0.13);
        border-color: rgba(255,255,255,0.35);
      }
      #pause-menu .pm-bind-btn.listening {
        background: rgba(245,200,66,0.18);
        border-color: #f5c842;
        color: #f5c842;
        animation: pm-bind-pulse 0.8s ease-in-out infinite alternate;
      }
      #pause-menu .pm-bind-btn.pm-bind-shared {
        opacity: 0.7;
      }
      #pause-menu .pm-fixed-keys {
        display: flex;
        gap: 4px;
        align-items: center;
        flex-shrink: 0;
      }
      #pause-menu .pm-fixed-key {
        display: inline-block;
        padding: 3px 8px;
        border: 1px solid rgba(255,255,255,0.15);
        border-radius: 5px;
        background: rgba(255,255,255,0.06);
        color: rgba(255,255,255,0.5);
        font-size: 11px;
        font-weight: 600;
        font-family: monospace;
        letter-spacing: 0.3px;
        white-space: nowrap;
      }
      #pause-menu .pm-bind-note {
        font-size: 10px;
        color: rgba(255,255,255,0.3);
        font-style: italic;
        font-weight: 400;
      }
      @keyframes pm-bind-pulse {
        from { opacity: 1; }
        to   { opacity: 0.5; }
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

    // Settings button
    this.container.querySelector('#pm-settings')!.addEventListener('click', () => {
      this.showSettingsPanel();
    });

    // Settings tab buttons
    this.container.querySelectorAll<HTMLButtonElement>('.pm-tab').forEach(tab => {
      tab.addEventListener('click', () => this.switchSettingsTab(tab.dataset.tab!));
    });

    // Settings back button
    this.container.querySelector('#pm-settings-back')!.addEventListener('click', () => {
      this.hideSettingsPanel();
    });

    // Settings inputs — wire live changes
    this.wireSettingsInputs();
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

  // ── Settings panel ────────────────────────────────────────────────────────

  private showSettingsPanel(): void {
    this.settingsVisible = true;
    this.container.querySelector<HTMLElement>('#pm-main')!.style.display = 'none';
    const panel = this.container.querySelector<HTMLElement>('#pm-settings-panel')!;
    panel.style.display = '';
    this.switchSettingsTab('audio');
    this.loadSettingsIntoPanel();
  }

  private hideSettingsPanel(): void {
    this.settingsVisible = false;
    this.container.querySelector<HTMLElement>('#pm-settings-panel')!.style.display = 'none';
    this.container.querySelector<HTMLElement>('#pm-main')!.style.display = '';
  }

  private switchSettingsTab(tab: string): void {
    const tabs = ['audio', 'display', 'controls'];
    for (const t of tabs) {
      const body = this.container.querySelector<HTMLElement>(`#ps-tab-${t}`)!;
      const btn  = this.container.querySelector<HTMLElement>(`.pm-tab[data-tab="${t}"]`)!;
      const active = t === tab;
      body.style.display = active ? '' : 'none';
      btn.classList.toggle('active', active);
    }
  }

  /** Populate the inputs from the persisted config. */
  private loadSettingsIntoPanel(): void {
    const cfg = ClientConfigManager.load();
    const g = cfg.graphics;
    const a = cfg.audio;
    const i = cfg.input;

    this.setSlider('ps-master-vol', Math.round((a.masterVolume ?? 1) * 100));
    this.setSlider('ps-sfx-vol',    Math.round((a.sfxVolume   ?? 0.8) * 100));
    this.setSlider('ps-music-vol',  Math.round((a.musicVolume  ?? 0.7) * 100));

    (this.container.querySelector<HTMLInputElement>('#ps-antialiasing')!).checked =
      g.antialiasing ?? true;
    (this.container.querySelector<HTMLSelectElement>('#ps-particle-quality')!).value =
      g.particleQuality ?? 'medium';
    (this.container.querySelector<HTMLSelectElement>('#ps-fps-cap')!).value =
      String(g.targetFPS ?? 144);

    this.setSlider('ps-mouse-sens', Math.round((i.mouseSensitivity ?? 1) * 100));
    (this.container.querySelector<HTMLInputElement>('#ps-invert-y')!).checked =
      i.invertMouseY ?? false;

    this.buildKeybindRows(i.keyBindings);
  }

  // ── Keybind rows ──────────────────────────────────────────────────────────

  /** Entry with `action` is rebindable; entry with `fixed` key(s) is display-only. */
  private static readonly KEYBIND_GROUPS: {
    label: string;
    entries: ({ action: string; label: string; note?: string } | { keys: string[]; label: string; note?: string })[];
  }[] = [
    {
      label: 'Player Controls',
      entries: [
        { action: 'move_forward',  label: 'Move Forward'    },
        { action: 'move_backward', label: 'Move Backward'   },
        { action: 'move_left',     label: 'Move Left'       },
        { action: 'move_right',    label: 'Move Right'      },
        { action: 'jump',          label: 'Jump'            },
        { action: 'interact',      label: 'Interact / Board'},
        { action: 'dismount',      label: 'Dismount'        },
        { keys: ['LMB'],           label: 'Attack / Fire'   },
        { keys: ['RMB'],           label: 'Aim'             },
        { keys: ['1–9'],           label: 'Hotbar Slots'    },
        { keys: ['F'],             label: 'Unequip Item'    },
      ],
    },
    {
      label: 'Ship Controls',
      entries: [
        { action: 'ship_move_forward',  label: 'Open Sails',        note: 'at helm' },
        { action: 'ship_move_backward', label: 'Close Sails / Reverse', note: 'at helm' },
        { action: 'ship_move_left',     label: 'Rudder Left',       note: 'at helm' },
        { action: 'ship_move_right',    label: 'Rudder Right',      note: 'at helm' },
        { keys: ['Shift + Rudder Left'],  label: 'Rotate Sails Left'  },
        { keys: ['Shift + Rudder Right'], label: 'Rotate Sails Right' },
        { action: 'ship_interact',      label: 'Dismount Helm'      },
        { action: 'toggle_camera_mode', label: 'Toggle Camera'      },
        { keys: ['L'],             label: 'Toggle All Ladders'      },
        { keys: ['R'],             label: 'Repair Sail'             },
        { keys: ['X'],             label: 'Cycle Ammo',             note: 'hold = force-load' },
        { keys: ['U'],             label: 'Toggle Cannon / Swivel Group' },
        { keys: ['1–9'],           label: 'Select Weapon Group',    note: 'at helm' },
        { keys: ['Ctrl+1–9'],      label: 'Assign Cannon to Group', note: 'at helm' },
      ],
    },
    {
      label: 'Build Mode',
      entries: [
        { keys: ['B'],             label: 'Toggle Build Mode'       },
        { action: 'destroy_plank', label: 'Destroy Plank'           },
        { keys: ['R'],             label: 'Rotate Piece Right'      },
        { keys: ['Q'],             label: 'Rotate Piece Left'       },
        { action: 'toggle_plank_bounds', label: 'Toggle Plank Bounds' },
      ],
    },
    {
      label: 'Debug',
      entries: [
        { action: 'toggle_debug',              label: 'Toggle Debug'            },
        { action: 'toggle_collision_tracker',  label: 'Toggle Collision Tracker'},
        { action: 'toggle_water_mode',         label: 'Toggle Water Mode'       },
      ],
    },
  ];

  /** Convert a KeyboardEvent.code like "KeyW" or "Space" to a short display string. */
  private static codeToLabel(code: string): string {
    if (code.startsWith('Key'))    return code.slice(3);
    if (code.startsWith('Digit'))  return code.slice(5);
    if (code === 'Space')          return 'Space';
    if (code === 'ArrowUp')        return '↑';
    if (code === 'ArrowDown')      return '↓';
    if (code === 'ArrowLeft')      return '←';
    if (code === 'ArrowRight')     return '→';
    if (code.startsWith('Numpad')) return 'Num' + code.slice(6);
    return code;
  }

  private buildKeybindRows(bindings: Map<string, string>): void {
    const container = this.container.querySelector<HTMLElement>('#ps-keybinds')!;
    if (!container) return;
    container.innerHTML = '';

    // Guard: if bindings isn't a real Map (e.g. deserialization issue) bail gracefully
    if (!(bindings instanceof Map)) {
      container.innerHTML = '<div style="color:rgba(255,255,255,0.4);font-size:12px;padding:8px 0">Key bindings unavailable.</div>';
      return;
    }

    // Track which rebindable actions we've already shown (can appear in multiple groups)
    const shownRebindable = new Set<string>();

    for (const group of PauseMenu.KEYBIND_GROUPS) {
      const header = document.createElement('div');
      header.className = 'pm-bind-group-header';
      header.textContent = group.label;
      container.appendChild(header);

      for (const entry of group.entries) {
        const row = document.createElement('div');
        row.className = 'pm-bind-row';

        if ('action' in entry) {
          // Rebindable entry
          const code = bindings.get(entry.action);
          if (!code) continue;
          const keyLabel = PauseMenu.codeToLabel(code);
          const already = shownRebindable.has(entry.action);
          shownRebindable.add(entry.action);

          row.innerHTML = `
            <span class="pm-bind-label">${entry.label}${entry.note ? `<span class="pm-bind-note"> (${entry.note})</span>` : ''}</span>
            <button class="pm-bind-btn${already ? ' pm-bind-shared' : ''}" data-action="${entry.action}">${keyLabel}</button>
          `;
          container.appendChild(row);

          if (!already) {
            row.querySelector<HTMLButtonElement>('.pm-bind-btn')!
              .addEventListener('click', (e) => { e.stopPropagation(); this.startListening(entry.action); });
          } else {
            // Show as read-only alias (changing in one group changes all)
            row.querySelector<HTMLButtonElement>('.pm-bind-btn')!
              .addEventListener('click', (e) => { e.stopPropagation(); this.startListening(entry.action); });
          }
        } else {
          // Fixed (hardcoded) display-only entry
          const keyBadges = entry.keys.map(k => `<span class="pm-fixed-key">${k}</span>`).join('');
          row.innerHTML = `
            <span class="pm-bind-label">${entry.label}${entry.note ? `<span class="pm-bind-note"> (${entry.note})</span>` : ''}</span>
            <span class="pm-fixed-keys">${keyBadges}</span>
          `;
          container.appendChild(row);
        }
      }
    }

    // Fallback: render any rebindable actions not covered by any group
    const coveredActions = new Set(
      PauseMenu.KEYBIND_GROUPS.flatMap(g =>
        g.entries.filter(e => 'action' in e).map(e => (e as { action: string }).action)
      )
    );
    const extras = [...bindings.keys()].filter(a => !coveredActions.has(a));
    if (extras.length > 0) {
      const header = document.createElement('div');
      header.className = 'pm-bind-group-header';
      header.textContent = 'Other';
      container.appendChild(header);
      for (const action of extras) {
        const code = bindings.get(action)!;
        const row = document.createElement('div');
        row.className = 'pm-bind-row';
        row.innerHTML = `
          <span class="pm-bind-label">${action}</span>
          <button class="pm-bind-btn" data-action="${action}">${PauseMenu.codeToLabel(code)}</button>
        `;
        container.appendChild(row);
        row.querySelector<HTMLButtonElement>('.pm-bind-btn')!
          .addEventListener('click', (e) => { e.stopPropagation(); this.startListening(action); });
      }
    }
  }

  private startListening(action: string): void {
    // Cancel any previous listen
    this.stopListening(false);

    this.listeningAction = action;
    const btn = this.container.querySelector<HTMLButtonElement>(`.pm-bind-btn[data-action="${action}"]`);
    if (btn) {
      btn.classList.add('listening');
      btn.textContent = 'Press a key…';
    }

    this.boundKeyListener = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === 'Escape') {
        this.stopListening(false);
        return;
      }
      this.commitBind(action, e.code);
    };

    window.addEventListener('keydown', this.boundKeyListener, { capture: true, once: true });
  }

  private stopListening(committed: boolean): void {
    if (this.boundKeyListener) {
      window.removeEventListener('keydown', this.boundKeyListener, { capture: true });
      this.boundKeyListener = null;
    }
    if (!committed && this.listeningAction) {
      // Restore the old label
      const cfg = ClientConfigManager.load();
      const code = cfg.input.keyBindings.get(this.listeningAction) ?? '';
      const btn = this.container.querySelector<HTMLButtonElement>(
        `.pm-bind-btn[data-action="${this.listeningAction}"]`);
      if (btn) {
        btn.classList.remove('listening');
        btn.textContent = PauseMenu.codeToLabel(code);
      }
    }
    this.listeningAction = null;
  }

  private commitBind(action: string, code: string): void {
    const cfg = ClientConfigManager.load();
    cfg.input.keyBindings.set(action, code);
    ClientConfigManager.save(cfg);

    const btn = this.container.querySelector<HTMLButtonElement>(`.pm-bind-btn[data-action="${action}"]`);
    if (btn) {
      btn.classList.remove('listening');
      btn.textContent = PauseMenu.codeToLabel(code);
    }
    this.listeningAction = null;
    this.boundKeyListener = null;

    // Notify so the app can apply the new bindings immediately
    this.saveAndNotify();
  }

  private setSlider(id: string, value: number): void {
    const input = this.container.querySelector<HTMLInputElement>(`#${id}`)!;
    const label = this.container.querySelector<HTMLElement>(`#${id}-val`)!;
    input.value  = String(value);
    label.textContent = String(value);
  }

  /** Wire all settings inputs to save + notify on change. */
  private wireSettingsInputs(): void {
    const onSlider = (id: string, valId: string) => {
      const input = this.container.querySelector<HTMLInputElement>(`#${id}`)!;
      const label = this.container.querySelector<HTMLElement>(`#${valId}`)!;
      input.addEventListener('input', () => {
        label.textContent = input.value;
        this.saveAndNotify();
      });
    };

    onSlider('ps-master-vol', 'ps-master-vol-val');
    onSlider('ps-sfx-vol',    'ps-sfx-vol-val');
    onSlider('ps-music-vol',  'ps-music-vol-val');
    onSlider('ps-mouse-sens', 'ps-mouse-sens-val');

    for (const id of ['ps-antialiasing', 'ps-particle-quality', 'ps-fps-cap', 'ps-invert-y']) {
      this.container.querySelector(`#${id}`)!.addEventListener('change', () => this.saveAndNotify());
    }
  }

  /** Read inputs → build GameSettings → persist → fire callback. */
  private saveAndNotify(): void {
    const masterVol      = parseInt((this.container.querySelector<HTMLInputElement>('#ps-master-vol')!).value, 10) / 100;
    const sfxVol         = parseInt((this.container.querySelector<HTMLInputElement>('#ps-sfx-vol')!).value, 10) / 100;
    const musicVol       = parseInt((this.container.querySelector<HTMLInputElement>('#ps-music-vol')!).value, 10) / 100;
    const antialiasing   = (this.container.querySelector<HTMLInputElement>('#ps-antialiasing')!).checked;
    const particleQuality = (this.container.querySelector<HTMLSelectElement>('#ps-particle-quality')!).value as GameSettings['particleQuality'];
    const targetFPS      = parseInt((this.container.querySelector<HTMLSelectElement>('#ps-fps-cap')!).value, 10);
    const mouseSensitivity = parseInt((this.container.querySelector<HTMLInputElement>('#ps-mouse-sens')!).value, 10) / 100;
    const invertMouseY   = (this.container.querySelector<HTMLInputElement>('#ps-invert-y')!).checked;

    const cfg = ClientConfigManager.load();
    cfg.audio.masterVolume       = masterVol;
    cfg.audio.sfxVolume          = sfxVol;
    cfg.audio.musicVolume        = musicVol;
    cfg.graphics.antialiasing    = antialiasing;
    cfg.graphics.particleQuality = particleQuality;
    cfg.graphics.targetFPS       = targetFPS;
    cfg.input.mouseSensitivity   = mouseSensitivity;
    cfg.input.invertMouseY       = invertMouseY;
    ClientConfigManager.save(cfg);

    this.onSettingsChange?.({
      masterVolume: masterVol,
      sfxVolume:    sfxVol,
      musicVolume:  musicVol,
      antialiasing,
      particleQuality,
      targetFPS,
      mouseSensitivity,
      invertMouseY,
      keyBindings: new Map(cfg.input.keyBindings),
    });
  }
}
