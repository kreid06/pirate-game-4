/**
 * CommandConsole.ts
 *
 * A terminal-style input bar anchored to the bottom of the screen.
 * Opens when the player presses `/` and allows typed commands to be sent
 * to the server.  Supports:
 *   - Tab autocomplete (cycles through matching commands / argument values)
 *   - ↑ / ↓ command history
 *   - Client-side help command
 */

export interface CommandEntry {
  kind: 'input' | 'response' | 'error' | 'info';
  text: string;
}

/** One argument slot in a command definition. */
interface ArgDef {
  name: string;
  /** Fixed set of accepted values shown during Tab-completion. */
  values?: string[];
}

/** A registered command with autocomplete metadata. */
interface CommandDef {
  name: string;         // without leading slash
  description: string;
  args: ArgDef[];
}

/** All known commands — drives autocomplete and /help. */
const COMMANDS: CommandDef[] = [
  {
    name: 'AddPlayerToCompany',
    description: 'Join a company (faction).',
    args: [{ name: 'company', values: ['pirates', 'navy', 'neutral'] }],
  },
  {
    name: 'help',
    description: 'List available commands.',
    args: [],
  },
];

/** Lookup by name for quick access. */
const CMD_MAP = new Map<string, CommandDef>(COMMANDS.map(c => [c.name, c]));

export class CommandConsole {
  public visible = false;

  /** Fired when the player submits a command. The string includes the leading `/`. */
  public onCommand: ((command: string) => void) | null = null;
  /** Called when the console opens or closes. */
  public onVisibilityChange: ((visible: boolean) => void) | null = null;

  private container!: HTMLDivElement;
  private styleEl!: HTMLStyleElement;
  private logEl!: HTMLDivElement;
  private inputEl!: HTMLInputElement;
  private hintEl!: HTMLSpanElement;

  private history: string[] = [];
  private historyIndex = -1;
  private log: CommandEntry[] = [];

  /** Tab-cycle state — reset on any non-Tab key. */
  private tabMatches: string[] = [];
  private tabIndex = -1;
  private tabBase = '';         // the text at the moment Tab was first pressed

  constructor() {
    this.styleEl = this.buildStyles();
    document.head.appendChild(this.styleEl);

    this.container = document.createElement('div');
    this.container.id = 'cmd-console';
    this.container.innerHTML = this.buildHTML();
    document.body.appendChild(this.container);

    this.logEl   = this.container.querySelector<HTMLDivElement>('#cmd-log')!;
    this.inputEl = this.container.querySelector<HTMLInputElement>('#cmd-input')!;
    this.hintEl  = this.container.querySelector<HTMLSpanElement>('#cmd-hint')!;

    this.bindEvents();
    this.syncVisibility();
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  open(): void {
    if (this.visible) return;
    this.visible = true;
    this.inputEl.value = '/';
    this.historyIndex = -1;
    this.clearTabState();
    this.syncVisibility();
    requestAnimationFrame(() => {
      this.inputEl.focus();
      this.inputEl.setSelectionRange(1, 1);
    });
    this.onVisibilityChange?.(true);
  }

  close(): void {
    if (!this.visible) return;
    this.visible = false;
    this.inputEl.blur();
    this.clearHint();
    this.clearTabState();
    this.syncVisibility();
    this.onVisibilityChange?.(false);
  }

  toggle(): void { this.visible ? this.close() : this.open(); }

  destroy(): void {
    this.container.remove();
    this.styleEl.remove();
  }

  /** Push a response line (from server or local) into the log. */
  pushResponse(text: string, kind: CommandEntry['kind'] = 'response'): void {
    this.pushLog({ kind, text });
  }

  // ── Autocomplete ─────────────────────────────────────────────────────────────

  private clearTabState(): void {
    this.tabMatches = [];
    this.tabIndex = -1;
    this.tabBase = '';
  }

  /** Build the candidate list for Tab-completion given current input text. */
  private buildTabMatches(current: string): string[] {
    // current always starts with '/'
    const body = current.slice(1);          // strip leading slash
    const parts = body.split(' ');
    const cmdName = parts[0].toLowerCase();
    const argParts = parts.slice(1);
    const argCount = argParts.length;       // 0 = still typing command name

    if (argCount === 0) {
      // Complete command name
      return COMMANDS
        .map(c => `/${c.name}`)
        .filter(c => c.startsWith(current.toLowerCase()));
    }

    // Complete an argument value
    const def = CMD_MAP.get(cmdName);
    if (!def) return [];
    const argIndex = argCount - 1;
    const argDef = def.args[argIndex];
    if (!argDef?.values) return [];
    const prefix = argParts[argIndex].toLowerCase();
    const base = `/${cmdName} ${argParts.slice(0, argIndex).join(' ')}${argIndex > 0 ? ' ' : ''}`;
    return argDef.values
      .filter(v => v.startsWith(prefix))
      .map(v => `${base}${v}`);
  }

  /** Update the ghost-hint shown to the right of the cursor. */
  private updateHint(current: string): void {
    const body = current.slice(1);
    const parts = body.split(' ');
    const cmdName = parts[0].toLowerCase();
    const def = CMD_MAP.get(cmdName);

    if (!def) {
      // Partial command name → show first matching command
      const match = COMMANDS.find(c => c.name.startsWith(cmdName) && c.name !== cmdName);
      this.hintEl.textContent = match ? match.name.slice(cmdName.length) : '';
      return;
    }

    // Show argument hint
    const argIndex = parts.length - 2; // parts[0]=cmd, parts[1..]=args; -2 for 0-index
    const nextArg = def.args[Math.max(0, argIndex + 1)];
    if (nextArg && parts.length <= def.args.length) {
      this.hintEl.textContent = ` <${nextArg.name}>`;
    } else {
      this.hintEl.textContent = '';
    }
  }

  private clearHint(): void { this.hintEl.textContent = ''; }

  // ── Submit ───────────────────────────────────────────────────────────────────

  private submit(): void {
    const raw = this.inputEl.value.trim();
    if (!raw || raw === '/') return;

    const cmd = raw.startsWith('/') ? raw : `/${raw}`;
    this.pushLog({ kind: 'input', text: cmd });

    if (this.history[0] !== cmd) this.history.unshift(cmd);
    if (this.history.length > 50) this.history.pop();
    this.historyIndex = -1;
    this.clearTabState();
    this.clearHint();

    // Handle client-side commands before forwarding
    const parts = cmd.slice(1).trim().split(/\s+/);
    const name  = parts[0].toLowerCase();

    if (name === 'help') {
      this.showHelp();
      this.inputEl.value = '/';
      return;
    }

    this.onCommand?.(cmd);
    this.inputEl.value = '/';
    this.updateHint('/');
  }

  private showHelp(): void {
    this.pushLog({ kind: 'info', text: '── Available commands ─────────────────' });
    for (const c of COMMANDS) {
      const argStr = c.args.map(a => `<${a.name}>`).join(' ');
      this.pushLog({ kind: 'info', text: `  /${c.name}${argStr ? ' ' + argStr : ''}  — ${c.description}` });
    }
  }

  // ── Events ───────────────────────────────────────────────────────────────────

  private bindEvents(): void {
    this.inputEl.addEventListener('input', () => {
      this.clearTabState();
      this.updateHint(this.inputEl.value);
    });

    this.inputEl.addEventListener('keydown', (e: KeyboardEvent) => {
      e.stopPropagation();

      switch (e.key) {
        case 'Enter':
          e.preventDefault();
          this.submit();
          break;

        case 'Escape':
          e.preventDefault();
          this.close();
          break;

        case 'Tab': {
          e.preventDefault();
          const current = this.inputEl.value;

          // First Tab press — build the match list from current text
          if (this.tabMatches.length === 0) {
            this.tabBase = current;
            this.tabMatches = this.buildTabMatches(current);
            this.tabIndex = -1;
          }

          if (this.tabMatches.length === 0) break;

          // Cycle forward (Shift+Tab cycles backward)
          if (e.shiftKey) {
            this.tabIndex = (this.tabIndex - 1 + this.tabMatches.length) % this.tabMatches.length;
          } else {
            this.tabIndex = (this.tabIndex + 1) % this.tabMatches.length;
          }

          const chosen = this.tabMatches[this.tabIndex];
          // Append a space after a completed command name so next Tab jumps to args
          const isFullCommand = CMD_MAP.has(chosen.slice(1));
          this.inputEl.value = isFullCommand ? chosen + ' ' : chosen;
          const len = this.inputEl.value.length;
          this.inputEl.setSelectionRange(len, len);
          this.updateHint(this.inputEl.value);
          break;
        }

        case 'ArrowUp': {
          e.preventDefault();
          this.clearTabState();
          const next = this.historyIndex + 1;
          if (next < this.history.length) {
            this.historyIndex = next;
            this.inputEl.value = this.history[next];
            const len = this.inputEl.value.length;
            this.inputEl.setSelectionRange(len, len);
            this.updateHint(this.inputEl.value);
          }
          break;
        }

        case 'ArrowDown': {
          e.preventDefault();
          this.clearTabState();
          const prev = this.historyIndex - 1;
          if (prev >= 0) {
            this.historyIndex = prev;
            this.inputEl.value = this.history[prev];
            const len = this.inputEl.value.length;
            this.inputEl.setSelectionRange(len, len);
            this.updateHint(this.inputEl.value);
          } else {
            this.historyIndex = -1;
            this.inputEl.value = '/';
            this.clearHint();
          }
          break;
        }

        case 'Backspace':
          // Prevent erasing the leading slash
          if (this.inputEl.selectionStart === 1 && this.inputEl.selectionEnd === 1) {
            e.preventDefault();
          } else {
            this.clearTabState();
          }
          break;

        default:
          // Any other key resets Tab cycle
          if (e.key.length === 1) this.clearTabState();
          break;
      }
    });

    this.container.addEventListener('mousedown', (e) => e.stopPropagation());
    this.container.addEventListener('mouseup',   (e) => e.stopPropagation());
    this.container.addEventListener('click',     (e) => e.stopPropagation());
  }

  // ── Log ──────────────────────────────────────────────────────────────────────

  private syncVisibility(): void {
    this.container.style.display = this.visible ? 'flex' : 'none';
  }

  private pushLog(entry: CommandEntry): void {
    this.log.push(entry);
    if (this.log.length > 200) this.log.shift();

    const line = document.createElement('div');
    line.className = `cmd-line cmd-${entry.kind}`;
    line.textContent = entry.text;
    this.logEl.appendChild(line);

    while (this.logEl.children.length > 100) {
      this.logEl.removeChild(this.logEl.firstChild!);
    }
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  // ── HTML / CSS ───────────────────────────────────────────────────────────────

  private buildHTML(): string {
    return /* html */`
      <div id="cmd-log"></div>
      <div id="cmd-input-row">
        <span class="cmd-prompt">▶</span>
        <div id="cmd-input-wrap">
          <input id="cmd-input" type="text" autocomplete="off" spellcheck="false"
                 placeholder="type a command… (Tab to autocomplete)" />
          <span id="cmd-hint"></span>
        </div>
      </div>
    `;
  }

  private buildStyles(): HTMLStyleElement {
    const el = document.createElement('style');
    el.textContent = /* css */`
      #cmd-console {
        position: fixed;
        left: 0; right: 0; bottom: 0;
        display: flex;
        flex-direction: column;
        pointer-events: all;
        z-index: 900;
        font-family: 'Courier New', Courier, monospace;
        font-size: 13px;
      }

      #cmd-log {
        max-height: 180px;
        overflow-y: auto;
        overflow-x: hidden;
        padding: 6px 12px 4px;
        background: rgba(0, 0, 0, 0.72);
        border-top: 1px solid rgba(245,200,66,0.25);
        display: flex;
        flex-direction: column;
        gap: 1px;
        scrollbar-width: thin;
        scrollbar-color: rgba(245,200,66,0.4) transparent;
      }
      #cmd-log::-webkit-scrollbar { width: 5px; }
      #cmd-log::-webkit-scrollbar-track { background: transparent; }
      #cmd-log::-webkit-scrollbar-thumb { background: rgba(245,200,66,0.35); border-radius: 3px; }

      #cmd-console .cmd-line {
        white-space: pre-wrap;
        word-break: break-all;
        line-height: 1.4;
      }
      #cmd-console .cmd-input    { color: #f5c842; }
      #cmd-console .cmd-response { color: #c8e6c9; }
      #cmd-console .cmd-error    { color: #ef9a9a; }
      #cmd-console .cmd-info     { color: #90caf9; }

      #cmd-input-row {
        display: flex;
        align-items: center;
        gap: 8px;
        background: rgba(0, 0, 0, 0.88);
        border-top: 1px solid rgba(245,200,66,0.5);
        padding: 6px 12px;
      }

      #cmd-console .cmd-prompt {
        color: #f5c842;
        font-size: 11px;
        flex-shrink: 0;
        user-select: none;
      }

      #cmd-input-wrap {
        flex: 1;
        position: relative;
        display: flex;
        align-items: center;
      }

      #cmd-input {
        flex: 1;
        background: transparent;
        border: none;
        outline: none;
        color: #f5c842;
        font-family: inherit;
        font-size: inherit;
        caret-color: #f5c842;
        min-width: 0;
      }
      #cmd-input::placeholder {
        color: rgba(245,200,66,0.3);
      }

      #cmd-hint {
        color: rgba(245,200,66,0.35);
        font-family: inherit;
        font-size: inherit;
        pointer-events: none;
        white-space: pre;
        user-select: none;
      }
    `;
    return el;
  }
}
