/**
 * ChatBox — HTML overlay chat window (top-left of screen).
 *
 * Channels: global (all players), local (nearby), company, alliance.
 * Press Enter (or T) to open input, Enter to send, Escape to cancel.
 * The container auto-hides 10 s after the last message is sent/received.
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

const MAX_MESSAGES  = 150;
/** Whole container hides this many ms after the last activity. */
const AUTOHIDE_MS   = 10_000;

export class ChatBox {
  private _root:     HTMLDivElement;
  private _tabs:     HTMLDivElement;
  private _msgArea:  HTMLDivElement;
  private _inputRow: HTMLDivElement;
  private _chanLbl:  HTMLSpanElement;
  private _input:    HTMLInputElement;

  private _channel:   ChatChannel = 'global';
  private _history:   ChatEntry[] = [];
  private _open       = false;
  private _hideTimer: ReturnType<typeof setTimeout> | null = null;

  /** Called when the player sends a message. */
  onSend: ((channel: ChatChannel, text: string) => void) | null = null;

  private static _styleInjected = false;

  private static _injectStyle(): void {
    if (ChatBox._styleInjected) return;
    ChatBox._styleInjected = true;
    const s = document.createElement('style');
    s.textContent = [
      '.chatbox-msgs::-webkit-scrollbar { width: 6px; }',
      '.chatbox-msgs::-webkit-scrollbar-track { background: rgba(255,255,255,0.05); }',
      '.chatbox-msgs::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.22); border-radius: 3px; }',
      '.chatbox-msgs::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.45); }',
      '.chatbox-msgs { scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.22) rgba(255,255,255,0.05); }',
    ].join('\n');
    document.head.appendChild(s);
  }

  /** Document-level PageUp/PageDown handler — also reveals the container if hidden. */
  private _docKeyHandler = (e: KeyboardEvent): void => {
    if (e.key === 'PageUp' || e.key === 'PageDown') {
      this._showContainer();   // reveal if hidden, reset auto-hide timer
      const delta = this._msgArea.clientHeight * 0.85;
      this._msgArea.scrollTop += e.key === 'PageUp' ? -delta : delta;
      e.preventDefault();
    }
  };

  constructor() {
    // ── Root container ──────────────────────────────────────────────────
    this._root = document.createElement('div');
    Object.assign(this._root.style, {
      position:         'fixed',
      top:              '8px',
      left:             '8px',
      width:            '340px',
      zIndex:           '60',
      fontFamily:       'Georgia, serif',
      fontSize:         '12px',
      pointerEvents:    'none',
      userSelect:       'none',
      WebkitUserSelect: 'none',
      display:          'none',   // hidden until first activity
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
      btn.textContent   = ch[0].toUpperCase() + ch.slice(1);
      btn.dataset['ch'] = ch;
      this._styleTab(btn, ch === this._channel);
      btn.addEventListener('mousedown', (e) => { e.preventDefault(); this._setChannel(ch); });
      this._tabs.appendChild(btn);
    }

    // ── Message area ────────────────────────────────────────────────────
    ChatBox._injectStyle();
    this._msgArea = document.createElement('div');
    this._msgArea.className = 'chatbox-msgs';
    Object.assign(this._msgArea.style, {
      height:     '160px',
      overflowY:  'scroll',  // always show track so layout is stable
      background: 'rgba(0,0,0,0.72)',
      border:     '1px solid rgba(255,255,255,0.18)',
      padding:    '4px 6px',
      boxSizing:  'border-box',
      lineHeight: '1.5',
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
    this._input.placeholder = 'Type a message… (Enter to send, Esc to cancel)';
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

    // Swallow all key events so the game doesn't see them while chatting
    for (const ev of ['keydown', 'keyup', 'keypress'] as const) {
      this._input.addEventListener(ev, (e: KeyboardEvent) => {
        e.stopPropagation();
        if (ev === 'keydown') this._onInputKey(e);
      });
    }
    this._input.addEventListener('blur', () => this._closeInput());

    this._inputRow.appendChild(this._chanLbl);
    this._inputRow.appendChild(this._input);

    this._root.appendChild(this._tabs);
    this._root.appendChild(this._msgArea);
    this._root.appendChild(this._inputRow);
    document.body.appendChild(this._root);
    document.addEventListener('keydown', this._docKeyHandler);
  }

  // ── Public API ──────────────────────────────────────────────────────────

  get isOpen(): boolean { return this._open; }

  /** Show the container and focus the text input. */
  open(): void {
    if (this._open) return;
    this._open = true;
    this._showContainer();                     // cancel any pending hide
    this._inputRow.style.visibility  = 'visible';
    this._root.style.pointerEvents   = 'auto';
    // Use rAF so the key that triggered open isn't typed into the field
    requestAnimationFrame(() => this._input.focus());
  }

  /** Receive a broadcast message from the server and display it. */
  addMessage(channel: ChatChannel, senderName: string, text: string): void {
    const entry: ChatEntry = { channel, senderName, text, timeMs: Date.now() };
    this._history.push(entry);
    if (this._history.length > MAX_MESSAGES) this._history.shift();
    this._appendLine(entry);
    // Show container and reset auto-hide timer
    this._showContainer();
  }

  destroy(): void {
    this._clearHideTimer();
    document.removeEventListener('keydown', this._docKeyHandler);
    this._root.remove();
  }

  // ── Private ─────────────────────────────────────────────────────────────

  private _onInputKey(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      const text = this._input.value.trim();
      if (text.length > 0) this.onSend?.(this._channel, text);
      this._input.value = '';
      this._closeInput();
    } else if (e.key === 'Escape') {
      this._input.value = '';
      this._closeInput();
    } else if (e.key === 'PageUp' || e.key === 'PageDown') {
      this._showContainer();   // reveal if hidden, reset auto-hide timer
      const delta = this._msgArea.clientHeight * 0.85;
      this._msgArea.scrollTop += e.key === 'PageUp' ? -delta : delta;
      e.preventDefault();
    }
  }

  /** Close the text input but keep the container visible (starts auto-hide). */
  private _closeInput(): void {
    if (!this._open) return;
    this._open = false;
    this._inputRow.style.visibility = 'hidden';
    this._root.style.pointerEvents  = 'none';
    this._scheduleHide();
  }

  /** Make the container visible and reset the 10-second auto-hide timer. */
  private _showContainer(): void {
    this._clearHideTimer();
    this._root.style.display = 'block';
    // If input is not open, schedule hide
    if (!this._open) this._scheduleHide();
  }

  private _scheduleHide(): void {
    this._clearHideTimer();
    this._hideTimer = setTimeout(() => {
      if (!this._open) this._root.style.display = 'none';
    }, AUTOHIDE_MS);
  }

  private _clearHideTimer(): void {
    if (this._hideTimer !== null) { clearTimeout(this._hideTimer); this._hideTimer = null; }
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
    body.style.color = '#d0cdc0';
    body.textContent = entry.text;

    line.appendChild(badge);
    line.appendChild(name);
    line.appendChild(body);
    this._msgArea.appendChild(line);
    this._msgArea.scrollTop = this._msgArea.scrollHeight;
  }

  private _setChannel(ch: ChatChannel): void {
    this._channel = ch;
    for (const el of Array.from(this._tabs.children) as HTMLButtonElement[]) {
      this._styleTab(el, el.dataset['ch'] === ch);
    }
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

