/**
 * Manning Priority Panel
 *
 * Left-side HUD panel for assigning NPC crew to tasks.
 * Each task holds an explicit list of NPC IDs (taskNpcs).
 * + picks one idle NPC and pins it to the task.
 * − releases the last NPC back to idle.
 * No implicit re-allocation — a task never steals from another.
 */

import { Npc } from '../../sim/Types.js';

export type ManningTask = 'Sails' | 'Gunners' | 'Repairs' | 'Combat';

/** NPC state constants (mirror server WorldNpcState) */
const NPC_STATE_AT_GUN = 2;
const NPC_STATE_REPAIRING = 3;

const TASK_COLORS: Record<ManningTask, string> = {
  Sails:   '#5aafff',
  Gunners: '#ffaa44',
  Repairs: '#55dd66',
  Combat:  '#aa44ff',
};

interface HitArea {
  x: number; y: number; w: number; h: number;
  action: () => void;
}

export class ManningPriorityPanel {
  // Mutable priority order (index 0 = highest priority)
  private priorityOrder: ManningTask[] = ['Sails', 'Gunners', 'Repairs', 'Combat'];

  // Explicit NPC ID lists per task. The only way an NPC enters a task is via + picking
  // from the idle pool. The only way it leaves is via −. Never implicitly re-allocated.
  private taskNpcs: Map<ManningTask, number[]> = new Map([
    ['Sails',   []],
    ['Gunners', []],
    ['Repairs', []],
    ['Combat',  []],
  ]);

  private hitAreas: HitArea[] = [];

  // npcId → task name for the most-recently rendered frame (fed to RenderSystem for NPC colours)
  private lastTaskMap: Map<number, string> = new Map();
  // npcId → task last SENT to the server (delta tracking — prevents re-sending unchanged assignments)
  private lastSentAssignment: Map<number, string> = new Map();
  private _currentShipId = 0;
  private _currentNpcs: Npc[] = [];
  private _localCompanyId = 0;

  /**
   * Fires whenever assignments change. Carries the full list of {npcId, task} including
   * "Idle" for any NPC not allocated to an active task.
   * Set this before calling render() — it needs access to the current NPC list.
   */
  public onAssignmentChanged: ((shipId: number, assignments: Array<{ npcId: number; task: string }>) => void) | null = null;

  /** Returns the most-recently-computed npcId → task name map (read-only). */
  getTaskMap(): ReadonlyMap<number, string> { return this.lastTaskMap; }

  /**
   * Called when the local player boards a new ship.
   * Seeds the task panel from the authoritative NPC states already in the world state
   * so the UI reflects reality instead of stale assignments from the previous ship.
   */
  syncFromBoarding(npcs: Npc[], shipId: number, localCompanyId: number = 0): void {
    this._currentShipId = shipId;
    this._localCompanyId = localCompanyId;
    this.lastSentAssignment.clear();
    for (const list of this.taskNpcs.values()) list.length = 0;
    this.lastTaskMap.clear();
    if (shipId === 0) return;

    const shipNpcs = npcs.filter(n => n.shipId === shipId && n.companyId === localCompanyId);

    // Seed task lists from the server-authoritative NPC role field.
    // role 1 = Gunner  → Gunners
    // role 3 = Rigger  → Sails
    // role 4 = Repairer → Repairs
    // role 0/2 (None/Helmsman) → unassigned/Idle
    for (const npc of shipNpcs) {
      if (npc.role === 1) {
        this.taskNpcs.get('Gunners')?.push(npc.id);
      } else if (npc.role === 3) {
        this.taskNpcs.get('Sails')?.push(npc.id);
      } else if (npc.role === 4) {
        this.taskNpcs.get('Repairs')?.push(npc.id);
      }
      // role 0 (None) / role 2 (Helmsman) → unassigned
    }

    // Rebuild lastTaskMap from seeded assignments
    const npcById = new Map(shipNpcs.map(n => [n.id, n]));
    for (const [task, ids] of this.taskNpcs) {
      for (const id of ids) {
        if (npcById.has(id)) this.lastTaskMap.set(id, task);
      }
    }
    for (const npc of shipNpcs) {
      if (!this.lastTaskMap.has(npc.id)) this.lastTaskMap.set(npc.id, 'Idle');
    }
  }

  // Panel geometry (screen-space, draggable)
  // Default: flush with left edge, just below the stats box (BY=10 + BOX_H=118 + 8px gap)
  private panelX = 10;
  private panelY = 136;
  private readonly PW = 192;
  private readonly HEADER_H = 26;
  private readonly ROW_H = 46;

  // Drag state
  private _dragging = false;
  private _dragOffX = 0;
  private _dragOffY = 0;

  // Minimize state
  private _minimized = false;

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Try to consume a mousedown. Handles header drag, minimize toggle, and button hits.
   * Returns true if the click was inside the panel.
   */
  handleMouseDown(cx: number, cy: number): boolean {
    const { panelX: px, panelY: py, PW: pw, HEADER_H } = this;

    // Click inside header → start drag (or fall through to minimize button below)
    if (cx >= px && cx < px + pw && cy >= py && cy < py + HEADER_H) {
      // Minimize toggle button (right side of header, 20 px wide)
      const minBtnX = px + pw - 20;
      if (cx >= minBtnX) {
        this._minimized = !this._minimized;
        return true;
      }
      // Begin drag
      this._dragging = true;
      this._dragOffX = cx - px;
      this._dragOffY = cy - py;
      return true;
    }

    // When minimized no other hit areas are active
    if (this._minimized) {
      return cx >= px && cx < px + pw && cy >= py && cy < py + HEADER_H;
    }

    for (const area of this.hitAreas) {
      if (cx >= area.x && cx < area.x + area.w && cy >= area.y && cy < area.y + area.h) {
        area.action();
        return true;
      }
    }
    return false;
  }

  handleMouseMove(cx: number, cy: number): void {
    if (!this._dragging) return;
    this.panelX = cx - this._dragOffX;
    this.panelY = cy - this._dragOffY;
  }

  handleMouseUp(): void {
    this._dragging = false;
  }

  /**
   * Render the panel. Call every frame after world rendering.
   * @param npcs  Full NPC list from WorldState (will be filtered to shipId)
   * @param shipId  Player's current ship. Pass 0 when not aboard — hides panel.
   */
  render(ctx: CanvasRenderingContext2D, npcs: Npc[], shipId: number, localCompanyId: number = 0): void {
    this.hitAreas = [];
    if (shipId === 0) return; // Not on a ship — nothing to manage

    // Store shipId + npcs for use in action callbacks
    if (this._currentShipId !== shipId) {
      // Ship changed — reset everything so the new ship gets a full sync
      this.lastSentAssignment.clear();
      for (const list of this.taskNpcs.values()) list.length = 0;
    }
    this._currentShipId = shipId;
    this._currentNpcs = npcs;
    this._localCompanyId = localCompanyId;

    const tasks = this.priorityOrder;
    const { panelX: px, panelY: py, PW: pw, HEADER_H, ROW_H } = this;
    const panelH = HEADER_H + tasks.length * ROW_H + 6;

    ctx.save();

    // ---- Panel background ----
    ctx.fillStyle = 'rgba(6, 14, 34, 0.88)';
    ctx.strokeStyle = 'rgba(80, 140, 220, 0.45)';
    ctx.lineWidth = 1;
    this.roundRect(ctx, px, py, pw, panelH, 7);
    ctx.fill();
    ctx.stroke();

    // ---- Header bar ----
    ctx.fillStyle = 'rgba(255,255,255,0.07)';
    this.roundRect(ctx, px + 1, py + 1, pw - 2, HEADER_H - 1, 6);
    ctx.fill();

    ctx.fillStyle = '#aac8ff';
    ctx.font = 'bold 11px Georgia, serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('CREW PRIORITY', px + pw / 2, py + HEADER_H / 2);

    // Minimize toggle button (top-right of header)
    const minLabel = this._minimized ? '▶' : '▼';
    ctx.fillStyle = 'rgba(255,255,255,0.15)';
    ctx.fillRect(px + pw - 20, py + 3, 17, HEADER_H - 6);
    ctx.fillStyle = '#aac8ff';
    ctx.font = '9px Georgia, serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(minLabel, px + pw - 11, py + HEADER_H / 2);

    if (this._minimized) {
      ctx.restore();
      return;
    }

    // ---- NPC pool: sort by ID (stable), same company only ----
    const shipNpcs = npcs
      .filter(n => n.shipId === shipId && n.companyId === localCompanyId)
      .sort((a, b) => a.id - b.id);

    // Prune stale NPC IDs (left ship / disconnected)
    const shipNpcIdSet = new Set(shipNpcs.map(n => n.id));
    for (const list of this.taskNpcs.values()) {
      for (let i = list.length - 1; i >= 0; i--) {
        if (!shipNpcIdSet.has(list[i])) list.splice(i, 1);
      }
    }

    // ── Server-role reconciliation ──────────────────────────────────────────
    // Sync taskNpcs with the broadcast npc.role so that npc_goto_module changes
    // are reflected immediately without waiting for + / - button presses.
    // Mapping: role 1 (GUNNER) → Gunners, role 3 (RIGGER) → Sails,
    //          role 4 (REPAIRER) → Repairs, role 0/2 → Idle (no task pin).
    const ROLE_TO_TASK: Record<number, ManningTask | null> = {
      0: null,  // NONE    → Idle
      1: 'Gunners',
      2: null,  // HELMSMAN → not tracked in panel
      3: 'Sails',
      4: 'Repairs',
    };
    for (const npc of shipNpcs) {
      const desiredTask = ROLE_TO_TASK[npc.role] ?? null;

      // Determine which task (if any) the NPC is currently pinned to
      let currentTask: ManningTask | null = null;
      for (const [t, ids] of this.taskNpcs) {
        if (ids.includes(npc.id)) { currentTask = t; break; }
      }

      if (desiredTask === null) {
        // Role is NONE / HELMSMAN — ensure the NPC is not pinned to any task
        if (currentTask !== null) {
          const list = this.taskNpcs.get(currentTask)!;
          list.splice(list.indexOf(npc.id), 1);
          // Mark as Idle in sent-state so the panel won't re-send a crew_assign
          this.lastSentAssignment.set(npc.id, 'Idle');
        }
      } else if (currentTask !== desiredTask) {
        // Role changed to a different task — move the pin
        if (currentTask !== null) {
          const oldList = this.taskNpcs.get(currentTask)!;
          oldList.splice(oldList.indexOf(npc.id), 1);
        }
        this.taskNpcs.get(desiredTask)!.push(npc.id);
        // Silence the delta-send so we don't echo back what the server already did
        this.lastSentAssignment.set(npc.id, desiredTask);
      }
    }
    // ── end reconciliation ──────────────────────────────────────────────────

    const assignments = this.computeAssignments(shipNpcs);

    // Update lastTaskMap so RenderSystem can tint NPCs by assigned task
    this.lastTaskMap.clear();
    for (const [task, assigned] of assignments) {
      for (const n of assigned) this.lastTaskMap.set(n.id, task);
    }
    for (const n of shipNpcs) {
      if (!this.lastTaskMap.has(n.id)) this.lastTaskMap.set(n.id, 'Idle');
    }

    // + is only enabled when at least one NPC is genuinely idle (not pinned to any task)
    const assignedIdSet = new Set(Array.from(this.taskNpcs.values()).flat());
    const canIncrement = shipNpcs.some(n => !assignedIdSet.has(n.id));

    let rowY = py + HEADER_H + 3;

    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      const count = this.taskNpcs.get(task)?.length ?? 0;
      const assignedNpcs = assignments.get(task) ?? [];
      const color = TASK_COLORS[task];

      // Divider between rows
      if (i > 0) {
        ctx.strokeStyle = 'rgba(255,255,255,0.07)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(px + 4, rowY);
        ctx.lineTo(px + pw - 4, rowY);
        ctx.stroke();
      }

      const rowMidY = rowY + ROW_H / 2;

      // ---- Priority arrows (▲ / ▼) ----
      const arrowX = px + 4;
      const upBtn  = { x: arrowX, y: rowY + 4,  w: 15, h: 17 };
      const dnBtn  = { x: arrowX, y: rowY + 25, w: 15, h: 17 };

      const canUp = i > 0;
      const canDn = i < tasks.length - 1;

      this.drawArrowBtn(ctx, upBtn, '▲', canUp);
      this.drawArrowBtn(ctx, dnBtn, '▼', canDn);

      if (canUp) this.hitAreas.push({ ...upBtn, action: () => this.moveUp(i) });
      if (canDn) this.hitAreas.push({ ...dnBtn, action: () => this.moveDown(i) });

      // ---- Task name ----
      ctx.fillStyle = color;
      ctx.font = 'bold 12px Georgia, serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(task.toUpperCase(), px + 24, rowMidY - 6);

      // ---- Assigned NPC chips (small text row) ----
      if (assignedNpcs.length > 0) {
        const chipParts = assignedNpcs.map(n => {
          const avail = n.state !== NPC_STATE_AT_GUN && n.state !== NPC_STATE_REPAIRING;
          return `#${n.id}${avail ? '' : '●'}`;
        });
        ctx.fillStyle = 'rgba(200,220,255,0.65)';
        ctx.font = '9px Georgia, serif';
        ctx.fillText(chipParts.join('  '), px + 24, rowMidY + 8);
      } else {
        ctx.fillStyle = 'rgba(180,180,180,0.25)';
        ctx.font = '9px Georgia, serif';
        ctx.fillText('no crew', px + 24, rowMidY + 8);
      }

      // ---- Count + buttons (right side) ----
      const right = px + pw - 5;
      const plusBtn  = { x: right - 16, y: rowY + 14, w: 16, h: 17 };
      const minusBtn = { x: right - 36, y: rowY + 14, w: 16, h: 17 };
      const badgeX   = right - 52;

      this.drawCountBtn(ctx, plusBtn,  '+', canIncrement);
      this.drawCountBtn(ctx, minusBtn, '−', count > 0);

      // Count badge background
      ctx.fillStyle = 'rgba(255,255,255,0.10)';
      ctx.fillRect(badgeX - 14, rowY + 14, 14, 17);
      ctx.fillStyle = '#e8f0ff';
      ctx.font = 'bold 10px Georgia, serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(count), badgeX - 7, rowY + 14 + 8);

      this.hitAreas.push({ ...plusBtn,  action: () => this.increment(task) });
      if (count > 0) {
        this.hitAreas.push({ ...minusBtn, action: () => this.decrement(task) });
      }

      rowY += ROW_H;
    }

    ctx.restore();
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private computeAssignments(npcs: Npc[]): Map<ManningTask, Npc[]> {
    const npcById = new Map(npcs.map(n => [n.id, n]));
    const result = new Map<ManningTask, Npc[]>();
    for (const task of this.priorityOrder) {
      const ids = this.taskNpcs.get(task) ?? [];
      result.set(task, ids.map(id => npcById.get(id)).filter((n): n is Npc => n !== undefined));
    }
    return result;
  }

  private moveUp(i: number): void {
    if (i <= 0) return;
    [this.priorityOrder[i - 1], this.priorityOrder[i]] =
      [this.priorityOrder[i], this.priorityOrder[i - 1]];
    // Display-only reorder — pinned NPC assignments don't change, no server message needed
  }

  private moveDown(i: number): void {
    if (i >= this.priorityOrder.length - 1) return;
    [this.priorityOrder[i], this.priorityOrder[i + 1]] =
      [this.priorityOrder[i + 1], this.priorityOrder[i]];
    // Display-only reorder — pinned NPC assignments don't change, no server message needed
  }

  private increment(task: ManningTask): void {
    const shipNpcs = this._currentNpcs
      .filter(n => n.shipId === this._currentShipId && n.companyId === this._localCompanyId)
      .sort((a, b) => a.id - b.id);
    const assigned = new Set(Array.from(this.taskNpcs.values()).flat());
    // Only pick from genuinely idle NPCs — never steal from another task
    const idle = shipNpcs.filter(n => !assigned.has(n.id));
    if (idle.length === 0) return;
    // Prefer a non-stationed NPC (state !== AT_CANNON/REPAIRING) to avoid interrupting active work
    const pick = idle.find(n => n.state !== NPC_STATE_AT_GUN && n.state !== NPC_STATE_REPAIRING) ?? idle[0];
    this.taskNpcs.get(task)!.push(pick.id);
    this.notifyAssignment();
  }

  private decrement(task: ManningTask): void {
    const list = this.taskNpcs.get(task);
    if (!list || list.length === 0) return;
    list.pop();
    this.notifyAssignment();
  }

  private notifyAssignment(): void {
    if (!this.onAssignmentChanged || this._currentShipId === 0) return;
    // Use the same stable ID-only sort so computed assignments match the displayed panel
    const shipNpcs = this._currentNpcs
      .filter(n => n.shipId === this._currentShipId && n.companyId === this._localCompanyId)
      .sort((a, b) => a.id - b.id);
    const assignments = this.computeAssignments(shipNpcs);

    // Only send assignments that CHANGED since the last send (delta) to avoid
    // displacing active NPCs with re-sent conflicting instructions.
    const out: Array<{ npcId: number; task: string }> = [];
    const assigned = new Set<number>();
    for (const [task, npcs] of assignments) {
      for (const npc of npcs) {
        if (this.lastSentAssignment.get(npc.id) !== task) {
          out.push({ npcId: npc.id, task });
          this.lastSentAssignment.set(npc.id, task);
        }
        assigned.add(npc.id);
      }
    }
    // Unassigned NPCs get task "Idle" — only send if previously had a different task
    for (const npc of shipNpcs) {
      if (!assigned.has(npc.id)) {
        if (this.lastSentAssignment.get(npc.id) !== 'Idle') {
          out.push({ npcId: npc.id, task: 'Idle' });
          this.lastSentAssignment.set(npc.id, 'Idle');
        }
      }
    }
    if (out.length > 0) {
      this.onAssignmentChanged(this._currentShipId, out);
    }
  }

  private drawArrowBtn(
    ctx: CanvasRenderingContext2D,
    btn: { x: number; y: number; w: number; h: number },
    label: string,
    active: boolean
  ): void {
    ctx.fillStyle = active ? 'rgba(255,255,255,0.13)' : 'rgba(255,255,255,0.03)';
    ctx.fillRect(btn.x, btn.y, btn.w, btn.h);
    ctx.fillStyle = active ? '#aac8ff' : 'rgba(255,255,255,0.18)';
    ctx.font = '9px Georgia, serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, btn.x + btn.w / 2, btn.y + btn.h / 2);
  }

  private drawCountBtn(
    ctx: CanvasRenderingContext2D,
    btn: { x: number; y: number; w: number; h: number },
    label: string,
    active: boolean
  ): void {
    ctx.fillStyle = active ? 'rgba(80,140,255,0.22)' : 'rgba(255,255,255,0.04)';
    ctx.strokeStyle = active ? 'rgba(100,160,255,0.5)' : 'rgba(255,255,255,0.09)';
    ctx.lineWidth = 1;
    ctx.fillRect(btn.x, btn.y, btn.w, btn.h);
    ctx.strokeRect(btn.x, btn.y, btn.w, btn.h);
    ctx.fillStyle = active ? '#aac8ff' : 'rgba(255,255,255,0.22)';
    ctx.font = 'bold 13px Georgia, serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, btn.x + btn.w / 2, btn.y + btn.h / 2);
  }

  private roundRect(
    ctx: CanvasRenderingContext2D,
    x: number, y: number, w: number, h: number, r: number
  ): void {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h);
    ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
  }
}
