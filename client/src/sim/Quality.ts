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
 * when the stat does not apply to the item (q8 === 0).
 */
export function statMultLabel(q8: number): string | null {
  if (!q8) return null;
  const pct = Math.round((q8 / 256 - 1) * 100);
  return (pct >= 0 ? '+' : '') + pct + '%';
}

/** Resource cost multiplier by tier (Crude=1×, Eternal=6×). */
const TIER_COST_MULT = [1.0, 1.25, 1.5, 2.0, 3.0, 4.5, 6.0];
export function qualityCostMult(tier: number): number {
  const i = Math.max(0, Math.min(TIER_COST_MULT.length - 1, Math.floor(tier)));
  return TIER_COST_MULT[i];
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
