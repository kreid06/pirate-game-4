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
  | 'sail'
  | 'helm_kit'
  | 'sword'
  | 'pistol'
  | 'hammer'
  | 'cloth_armor'
  | 'leather_armor'
  | 'iron_armor'
  | 'wooden_shield'
  | 'iron_shield'
  | 'deck'
  | 'swivel';

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
  /** Short description shown in the hotbar tooltip */
  description: string;
}

export const ITEM_DEFS: Record<ItemKind, ItemDef> = {
  none:          { kind: 'none',          name: 'Empty',         category: 'none',     maxStack: 0,  color: '#2a2a2a', borderColor: '#444',    symbol: '',   description: 'An empty slot.' },
  plank:         { kind: 'plank',         name: 'Plank',         category: 'building', maxStack: 99, color: '#b8832b', borderColor: '#7a5520', symbol: 'P',  description: 'Replaces a missing hull plank on your ship.' },
  repair_kit:    { kind: 'repair_kit',    name: 'Repair Kit',    category: 'repair',   maxStack: 99, color: '#2577e3', borderColor: '#1a4fa0', symbol: 'R',  description: 'Press E to repair the most damaged plank or sail on your ship.' },
  cannon_ball:   { kind: 'cannon_ball',   name: 'Cannonball',    category: 'ammo',     maxStack: 99, color: '#555',    borderColor: '#333',    symbol: 'C',  description: 'Standard ammunition. Deals heavy damage to hull planks.' },
  cannon:        { kind: 'cannon',        name: 'Cannon',        category: 'building', maxStack: 9,  color: '#333333', borderColor: '#111',    symbol: '\u26ab', description: 'Replaces a destroyed cannon on your ship.' },
  sail:          { kind: 'sail',          name: 'Sail',          category: 'building', maxStack: 9,  color: '#1e8c6e', borderColor: '#0f5c48', symbol: '\u26f5', description: 'Replaces a missing mast and sail on your ship.' },
  helm_kit:      { kind: 'helm_kit',      name: 'Helm Kit',      category: 'building', maxStack: 3,  color: '#6a3d8f', borderColor: '#3d2060', symbol: 'W',  description: 'Replaces a destroyed ship helm (steering wheel).' },
  deck:          { kind: 'deck',          name: 'Deck',          category: 'building', maxStack: 9,  color: '#8b5e3c', borderColor: '#5c3a1c', symbol: '\u229f', description: 'Replaces a destroyed ship deck. Required for crew to walk on.' },
  sword:         { kind: 'sword',         name: 'Sword',         category: 'weapon',   maxStack: 1,  color: '#c0c0c0', borderColor: '#777',    symbol: 'S',  description: 'Melee weapon. Left-click to slash nearby enemies.' },
  pistol:        { kind: 'pistol',        name: 'Pistol',        category: 'weapon',   maxStack: 1,  color: '#8b4513', borderColor: '#5a2d0c', symbol: 'G',  description: 'Ranged weapon. Left-click to fire a shot at your cursor.' },
  hammer:        { kind: 'hammer',        name: 'Hammer',        category: 'tool',     maxStack: 1,  color: '#c07830', borderColor: '#885020', symbol: 'H',  description: 'Click a damaged module or the ship deck to begin a repair minigame.' },
  cloth_armor:   { kind: 'cloth_armor',   name: 'Cloth Armor',   category: 'armor',    maxStack: 1,  color: '#8b7f4a', borderColor: '#5c5430', symbol: 'A',  description: 'Light armor. Provides basic protection against attacks.' },
  leather_armor: { kind: 'leather_armor', name: 'Leather Armor', category: 'armor',    maxStack: 1,  color: '#8b5a2b', borderColor: '#5a3010', symbol: 'A',  description: 'Medium armor. Better protection than cloth.' },
  iron_armor:    { kind: 'iron_armor',    name: 'Iron Armor',    category: 'armor',    maxStack: 1,  color: '#8a8a8c', borderColor: '#555558', symbol: 'A',  description: 'Heavy armor. Provides strong protection.' },
  wooden_shield: { kind: 'wooden_shield', name: 'Wooden Shield', category: 'shield',   maxStack: 1,  color: '#c8a46e', borderColor: '#8a6030', symbol: 'D',  description: 'A light wooden shield for blocking attacks.' },
  iron_shield:   { kind: 'iron_shield',   name: 'Iron Shield',   category: 'shield',   maxStack: 1,  color: '#aaaaac', borderColor: '#666668', symbol: 'D',  description: 'A sturdy iron shield for reliable defense.' },
  swivel:        { kind: 'swivel',        name: 'Swivel Gun',    category: 'building', maxStack: 9,  color: '#7a4a2a', borderColor: '#4a2810', symbol: '\u2023', description: 'A fast anti-personnel swivel gun. Place anywhere on the ship rail.' },
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
  8:  'sail',
  9:  'helm_kit',
  4:  'sword',
  5:  'pistol',
  6:  'hammer',
  10: 'cloth_armor',
  11: 'leather_armor',
  12: 'iron_armor',
  20: 'wooden_shield',
  21: 'iron_shield',
  13: 'deck',
  14: 'swivel',
};

/**
 * Reverse map: ItemKind → numeric server ID.
 * Useful for display (tooltips, logs).
 */
export const ITEM_KIND_ID: Partial<Record<ItemKind, number>> = Object.fromEntries(
  Object.entries(ITEM_ID_MAP).map(([id, kind]) => [kind, Number(id)])
) as Partial<Record<ItemKind, number>>;

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

  // 255 = unequipped sentinel; 0-9 = valid hotbar slots; anything else clamp to 0
  inv.activeSlot = (activeSlot === 255 || (activeSlot >= 0 && activeSlot < INVENTORY_SLOTS)) ? activeSlot : 0;
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
