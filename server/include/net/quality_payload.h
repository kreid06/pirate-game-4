#ifndef NET_QUALITY_PAYLOAD_H
#define NET_QUALITY_PAYLOAD_H

#include <stdint.h>

/*
 * Dependency-free quality payload definitions, shared by websocket_server.h
 * (which embeds QualityPayload in structs) and net/quality.h (the roll API).
 * See docs/LOOT_QUALITY_SYSTEM.md.
 */

/* Per-stat multiplier slots. base = 1.0 (256 in q8). */
typedef enum {
    STAT_DURABILITY = 0,        /* scales max HP for items that already have HP */
    STAT_WEAPON_DAMAGE,         /* scales final melee / cannon damage            */
    STAT_SAIL_EFFECTIVENESS,    /* scales sail wind efficiency                   */
    STAT_STRUCT_RESISTANCE,     /* scales structure damage resistance (forts)    */
    STAT_REPAIR_SPEED,          /* scales structure repair rate (forts)          */
    STAT_COUNT
} QualityStatId;

/* Compact payload reused on blueprints, crafted items, placed modules, saves. */
typedef struct {
    uint8_t  quality_q8;                 /* quality * 32, clamped 0..255 (0.0 .. ~7.9) */
    uint16_t stat_mult_q8[STAT_COUNT];   /* multiplier * 256, 256 = 1.00x; 0 = stat n/a */
} QualityPayload;

#endif /* NET_QUALITY_PAYLOAD_H */
