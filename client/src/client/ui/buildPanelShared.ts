import { GhostModuleKind } from '../../sim/Types.js';

/** One ship-deck build module shown in the build panel, hotbar, and schematics tab. */
export type ShipBuildPanelEntry = {
  kind: GhostModuleKind;
  label: string;
  symbol: string;
  color: string;
  borderColor: string;
  cost: { wood: number; fiber: number; metal: number; stone: number };
};

/** Canonical ship build entries — keep in sync with server MODULE_RES_COST. */
export const SHIP_BUILD_PANEL_ENTRIES: ShipBuildPanelEntry[] = [
  { kind: 'plank',       label: 'Plank',          symbol: 'P',  color: '#b8832b', borderColor: '#7a5520', cost: { wood: 10, fiber: 0,  metal: 0, stone: 0 } },
  { kind: 'cannon',      label: 'Cannon',          symbol: '⚫', color: '#444',    borderColor: '#888',    cost: { wood: 2,  fiber: 0,  metal: 5, stone: 0 } },
  { kind: 'swivel',      label: 'Swivel Gun',      symbol: '›', color: '#7a4a2a', borderColor: '#4a2810', cost: { wood: 1,  fiber: 0,  metal: 3, stone: 0 } },
  { kind: 'mast',        label: 'Sail / Mast',     symbol: '⛵', color: '#1e8c6e', borderColor: '#0f5c48', cost: { wood: 20, fiber: 10, metal: 0, stone: 0 } },
  { kind: 'helm',        label: 'Helm',            symbol: 'W',  color: '#6a3d8f', borderColor: '#3d2060', cost: { wood: 5,  fiber: 0,  metal: 3, stone: 0 } },
  { kind: 'deck',        label: 'Deck',            symbol: '⊟', color: '#8b5e3c', borderColor: '#5c3a1c', cost: { wood: 15, fiber: 0,  metal: 0, stone: 0 } },
  { kind: 'ramp',        label: 'Ramp',            symbol: '/', color: '#7a5c2a', borderColor: '#4a3410', cost: { wood: 8,  fiber: 0,  metal: 0, stone: 0 } },
  { kind: 'gunport',     label: 'Gunport',         symbol: '▪', color: '#4a3828', borderColor: '#2a1808', cost: { wood: 6,  fiber: 0,  metal: 2, stone: 0 } },
  { kind: 'hatch_cover', label: 'Hatch Cover',     symbol: '⊞', color: '#8b832b', borderColor: '#5a5520', cost: { wood: 8,  fiber: 0,  metal: 0, stone: 0 } },
  { kind: 'workbench',   label: 'Workbench',       symbol: '⚒', color: '#9a6a28', borderColor: '#5a4010', cost: { wood: 12, fiber: 0,  metal: 0, stone: 0 } },
  { kind: 'chest',       label: 'Chest',           symbol: '⊡', color: '#7a4820', borderColor: '#4a2810', cost: { wood: 12, fiber: 0,  metal: 0, stone: 0 } },
  { kind: 'bed',         label: 'Bed',             symbol: '🛏', color: '#4a3060', borderColor: '#2a1840', cost: { wood: 10, fiber: 5,  metal: 0, stone: 0 } },
  { kind: 'well',        label: 'Bilge Well',      symbol: '⛲', color: '#4a7ab0', borderColor: '#2a4878', cost: { wood: 8,  fiber: 4,  metal: 0, stone: 0 } },
];
