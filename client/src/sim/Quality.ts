// Loot quality / schematic tier helpers (mirrors server net/quality.*).
//
// Quality is encoded by the server as a 0..1 "quality" value mapped to one of
// seven named tiers. Each stat multiplier is sent q8-style where 256 == 1.00x
// and 0 means "stat not applicable to this item".
import { ITEM_ID_MAP, ITEM_DEFS, ItemKind } from './Inventory';

export interface QualityTierInfo {
  tier: number;
  name: string;
  color: string;
}

/** Seven loot tiers, lowest (0) to highest (6). Colors match the design doc. */
export const QUALITY_TIERS: QualityTierInfo[] = [
  { tier: 0, name: 'Crude',       color: '#9d9d9d' },
  { tier: 1, name: 'Ironbound',   color: '#1eff00' },
  { tier: 2, name: 'Brineforged', color: '#0070dd' },
  { tier: 3, name: "Buccaneer's", color: '#a335ee' },
  { tier: 4, name: 'Legendary',   color: '#ffd700' },
  { tier: 5, name: 'Mythical',    color: '#00ffff' },
  { tier: 6, name: 'Eternal',     color: '#ff00ff' },
];

export function tierInfo(tier: number): QualityTierInfo {
  const t = Math.max(0, Math.min(QUALITY_TIERS.length - 1, Math.floor(tier)));
  return QUALITY_TIERS[t];
}

export function tierColor(tier: number): string {
  return tierInfo(tier).color;
}

export function tierName(tier: number): string {
  return tierInfo(tier).name;
}

/** Stat names indexed by server QualityStatId (DURABILITY..REPAIR_SPEED). */
export const QUALITY_STAT_NAMES: string[] = [
  'Durability',
  'Weapon Damage',
  'Sail Effectiveness',
  'Structural Resistance',
  'Repair Speed',
];

/** Map a server item id to its human-readable display name. */
export function itemDisplayName(itemId: number): string {
  const kind = ITEM_ID_MAP[itemId] as ItemKind | undefined;
  if (!kind) return `item #${itemId}`;
  return ITEM_DEFS[kind]?.name ?? kind;
}

/**
 * Format a q8 stat multiplier as a signed percentage (e.g. "+12%"), or null
 * when the stat does not apply (q8 === 0) or has no bonus (q8 === 256 = 1.00×).
 * Returning null for 256 prevents "+0%" labels from appearing on neutral base-value
 * stats that happen to be tracked for the item type but carry no actual bonus.
 */
export function statMultLabel(q8: number): string | null {
  if (!q8 || q8 === 256) return null;
  const pct = Math.round((q8 / 256 - 1) * 100);
  return (pct >= 0 ? '+' : '') + pct + '%';
}

/** Mirrors server MAX_PLAYER_SCHEMATICS — persistent blueprint inventory cap. */
export const MAX_PLAYER_SCHEMATICS = 128;

/** Mirrors server QUALITY_TIER_BONUS_PER_TIER — applied to durability & weapon damage rolls. */
export const QUALITY_TIER_BONUS_PER_TIER = 0.10;

export const CANNON_HULL_BASE_DAMAGE   = 3000;
export const CANNON_ENTITY_BASE_DAMAGE = 75;
export const BAR_SHOT_ENTITY_BASE_DAMAGE = 15;

/** Ship Damage attribute output multiplier (+4% per level above 1). */
export function shipLevelDamageMult(damageLevel: number): number {
  return 1 + 0.04 * Math.max(0, damageLevel - 1);
}

/** Tier multiplicative bonus: final = base × (1 + tier × 0.10). Mirrors server quality_roll_payload. */
export function qualityTierBonusMult(tier: number): number {
  const t = Math.max(0, Math.min(6, Math.floor(tier)));
  return 1 + t * QUALITY_TIER_BONUS_PER_TIER;
}

/** Convert a server q8 stat multiplier to a float (256 = 1.00×). Includes tier bonus when rolled server-side. */
export function qualityStatMultFromQ8(q8: number): number {
  if (!q8) return 1;
  return q8 / 256;
}

/** Effective cannon hull damage for UI (base × ship damage level × weapon quality q8). */
export function computeCannonHullDamage(
  baseDamage: number,
  shipDamageLevel: number,
  weaponDmgQ8?: number,
  qualityTier?: number,
): number {
  let dmg = baseDamage * shipLevelDamageMult(shipDamageLevel);
  if (weaponDmgQ8 && weaponDmgQ8 > 0) {
    dmg *= qualityStatMultFromQ8(weaponDmgQ8);
  } else if (typeof qualityTier === 'number' && qualityTier >= 1) {
    dmg *= qualityTierBonusMult(qualityTier);
  }
  return Math.round(dmg);
}

/** Effective anti-personnel damage (cannonball 75 / bar shot 15 base × ship damage level only). */
export function computeCannonEntityDamage(
  baseDamage: number,
  shipDamageLevel: number,
): number {
  return Math.round(baseDamage * shipLevelDamageMult(shipDamageLevel));
}

/** Craft resource cost multiplier by tier (Crude 1× .. Eternal 3×). Mirrors server quality_craft_cost_mult. */
export function qualityCostMult(tier: number): number {
  const t = Math.max(0, Math.min(6, Math.floor(tier)));
  return 1 + (2 * t) / 6;
}

/** Resource cost for one craft from a schematic blueprint. */
export interface SchematicCraftCost {
  wood: number;
  fiber: number;
  metal: number;
  stone: number;
}

/** Base ingredient counts for crafting from a schematic (mirrors server bp_base_cost). */
export function blueprintBaseCost(itemId: number): SchematicCraftCost {
  switch (itemId) {
    case 7:  return { wood: 8,  fiber: 0,   metal: 20, stone: 0 };  // cannon
    case 14: return { wood: 5,  fiber: 0,   metal: 8,  stone: 0 };  // swivel
    case 4:  return { wood: 2,  fiber: 0,   metal: 5,  stone: 0 };  // sword
    case 15: return { wood: 2,  fiber: 0,   metal: 0,  stone: 5 };  // axe
    case 25: return { wood: 3,  fiber: 0,   metal: 0,  stone: 4 };  // pickaxe
    case 8:  return { wood: 40, fiber: 100, metal: 0,  stone: 0 };  // sail
    case 1:  return { wood: 30, fiber: 0,   metal: 0,  stone: 0 };  // plank
    case 13: return { wood: 75, fiber: 0,   metal: 0,  stone: 0 };  // deck
    case 9:  return { wood: 10, fiber: 0,   metal: 0,  stone: 0 };  // helm
    case 16: return { wood: 20, fiber: 0,   metal: 0,  stone: 0 };  // wooden floor
    case 18: return { wood: 10, fiber: 0,   metal: 0,  stone: 0 };  // wall
    case 28: return { wood: 15, fiber: 0,   metal: 0,  stone: 0 };  // wood ceiling
    case 20: return { wood: 4,  fiber: 0,   metal: 0,  stone: 0 };  // door
    case 35: return { wood: 40, fiber: 0,   metal: 0,  stone: 40 }; // flag fort
    case 26: return { wood: 30, fiber: 0,   metal: 0,  stone: 0 };  // shipyard (+10 plank on server)
    default: return { wood: 0, fiber: 0, metal: 0, stone: 0 };
  }
}

/** Tier-scaled craft cost for a schematic entry (mirrors server handle_craft_blueprint). */
export function schematicCraftCost(entry: Pick<SchematicEntry, 'item' | 'tier'>): SchematicCraftCost {
  const base = blueprintBaseCost(entry.item);
  const mult = qualityCostMult(entry.tier);
  const scale = (n: number) => (n > 0 ? Math.max(n, Math.ceil(n * mult)) : 0);
  return {
    wood:  scale(base.wood),
    fiber: scale(base.fiber),
    metal: scale(base.metal),
    stone: scale(base.stone),
  };
}

/** A schematic/blueprint entry as sent by the server in `schematic_list`. */
export interface SchematicEntry {
  /** Server-side slot index (used as the craft index). */
  index: number;
  /** Server item id. */
  item: number;
  /** Quality value 0..1. */
  quality: number;
  /** Tier 0..6. */
  tier: number;
  /** Remaining crafts available from this blueprint. */
  crafts: number;
  /** Per-stat q8 multipliers, indexed by QualityStatId. */
  stats: number[];
}

/** Ship shared pool entry from `ship_schematic_list`. */
export interface ShipSchematicEntry extends SchematicEntry {
  /** Priority within the item type — lower = NPCs use first. */
  prio: number;
}

export const MAX_SHIP_SCHEMATICS = 48;
