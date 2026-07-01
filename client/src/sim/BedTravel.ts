/** Bed fast-travel cooldown — mirrors server bed_last_use_ms gate (60 s). */

export const BED_TRAVEL_COOLDOWN_MS = 60_000;

export function getBedTravelCooldownRemaining(cooldownUntilMs: number, nowMs = Date.now()): number {
  if (cooldownUntilMs <= 0) return 0;
  return Math.max(0, cooldownUntilMs - nowMs);
}

export function formatBedCooldownLabel(remainingMs: number): string {
  const secs = Math.ceil(remainingMs / 1000);
  return `${secs}s`;
}
