/**
 * Manning Priority Panel
 *
 * Left-side HUD panel for assigning NPC crew to tasks by priority.
 * Tasks: Sails, Cannons, Repairs, Combat.
 * NPCs are allocated top-to-bottom through the priority list;
 * available NPCs (not currently busy) are assigned first, ties broken by ID.
 */

import { Npc } from '../../sim/Types.js';

export type ManningTask = 'Sails' | 'Cannons' | 'Repairs' | 'Combat';

/** NPC state constants (mirror server WorldNpcState) */
const NPC_STATE_AT_CANNON = 2;

/** NPC role constants (mirror server NpcRole) */
const NPC_ROLE_GUNNER = 1;
const NPC_ROLE_RIGGER = 3;

/** Which role is preferred for each task (0 = any) */
const TASK_PREFERRED_ROLE: Record<ManningTask, number> = {
  Sails:   NPC_ROLE_RIGGER,
  Cannons: NPC_ROLE_GUNNER,
  Repairs: 0,
  Combat:  NPC_ROLE_GUNNER,
};

const TASK_COLORS: Record<ManningTask, string> = {
  Sails:   '#5aafff',
  Cannons: '#ffaa44',
  Repairs: '#55dd66',
  Combat:  '#ff5555',
};

interface HitArea {
  x: number; y: number; w: number; h: number;
  action: () => void;
}

export class ManningPriorityPanel {
  // Mutable priority order (index 0 = highest priority)
  private priorityOrder: ManningTask[] = ['Sails', 'Cannons', 'Repairs', 'Combat'];

  // How many NPC slots to fill for each task (all start at 0 — crew begins idle)
  private assignedCounts: Map<ManningTask, number> = new Map([
    ['Sails',   0],
    ['Cannons', 0],
    ['Repairs', 0],
    ['Combat',  0],
  ]);

  private hitAreas: HitArea[] = [];

  // npcId → task name for the most-recently rendered frame (fed to RenderSystem for NPC colours)
  private lastTaskMap: Map<number, string> = new Map();
  private _currentShipId = 0;
  private _currentNpcs: Npc[] = [];

  /**
   * Fires whenever assignments change. Carries the full list of {npcId, task} including
   * "Idle" for any NPC not allocated to an active task.
   * Set this before calling render() — it needs access to the current NPC list.
   */
  public onAssignmentChanged: ((shipId: number, assignments: Array<{ npcId: number; task: string }>) => void) | null = null;

  /** Returns the most-recently-computed npcId → task name map (read-only). */
  getTaskMap(): ReadonlyMap<number, string> { return this.lastTaskMap; }

  // Panel geometry (screen-space, fixed on left side)
  private readonly PX = 10;
  private readonly PY = 60;
  private readonly PW = 192;
  private readonly HEADER_H = 26;
  private readonly ROW_H = 46;

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Try to consume a canvas click. Returns true if the click was inside the panel.
   */
  handleClick(cx: number, cy: number): boolean {
    for (const area of this.hitAreas) {
      if (cx >= area.x && cx < area.x + area.w && cy >= area.y && cy < area.y + area.h) {
        area.action();
        return true;
      }
    }
    return false;
  }

  /**
   * Render the panel. Call every frame after world rendering.
   * @param npcs  Full NPC list from WorldState (will be filtered to shipId)
   * @param shipId  Player's current ship. Pass 0 when not aboard — hides panel.
   */
  render(ctx: CanvasRenderingContext2D, npcs: Npc[], shipId: number): void {
    this.hitAreas = [];
    if (shipId === 0) return; // Not on a ship — nothing to manage

    // Store shipId + npcs for use in action callbacks
    this._currentShipId = shipId;
    this._currentNpcs = npcs;

    const tasks = this.priorityOrder;
    const { PX: px, PY: py, PW: pw, HEADER_H, ROW_H } = this;
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
    ctx.font = 'bold 11px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('CREW PRIORITY', px + pw / 2, py + HEADER_H / 2);

    // ---- NPC pool: sort available first, then by ID ----
    const shipNpcs = npcs
      .filter(n => n.shipId === shipId)
      .sort((a, b) => {
        const aAvail = a.state !== NPC_STATE_AT_CANNON ? 0 : 1;
        const bAvail = b.state !== NPC_STATE_AT_CANNON ? 0 : 1;
        return aAvail !== bAvail ? aAvail - bAvail : a.id - b.id;
      });

    const assignments = this.computeAssignments(shipNpcs);

    // Update lastTaskMap so RenderSystem can tint NPCs by assigned task
    this.lastTaskMap.clear();
    for (const [task, assigned] of assignments) {
      for (const n of assigned) this.lastTaskMap.set(n.id, task);
    }
    for (const n of shipNpcs) {
      if (!this.lastTaskMap.has(n.id)) this.lastTaskMap.set(n.id, 'Idle');
    }

    const totalAssigned = Array.from(this.assignedCounts.values()).reduce((a, b) => a + b, 0);
    const canIncrement = shipNpcs.length > 0 && totalAssigned < shipNpcs.length;

    let rowY = py + HEADER_H + 3;

    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      const count = this.assignedCounts.get(task) ?? 0;
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
      ctx.font = 'bold 12px monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(task.toUpperCase(), px + 24, rowMidY - 6);

      // ---- Assigned NPC chips (small text row) ----
      if (assignedNpcs.length > 0) {
        const chipParts = assignedNpcs.map(n => {
          const avail = n.state !== NPC_STATE_AT_CANNON;
          return `#${n.id}${avail ? '' : '●'}`;
        });
        ctx.fillStyle = 'rgba(200,220,255,0.65)';
        ctx.font = '9px monospace';
        ctx.fillText(chipParts.join('  '), px + 24, rowMidY + 8);
      } else {
        ctx.fillStyle = 'rgba(180,180,180,0.25)';
        ctx.font = '9px monospace';
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
      ctx.font = 'bold 10px monospace';
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
    const result = new Map<ManningTask, Npc[]>();
    const used = new Set<number>();

    for (const task of this.priorityOrder) {
      const want = this.assignedCounts.get(task) ?? 0;
      const preferRole = TASK_PREFERRED_ROLE[task];
      const assigned: Npc[] = [];

      // First pass: role-matching NPCs (available ones come first due to outer sort)
      for (const npc of npcs) {
        if (used.has(npc.id)) continue;
        if (assigned.length >= want) break;
        if (preferRole !== 0 && npc.role !== preferRole) continue;
        assigned.push(npc);
        used.add(npc.id);
      }

      result.set(task, assigned);
    }
    return result;
  }

  private moveUp(i: number): void {
    if (i <= 0) return;
    [this.priorityOrder[i - 1], this.priorityOrder[i]] =
      [this.priorityOrder[i], this.priorityOrder[i - 1]];
    this.notifyAssignment();
  }

  private moveDown(i: number): void {
    if (i >= this.priorityOrder.length - 1) return;
    [this.priorityOrder[i], this.priorityOrder[i + 1]] =
      [this.priorityOrder[i + 1], this.priorityOrder[i]];
    this.notifyAssignment();
  }

  private increment(task: ManningTask): void {
    const shipNpcs = this._currentNpcs.filter(n => n.shipId === this._currentShipId);
    const totalAssigned = Array.from(this.assignedCounts.values()).reduce((a, b) => a + b, 0);
    if (totalAssigned >= shipNpcs.length) return;

    this.assignedCounts.set(task, (this.assignedCounts.get(task) ?? 0) + 1);
    this.notifyAssignment();
  }

  private decrement(task: ManningTask): void {
    this.assignedCounts.set(task, Math.max(0, (this.assignedCounts.get(task) ?? 0) - 1));
    this.notifyAssignment();
  }

  private notifyAssignment(): void {
    if (!this.onAssignmentChanged || this._currentShipId === 0) return;
    const shipNpcs = this._currentNpcs
      .filter(n => n.shipId === this._currentShipId)
      .sort((a, b) => {
        const aAvail = a.state !== NPC_STATE_AT_CANNON ? 0 : 1;
        const bAvail = b.state !== NPC_STATE_AT_CANNON ? 0 : 1;
        return aAvail !== bAvail ? aAvail - bAvail : a.id - b.id;
      });
    const assignments = this.computeAssignments(shipNpcs);
    const out: Array<{ npcId: number; task: string }> = [];
    const assigned = new Set<number>();
    for (const [task, npcs] of assignments) {
      for (const npc of npcs) {
        out.push({ npcId: npc.id, task });
        assigned.add(npc.id);
      }
    }
    // Unassigned NPCs get task "Idle"
    for (const npc of shipNpcs) {
      if (!assigned.has(npc.id)) out.push({ npcId: npc.id, task: 'Idle' });
    }
    this.onAssignmentChanged(this._currentShipId, out);
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
    ctx.font = '9px monospace';
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
    ctx.font = 'bold 13px monospace';
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
