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

  /** Called when the player clicks "Logout". */
  public onLogout: (() => void) | null = null;

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
        <button class="pm-btn" id="pm-logout">Logout</button>
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
  }
}
