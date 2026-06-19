/**
 * Inventory System
 *
 * Defines all item types, item metadata, inventory slots and the PlayerInventory
 * structure held on each Player. The server mirrors this layout (server-side
 * enum values must stay in sync with ItemKind below).
 */

// ── Slot count ──────────────────────────────────────────────────────────────
export const INVENTORY_SLOTS = 16;  /** total regular bag slots per player */
export const HOTBAR_SLOTS    = 8;   /** first N slots shown on the hotbar  */

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
  | 'swivel'
  | 'ramp'
  | 'axe'
  | 'wooden_floor'
  | 'workbench'
  | 'wall'
  | 'door_frame'
  | 'door'
  | 'wood'
  | 'fiber'
  | 'metal'
  | 'pickaxe'
  | 'shipyard'
  | 'stone'
  | 'wood_ceiling'
  | 'claim_flag'
  | 'flag_fort'
  | 'company_fortress'
  | 'cloth_hat'
  | 'cloth_shirt'
  | 'cloth_pants'
  | 'cloth_shoes'
  | 'cloth_gloves'
  | 'resource_chest'
  | 'bed'
  | 'metal_axe'
  | 'metal_pickaxe'
  | 'grapple_hook';

// ── Category groups ─────────────────────────────────────────────────────────
export type ItemCategory = 'none' | 'building' | 'repair' | 'ammo' | 'weapon' | 'tool' | 'armor' | 'shield' | 'resource' | 'utility';

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
  /** Weight per single unit — used for ship cargo load calculation */
  weight: number;
}

export const ITEM_DEFS: Record<ItemKind, ItemDef> = {
  none:          { kind: 'none',          name: 'Empty',         category: 'none',     maxStack: 0,  color: '#2a2a2a', borderColor: '#444',    symbol: '',   description: 'An empty slot.',                                                                    weight: 0   },
  plank:         { kind: 'plank',         name: 'Plank',         category: 'building', maxStack: 99, color: '#b8832b', borderColor: '#7a5520', symbol: 'P',  description: 'Replaces a missing hull plank on your ship.',                                        weight: 5   },
  repair_kit:    { kind: 'repair_kit',    name: 'Repair Kit',    category: 'repair',   maxStack: 99, color: '#2577e3', borderColor: '#1a4fa0', symbol: 'R',  description: 'Press E to repair the most damaged plank or sail on your ship.',                    weight: 3   },
  cannon_ball:   { kind: 'cannon_ball',   name: 'Cannonball',    category: 'ammo',     maxStack: 99, color: '#555',    borderColor: '#333',    symbol: 'C',  description: 'Standard ammunition. Deals heavy damage to hull planks.',                           weight: 5   },
  cannon:        { kind: 'cannon',        name: 'Cannon',        category: 'building', maxStack: 9,  color: '#333333', borderColor: '#111',    symbol: '\u26ab', description: 'Replaces a destroyed cannon on your ship.',                                      weight: 200 },
  sail:          { kind: 'sail',          name: 'Sail',          category: 'building', maxStack: 9,  color: '#1e8c6e', borderColor: '#0f5c48', symbol: '\u26f5', description: 'Replaces a missing mast and sail on your ship.',                                 weight: 30  },
  helm_kit:      { kind: 'helm_kit',      name: 'Helm Kit',      category: 'building', maxStack: 3,  color: '#6a3d8f', borderColor: '#3d2060', symbol: 'W',  description: 'Replaces a destroyed ship helm (steering wheel).',                                   weight: 50  },
  deck:          { kind: 'deck',          name: 'Deck',          category: 'building', maxStack: 9,  color: '#8b5e3c', borderColor: '#5c3a1c', symbol: '\u229f', description: 'Replaces a destroyed ship deck. Required for crew to walk on.',                  weight: 20  },
  sword:         { kind: 'sword',         name: 'Sword',         category: 'weapon',   maxStack: 1,  color: '#c0c0c0', borderColor: '#777',    symbol: 'S',  description: 'Melee weapon. Left-click to slash nearby enemies.',                                  weight: 2   },
  pistol:        { kind: 'pistol',        name: 'Pistol',        category: 'weapon',   maxStack: 1,  color: '#8b4513', borderColor: '#5a2d0c', symbol: 'G',  description: 'Ranged weapon. Left-click to fire a shot at your cursor.',                          weight: 1   },
  hammer:        { kind: 'hammer',        name: 'Hammer',        category: 'tool',     maxStack: 1,  color: '#c07830', borderColor: '#885020', symbol: 'H',  description: 'Click a damaged module or the ship deck to begin a repair minigame.',              weight: 1.5 },
  cloth_armor:   { kind: 'cloth_armor',   name: 'Cloth Armor',   category: 'armor',    maxStack: 1,  color: '#8b7f4a', borderColor: '#5c5430', symbol: 'A',  description: 'Light armor. Provides basic protection against attacks.',                           weight: 2   },
  leather_armor: { kind: 'leather_armor', name: 'Leather Armor', category: 'armor',    maxStack: 1,  color: '#8b5a2b', borderColor: '#5a3010', symbol: 'A',  description: 'Medium armor. Better protection than cloth.',                                        weight: 5   },
  iron_armor:    { kind: 'iron_armor',    name: 'Iron Armor',    category: 'armor',    maxStack: 1,  color: '#8a8a8c', borderColor: '#555558', symbol: 'A',  description: 'Heavy armor. Provides strong protection.',                                           weight: 15  },
  wooden_shield: { kind: 'wooden_shield', name: 'Wooden Shield', category: 'shield',   maxStack: 1,  color: '#c8a46e', borderColor: '#8a6030', symbol: 'D',  description: 'A light wooden shield for blocking attacks.',                                        weight: 8   },
  iron_shield:   { kind: 'iron_shield',   name: 'Iron Shield',   category: 'shield',   maxStack: 1,  color: '#aaaaac', borderColor: '#666668', symbol: 'D',  description: 'A sturdy iron shield for reliable defense.',                                         weight: 4   },
  swivel:        { kind: 'swivel',        name: 'Swivel Gun',    category: 'building', maxStack: 9,  color: '#7a4a2a', borderColor: '#4a2810', symbol: '\u2023', description: 'A fast anti-personnel swivel gun. Place anywhere on the ship rail.',            weight: 50  },
  ramp:          { kind: 'ramp',          name: 'Ramp',          category: 'building', maxStack: 9,  color: '#7a5c2a', borderColor: '#4a3410', symbol: '\u27cb', description: 'A wooden ramp connecting the lower and upper ship decks.',                   weight: 10  },
  axe:           { kind: 'axe',           name: 'Stone Axe',     category: 'tool',     maxStack: 1,  color: '#8b5e2a', borderColor: '#5c3a10', symbol: '\uD83E\uDE93', description: 'Chop wood resources on islands. Equip and press E near a tree.',           weight: 2   },
  wooden_floor:  { kind: 'wooden_floor',  name: 'Wooden Floor',  category: 'building', maxStack: 20, color: '#b8832b', borderColor: '#7a5520', symbol: '\u229f',      description: 'Place on island ground as a foundation for workbenches.',               weight: 10  },
  workbench:     { kind: 'workbench',     name: 'Workbench',     category: 'building', maxStack: 5,  color: '#7a4820', borderColor: '#4a2810', symbol: '\u2692',      description: 'Crafting station. Place on a wooden floor and press E to open.',       weight: 30  },
  wall:          { kind: 'wall',          name: 'Wall',          category: 'building', maxStack: 20, color: '#5c3a1a', borderColor: '#2e1a08', symbol: '\u2503',      description: 'Place on a floor tile edge to build a wall segment.',                   weight: 15  },
  door_frame:    { kind: 'door_frame',    name: 'Door Frame',    category: 'building', maxStack: 10, color: '#7a4820', borderColor: '#3e200c', symbol: 'Fr',          description: 'Place on a floor tile edge. Creates a gap for a door panel.',         weight: 8   },
  door:          { kind: 'door',          name: 'Door',          category: 'building', maxStack: 4,  color: '#7a4820', borderColor: '#3e200c', symbol: '\u25a1',      description: 'Snap onto a door frame. Press E to open/close.',                        weight: 8   },
  wood:          { kind: 'wood',          name: 'Wood',          category: 'resource', maxStack: 99, color: '#8b5e2a', borderColor: '#5c3a10', symbol: 'W',  description: 'Raw wood harvested from island trees. Used for crafting and construction.',     weight: 0.5 },
  fiber:         { kind: 'fiber',         name: 'Fiber',         category: 'resource', maxStack: 99, color: '#c8a46e', borderColor: '#8a6030', symbol: 'Fi', description: 'Plant fiber from island vegetation. Used to craft sails and cloth.',              weight: 0.1 },
  metal:         { kind: 'metal',         name: 'Metal',         category: 'resource', maxStack: 99, color: '#8a8a8c', borderColor: '#555558', symbol: 'Fe', description: 'Metal ingots. Used to craft weapons, cannons, and fittings.',                     weight: 1   },
  pickaxe:       { kind: 'pickaxe',       name: 'Stone Pickaxe', category: 'tool',     maxStack: 1,  color: '#7a7a7c', borderColor: '#555558', symbol: '\u26cf', description: 'Mine rock outcroppings on islands to gather metal.',                         weight: 3   },
  shipyard:      { kind: 'shipyard',      name: 'Shipyard',      category: 'building', maxStack: 1,  color: '#2a5f8a', borderColor: '#14304a', symbol: '\u2693', description: 'Place in shallow water next to an island to build ships.',                 weight: 100 },
  stone:         { kind: 'stone',         name: 'Stone',         category: 'resource', maxStack: 99, color: '#9a9a9c', borderColor: '#666668', symbol: 'St', description: 'Raw stone gathered from rocky outcroppings. Used for crafting.',                  weight: 0.75},
  wood_ceiling:  { kind: 'wood_ceiling',  name: 'Wood Ceiling',  category: 'building', maxStack: 20, color: '#b8832b', borderColor: '#7a5520', symbol: '\u25a6', description: 'A wooden ceiling tile. Fits over a floor section.',                        weight: 10  },
  claim_flag:    { kind: 'claim_flag',    name: 'Claiming Flag', category: 'building', maxStack: 5,  color: '#dd3333', borderColor: '#991111', symbol: '\uD83D\uDEA9', description: 'Plant in contested territory to capture it for your company over 60 seconds.', weight: 5 },
  flag_fort:       { kind: 'flag_fort',       name: 'Flag Fort',        category: 'building', maxStack: 1,  color: '#cc8822', borderColor: '#886611', symbol: '\uD83C\uDFF0', description: 'Place on an unclaimed island to establish your company\u2019s territory claim.', weight: 30  },
  company_fortress: { kind: 'company_fortress', name: 'Company Fortress', category: 'building', maxStack: 1, color: '#8844cc', borderColor: '#5522aa', symbol: '\uD83C\uDFAF', description: 'Place on an island to begin a 15-minute build. Claims the entire island when complete.', weight: 200 },
  /* ── Cloth armour set ─────────────────────────────────────────────────── */
  cloth_hat:     { kind: 'cloth_hat',     name: 'Cloth Hat',     category: 'armor',    maxStack: 1,  color: '#9e8f5a', borderColor: '#6b5f35', symbol: '\u26D1', description: 'Light cloth helm. +5 armour. Reduces incoming damage.',       weight: 0.5 },
  cloth_shirt:   { kind: 'cloth_shirt',   name: 'Cloth Shirt',   category: 'armor',    maxStack: 1,  color: '#8b7f4a', borderColor: '#5c5430', symbol: 'Cs', description: 'Light cloth chest. +20 armour. Reduces incoming damage.',       weight: 1 },
  cloth_pants:   { kind: 'cloth_pants',   name: 'Cloth Pants',   category: 'armor',    maxStack: 1,  color: '#7a7040', borderColor: '#524a28', symbol: 'Cp', description: 'Light cloth legs. +15 armour. Reduces incoming damage.',        weight: 0.8 },
  cloth_shoes:   { kind: 'cloth_shoes',   name: 'Cloth Shoes',   category: 'armor',    maxStack: 1,  color: '#8f7c50', borderColor: '#5c5030', symbol: 'Cx', description: 'Light cloth boots. +8 armour. Reduces incoming damage.',        weight: 0.5 },
  cloth_gloves:  { kind: 'cloth_gloves',  name: 'Cloth Gloves',  category: 'armor',    maxStack: 1,  color: '#9a8855', borderColor: '#635830', symbol: 'Cg', description: 'Light cloth gloves. +7 armour. Reduces incoming damage.',      weight: 0.3 },
  resource_chest: { kind: 'resource_chest', name: 'Resource Chest', category: 'building', maxStack: 3,  color: '#7a4820', borderColor: '#4a2810', symbol: '\u229f', description: 'A wooden chest for storing resources. Supplies ship auto-repair and land structure upkeep.', weight: 0 },
  bed:           { kind: 'bed',           name: 'Bed',           category: 'utility',  maxStack: 3,  color: '#6a3a8f', borderColor: '#3d1e5e', symbol: '\uD83D\uDECF', description: 'Place on an island floor to set a respawn point. Use on a ship to set ship respawn. 60 s cooldown.', weight: 12 },
  metal_axe:     { kind: 'metal_axe',     name: 'Metal Axe',     category: 'tool',     maxStack: 1,  color: '#7a9ab0', borderColor: '#4a6878', symbol: '\uD83E\uDE93', description: 'A durable metal axe. Yields more wood per swing than a stone axe.',                            weight: 3   },
  metal_pickaxe: { kind: 'metal_pickaxe', name: 'Metal Pickaxe', category: 'tool',     maxStack: 1,  color: '#6a8aa0', borderColor: '#3a5868', symbol: '\u26cf',       description: 'A sturdy metal pickaxe. Yields more metal/stone per swing than a stone pickaxe.',           weight: 4   },
  grapple_hook:  { kind: 'grapple_hook',  name: 'Grapple Hook',  category: 'tool',     maxStack: 1,  color: '#808080', borderColor: '#505050', symbol: '\u2693',       description: 'A metal grappling hook. Craft at a workbench.',                                                 weight: 2   },
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
  // Note: server ID 20 collision — ITEM_DOOR wins (ITEM_WOODEN_SHIELD pre-existing duplicate bug)
  21: 'iron_shield',
  13: 'deck',
  14: 'swivel',
  37: 'ramp',
  15: 'axe',
  16: 'wooden_floor',
  17: 'workbench',
  18: 'wall',
  19: 'door_frame',
  20: 'door',
  22: 'wood',
  23: 'fiber',
  24: 'metal',
  25: 'pickaxe',
  26: 'shipyard',
  27: 'stone',
  28: 'wood_ceiling',
  29: 'claim_flag',
  35: 'flag_fort',
  36: 'company_fortress',
  30: 'cloth_hat',
  31: 'cloth_shirt',
  32: 'cloth_pants',
  33: 'cloth_shoes',
  34: 'cloth_gloves',
  38: 'resource_chest',
  39: 'bed',
  40: 'metal_axe',
  41: 'metal_pickaxe',
  42: 'grapple_hook',
};

/**
 * Reverse map: ItemKind → numeric server ID.
 * Useful for display (tooltips, logs).
 */
export const ITEM_KIND_ID: Partial<Record<ItemKind, number>> = Object.fromEntries(
  Object.entries(ITEM_ID_MAP).map(([id, kind]) => [kind, Number(id)])
) as Partial<Record<ItemKind, number>>;

// ── Canvas icon helpers ───────────────────────────────────────────────────────

/** Cached sword sprite loaded from /items/sword.png. */
let _swordImg: HTMLImageElement | null = null;
let _swordImgLoaded = false;
(function () {
  if (typeof window === 'undefined') return;
  const img = new Image();
  img.src = '/items/sword.png';
  img.onload = () => { _swordImgLoaded = true; };
  _swordImg = img;
})();

export function drawSwordIcon(
  ctx: CanvasRenderingContext2D,
  cx:  number,
  cy:  number,
  sz:  number,
): void {
  if (_swordImgLoaded && _swordImg) {
    const dim = Math.round(sz * 0.80);
    ctx.drawImage(_swordImg, Math.round(cx - dim / 2), Math.round(cy - dim / 2), dim, dim);
  } else {
    // Fallback while image loads
    ctx.fillStyle = '#c0c0c0';
    ctx.font = `bold ${Math.round(sz * 0.55)}px Georgia, serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('S', cx, cy);
  }
}

/** Cached monochrome axe sprite (white emoji, redrawn when slot size changes). */
let _axeCache: { sz: number; canvas: OffscreenCanvas } | null = null;

/**
 * Draws the axe emoji tinted flat white so it matches the monochrome style of ⛏.
 * Renders to an offscreen canvas, composites white over all pixels, then blits.
 */
export function drawAxeIcon(
  ctx: CanvasRenderingContext2D,
  cx:  number,
  cy:  number,
  sz:  number,
): void {
  const dim = Math.ceil(sz * 0.85); // sized to match ⛏ pickaxe visual scale
  if (!_axeCache || _axeCache.sz !== dim) {
    const off    = new OffscreenCanvas(dim, dim);
    const offCtx = off.getContext('2d')!;
    offCtx.font         = `bold ${Math.round(sz * 0.40)}px sans-serif`;
    offCtx.textAlign    = 'center';
    offCtx.textBaseline = 'middle';
    offCtx.fillText('\uD83E\uDE93', dim / 2, dim / 2);   // 🪓
    // Tint every non-transparent pixel to white
    offCtx.globalCompositeOperation = 'source-in';
    offCtx.fillStyle = '#ffffff';
    offCtx.fillRect(0, 0, dim, dim);
    _axeCache = { sz: dim, canvas: off };
  }
  ctx.drawImage(
    _axeCache.canvas as unknown as HTMLCanvasElement,
    Math.round(cx - dim / 2),
    Math.round(cy - dim / 2),
    dim, dim,
  );
}

// ── Slot / inventory structures ─────────────────────────────────────────────

export interface InventorySlot {
  item: ItemKind;
  /** 0 = empty slot. Weapons / tools always use 1. */
  quantity: number;
}

export interface PlayerEquipment {
  helm:   ItemKind;
  torso:  ItemKind;
  legs:   ItemKind;
  feet:   ItemKind;
  hands:  ItemKind;
  shield: ItemKind;
}

/** Raw resource amounts tracked separately from the regular item inventory. */
export interface PlayerResources {
  wood:  number;
  fiber: number;
  metal: number;
  stone: number;
}

/**
 * Resource cost required to complete each type of planned module.
 * Keys match GhostModuleKind / ModuleKind strings.
 */
export const STRUCTURE_COSTS: Record<string, PlayerResources> = {
  plank:       { wood: 10, fiber: 0,  metal: 0,  stone: 0 },
  cannon:      { wood: 2,  fiber: 0,  metal: 5,  stone: 0 },
  mast:        { wood: 20, fiber: 10, metal: 0,  stone: 0 },
  helm:        { wood: 5,  fiber: 0,  metal: 3,  stone: 0 },
  deck:        { wood: 15, fiber: 0,  metal: 0,  stone: 0 },
  swivel:      { wood: 1,  fiber: 0,  metal: 3,  stone: 0 },
  ramp:        { wood: 8,  fiber: 0,  metal: 0,  stone: 0 },
  hatch_cover: { wood: 8,  fiber: 0,  metal: 0,  stone: 0 },
  gunport:     { wood: 6,  fiber: 0,  metal: 2,  stone: 0 },
  workbench:   { wood: 12, fiber: 0,  metal: 0,  stone: 0 },
  chest:       { wood: 12, fiber: 0,  metal: 0,  stone: 0 },
};

export interface PlayerInventory {
  /** INVENTORY_SLOTS hotbar slots */
  slots: InventorySlot[];
  equipment: PlayerEquipment;
  /** Which hotbar slot is currently selected (0–9). Client-authoritative. */
  activeSlot: number;
  /** Raw resource counts — extracted from inventory slots, shown in a dedicated Resources section. */
  resources: PlayerResources;
}

// ── Factory helpers ─────────────────────────────────────────────────────────

export function createEmptyInventory(): PlayerInventory {
  return {
    slots: Array.from({ length: INVENTORY_SLOTS }, () => ({ item: 'none' as ItemKind, quantity: 0 })),
    equipment: { helm: 'none', torso: 'none', legs: 'none', feet: 'none', hands: 'none', shield: 'none' },
    activeSlot: 0,
    resources: { wood: 0, fiber: 0, metal: 0, stone: 0 },
  };
}

/**
 * Parse inventory from the compact server wire format.
 * `rawSlots` is a 16-element array of [itemId, quantity] pairs.
 * Equipment IDs are the numeric ItemKind values from the server.
 * `resWood/resFiber/resMetal/resStone` come directly from the server resource pool.
 */
export function parseInventoryFromServer(
  rawSlots: Array<[number, number]> | undefined,
  activeSlot: number,
  helmId:  number,
  torsoId: number,
  legsId:  number,
  feetId:  number,
  handsId: number,
  shieldId: number,
  resWood  = 0,
  resFiber = 0,
  resMetal = 0,
  resStone = 0,
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
  inv.equipment.helm   = ITEM_ID_MAP[helmId]   ?? 'none';
  inv.equipment.torso  = ITEM_ID_MAP[torsoId]  ?? 'none';
  inv.equipment.legs   = ITEM_ID_MAP[legsId]   ?? 'none';
  inv.equipment.feet   = ITEM_ID_MAP[feetId]   ?? 'none';
  inv.equipment.hands  = ITEM_ID_MAP[handsId]  ?? 'none';
  inv.equipment.shield = ITEM_ID_MAP[shieldId] ?? 'none';

  // Resource pool comes directly from server fields (not stored in inventory slots)
  inv.resources.wood  = resWood;
  inv.resources.fiber = resFiber;
  inv.resources.metal = resMetal;
  inv.resources.stone = resStone;

  return inv;
}

// ── Convenience helpers ─────────────────────────────────────────────────────

export function isStackable(kind: ItemKind): boolean {
  return (ITEM_DEFS[kind]?.maxStack ?? 0) > 1;
}

/** Total weight of all items across all bag slots (equipped items not counted). */
export function computeInventoryWeight(inv: PlayerInventory): number {
  let total = 0;
  for (const slot of inv.slots) {
    if (slot.item !== 'none' && slot.quantity > 0) {
      total += (ITEM_DEFS[slot.item]?.weight ?? 0) * slot.quantity;
    }
  }
  // Resource pool (wood/fiber/metal/stone) lives outside slots
  const res = inv.resources;
  total += (ITEM_DEFS.wood.weight  ?? 0) * res.wood;
  total += (ITEM_DEFS.fiber.weight ?? 0) * res.fiber;
  total += (ITEM_DEFS.metal.weight ?? 0) * res.metal;
  total += (ITEM_DEFS.stone.weight ?? 0) * res.stone;
  return total;
}

export function getActiveSlot(inv: PlayerInventory): InventorySlot {
  return inv.slots[inv.activeSlot] ?? { item: 'none', quantity: 0 };
}
