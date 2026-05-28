/**
 * ChatBox — HTML overlay chat window (top-left of screen).
 *
 * Channels: global (all players), local (nearby), company, alliance.
 * Press T to open input, Enter to send, Escape to cancel.
 */

export type ChatChannel = 'global' | 'local' | 'company' | 'alliance';

export interface ChatEntry {
  channel:    ChatChannel;
  senderName: string;
  text:       string;
  timeMs:     number;
}

const CHANNEL_COLOR: Record<ChatChannel, string> = {
  global:   '#e0ddd0',
  local:    '#88ee99',
  company:  '#88aaff',
  alliance: '#88eeff',
};

const MAX_MESSAGES = 150;

/** How long (ms) a message stays fully opaque before fading when chat is closed. */
const FADE_AFTER_MS  = 8_000;
/** Duration of the CSS opacity fade. */
const FADE_DUR_MS    = 2_000;

export class ChatBox {
  private _root:     HTMLDivElement;
  private _tabs:     HTMLDivElement;
  private _msgArea:  HTMLDivElement;
  private _inputRow: HTMLDivElement;
  private _chanLbl:  HTMLSpanElement;
  private _input:    HTMLInputElement;

  private _channel: ChatChannel = 'global';
  private _history: ChatEntry[] = [];
  private _open    = false;
  private _fadeTimer: ReturnType<typeof setTimeout> | null = null;

  /** Called when the player sends a message. */
  onSend: ((channel: ChatChannel, text: string) => void) | null = null;

  constructor() {
    // ── Root container ──────────────────────────────────────────────────
    this._root = document.createElement('div');
    Object.assign(this._root.style, {
      position:       'fixed',
      top:            '8px',
      left:           '8px',
      width:          '340px',
      zIndex:         '60',
      fontFamily:     'Georgia, serif',
      fontSize:       '12px',
      pointerEvents:  'none',   // disabled by default; enabled on focus
      userSelect:     'none',
      WebkitUserSelect: 'none',
    });

    // ── Channel tabs ────────────────────────────────────────────────────
    this._tabs = document.createElement('div');
    Object.assign(this._tabs.style, {
      display:       'flex',
      gap:           '2px',
      marginBottom:  '2px',
      pointerEvents: 'auto',
    });
    const channels: ChatChannel[] = ['global', 'local', 'company', 'alliance'];
    for (const ch of channels) {
      const btn = document.createElement('button');
      btn.textContent  = ch[0].toUpperCase() + ch.slice(1);
      btn.dataset['ch'] = ch;
      this._styleTab(btn, ch === this._channel);
      btn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this._setChannel(ch);
      });
      this._tabs.appendChild(btn);
    }

    // ── Message area ────────────────────────────────────────────────────
    this._msgArea = document.createElement('div');
    Object.assign(this._msgArea.style, {
      height:     '160px',
      overflowY:  'auto',
      background: 'rgba(0,0,0,0.72)',
      border:     '1px solid rgba(255,255,255,0.18)',
      padding:    '4px 6px',
      boxSizing:  'border-box',
      lineHeight: '1.5',
      transition: `opacity ${FADE_DUR_MS}ms ease`,
    });

    // ── Input row ────────────────────────────────────────────────────────
    this._inputRow = document.createElement('div');
    Object.assign(this._inputRow.style, {
      display:       'flex',
      gap:           '3px',
      marginTop:     '2px',
      visibility:    'hidden',
      pointerEvents: 'auto',
    });

    this._chanLbl = document.createElement('span');
    Object.assign(this._chanLbl.style, {
      display:    'flex',
      alignItems: 'center',
      padding:    '1px 7px',
      background: 'rgba(20,20,20,0.88)',
      border:     '1px solid rgba(255,255,255,0.18)',
      color:      CHANNEL_COLOR[this._channel],
      fontSize:   '11px',
      whiteSpace: 'nowrap',
    });
    this._chanLbl.textContent = this._channel[0].toUpperCase() + this._channel.slice(1);

    this._input = document.createElement('input');
    this._input.type        = 'text';
    this._input.maxLength   = 200;
    this._input.placeholder = 'Press Enter to send, Esc to cancel…';
    Object.assign(this._input.style, {
      flex:       '1',
      padding:    '2px 6px',
      background: 'rgba(10,10,18,0.92)',
      border:     '1px solid rgba(255,255,255,0.25)',
      color:      '#e0ddd0',
      fontSize:   '12px',
      fontFamily: 'Georgia, serif',
      outline:    'none',
    });

    // Stop game from consuming keystrokes while chat is open
    for (const ev of ['keydown', 'keyup', 'keypress'] as const) {
      this._input.addEventListener(ev, (e: KeyboardEvent) => {
        e.stopPropagation();
        if (ev === 'keydown') this._onKey(e);
      });
    }
    this._input.addEventListener('blur', () => this._close());

    this._inputRow.appendChild(this._chanLbl);
    this._inputRow.appendChild(this._input);

    // ── Assemble ─────────────────────────────────────────────────────────
    this._root.appendChild(this._tabs);
    this._root.appendChild(this._msgArea);
    this._root.appendChild(this._inputRow);
    document.body.appendChild(this._root);

    // Start with transparent message area until first message arrives
    this._msgArea.style.opacity = '0';
  }

  // ── Public API ──────────────────────────────────────────────────────────

  get isOpen(): boolean { return this._open; }

  /** Open the input box (call on T keydown). */
  open(): void {
    if (this._open) return;
    this._open = true;
    this._clearFadeTimer();
    this._msgArea.style.opacity      = '1';
    this._inputRow.style.visibility  = 'visible';
    this._root.style.pointerEvents   = 'auto';
    // Focus async to avoid the T character being typed into the input
    requestAnimationFrame(() => this._input.focus());
  }

  /** Receive a chat message from the server and display it. */
  addMessage(channel: ChatChannel, senderName: string, text: string): void {
    const entry: ChatEntry = { channel, senderName, text, timeMs: Date.now() };
    this._history.push(entry);
    if (this._history.length > MAX_MESSAGES) this._history.shift();
    this._appendLine(entry);
    // If closed, flash the message area visible briefly
    if (!this._open) this._flashVisible();
  }

  destroy(): void {
    this._clearFadeTimer();
    this._root.remove();
  }

  // ── Private ─────────────────────────────────────────────────────────────

  private _onKey(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      const text = this._input.value.trim();
      if (text.length > 0) this.onSend?.(this._channel, text);
      this._input.value = '';
      this._close();
    } else if (e.key === 'Escape') {
      this._input.value = '';
      this._close();
    }
  }

  private _close(): void {
    if (!this._open) return;
    this._open = false;
    this._inputRow.style.visibility = 'hidden';
    this._root.style.pointerEvents  = 'none';
    this._flashVisible();
  }

  /** Show messages then fade them out. */
  private _flashVisible(): void {
    this._clearFadeTimer();
    this._msgArea.style.transition = 'none';
    this._msgArea.style.opacity    = '1';
    this._fadeTimer = setTimeout(() => {
      this._msgArea.style.transition = `opacity ${FADE_DUR_MS}ms ease`;
      this._msgArea.style.opacity    = '0';
    }, FADE_AFTER_MS);
  }

  private _clearFadeTimer(): void {
    if (this._fadeTimer !== null) { clearTimeout(this._fadeTimer); this._fadeTimer = null; }
  }

  private _appendLine(entry: ChatEntry): void {
    const line = document.createElement('div');
    line.style.marginBottom = '1px';
    line.style.wordBreak    = 'break-word';

    const badge = document.createElement('span');
    badge.style.color       = CHANNEL_COLOR[entry.channel];
    badge.style.marginRight = '4px';
    badge.style.fontSize    = '11px';
    badge.textContent       = `[${entry.channel[0].toUpperCase()}]`;

    const name = document.createElement('span');
    name.style.color      = CHANNEL_COLOR[entry.channel];
    name.style.fontWeight = 'bold';
    name.textContent      = `${entry.senderName}: `;

    const body = document.createElement('span');
    body.style.color  = '#d0cdc0';
    body.textContent  = entry.text;

    line.appendChild(badge);
    line.appendChild(name);
    line.appendChild(body);
    this._msgArea.appendChild(line);
    this._msgArea.scrollTop = this._msgArea.scrollHeight;
  }

  private _setChannel(ch: ChatChannel): void {
    this._channel = ch;
    // Update tab highlights
    for (const el of Array.from(this._tabs.children) as HTMLButtonElement[]) {
      this._styleTab(el, el.dataset['ch'] === ch);
    }
    // Update label
    this._chanLbl.textContent = ch[0].toUpperCase() + ch.slice(1);
    this._chanLbl.style.color = CHANNEL_COLOR[ch];
  }

  private _styleTab(btn: HTMLButtonElement, active: boolean): void {
    const ch = btn.dataset['ch'] as ChatChannel;
    Object.assign(btn.style, {
      flex:         '1',
      padding:      '2px 4px',
      background:   active ? 'rgba(50,50,60,0.92)' : 'rgba(10,10,18,0.78)',
      border:       `1px solid ${CHANNEL_COLOR[ch]}44`,
      color:        CHANNEL_COLOR[ch],
      cursor:       'pointer',
      fontSize:     '11px',
      fontFamily:   'Georgia, serif',
      borderRadius: '2px',
    });
  }
}
