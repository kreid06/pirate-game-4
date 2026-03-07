/**
 * Inventory System
 *
 * Defines all item types, item metadata, inventory slots and the PlayerInventory
 * structure held on each Player. The server mirrors this layout (server-side
 * enum values must stay in sync with ItemKind below).
 */

// ── Slot count ──────────────────────────────────────────────────────────────
export const INVENTORY_SLOTS = 10;

// ── Item identifiers (must match server ItemKind enum) ─────────────────────
export type ItemKind =
  | 'none'
  | 'plank'
  | 'repair_kit'
  | 'cannon_ball'
  | 'cannon'
  | 'sword'
  | 'pistol'
  | 'hammer'
  | 'cloth_armor'
  | 'leather_armor'
  | 'iron_armor'
  | 'wooden_shield'
  | 'iron_shield';

// ── Category groups ─────────────────────────────────────────────────────────
export type ItemCategory = 'none' | 'building' | 'repair' | 'ammo' | 'weapon' | 'tool' | 'armor' | 'shield';

// ── Per-item metadata ───────────────────────────────────────────────────────
export interface ItemDef {
  kind: ItemKind;
  name: string;
  category: ItemCategory;
  /** 1 for weapons / tools / equipment; up to 99 for stackable items */
  maxStack: number;
  /** CSS-style fill color for canvas rendering */
  color: string;
  borderColor: string;
  /** One or two characters shown inside the slot */
  symbol: string;
}

export const ITEM_DEFS: Record<ItemKind, ItemDef> = {
  none:          { kind: 'none',          name: 'Empty',         category: 'none',     maxStack: 0,  color: '#2a2a2a', borderColor: '#444',    symbol: ''  },
  plank:         { kind: 'plank',         name: 'Plank',         category: 'building', maxStack: 99, color: '#b8832b', borderColor: '#7a5520', symbol: 'P' },
  repair_kit:    { kind: 'repair_kit',    name: 'Repair Kit',    category: 'repair',   maxStack: 99, color: '#2577e3', borderColor: '#1a4fa0', symbol: 'R' },
  cannon_ball:   { kind: 'cannon_ball',   name: 'Cannonball',    category: 'ammo',     maxStack: 99, color: '#555',    borderColor: '#333',    symbol: 'C' },
  cannon:        { kind: 'cannon',        name: 'Cannon',        category: 'building', maxStack: 9,  color: '#333333', borderColor: '#111',    symbol: '⚫' },
  sword:         { kind: 'sword',         name: 'Sword',         category: 'weapon',   maxStack: 1,  color: '#c0c0c0', borderColor: '#777',    symbol: 'S' },
  pistol:        { kind: 'pistol',        name: 'Pistol',        category: 'weapon',   maxStack: 1,  color: '#8b4513', borderColor: '#5a2d0c', symbol: 'G' },
  hammer:        { kind: 'hammer',        name: 'Hammer',        category: 'tool',     maxStack: 1,  color: '#c07830', borderColor: '#885020', symbol: 'H' },
  cloth_armor:   { kind: 'cloth_armor',   name: 'Cloth Armor',   category: 'armor',    maxStack: 1,  color: '#8b7f4a', borderColor: '#5c5430', symbol: 'A' },
  leather_armor: { kind: 'leather_armor', name: 'Leather Armor', category: 'armor',    maxStack: 1,  color: '#8b5a2b', borderColor: '#5a3010', symbol: 'A' },
  iron_armor:    { kind: 'iron_armor',    name: 'Iron Armor',    category: 'armor',    maxStack: 1,  color: '#8a8a8c', borderColor: '#555558', symbol: 'A' },
  wooden_shield: { kind: 'wooden_shield', name: 'Wooden Shield', category: 'shield',   maxStack: 1,  color: '#c8a46e', borderColor: '#8a6030', symbol: 'D' },
  iron_shield:   { kind: 'iron_shield',   name: 'Iron Shield',   category: 'shield',   maxStack: 1,  color: '#aaaaac', borderColor: '#666668', symbol: 'D' },
};

/**
 * Numeric ID → ItemKind mapping. Server sends item IDs as integers.
 * Must stay in sync with the server-side ItemKind enum.
 */
export const ITEM_ID_MAP: Record<number, ItemKind> = {
  0:  'none',
  1:  'plank',
  2:  'repair_kit',
  3:  'cannon_ball',
  7:  'cannon',
  4:  'sword',
  5:  'pistol',
  6:  'hammer',
  10: 'cloth_armor',
  11: 'leather_armor',
  12: 'iron_armor',
  20: 'wooden_shield',
  21: 'iron_shield',
};

// ── Slot / inventory structures ─────────────────────────────────────────────

export interface InventorySlot {
  item: ItemKind;
  /** 0 = empty slot. Weapons / tools always use 1. */
  quantity: number;
}

export interface PlayerEquipment {
  armor: ItemKind;
  shield: ItemKind;
}

export interface PlayerInventory {
  /** INVENTORY_SLOTS hotbar slots */
  slots: InventorySlot[];
  equipment: PlayerEquipment;
  /** Which hotbar slot is currently selected (0–9). Client-authoritative. */
  activeSlot: number;
}

// ── Factory helpers ─────────────────────────────────────────────────────────

export function createEmptyInventory(): PlayerInventory {
  return {
    slots: Array.from({ length: INVENTORY_SLOTS }, () => ({ item: 'none' as ItemKind, quantity: 0 })),
    equipment: { armor: 'none', shield: 'none' },
    activeSlot: 0,
  };
}

/**
 * Parse inventory from the compact server wire format.
 * `rawSlots` is a 10-element array of [itemId, quantity] pairs.
 */
export function parseInventoryFromServer(
  rawSlots: Array<[number, number]> | undefined,
  activeSlot: number,
  armorId: number,
  shieldId: number,
): PlayerInventory {
  const inv = createEmptyInventory();

  if (rawSlots) {
    for (let i = 0; i < INVENTORY_SLOTS && i < rawSlots.length; i++) {
      const [id, qty] = rawSlots[i];
      inv.slots[i] = { item: ITEM_ID_MAP[id] ?? 'none', quantity: qty };
    }
  }

  inv.activeSlot = (activeSlot >= 0 && activeSlot < INVENTORY_SLOTS) ? activeSlot : 0;
  inv.equipment.armor  = ITEM_ID_MAP[armorId]  ?? 'none';
  inv.equipment.shield = ITEM_ID_MAP[shieldId] ?? 'none';

  return inv;
}

// ── Convenience helpers ─────────────────────────────────────────────────────

export function isStackable(kind: ItemKind): boolean {
  return (ITEM_DEFS[kind]?.maxStack ?? 0) > 1;
}

export function getActiveSlot(inv: PlayerInventory): InventorySlot {
  return inv.slots[inv.activeSlot] ?? { item: 'none', quantity: 0 };
}
