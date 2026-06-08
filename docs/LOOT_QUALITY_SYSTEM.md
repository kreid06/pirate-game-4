# Loot Quality & Schematic System — Design Doc

Status: **DRAFT for review** — do not implement until the Decision Points are signed off.

This document captures the quality-tier loot system: ghost ships drop schematic
blueprints of varying quality; players salvage them from shipwrecks; crafting a
blueprint rolls per-stat multipliers and produces a quality item with a limited
number of crafts.

---

## 1. Quality Tiers

`quality` is a continuous float. The **display tier** is `clamp(floor(quality), 0, 6)`.
The raw float drives the stat math (so a 2.4 and a 2.9 differ).

| Tier | Name | Color | Hex | quality range |
|-----:|------|-------|-----|---------------|
| 0 | Crude | grey | `#9d9d9d` | 0.0 – 0.9 |
| 1 | Ironbound | green | `#1eff00` | 1.0 – 1.9 |
| 2 | Brineforged | blue | `#0070dd` | 2.0 – 2.9 |
| 3 | Buccaneer's | purple | `#a335ee` | 3.0 – 3.9 |
| 4 | Legendary | yellow | `#ffd700` | 4.0 – 4.9 |
| 5 | Mythical | cyan | `#00ffff` | 5.0 – 5.9 |
| 6 | Eternal | magenta | `#ff00ff` | 6.0+ |

---

## 2. Quality from Ghost Level (drop-time roll)

When a ghost ship dies it drops a wreck. Each blueprint in that wreck gets a
fixed quality, rolled once:

```
base_quality = ghost_level / 10.0          // lvl 24 -> 2.4
quality      = base_quality * rand(0.75, 1.25)   // ±25% spread
// quality is then FIXED and stored on the blueprint
```

Level → tier band (before the ±25% roll):

| Ghost level | base_quality | typical tier after roll |
|-------------|--------------|--------------------------|
| 1–9 | 0.1–0.9 | Crude (can dip to 0, nudge to Ironbound) |
| 10–19 | 1.0–1.9 | Ironbound (±1 tier at edges) |
| 20–29 | 2.0–2.9 | Brineforged |
| 30–39 | 3.0–3.9 | Buccaneer's |
| 40–49 | 4.0–4.9 | Legendary |
| 50–59 | 5.0–5.9 | Mythical |
| 60+ | 6.0+ | Eternal |

Example: a **lvl 24** ghost rolls quality in `2.4 × [0.75, 1.25] = [1.8, 3.0]` —
mostly Brineforged, occasionally Ironbound or Buccaneer's.

> Open: is there a ghost level cap? At lvl 60 the high roll gives `6.0 × 1.25 = 7.5`
> quality. That's fine for the math (Eternal display, higher stat rolls), but if
> ghosts can reach lvl 100+, quality/stats keep scaling. See Decision Point D.

---

## 3. Item Stat Caps & Craft Counts

All stats are **multipliers** over the item's existing base value. `base = 1.0` (100%).

| Item | Max crafts | Rolled stats (cap) |
|------|-----------:|--------------------|
| Cannon | 20 | weapon damage (3.0×), durability (3.0×) |
| Plank | 20 | durability (3.0×) |
| Deck | 6 | durability (3.0×) |
| Chest | 20 | durability (3.0×) |
| Steering wheel | 8 | durability (3.0×) |
| Sail | 10 | durability (3.0×), sail effectiveness (1.5×) |
| Sword | 10 | weapon damage (3.0×), durability (3.0×) |
| Axe | 10 | weapon damage (3.0×), durability (3.0×) |
| Pickaxe | 10 | weapon damage (3.0×), durability (3.0×) |
| Wooden Floor | 40 | durability (3.0×) |
| Wall | 40 | durability (3.0×)|
| Ceiling | 40 | durability (3.0×)|
| Door | 20 |durability (3.0×)|
| Fort | 3 | durability (3.0×), structure dmg resistance (2.0×), repair speed (2.0×) |
| Shipyard | 5 | durability (3.0×) |

> Items with "no rolled stats" still carry a quality/tier for color & prestige, but
> craft to a plain item. (Confirm in Decision Point E.)
> Additional note is that we're going to merge the door frame item into the wall item and we can have the `t` key to cycle through variants `wall` and `door frame`
---

## 4. Stat Roll Formula

Per **stat**, rolled **per craft** (each charge of a blueprint can differ):

```
step  = (max_mult - base_mult) / 7          // base_mult = 1.0
roll  = step * (quality + 1) * (0.25 + random())   // random() in [0,1) -> factor [0.25, 1.25)
final = clamp(roll, base_mult, max_mult)    // under base -> base; over cap -> cap
```

This is the literal spec ("Model A"). **It has a structural problem — see Decision Point A.**

### 4a. Model A behaviour (literal spec)

Because `final` is an **absolute** value clamped up to base, the `step*(quality+1)`
term must climb **above 1.0** before quality does anything. For a 3.0× cap stat
(`step = 0.2857`), using `quality = tier` as the reference point:

| Tier | raw range | final multiplier (after clamp) |
|-----:|-----------|--------------------------------|
| 0 Crude | 0.07–0.36 | **1.00×** (always base) |
| 1 Ironbound | 0.14–0.71 | **1.00×** (always base) |
| 2 Brineforged | 0.21–1.07 | 1.00× – 1.07× |
| 3 Buccaneer's | 0.29–1.43 | 1.00× – 1.43× |
| 4 Legendary | 0.36–1.79 | 1.00× – 1.79× |
| 5 Mythical | 0.43–2.14 | 1.00× – 2.14× |
| 6 Eternal | 0.50–2.50 | 1.00× – 2.50× |

Problems this surfaces:
1. **Tiers 0–1 are always exactly base** for every stat. Quality is cosmetic there.
2. **The cap is barely reachable.** Even Eternal tops at 2.50× for a 3.0× stat at
   `quality = 6`; you need `quality ≈ 7.4` (a lucky lvl 60+ roll) to hit 3.0×.
3. **Small-cap stats never move.** Sail effectiveness (1.5× cap, `step = 0.071`):
   at tier 6 the raw range is `0.125–0.625` → **always clamps to base 1.0×**. So
   sail effectiveness, fort resistance (2.0×), and repair speed (2.0×) get little
   or no benefit from quality under this formula.

### 4b. Model B behaviour (recommended: base + bonus)

One-line change — make the roll a **bonus added to base**:

```
bonus = step * (quality + 1) * (0.25 + random())
final = clamp(base_mult + bonus, base_mult, max_mult)   // = base + bonus, capped
```

Same 3.0× cap stat, by tier:

| Tier | final multiplier |
|-----:|------------------|
| 0 Crude | 1.07× – 1.36× |
| 1 Ironbound | 1.14× – 1.71× |
| 2 Brineforged | 1.21× – 2.07× |
| 3 Buccaneer's | 1.29× – 2.43× |
| 4 Legendary | 1.36× – 2.79× |
| 5 Mythical | 1.43× – 3.0× (clamped) |
| 6 Eternal | 1.50× – 3.0× (clamped) |

And small-cap stats now scale correctly:
- Sail effectiveness (1.5× cap): tier 0 ≈ 1.02–1.09×, tier 6 ≈ 1.13–1.50×.
- Fort resistance (2.0× cap): tier 6 ≈ 1.25–2.0×.

Every tier gives a meaningful bump, the cap is reachable at the top tiers, and the
"clamp under base" rule becomes a harmless safety net (bonus is always ≥ 0).

**Recommendation: adopt Model B.** It matches the intent ("higher quality = better")
and keeps your ±25% quality roll and the `(0.25 + random())` factor exactly as you
specified.


>>Model B seems better lets run it
---

## 5. Blueprint / Schematic Lifecycle

```
Ghost ship dies
   └─> spawn STRUCT_WRECK with N blueprint loot slots
         each slot = { item_kind, quality (fixed), crafts_remaining = max_crafts }
   └─> player opens wreck  ->  blueprints go into (Schematic) inventory (see my notes on schematic inventory)
   └─> player crafts from a blueprint (costs resources, TBD)
         - roll every stat for that item (Model B), using the blueprint's quality
         - produce 1 quality item with its rolled multipliers
         - crafts_remaining -= 1; blueprint consumed when it hits 0
   └─> quality item placed/equipped keeps its rolled multipliers (persisted)
```
>>>  Tthe schematic inventory is going to need be a drop down when you click on a certain schematic type to view availible schematics in the 
>>> players inventory and should be retained after death for now. In the furture we're going to have a system where the player needs to head some >>> where to research so that its permanently in the schematic portion but for now we're going to make it pernamment right off the bat
>> we may need to update the shipgui to inventory interface to have a schematic section

Open: re-roll per craft (default — each crafted item from the same blueprint can
differ) vs. lock stats at drop (all crafts identical). Default assumes **re-roll
per craft**. See Decision Point C.


>>> All crafts identicall

---

## 6. Data Model Changes (server)

Current relevant structs (for reference):
- `DroppedItem` — `{ id, item_kind, quantity, x, y, spawn_time_ms, active }`
  (`server/src/net/websocket_server.c`)
- `InventorySlot` — `{ ItemKind item, uint8_t quantity }`
  (`server/include/net/websocket_server.h`)
- Wreck loot on `PlacedStructure` — `wreck_items[6]`, `wreck_qtys[6]` (uint8 each)
- Module stats live on `ShipModule` (`server/include/sim/module_types.h`)

Proposed additions (a compact, shared quality payload reused everywhere):

```c
typedef enum {
    STAT_DURABILITY = 0,
    STAT_WEAPON_DAMAGE,
    STAT_SAIL_EFFECTIVENESS,
    STAT_STRUCT_RESISTANCE,
    STAT_REPAIR_SPEED,
    STAT_COUNT
} QualityStatId;

typedef struct {
    uint8_t  quality_q8;          /* quality float * 32, 0..255 (0.0..~7.9) */
    uint16_t stat_mult_q8[STAT_COUNT]; /* multiplier * 256, 256 = 1.00x     */
} QualityPayload;
```

- **Blueprint storage**: extend inventory/wreck loot to carry `{ quality, crafts_remaining }`.
  The 6-slot wreck arrays are uint8 — they'll need a parallel `wreck_quality[6]`
  and `wreck_crafts[6]` (or a richer loot struct).
- **Crafted items / placed modules**: attach `QualityPayload` so a placed Eternal
  cannon keeps its rolled damage/durability after reload.
- **Persistence**: serialize `quality` + `stat_mult[]` per module in `world_state.json`
  (alongside the existing health fields), and per blueprint in player saves.

Exact field placement (inventory slot vs. a separate parallel array) is an
implementation choice I'll finalize once Model A/B is picked.

---

## 7. Client Changes (later pass)

- Tier name + color table (Section 1) for item tooltips, blueprint cards, dropped-item glints.
- Blueprint inventory UI: show item, tier (colored), crafts remaining, rolled-stat preview.
- Wreck-open flow already exists; add quality coloring to looted blueprints.
- Dropped-item / wreck world glow tinted by tier color.

---

## 8. Decision Points (need your call)

- **A. Formula model — Model A (literal) or Model B (base + bonus)?**
  Strong recommendation: **Model B**. Model A leaves tiers 0–1 always-base and
  makes small-cap stats (sail effectiveness, fort resist/repair) inert.
  >>model B
- **B. Quality cap.** Cap quality at 6.0 for the math, or let it ride to 7.5+ on
  high-level lucky rolls (lets top stats reach their caps under Model B too)?
  >>>let it ride
- **C. Re-roll per craft** (each craft differs) **or lock stats at drop** (all
  crafts identical)? Default: re-roll per craft.
  >>> idential
- **D. Ghost level cap.** What's the max ghost level? Affects max attainable quality.
>>> 60 for now
- **E. Stat-less items** (floor/wall/ceiling/door): do they still get a tier/color
  for prestige, or are they always plain?
  >>>tier/color and i added durabillity to them 
- **F. Craft resource cost.** Do quality crafts cost extra/rarer resources, or just
  consume a blueprint charge + normal mats?
  >>> in the future will be different types of resources but for now lets just make it up 3x more the resources for the max quality stuff

---

## 9. Build Order (once signed off)

1. [DONE] Server: `QualityStatId`, `QualityPayload`, roll function (Model B). → `net/quality.{h,c}`, `net/quality_payload.h`.
2. [DONE] Server: ghost-death → blueprint quality roll → wreck loot carries blueprints. → `ship_init.c` (`tick_sinking_ships`).
3. [DONE] Server: schematic inventory + wreck salvage + craft-blueprint handler → roll-once quality item, decrement charges. → `crafting.{h,c}`, `structures.c`, `websocket_server.c` dispatch.
4. [DONE] Server: persistence + attach payload to placed modules.
   - [DONE] Persist schematic inventory + crafted-item slot quality in player save. → `player_persistence.c`.
   - [DONE] `QualityPayload` field added to `ShipModule` + `PlacedStructure` (data model).
   - [DONE] Read source-slot quality at item-based placement sites (cannon, sail/mast, structures), scale HP by durability mult, set health=max. → `module_apply_quality()` in `module_types.c`; `structures.c`. (Plank/deck/swivel are resource-pool placements — no discrete quality item flows through them.)
   - [DONE] Persist placed quality in `world_state.json` save/load (modules + structures). → `world_save.c`.
   - [DONE] Apply weapon-damage mult (cannon fire + held sword), sail-effectiveness mult (mast thrust), structural-resistance mult (structure damage). → `cannon_fire.c`, `websocket_server.c`, `structures.c`.
   - [DONE] Serialize placed quality in live GAME_STATE for client coloring — module `qt` (cannon/mast/swivel) + structure `qt` + wreck `wreck_tier` fields; client renders tier-colored gems/glints. → `websocket_server.c`, `ship_init.c`, client `RenderSystem.ts`/`NetworkManager.ts`.
5. [DONE] Door-frame merges into Wall (`T`-variant cycle) — §11.5 refactor.
6. [DONE] Client: tier colors/names, schematic UI, message senders/handlers, tooltips, world glints.

---

## 10. Confirmed Decisions (from review)

- **A — Formula: Model B (base + bonus).** Final, locked:
  ```
  step  = (max_mult - 1.0) / 7
  bonus = step * (quality + 1) * (0.25 + random())   // random() in [0,1)
  final = clamp(1.0 + bonus, 1.0, max_mult)
  ```
- **B — Quality "lets it ride."** No clamp on the raw quality float; with the lvl-60
  cap this tops out at `6.0 × 1.25 = 7.5`. Display tier still clamps to 6 (Eternal).
- **C — All crafts identical.** Consequence: stats are rolled **once at wreck-drop
  time** and the full rolled `QualityPayload` (quality + every `stat_mult`) is stored
  on the blueprint. Every craft copies it verbatim; only `crafts_remaining` changes.
- **D — Ghost level cap = 60** (for now). Max quality therefore 7.5.
- **E — Stat-less items now roll durability.** Floor/Wall/Ceiling/Door each get
  durability (3.0×) and a tier/color. Table in §3 updated.
- **F — Craft cost scales with quality.** Proposed curve (confirm in §11.4):
  `cost = ceil(base_recipe_cost * (1 + 2 * min(quality, 6) / 6))`
  → Crude ≈ 1×, Legendary ≈ 2.3×, Eternal = 3× the normal recipe mats, plus one
  blueprint charge. (Rarer resource types come later.)

### New requirements captured from notes

- **Schematic inventory** is a **separate, persistent container** (not the 16 bag
  slots). Grouped by item type; clicking a type opens a dropdown of the player's
  owned blueprints of that type (each with its own tier + crafts remaining).
  Retained through death and **permanent from the start** (the "go research it to
  keep it" gate comes later). Ship/inventory GUI gets a new Schematic section.
- **Door-frame merges into Wall** with a `T`-key variant cycle (`wall` ⇄ `door
  frame`). For loot purposes there is a single **Wall** blueprint. This is a
  separate refactor of `STRUCT_DOOR_FRAME`/`ITEM_DOOR_FRAME` — see §11.5.

---

## 11. Resolved Questions

1. **Durability scope — store-only for v1, option (a).** Items carry a
   `durability_mult` shown in the UI. For items that **already** have HP (modules,
   structures) the multiplier scales their existing `max_health` immediately
   (Eternal plank/cannon/wall gets up to 3× HP). Tools/weapons/chests have no HP
   today, so their `durability_mult` is display-only until a real wear system lands. ✔
2. **Weapon-damage multiplier** scales the final computed damage
   (`damage *= weapon_damage_mult`), stacking on player stats / cannon base. ✔
3. **Ghost wreck drops:** each wreck drops **2–6 blueprints**, item types chosen
   **uniformly at random for now** (weighting comes later), **in addition to** the
   existing resource loot (planks, etc.). ✔
4. **Craft cost curve confirmed:** `ceil(base * (1 + 2*min(quality,6)/6))`
   (Crude 1× → Eternal 3×) + one blueprint charge. ✔
5. **Door-frame → Wall merge is bundled** into this work (`T`-cycle variant, single
   Wall blueprint, plus the `structures.c` cascade refactor). ✔
6. **Schematic inventory:** **unlimited** size, keyed by item type; multiple
   blueprints of different tiers coexist within one type group (e.g. several Cannon
   blueprints under "Cannon"). ✔
