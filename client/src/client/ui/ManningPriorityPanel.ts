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

export type ManningTask   = 'Sails' | 'Gunners' | 'Repairs' | 'Combat';
export type RepairTarget  = 'Deck' | 'Planks' | 'Sails' | 'Weapons' | 'Steering' | 'Misc';
export type RepairCrewGroup = 'Repairs' | 'Buckets';

/** NPC state constants (mirror server WorldNpcState) */
const NPC_STATE_AT_GUN = 2;
const NPC_STATE_REPAIRING = 3;

const TASK_COLORS: Record<ManningTask, string> = {
  Sails:   '#5aafff',
  Gunners: '#ffaa44',
  Repairs: '#55dd66',
  Combat:  '#aa44ff',
};

const REPAIR_COLORS: Record<RepairTarget, string> = {
  Deck:     '#7fd4c8',
  Planks:   '#c8963c',
  Sails:    '#c8d888',
  Weapons:  '#dd6666',
  Steering: '#88aaee',
  Misc:     '#999999',
};

const REPAIR_CREW_COLORS: Record<RepairCrewGroup, string> = {
  Repairs: '#55dd66',
  Buckets: '#44bbee',
};

const REPAIR_CREW_GROUPS: RepairCrewGroup[] = ['Repairs', 'Buckets'];

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

  // Repair crew subgroup — splits the Repairs crew task into repair vs bucket duty.
  private repairCrewNpcs: Map<RepairCrewGroup, number[]> = new Map([
    ['Repairs', []],
    ['Buckets', []],
  ]);
  private repairCrewSentAssignment: Map<number, RepairCrewGroup> = new Map();

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

  /** Returns the current repair priority order (read-only). */
  getRepairOrder(): readonly RepairTarget[] { return this.repairOrder; }

  /**
   * Called when the local player boards a new ship.
   * Seeds the task panel from the authoritative NPC states already in the world state
   * so the UI reflects reality instead of stale assignments from the previous ship.
   */
  syncFromBoarding(npcs: Npc[], shipId: number, localCompanyId: number = 0): void {
    this._currentShipId = shipId;
    this._localCompanyId = localCompanyId;
    this.lastSentAssignment.clear();
    this.repairCrewSentAssignment.clear();
    for (const list of this.taskNpcs.values()) list.length = 0;
    for (const list of this.repairCrewNpcs.values()) list.length = 0;
    this.lastTaskMap.clear();
    if (shipId === 0) return;

    const shipNpcs = npcs.filter(n => n.shipId === shipId && n.companyId === localCompanyId);

    // Seed task lists from the server-authoritative NPC role field.
    // role 1 = Gunner  → Gunners
    // role 3 = Rigger  → Sails
    // role 4 = Repairer → Repairs crew + Repairs subgroup
    // role 5 = Bucket bailer → Repairs crew + Buckets subgroup
    for (const npc of shipNpcs) {
      if (npc.role === 1) {
        this.taskNpcs.get('Gunners')?.push(npc.id);
      } else if (npc.role === 3) {
        this.taskNpcs.get('Sails')?.push(npc.id);
      } else if (npc.role === 4 || npc.role === 5) {
        this.taskNpcs.get('Repairs')?.push(npc.id);
        if (npc.role === 5) {
          this.repairCrewNpcs.get('Buckets')?.push(npc.id);
        } else {
          this.repairCrewNpcs.get('Repairs')?.push(npc.id);
        }
      }
      // role 0 (None) / role 2 (Helmsman) → unassigned
    }

    // Rebuild lastTaskMap from seeded assignments
    const npcById = new Map(shipNpcs.map(n => [n.id, n]));
    for (const [task, ids] of this.taskNpcs) {
      for (const id of ids) {
        if (!npcById.has(id)) continue;
        if (task === 'Repairs' && this.repairCrewNpcs.get('Buckets')?.includes(id)) {
          this.lastTaskMap.set(id, 'Buckets');
        } else {
          this.lastTaskMap.set(id, task);
        }
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

  // Active tab
  private activeTab: 'crew' | 'repair' = 'crew';
  // Repair priority order (index 0 = highest priority)
  private repairOrder: RepairTarget[] = ['Deck', 'Planks', 'Sails', 'Weapons', 'Steering', 'Misc'];

  // Row drag-to-reorder state
  private _rowDragTab: 'crew' | 'repair' | null = null;
  private _rowDragFromIndex = -1;
  private _rowDragCurrentY = 0;

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

    // Row drag — clicked inside panel content below the tab strip but not on any button
    {
      const { panelX: px, panelY: py, PW: pw, HEADER_H, ROW_H } = this;
      const TAB_H = 20;
      const REPAIR_ROW_H = 30;
      const REPAIR_GROUP_H = 36;
      const rowH = this.activeTab === 'crew' ? ROW_H : REPAIR_ROW_H;
      const contentStartY = py + HEADER_H + TAB_H + 3;
      if (this.activeTab === 'repair') {
        const moduleStartY = contentStartY + REPAIR_CREW_GROUPS.length * REPAIR_GROUP_H + 14;
        const ri = Math.floor((cy - moduleStartY) / REPAIR_ROW_H);
        if (cx >= px && cx < px + pw && ri >= 0 && ri < this.repairOrder.length) {
          this._rowDragTab = 'repair';
          this._rowDragFromIndex = ri;
          this._rowDragCurrentY = cy;
          return true;
        }
        return false;
      }
      const orderLen = this.priorityOrder.length;
      const ri = Math.floor((cy - contentStartY) / rowH);
      if (cx >= px && cx < px + pw && ri >= 0 && ri < orderLen) {
        this._rowDragTab      = this.activeTab;
        this._rowDragFromIndex = ri;
        this._rowDragCurrentY  = cy;
        return true;
      }
    }
    return false;
  }

  handleMouseMove(cx: number, cy: number): void {
    if (this._dragging) {
      this.panelX = cx - this._dragOffX;
      this.panelY = cy - this._dragOffY;
      return;
    }
    if (this._rowDragFromIndex >= 0) {
      this._rowDragCurrentY = cy;
    }
  }

  handleMouseUp(): void {
    this._dragging = false;
    if (this._rowDragFromIndex >= 0 && this._rowDragTab !== null) {
      const TAB_H = 20;
      const REPAIR_ROW_H = 30;
      const { panelY: py, HEADER_H, ROW_H } = this;
      const contentStartY = py + HEADER_H + TAB_H + 3;
      const from = this._rowDragFromIndex;
      if (this._rowDragTab === 'crew') {
        const order = this.priorityOrder;
        const to = Math.max(0, Math.min(order.length - 1,
          Math.floor((this._rowDragCurrentY - contentStartY) / ROW_H)));
        if (to !== from) { const [item] = order.splice(from, 1); order.splice(to, 0, item); }
      } else {
        const REPAIR_GROUP_H = 36;
        const order = this.repairOrder;
        const contentStartY = py + HEADER_H + TAB_H + 3;
        const moduleStartY = contentStartY + REPAIR_CREW_GROUPS.length * REPAIR_GROUP_H + 14;
        const to = Math.max(0, Math.min(order.length - 1,
          Math.floor((this._rowDragCurrentY - moduleStartY) / REPAIR_ROW_H)));
        if (to !== from) { const [item] = order.splice(from, 1); order.splice(to, 0, item); }
      }
      this._rowDragTab       = null;
      this._rowDragFromIndex  = -1;
    }
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
      this.lastSentAssignment.clear();
      this.repairCrewSentAssignment.clear();
      for (const list of this.taskNpcs.values()) list.length = 0;
      for (const list of this.repairCrewNpcs.values()) list.length = 0;
    }
    this._currentShipId = shipId;
    this._currentNpcs = npcs;
    this._localCompanyId = localCompanyId;

    const tasks = this.priorityOrder;
    const { panelX: px, panelY: py, PW: pw, HEADER_H, ROW_H } = this;
    const REPAIR_ROW_H = 30;
    const TAB_H = 20;
    const REPAIR_GROUP_H = 36;
    const rowCount = this.activeTab === 'crew'
      ? tasks.length
      : REPAIR_CREW_GROUPS.length + 1 + this.repairOrder.length;
    const rowH    = this.activeTab === 'crew' ? ROW_H : REPAIR_ROW_H;
    const panelH  = this.activeTab === 'crew'
      ? HEADER_H + TAB_H + rowCount * rowH + 6
      : HEADER_H + TAB_H + REPAIR_CREW_GROUPS.length * REPAIR_GROUP_H + 14 + this.repairOrder.length * REPAIR_ROW_H + 6;

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
    ctx.fillText(this.activeTab === 'crew' ? 'CREW PRIORITY' : 'REPAIR PRIORITY', px + pw / 2, py + HEADER_H / 2);

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

    // ---- Tab strip ----
    const tabW = pw / 2;
    const tabY = py + HEADER_H;
    const tabDefs: Array<{ label: string; value: 'crew' | 'repair' }> = [
      { label: 'CREW',   value: 'crew'   },
      { label: 'REPAIR', value: 'repair' },
    ];
    for (let t = 0; t < tabDefs.length; t++) {
      const tab = tabDefs[t];
      const tx = px + t * tabW;
      const tabActive = this.activeTab === tab.value;
      ctx.fillStyle = tabActive ? 'rgba(80,140,220,0.30)' : 'rgba(255,255,255,0.05)';
      ctx.fillRect(tx, tabY, tabW, TAB_H);
      ctx.strokeStyle = tabActive ? 'rgba(100,160,255,0.50)' : 'rgba(255,255,255,0.10)';
      ctx.lineWidth = 1;
      ctx.strokeRect(tx, tabY, tabW, TAB_H);
      ctx.fillStyle = tabActive ? '#aac8ff' : 'rgba(180,200,255,0.45)';
      ctx.font = 'bold 9px Georgia, serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(tab.label, tx + tabW / 2, tabY + TAB_H / 2);
      const capturedValue = tab.value;
      this.hitAreas.push({ x: tx, y: tabY, w: tabW, h: TAB_H, action: () => { this.activeTab = capturedValue; } });
    }
    // Separator line below tab strip
    ctx.strokeStyle = 'rgba(80,140,220,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(px, tabY + TAB_H);
    ctx.lineTo(px + pw, tabY + TAB_H);
    ctx.stroke();

    // ---- Route to repair tab if active ----
    if (this.activeTab === 'repair') {
      this.renderRepairTab(ctx, px, py, pw, REPAIR_ROW_H, TAB_H, npcs, shipId, localCompanyId);
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
      0: null,
      1: 'Gunners',
      2: null,
      3: 'Sails',
      4: 'Repairs',
      5: 'Repairs',
    };
    const ROLE_TO_REPAIR_CREW: Record<number, RepairCrewGroup | null> = {
      4: 'Repairs',
      5: 'Buckets',
    };
    for (const npc of shipNpcs) {
      const desiredTask = ROLE_TO_TASK[npc.role] ?? null;
      const desiredRepairCrew = ROLE_TO_REPAIR_CREW[npc.role] ?? null;

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

      if (desiredRepairCrew) {
        for (const g of REPAIR_CREW_GROUPS) {
          const gl = this.repairCrewNpcs.get(g)!;
          const idx = gl.indexOf(npc.id);
          if (idx >= 0) gl.splice(idx, 1);
        }
        this.repairCrewNpcs.get(desiredRepairCrew)!.push(npc.id);
        this.repairCrewSentAssignment.set(npc.id, desiredRepairCrew);
      } else {
        for (const g of REPAIR_CREW_GROUPS) {
          const gl = this.repairCrewNpcs.get(g)!;
          const idx = gl.indexOf(npc.id);
          if (idx >= 0) gl.splice(idx, 1);
        }
      }
    }
    // ── end reconciliation ──────────────────────────────────────────────────

    const assignments = this.computeAssignments(shipNpcs);

    // Update lastTaskMap so RenderSystem can tint NPCs by assigned task
    this.lastTaskMap.clear();
    for (const [task, assigned] of assignments) {
      for (const n of assigned) {
        if (task === 'Repairs' && this.repairCrewNpcs.get('Buckets')?.includes(n.id)) {
          this.lastTaskMap.set(n.id, 'Buckets');
        } else {
          this.lastTaskMap.set(n.id, task);
        }
      }
    }
    for (const n of shipNpcs) {
      if (!this.lastTaskMap.has(n.id)) this.lastTaskMap.set(n.id, 'Idle');
    }

    // + is only enabled when at least one NPC is genuinely idle (not pinned to any task)
    const assignedIdSet = new Set(Array.from(this.taskNpcs.values()).flat());
    const canIncrement = shipNpcs.some(n => !assignedIdSet.has(n.id));

    let rowY = py + HEADER_H + TAB_H + 3;

    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      const count = this.taskNpcs.get(task)?.length ?? 0;
      const assignedNpcs = assignments.get(task) ?? [];
      const color = TASK_COLORS[task];
      // Dim this row while it is being dragged
      const _crewRowDragging = this._rowDragTab === 'crew' && this._rowDragFromIndex === i;
      if (_crewRowDragging) { ctx.save(); ctx.globalAlpha *= 0.3; }

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

      if (_crewRowDragging) ctx.restore();
      rowY += ROW_H;
    }

    // ---- Row drag overlay (drop indicator + ghost) ----
    if (this._rowDragTab === 'crew' && this._rowDragFromIndex >= 0) {
      const contentStartY = py + HEADER_H + TAB_H + 3;
      const dropIdx = Math.max(0, Math.min(tasks.length - 1,
        Math.floor((this._rowDragCurrentY - contentStartY) / ROW_H)));
      // Highlight target row background
      ctx.fillStyle = 'rgba(80,140,220,0.18)';
      ctx.fillRect(px + 2, contentStartY + dropIdx * ROW_H, pw - 4, ROW_H - 1);
      // Drop indicator line at top of target row
      ctx.strokeStyle = '#aac8ff';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(px + 4, contentStartY + dropIdx * ROW_H);
      ctx.lineTo(px + pw - 4, contentStartY + dropIdx * ROW_H);
      ctx.stroke();
      // Ghost row following the cursor
      const ghostLabel = tasks[this._rowDragFromIndex];
      const ghostY = Math.max(contentStartY,
        Math.min(contentStartY + (tasks.length - 1) * ROW_H, this._rowDragCurrentY - ROW_H / 2));
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = 'rgba(20,50,120,0.90)';
      ctx.strokeStyle = '#aac8ff';
      ctx.lineWidth = 1;
      ctx.fillRect(px + 4, ghostY, pw - 8, ROW_H - 4);
      ctx.strokeRect(px + 4, ghostY, pw - 8, ROW_H - 4);
      ctx.globalAlpha = 1;
      ctx.fillStyle = TASK_COLORS[ghostLabel];
      ctx.font = 'bold 12px Georgia, serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText('⣿ ' + ghostLabel.toUpperCase(), px + 14, ghostY + (ROW_H - 4) / 2);
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
    if (task === 'Repairs') {
      this.repairCrewNpcs.get('Repairs')!.push(pick.id);
    }
    this.notifyAssignment();
  }

  private decrement(task: ManningTask): void {
    const list = this.taskNpcs.get(task);
    if (!list || list.length === 0) return;
    const removed = list.pop()!;
    if (task === 'Repairs') {
      for (const g of REPAIR_CREW_GROUPS) {
        const gl = this.repairCrewNpcs.get(g)!;
        const idx = gl.indexOf(removed);
        if (idx >= 0) gl.splice(idx, 1);
      }
    }
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
        const sendTask = (task === 'Repairs' && this.repairCrewNpcs.get('Buckets')?.includes(npc.id))
          ? 'Buckets'
          : task;
        if (this.lastSentAssignment.get(npc.id) !== sendTask) {
          out.push({ npcId: npc.id, task: sendTask });
          this.lastSentAssignment.set(npc.id, sendTask);
          if (task === 'Repairs') {
            const subgroup: RepairCrewGroup = sendTask === 'Buckets' ? 'Buckets' : 'Repairs';
            this.repairCrewSentAssignment.set(npc.id, subgroup);
          }
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

  private renderRepairTab(
    ctx: CanvasRenderingContext2D,
    px: number, py: number, pw: number,
    rowH: number, tabH: number,
    npcs: Npc[], shipId: number, localCompanyId: number
  ): void {
    const REPAIR_GROUP_H = 36;
    const shipNpcs = npcs
      .filter(n => n.shipId === shipId && n.companyId === localCompanyId)
      .sort((a, b) => a.id - b.id);
    const shipNpcIdSet = new Set(shipNpcs.map(n => n.id));

    for (const list of this.taskNpcs.values()) {
      for (let i = list.length - 1; i >= 0; i--) {
        if (!shipNpcIdSet.has(list[i])) list.splice(i, 1);
      }
    }
    for (const list of this.repairCrewNpcs.values()) {
      for (let i = list.length - 1; i >= 0; i--) {
        if (!shipNpcIdSet.has(list[i])) list.splice(i, 1);
      }
    }

    const repairCrewIds = this.taskNpcs.get('Repairs') ?? [];
    const repairCrewSet = new Set(repairCrewIds);
    for (const g of REPAIR_CREW_GROUPS) {
      const gl = this.repairCrewNpcs.get(g)!;
      for (let i = gl.length - 1; i >= 0; i--) {
        if (!repairCrewSet.has(gl[i])) gl.splice(i, 1);
      }
    }
    for (const id of repairCrewIds) {
      const inSubgroup = REPAIR_CREW_GROUPS.some(g => this.repairCrewNpcs.get(g)!.includes(id));
      if (!inSubgroup) this.repairCrewNpcs.get('Repairs')!.push(id);
    }

    const npcById = new Map(shipNpcs.map(n => [n.id, n]));
    let rowY = py + this.HEADER_H + tabH + 3;

    ctx.fillStyle = 'rgba(180,200,255,0.45)';
    ctx.font = 'bold 8px Georgia, serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('CREW GROUPS', px + 6, rowY + 6);

    for (let gi = 0; gi < REPAIR_CREW_GROUPS.length; gi++) {
      const group = REPAIR_CREW_GROUPS[gi];
      const color = REPAIR_CREW_COLORS[group];
      const ids = this.repairCrewNpcs.get(group) ?? [];
      const count = ids.length;
      const otherGroup = group === 'Repairs' ? 'Buckets' : 'Repairs';
      const otherCount = this.repairCrewNpcs.get(otherGroup)?.length ?? 0;
      const canInc = group === 'Repairs'
        ? otherCount > 0
        : (this.repairCrewNpcs.get('Repairs')?.length ?? 0) > 0;
      const canDec = count > 0;

      if (gi > 0) {
        ctx.strokeStyle = 'rgba(255,255,255,0.07)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(px + 4, rowY);
        ctx.lineTo(px + pw - 4, rowY);
        ctx.stroke();
      }

      const rowMidY = rowY + REPAIR_GROUP_H / 2;
      ctx.fillStyle = color;
      ctx.font = 'bold 11px Georgia, serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(group.toUpperCase(), px + 8, rowMidY - 5);

      const chipParts = ids.map(id => {
        const n = npcById.get(id);
        if (!n) return `#${id}`;
        const busy = n.state === NPC_STATE_AT_GUN || n.state === NPC_STATE_REPAIRING;
        return `#${id}${busy ? '●' : ''}`;
      });
      ctx.fillStyle = chipParts.length > 0 ? 'rgba(200,220,255,0.65)' : 'rgba(180,180,180,0.25)';
      ctx.font = '9px Georgia, serif';
      ctx.fillText(chipParts.length > 0 ? chipParts.join('  ') : 'no crew', px + 8, rowMidY + 9);

      const right = px + pw - 5;
      const plusBtn  = { x: right - 16, y: rowY + 9, w: 16, h: 17 };
      const minusBtn = { x: right - 36, y: rowY + 9, w: 16, h: 17 };
      const badgeX   = right - 52;

      this.drawCountBtn(ctx, plusBtn, '+', canInc);
      this.drawCountBtn(ctx, minusBtn, '−', canDec);
      ctx.fillStyle = 'rgba(255,255,255,0.10)';
      ctx.fillRect(badgeX - 14, rowY + 9, 14, 17);
      ctx.fillStyle = '#e8f0ff';
      ctx.font = 'bold 10px Georgia, serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(count), badgeX - 7, rowY + 17);

      if (canInc) this.hitAreas.push({ ...plusBtn, action: () => this.incrementRepairCrew(group) });
      if (canDec) this.hitAreas.push({ ...minusBtn, action: () => this.decrementRepairCrew(group) });

      rowY += REPAIR_GROUP_H;
    }

    rowY += 6;
    ctx.strokeStyle = 'rgba(80,140,220,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(px + 4, rowY);
    ctx.lineTo(px + pw - 4, rowY);
    ctx.stroke();
    rowY += 8;

    ctx.fillStyle = 'rgba(180,200,255,0.45)';
    ctx.font = 'bold 8px Georgia, serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('MODULE PRIORITY', px + 6, rowY);
    rowY += 10;

    const items = this.repairOrder;
    const moduleStartY = rowY;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const color = REPAIR_COLORS[item];
      const _repairRowDragging = this._rowDragTab === 'repair' && this._rowDragFromIndex === i;
      if (_repairRowDragging) { ctx.save(); ctx.globalAlpha *= 0.3; }

      if (i > 0) {
        ctx.strokeStyle = 'rgba(255,255,255,0.07)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(px + 4, rowY);
        ctx.lineTo(px + pw - 4, rowY);
        ctx.stroke();
      }

      const rowMidY = rowY + rowH / 2;
      const upBtn = { x: px + 4, y: rowY + 2,  w: 15, h: 12 };
      const dnBtn = { x: px + 4, y: rowY + 16, w: 15, h: 12 };
      this.drawArrowBtn(ctx, upBtn, '▲', i > 0);
      this.drawArrowBtn(ctx, dnBtn, '▼', i < items.length - 1);
      if (i > 0)                this.hitAreas.push({ ...upBtn, action: () => this.moveRepairUp(i) });
      if (i < items.length - 1) this.hitAreas.push({ ...dnBtn, action: () => this.moveRepairDown(i) });

      ctx.fillStyle = 'rgba(255,255,255,0.10)';
      ctx.fillRect(px + 24, rowMidY - 8, 14, 16);
      ctx.fillStyle = '#e8f0ff';
      ctx.font = 'bold 9px Georgia, serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), px + 31, rowMidY);

      ctx.fillStyle = color;
      ctx.font = 'bold 11px Georgia, serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(item.toUpperCase(), px + 42, rowMidY);

      if (_repairRowDragging) ctx.restore();
      rowY += rowH;
    }

    if (this._rowDragTab === 'repair' && this._rowDragFromIndex >= 0) {
      const dropIdx = Math.max(0, Math.min(items.length - 1,
        Math.floor((this._rowDragCurrentY - moduleStartY) / rowH)));
      ctx.fillStyle = 'rgba(80,140,220,0.18)';
      ctx.fillRect(px + 2, moduleStartY + dropIdx * rowH, pw - 4, rowH - 1);
      ctx.strokeStyle = '#aac8ff';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(px + 4, moduleStartY + dropIdx * rowH);
      ctx.lineTo(px + pw - 4, moduleStartY + dropIdx * rowH);
      ctx.stroke();
      const ghostItem = items[this._rowDragFromIndex];
      const ghostY = Math.max(moduleStartY,
        Math.min(moduleStartY + (items.length - 1) * rowH, this._rowDragCurrentY - rowH / 2));
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = 'rgba(20,50,120,0.90)';
      ctx.strokeStyle = '#aac8ff';
      ctx.lineWidth = 1;
      ctx.fillRect(px + 4, ghostY, pw - 8, rowH - 4);
      ctx.strokeRect(px + 4, ghostY, pw - 8, rowH - 4);
      ctx.globalAlpha = 1;
      ctx.fillStyle = REPAIR_COLORS[ghostItem];
      ctx.font = 'bold 11px Georgia, serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText('⣿ ' + ghostItem.toUpperCase(), px + 14, ghostY + (rowH - 4) / 2);
    }

    this.lastTaskMap.clear();
    for (const [task, ids] of this.taskNpcs) {
      for (const id of ids) {
        if (!npcById.has(id)) continue;
        if (task === 'Repairs' && this.repairCrewNpcs.get('Buckets')?.includes(id)) {
          this.lastTaskMap.set(id, 'Buckets');
        } else {
          this.lastTaskMap.set(id, task);
        }
      }
    }
    for (const n of shipNpcs) {
      if (!this.lastTaskMap.has(n.id)) this.lastTaskMap.set(n.id, 'Idle');
    }
  }

  private incrementRepairCrew(group: RepairCrewGroup): void {
    const other: RepairCrewGroup = group === 'Repairs' ? 'Buckets' : 'Repairs';
    const otherList = this.repairCrewNpcs.get(other)!;
    if (otherList.length === 0) return;
    const pick = otherList.pop()!;
    this.repairCrewNpcs.get(group)!.push(pick);
    this.notifyRepairCrewAssignment(pick, group);
  }

  private decrementRepairCrew(group: RepairCrewGroup): void {
    const list = this.repairCrewNpcs.get(group);
    if (!list || list.length === 0) return;
    const removed = list.pop()!;
    const dest: RepairCrewGroup = group === 'Repairs' ? 'Buckets' : 'Repairs';
    this.repairCrewNpcs.get(dest)!.push(removed);
    this.notifyRepairCrewAssignment(removed, dest);
  }

  private notifyRepairCrewAssignment(npcId: number, group: RepairCrewGroup): void {
    if (!this.onAssignmentChanged || this._currentShipId === 0) return;
    if (this.repairCrewSentAssignment.get(npcId) === group) return;
    this.repairCrewSentAssignment.set(npcId, group);
    this.lastSentAssignment.set(npcId, 'Repairs');
    this.onAssignmentChanged(this._currentShipId, [{ npcId, task: group }]);
  }

  private moveRepairUp(i: number): void {
    if (i <= 0) return;
    [this.repairOrder[i - 1], this.repairOrder[i]] = [this.repairOrder[i], this.repairOrder[i - 1]];
  }

  private moveRepairDown(i: number): void {
    if (i >= this.repairOrder.length - 1) return;
    [this.repairOrder[i], this.repairOrder[i + 1]] = [this.repairOrder[i + 1], this.repairOrder[i]];
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
