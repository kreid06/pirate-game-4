/**
 * module_ids.h — Module ID encoding scheme (8+8 bit-split uint16_t)
 *
 * Every module ID in the game is a uint16_t split into two bytes:
 *
 *   ┌────────────────┬────────────────┐
 *   │  bits [15..8]  │  bits  [7..0]  │
 *   │   ship_seq     │    offset      │
 *   └────────────────┴────────────────┘
 *
 *   ship_seq  (uint8_t, 1–255) — monotonically-incrementing ship counter.
 *             0 is reserved as "invalid / no ship".
 *             Supports up to 255 simultaneous ships per server instance.
 *
 *   offset    (uint8_t, 0–255) — module slot within that ship.
 *             0 is reserved as "invalid / no module".
 *
 * ── Derivation (no lookup table required) ─────────────────────────────────
 *
 *   ship_seq = MID_SHIP_SEQ(id)    // (id >> 8) & 0xFF
 *   offset   = MID_OFFSET(id)      // id & 0xFF
 *
 * ── Fixed offset allocations per ship ─────────────────────────────────────
 *
 *   0x00   reserved / invalid           MODULE_OFFSET_INVALID
 *   0x01   emergency stern ladder       MODULE_OFFSET_LADDER
 *   0x02   helm (steering wheel)        MODULE_OFFSET_HELM
 *   0x03   cannon port-0 (mid)          MODULE_OFFSET_CANNON_PORT_0
 *   0x04   cannon port-1 (bow)          MODULE_OFFSET_CANNON_PORT_1
 *   0x05   cannon port-2 (stern)        MODULE_OFFSET_CANNON_PORT_2
 *   0x06   cannon starboard-0           MODULE_OFFSET_CANNON_STBD_0
 *   0x07   cannon starboard-1           MODULE_OFFSET_CANNON_STBD_1
 *   0x08   cannon starboard-2           MODULE_OFFSET_CANNON_STBD_2
 *   0x09   mast bow                     MODULE_OFFSET_MAST_BOW
 *   0x0A   mast mid                     MODULE_OFFSET_MAST_MID
 *   0x0B   mast stern                   MODULE_OFFSET_MAST_STERN
 *   0x0C   plank 0  (bow port)          MODULE_OFFSET_PLANK(0)
 *   0x0D   plank 1  (bow stbd)
 *   0x0E   plank 2  (stbd side 0)
 *   0x0F   plank 3  (stbd side 1)
 *   0x10   plank 4  (stbd side 2)
 *   0x11   plank 5  (stern stbd)
 *   0x12   plank 6  (stern port)
 *   0x13   plank 7  (port side 0)
 *   0x14   plank 8  (port side 1)
 *   0x15   plank 9  (port side 2)        MODULE_OFFSET_PLANK(9)
 *   0x16   deck                          MODULE_OFFSET_DECK
 *   0x17–0xFF  dynamically placed mods   MODULE_OFFSET_DYNAMIC_BASE
 *
 * ── Wire cost ─────────────────────────────────────────────────────────────
 *   JSON  : max 5 chars (65535)
 *   Binary: 2 bytes (uint16_t little-endian)
 */

#ifndef MODULE_IDS_H
#define MODULE_IDS_H

#include <stdint.h>

/* The module ID type used throughout the codebase */
typedef uint16_t module_id_t;

/* ── Construction / extraction macros ────────────────────────────────────── */

/** Build a module_id_t from a ship sequence number and a per-ship offset. */
#define MID(ship_seq, offset) \
    ((module_id_t)(((uint16_t)(ship_seq) << 8) | ((uint8_t)(offset))))

/** Extract the ship sequence byte from a module ID. */
#define MID_SHIP_SEQ(mid)   (((mid) >> 8) & 0xFF)

/** Extract the per-ship offset byte from a module ID. */
#define MID_OFFSET(mid)     ((mid) & 0xFF)

/** True if the module belongs to the given ship_seq. */
#define MID_BELONGS_TO(mid, ship_seq) (MID_SHIP_SEQ(mid) == (uint8_t)(ship_seq))

/* ── Sentinel ────────────────────────────────────────────────────────────── */

/** The zero value — never a valid module ID. */
#define MODULE_ID_INVALID   ((module_id_t)0x0000)

/* ── Fixed per-ship module offsets ──────────────────────────────────────── */

#define MODULE_OFFSET_INVALID       0x00u  /* reserved — must never be assigned   */
#define MODULE_OFFSET_LADDER        0x01u  /* emergency stern ladder (always here) */
#define MODULE_OFFSET_HELM          0x02u  /* steering wheel                       */
#define MODULE_OFFSET_CANNON_PORT_0 0x03u  /* port cannon 0 (mid-ship)             */
#define MODULE_OFFSET_CANNON_PORT_1 0x04u  /* port cannon 1 (bow-ward)             */
#define MODULE_OFFSET_CANNON_PORT_2 0x05u  /* port cannon 2 (stern-ward)           */
#define MODULE_OFFSET_CANNON_STBD_0 0x06u  /* starboard cannon 0                   */
#define MODULE_OFFSET_CANNON_STBD_1 0x07u  /* starboard cannon 1                   */
#define MODULE_OFFSET_CANNON_STBD_2 0x08u  /* starboard cannon 2                   */
#define MODULE_OFFSET_MAST_BOW      0x09u  /* forward mast                         */
#define MODULE_OFFSET_MAST_MID      0x0Au  /* middle mast                          */
#define MODULE_OFFSET_MAST_STERN    0x0Bu  /* aft mast                             */
#define MODULE_OFFSET_PLANK_BASE    0x0Cu  /* first plank (planks 0–9 = 0x0C–0x15) */
#define MODULE_OFFSET_DECK          0x16u  /* centre deck                           */
#define MODULE_OFFSET_DYNAMIC_BASE  0x17u  /* first dynamically placed module slot  */

/* ── Per-plank helper (n = 0..9) ─────────────────────────────────────────── */
#define MODULE_OFFSET_PLANK(n)  ((uint8_t)(MODULE_OFFSET_PLANK_BASE + (n)))

/* ── Cannon offset helpers ───────────────────────────────────────────────── */

/**
 * Cannon slot index → offset.
 * Slots 0–2 are port, slots 3–5 are starboard — matches the iteration order
 * used in init_brigantine_ship and sim_create_ship.
 */
#define MODULE_OFFSET_CANNON(i) ((uint8_t)(MODULE_OFFSET_CANNON_PORT_0 + (i)))

/**
 * Offset → cannon slot index (0–5).
 * Only valid when MID_OFFSET(id) is in [CANNON_PORT_0, CANNON_STBD_2].
 */
#define MID_CANNON_INDEX(mid) ((int)(MID_OFFSET(mid) - MODULE_OFFSET_CANNON_PORT_0))

/* ── Mast offset helper (i = 0 = bow, 1 = mid, 2 = stern) ───────────────── */
#define MODULE_OFFSET_MAST(i)  ((uint8_t)(MODULE_OFFSET_MAST_BOW + (i)))

/* ── Range predicates ───────────────────────────────────────────────────── */

/** True if the offset is one of the 6 cannon slots. */
#define MODULE_OFFSET_IS_CANNON(off) \
    ((off) >= MODULE_OFFSET_CANNON_PORT_0 && (off) <= MODULE_OFFSET_CANNON_STBD_2)

/** True if the offset is one of the 3 mast slots. */
#define MODULE_OFFSET_IS_MAST(off) \
    ((off) >= MODULE_OFFSET_MAST_BOW && (off) <= MODULE_OFFSET_MAST_STERN)

/** True if the offset is one of the 10 plank slots. */
#define MODULE_OFFSET_IS_PLANK(off) \
    ((off) >= MODULE_OFFSET_PLANK_BASE && (off) < MODULE_OFFSET_DECK)

#endif /* MODULE_IDS_H */
