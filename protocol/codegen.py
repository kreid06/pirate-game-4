#!/usr/bin/env python3
"""
protocol/codegen.py — Generate ship definition headers from JSON source of truth.

Reads:   protocol/ship_definitions.json
Writes:  protocol/ship_definitions.h       (C99 header for server + C client)
         client/src/common/ShipDefinitions.ts  (TypeScript for web client)

Usage:
    python3 protocol/codegen.py          # from repo root
    make codegen                         # via protocol/Makefile
"""

import json
import sys
import textwrap
from pathlib import Path

REPO   = Path(__file__).parent.parent
PROTO  = Path(__file__).parent
SRC    = PROTO / "ship_definitions.json"
C_OUT  = PROTO / "ship_definitions.h"
TS_OUT = REPO  / "client" / "src" / "common" / "ShipDefinitions.ts"

# ── Helpers ──────────────────────────────────────────────────────────────────

def load():
    with open(SRC) as f:
        return json.load(f)

def guard(path: Path) -> str:
    return path.name.upper().replace(".", "_").replace("-", "_")

# ── C header generator ───────────────────────────────────────────────────────

C_HEADER_BOILERPLATE = '''\
/**
 * {name} — C99 header generated from ship_definitions.json.
 * DO NOT EDIT — run `python3 protocol/codegen.py` to regenerate.
 *
 * Source of truth: protocol/ship_definitions.json
 */
#ifndef {guard}
#define {guard}

#include <math.h>

typedef struct {{ float x; float y; }} Vec2;

/* ── Bezier / lerp helpers (hand-written, not generated) ─────────────────── */

static inline Vec2 _quadratic_bezier(Vec2 p0, Vec2 p1, Vec2 p2, float t) {{
    float u = 1.0f - t;
    return (Vec2){{
        u*u*p0.x + 2*u*t*p1.x + t*t*p2.x,
        u*u*p0.y + 2*u*t*p1.y + t*t*p2.y
    }};
}}

static inline Vec2 _lerp(Vec2 p0, Vec2 p1, float t) {{
    return (Vec2){{ p0.x + t*(p1.x-p0.x), p0.y + t*(p1.y-p0.y) }};
}}

'''

C_FOOTER = '#endif /* {guard} */\n'

def _cf(v) -> str:
    """Format a number as a C float literal."""
    s = str(float(v))
    return s + "f" if "." in s else s + ".0f"

def c_hull_struct(ship_id: str, cp: dict) -> str:
    lines = [f"/* ── {ship_id.title()} hull control points ─── */\n"]
    lines.append(f"typedef struct {{\n")
    for key in cp:
        lines.append(f"    Vec2 {key};\n")
    lines.append(f"}} {ship_id.title()}HullPoints;\n\n")

    lines.append(f"static const {ship_id.title()}HullPoints {ship_id.upper()}_HULL = {{\n")
    for key, val in cp.items():
        lines.append(f"    .{key} = {{ {_cf(val['x'])}, {_cf(val['y'])} }},\n")
    lines.append("};\n\n")
    return "".join(lines)

def c_hull_generator(ship_id: str, segments: list, total: int) -> str:
    name = ship_id.upper()
    lines = [
        f"static inline int generate_{ship_id}_hull(Vec2 *out) {{\n",
        f"    const {ship_id.title()}HullPoints *p = &{name}_HULL;\n",
        "    int i = 0;\n",
    ]
    for seg_idx, seg in enumerate(segments):
        subdivisions = seg["subdivisions"]
        if seg["type"] == "quadratic_bezier":
            p0, p1, p2 = seg["p0"], seg["p1"], seg["p2"]
            start = 0 if seg_idx == 0 else 1
            lines.append(
                f"    for (int j = {start}; j <= {subdivisions}; j++)\n"
                f"        out[i++] = _quadratic_bezier(p->{p0}, p->{p1}, p->{p2}, (float)j/{subdivisions}.0f);\n"
            )
        elif seg["type"] == "straight_line":
            p0, p1 = seg["p0"], seg["p1"]
            comment = seg.get("comment", "")
            end_val = subdivisions - 1 if "avoid duplicate" in comment else subdivisions
            lines.append(
                f"    for (int j = 1; j <= {end_val}; j++)\n"
                f"        out[i++] = _lerp(p->{p0}, p->{p1}, (float)j/{subdivisions}.0f);\n"
            )
    lines.append(f"    return i; /* expected: {total} */\n")
    lines.append("}\n\n")
    return "".join(lines)

def c_physics_defines(ship_id: str, physics: dict, dimensions: dict, modules: dict) -> str:
    prefix = ship_id.upper()
    lines = [f"/* ── {ship_id.title()} physics / dimensions ─── */\n"]
    for key, val in physics.items():
        macro = f"{prefix}_{key.upper()}"
        lines.append(f"#define {macro} {_cf(val)}\n")
    lines.append("\n")
    for key, val in dimensions.items():
        if key == "comment":
            continue
        macro = f"{prefix}_{key.upper()}"
        lines.append(f"#define {macro} {_cf(val)}\n")
    lines.append("\n")

    # Module IDs
    lines.append(f"/* ── {ship_id.title()} module IDs ─── */\n")
    for mod_name, mod in modules.items():
        if isinstance(mod, dict):
            if "id" in mod:
                lines.append(f"#define {prefix}_{mod_name.upper()}_ID {mod['id']}\n")
            if "start_id" in mod:
                lines.append(f"#define {prefix}_{mod_name.upper()}_START_ID {mod['start_id']}\n")
            if "count" in mod:
                lines.append(f"#define {prefix}_{mod_name.upper()}_COUNT {mod['count']}\n")
            if "position" in mod:
                pos = mod["position"]
                lines.append(
                    f"static const Vec2 {prefix}_{mod_name.upper()}_POSITION = "
                    f"{{ {_cf(pos['x'])}, {_cf(pos['y'])} }};\n"
                )
    lines.append("\n")
    return "".join(lines)

def generate_c(data: dict) -> str:
    grd = guard(C_OUT)
    out = [C_HEADER_BOILERPLATE.format(name=C_OUT.name, guard=grd)]
    for ship_id, ship in data.items():
        cp  = ship["hull_control_points"]
        gen = ship["hull_generation"]
        out.append(c_hull_struct(ship_id, cp))
        out.append(c_hull_generator(ship_id, gen["segments"], gen["total_points"]))
        out.append(c_physics_defines(
            ship_id, ship["physics"], ship["dimensions"], ship["modules"]
        ))

        # Decks array
        decks = ship.get("decks", [])
        prefix = ship_id.upper()
        out.append(f"// {ship_id.title()} decks\n")
        out.append(f"#define {prefix}_DECK_COUNT {len(decks)}\n")
        for i, deck in enumerate(decks):
            out.append(f"static const struct {{\n")
            out.append(f"    uint8_t id;\n")
            out.append(f"    uint8_t z_index;\n")
            out.append(f"    Vec2 collision[{len(deck['collision'])}];\n")
            out.append(f"    uint8_t collision_count;\n")
            out.append(f"    struct {{ float x, y; uint8_t type; }} snap_points[{len(deck['snap_points'])}];\n")
            out.append(f"    uint8_t snap_point_count;\n")
            out.append(f"}} {prefix}_DECK_{i} = {{\n")
            out.append(f"    {deck['id']}, // id\n")
            out.append(f"    {deck['z_index']}, // z_index\n")
            out.append(f"    {{ ")
            out.append(", ".join(f"{{ {_cf(pt['x'])}, {_cf(pt['y'])} }}" for pt in deck['collision']))
            out.append(f" }}, // collision\n")
            out.append(f"    {len(deck['collision'])}, // collision_count\n")
            out.append(f"    {{ ")
            out.append(", ".join(f"{{ {_cf(sp['x'])}, {_cf(sp['y'])}, {0 if sp['type']=='ladder' else 1} }}" for sp in deck['snap_points']))
            out.append(f" }}, // snap_points\n")
            out.append(f"    {len(deck['snap_points'])}, // snap_point_count\n")
            out.append(f"}};\n")
        if decks:
            out.append(f"static const void* {prefix}_DECKS[{len(decks)}] = {{ ")
            out.append(", ".join(f"&{prefix}_DECK_{i}" for i in range(len(decks))))
            out.append(f" }};\n")
        out.append("\n")
    out.append(C_FOOTER.format(guard=grd))
    return "".join(out)

# ── TypeScript generator ─────────────────────────────────────────────────────

TS_HEADER = '''\
/**
 * ShipDefinitions.ts — generated from protocol/ship_definitions.json.
 * DO NOT EDIT — run `python3 protocol/codegen.py` to regenerate.
 *
 * Source of truth: protocol/ship_definitions.json
 */

'''

def ts_camel(s: str) -> str:
    parts = s.split("_")
    return parts[0] + "".join(p.title() for p in parts[1:])

def generate_ts(data: dict) -> str:
    out = [TS_HEADER]
    for ship_id, ship in data.items():
        prefix = ship_id.upper()
        title  = ship_id.title()
        phys   = ship["physics"]
        dims   = ship["dimensions"]
        mods   = ship["modules"]
        cp     = ship["hull_control_points"]

        out.append(f"// ── {title} ────────────────────────────────────────\n\n")

        # Hull control points
        out.append(f"export const {prefix}_HULL = {{\n")
        for key, val in cp.items():
            out.append(f"  {ts_camel(key)}: {{ x: {val['x']}, y: {val['y']} }},\n")
        out.append("} as const;\n\n")

        # Physics flat exports
        for key, val in phys.items():
            out.append(f"export const {prefix}_{key.upper()} = {val};\n")
        out.append("\n")

        # Dimensions
        for key, val in dims.items():
            if key == "comment":
                continue
            out.append(f"export const {prefix}_{key.upper()} = {val};\n")
        out.append("\n")

        # Module IDs
        for mod_name, mod in mods.items():
            if not isinstance(mod, dict):
                continue
            MN = mod_name.upper()
            if "id" in mod:
                out.append(f"export const {prefix}_{MN}_ID = {mod['id']};\n")
            if "start_id" in mod:
                out.append(f"export const {prefix}_{MN}_START_ID = {mod['start_id']};\n")
            if "count" in mod:
                out.append(f"export const {prefix}_{MN}_COUNT = {mod['count']};\n")
        out.append("\n")

        # Grouped physics object
        out.append(f"export const {prefix}_PHYSICS = {{\n")
        for key, val in phys.items():
            out.append(f"  {ts_camel(key)}: {val},\n")
        out.append("} as const;\n\n")

        # Validation helper
        fields = list(phys.keys())
        param_lines = ",\n  ".join(f"{ts_camel(k)}: number" for k in fields)
        check_lines = " &&\n    ".join(
            f"Math.abs(s.{ts_camel(k)} - {prefix}_{k.upper()}) < eps"
            for k in fields
        )
        out.append(
            f"export function validate{title}Physics(\n"
            f"  s: {{ {param_lines} }},\n"
            f"  eps = 0.01\n"
            f"): boolean {{\n"
            f"  return {check_lines};\n"
            f"}}\n\n"
        )

    return "".join(out)

# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    data = load()

    c_src = generate_c(data)
    C_OUT.write_text(c_src)
    print(f"  wrote {C_OUT.relative_to(REPO)}")

    ts_src = generate_ts(data)
    TS_OUT.write_text(ts_src)
    print(f"  wrote {TS_OUT.relative_to(REPO)}")

if __name__ == "__main__":
    print(f"codegen: reading {SRC.relative_to(REPO)}")
    main()
    print("done.")
