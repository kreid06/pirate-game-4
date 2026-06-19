/**
 * Grapple carry-weight helpers — mirror server GRAPPLE_BODY_MASS_KG + target inventory.
 */

import type { Player } from './Types.js';
import { computeInventoryWeight } from './Inventory.js';

export const GRAPPLE_BODY_MASS_KG = 40;
export const GRAPPLE_TARGET_PLAYER = 3;
export const GRAPPLE_TARGET_NPC = 4;

/** Extra carry load (kg) while grappling a player or NPC. */
export function computeGrappleExtraCarryKg(player: Player, allPlayers: Player[]): number {
  if (player.grappleState !== 2) return 0;
  const gt = player.grappleTargetType;
  if (gt !== GRAPPLE_TARGET_PLAYER && gt !== GRAPPLE_TARGET_NPC) return 0;
  if (gt === GRAPPLE_TARGET_NPC) return GRAPPLE_BODY_MASS_KG;

  let extra = GRAPPLE_BODY_MASS_KG;
  if (player.grappleX !== undefined && player.grappleY !== undefined) {
    const gx = player.grappleX;
    const gy = player.grappleY;
    const tgt = allPlayers.find(p =>
      p.id !== player.id &&
      Math.hypot(p.position.x - gx, p.position.y - gy) < 8,
    );
    if (tgt?.inventory) extra += computeInventoryWeight(tgt.inventory);
  }
  return extra;
}

export function playerCarryCapacityKg(statWeight = 0): number {
  return 300 * (1 + statWeight * 0.1);
}

export function playerEffectiveCarryRatio(player: Player, allPlayers: Player[]): number {
  const cap = playerCarryCapacityKg(player.statWeight ?? 0);
  if (cap <= 0) return 0;
  const kg = (player.inventory ? computeInventoryWeight(player.inventory) : 0)
    + computeGrappleExtraCarryKg(player, allPlayers);
  return kg / cap;
}

export function isGrappleEncumbered(player: Player, allPlayers: Player[]): boolean {
  return playerEffectiveCarryRatio(player, allPlayers) >= 1.0;
}
