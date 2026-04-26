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
  /** Dynamic values provider — called at Tab-press time instead of static values. */
  valuesProvider?: () => string[];
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
    name: 'TpPlayerToShip',
    description: 'Teleport a player to a ship by ship ID.',
    args: [
      { name: 'playername' },
      { name: 'ship_id' },
    ],
  },
  {
    name: 'SpawnEntity',
    description: 'Spawn an entity at your current location.',
    args: [
      { name: 'entityname', values: ['crewmember'] },
      { name: 'company', values: ['neutral', 'pirates', 'navy'] },
    ],
  },
  {
    name: 'KillPlayer',
    description: 'Kill a player by name, triggering the respawn screen.',
    args: [{ name: 'playername' }],
  },
  {
    name: 'TpPlayerTo',
    description: 'Teleport a player to world coordinates.',
    args: [
      { name: 'playername' },
      { name: 'x' },
      { name: 'y' },
    ],
  },
  {
    name: 'forcesave',
    description: 'Immediately save the world state to disk.',
    args: [],
  },
  {
    name: 'shutdown',
    description: 'Broadcast server_shutdown and stop the server.',
    args: [{ name: 'save', values: ['true', 'false'] }],
  },
  {
    name: 'restart',
    description: 'Save, broadcast server_shutdown, then re-launch the server binary.',
    args: [{ name: 'save', values: ['true', 'false'] }],
  },
  {
    name: 'help',
    description: 'List available commands.',
    args: [],
  },
  {
    name: 'islandEditor',
    description: 'Open the island polygon editor (dev tool).',
    args: [{ name: 'island_id' }],
  },
];

/** Lookup by lowercase name for case-insensitive access. */
const CMD_MAP = new Map<string, CommandDef>(COMMANDS.map(c => [c.name.toLowerCase(), c]));

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
  private sizerEl!: HTMLSpanElement;

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
    this.sizerEl = this.container.querySelector<HTMLSpanElement>('#cmd-sizer')!

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
      this.updateInputWidth();
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

  /**
   * Register a dynamic values provider for a command argument.
   * Called at Tab-press time so it always reflects live game state.
   * @param cmdName  Command name (case-insensitive, without leading slash)
   * @param argIndex 0-based index of the argument slot
   * @param provider Function returning the current list of valid values
   */
  setArgValuesProvider(cmdName: string, argIndex: number, provider: () => string[]): void {
    const def = CMD_MAP.get(cmdName.toLowerCase());
    if (!def || argIndex >= def.args.length) return;
    def.args[argIndex].valuesProvider = provider;
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
      // Complete command name (case-insensitive prefix match, preserve original casing)
      const lowerCurrent = current.toLowerCase();
      return COMMANDS
        .map(c => `/${c.name}`)
        .filter(c => c.toLowerCase().startsWith(lowerCurrent));
    }

    // Complete an argument value
    const def = CMD_MAP.get(cmdName);
    if (!def) return [];
    const argIndex = argCount - 1;
    const argDef = def.args[argIndex];
    const values = argDef?.valuesProvider?.() ?? argDef?.values;
    if (!values) return [];
    const prefix = argParts[argIndex].toLowerCase();
    // Use the original command name casing for the completed result
    const origCmdName = def.name;
    const base = `/${origCmdName} ${argParts.slice(0, argIndex).join(' ')}${argIndex > 0 ? ' ' : ''}`;
    return values
      .filter(v => v.toLowerCase().startsWith(prefix))
      .map(v => `${base}${v}`);
  }

  /** Resize the input to its content so the ghost hint sits flush after the text. */
  private updateInputWidth(): void {
    this.sizerEl.textContent = this.inputEl.value || '/';
    this.inputEl.style.width = Math.max(this.sizerEl.offsetWidth + 2, 40) + 'px';
  }

  /** Update the ghost-hint shown to the right of the cursor. */
  private updateHint(current: string): void {
    const matches = this.buildTabMatches(current);
    if (matches.length === 0) { this.clearHint(); return; }

    const best = matches[0];
    const suffix = best.slice(current.length);

    if (suffix !== '') {
      // Show the remaining characters of the best match
      this.hintEl.textContent = suffix;
      return;
    }

    // Current text fully matches a candidate — if it's a full command name,
    // show the first expected argument value as a hint.
    const body = current.slice(1);           // strip leading slash
    const parts = body.split(' ');
    const cmdName = parts[0].toLowerCase();
    const def = CMD_MAP.get(cmdName);
    if (def) {
      const argIndex = parts.length - 2;     // 0-based index of the arg being typed
      const nextIndex = argIndex + 1;
      const nextArg = def.args[nextIndex];
      if (nextArg) {
        const firstVal = nextArg.values?.[0] ?? nextArg.name;
        this.hintEl.textContent = firstVal;
        return;
      }
    }
    this.clearHint();
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
      this.updateInputWidth();
      return;
    }

    this.onCommand?.(cmd);
    this.close();
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
      this.updateInputWidth();
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

          // Build match list on first Tab press
          if (this.tabMatches.length === 0) {
            this.tabBase = current;
            this.tabMatches = this.buildTabMatches(current);
            this.tabIndex = -1;
          }

          if (this.tabMatches.length === 0) break;

          // First Tab completes the ghost suggestion (index 0); subsequent Tabs cycle
          if (e.shiftKey) {
            this.tabIndex = this.tabIndex <= 0
              ? this.tabMatches.length - 1
              : this.tabIndex - 1;
          } else {
            this.tabIndex = this.tabIndex < 0
              ? 0
              : (this.tabIndex + 1) % this.tabMatches.length;
          }

          const chosen = this.tabMatches[this.tabIndex];
          // Append trailing space after a completed command name, or after a
          // completed argument when there are more arguments to fill in.
          const chosenBody = chosen.slice(1); // strip leading slash
          const chosenParts = chosenBody.split(' ');
          const chosenCmdName = chosenParts[0].toLowerCase();
          const isFullCommand = CMD_MAP.has(chosenCmdName) && chosenParts.length === 1;
          const completedArgIndex = chosenParts.length - 2; // 0-based index of the arg just completed
          const cmdDef = CMD_MAP.get(chosenCmdName);
          const hasMoreArgs = cmdDef ? completedArgIndex + 1 < cmdDef.args.length : false;
          const needsSpace = isFullCommand || hasMoreArgs;
          this.inputEl.value = needsSpace ? chosen + ' ' : chosen;
          const len = this.inputEl.value.length;
          this.inputEl.setSelectionRange(len, len);
          this.updateInputWidth();
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
            this.updateInputWidth();
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
            this.updateInputWidth();
            this.updateHint(this.inputEl.value);
          } else {
            this.historyIndex = -1;
            this.inputEl.value = '/';
            this.updateInputWidth();
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
          <span id="cmd-sizer" aria-hidden="true"></span>
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
        overflow: hidden;
      }

      #cmd-input {
        background: transparent;
        border: none;
        outline: none;
        color: #f5c842;
        font-family: inherit;
        font-size: inherit;
        caret-color: #f5c842;
        min-width: 40px;
        width: 40px;    /* dynamically updated via JS */
        flex-shrink: 0;
      }
      #cmd-input::placeholder {
        color: rgba(245,200,66,0.3);
      }

      #cmd-hint {
        color: rgba(245,200,66,0.32);
        font-family: inherit;
        font-size: inherit;
        pointer-events: none;
        white-space: pre;
        user-select: none;
        flex-shrink: 0;
      }

      #cmd-sizer {
        position: absolute;
        visibility: hidden;
        white-space: pre;
        font-family: 'Courier New', Courier, monospace;
        font-size: 13px;
        pointer-events: none;
        left: 0; top: 0;
      }
    `;
    return el;
  }
}
