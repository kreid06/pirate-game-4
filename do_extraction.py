#!/usr/bin/env python3
"""
Extract ship_control and cannon_fire modules from websocket_server.c
"""
import re

BASE = r"c:\Users\kevin\Documents\Projects\pirate-game-4"
SERVER = BASE + r"\server"
SRC_NET = SERVER + r"\src\net"
INC_NET = SERVER + r"\include\net"

WS_SERVER = SRC_NET + r"\websocket_server.c"

# Read source file
with open(WS_SERVER, 'r', encoding='utf-8') as f:
    ws_lines = f.readlines()

total_lines = len(ws_lines)
print(f"websocket_server.c has {total_lines} lines")

# ============================================================================
# Step 1: Create ship_control.h
# ============================================================================
ship_control_h = r"""#pragma once
#include "net/websocket_server.h"

struct WebSocketClient;

bool is_mast_manned(uint16_t ship_id, uint32_t mast_id);
void handle_ship_sail_control(WebSocketPlayer* player, struct WebSocketClient* client, SimpleShip* ship, int desired_openness);
void handle_ship_rudder_control(WebSocketPlayer* player, struct WebSocketClient* client, SimpleShip* ship, bool turning_left, bool turning_right, bool moving_backward);
void handle_ship_sail_angle_control(WebSocketPlayer* player, struct WebSocketClient* client, SimpleShip* ship, float desired_angle);"""

with open(INC_NET + r"\ship_control.h", 'w', encoding='utf-8') as f:
    f.write(ship_control_h)
print("Created ship_control.h")

# ============================================================================
# Step 2: Create ship_control.c
# ============================================================================
# Lines 858-1025 (1-based) => indices 857-1024
ship_body_lines = ws_lines[857:1025]  # indices 857..1024 inclusive

# Apply static removals
ship_body = ''.join(ship_body_lines)
ship_body = ship_body.replace('static bool is_mast_manned(', 'bool is_mast_manned(')
ship_body = ship_body.replace('static void handle_ship_sail_control(', 'void handle_ship_sail_control(')
ship_body = ship_body.replace('static void handle_ship_rudder_control(', 'void handle_ship_rudder_control(')
ship_body = ship_body.replace('static void handle_ship_sail_angle_control(', 'void handle_ship_sail_angle_control(')
# Keep static bool is_mast_manned_by_friendly( unchanged

ship_control_c = '#include "net/websocket_server_internal.h"\n'
ship_control_c += '#include "net/ship_control.h"\n'
ship_control_c += '#include "net/npc_world.h"\n'
ship_control_c += '\n'
ship_control_c += ship_body

with open(SRC_NET + r"\ship_control.c", 'w', encoding='utf-8') as f:
    f.write(ship_control_c)
print(f"Created ship_control.c ({ship_control_c.count(chr(10))} lines)")

# ============================================================================
# Step 3: Create cannon_fire.h
# ============================================================================
cannon_fire_h = r"""#pragma once
#include "net/websocket_server.h"

struct WebSocketClient;

int parse_json_uint32_array(const char* json, const char* key, uint32_t* out, int max_out);
void handle_cannon_group_config(WebSocketPlayer* player, int group_index, WeaponGroupMode mode, module_id_t* weapon_ids, int weapon_count, uint16_t target_ship_id);
void tick_ship_weapon_groups(void);
void handle_cannon_aim(WebSocketPlayer* player, float aim_angle, uint32_t* active_group_indices, int active_group_count);
void broadcast_cannon_group_state(SimpleShip* ship, uint8_t company_id);
void handle_cannon_force_reload(WebSocketPlayer* player);
void handle_cannon_fire(WebSocketPlayer* player, bool fire_all, uint8_t ammo_type, module_id_t* explicit_ids, int explicit_count, bool skip_aim_check);
void update_flame_waves(uint32_t time_elapsed);"""

with open(INC_NET + r"\cannon_fire.h", 'w', encoding='utf-8') as f:
    f.write(cannon_fire_h)
print("Created cannon_fire.h")

# ============================================================================
# Step 4: Create cannon_fire.c
# ============================================================================
# Lines 1057-2505 (1-based) => indices 1056-2504
cannon_body_lines = ws_lines[1056:2505]  # indices 1056..2504 inclusive

cannon_body = ''.join(cannon_body_lines)
# Apply static removals
cannon_body = cannon_body.replace('static int parse_json_uint32_array(', 'int parse_json_uint32_array(')
cannon_body = cannon_body.replace('static void handle_cannon_group_config(', 'void handle_cannon_group_config(')
cannon_body = cannon_body.replace('static void tick_ship_weapon_groups(', 'void tick_ship_weapon_groups(')
cannon_body = cannon_body.replace('static void handle_cannon_aim(', 'void handle_cannon_aim(')
cannon_body = cannon_body.replace('static void broadcast_cannon_group_state(', 'void broadcast_cannon_group_state(')
cannon_body = cannon_body.replace('static void handle_cannon_force_reload(', 'void handle_cannon_force_reload(')
cannon_body = cannon_body.replace('static void broadcast_json_all(', 'void broadcast_json_all(')
cannon_body = cannon_body.replace('static void handle_cannon_fire(', 'void handle_cannon_fire(')
# Keep static: broadcast_cannon_fire, fire_cannon, handle_swivel_fire

# Flame wave body: lines 11546-11761 (1-based) => indices 11545-11760
flame_body_lines = ws_lines[11545:11761]  # indices 11545..11760 inclusive
flame_body = ''.join(flame_body_lines)

flame_func = (
    '\n'
    '/**\n'
    ' * Advance all active flamethrower waves, apply fire to newly-reached targets,\n'
    ' * and broadcast the current wave state to clients.\n'
    ' * Called every cannon-update tick (every 100 ms).\n'
    ' */\n'
    'void update_flame_waves(uint32_t time_elapsed) {\n'
)
flame_func += flame_body
flame_func += '}\n'

cannon_fire_c = '#include "net/websocket_server_internal.h"\n'
cannon_fire_c += '#include "net/cannon_fire.h"\n'
cannon_fire_c += '#include "net/npc_agents.h"\n'
cannon_fire_c += '#include "net/npc_world.h"\n'
cannon_fire_c += '#include "net/module_interactions.h"\n'
cannon_fire_c += '\n'
cannon_fire_c += cannon_body
cannon_fire_c += flame_func

with open(SRC_NET + r"\cannon_fire.c", 'w', encoding='utf-8') as f:
    f.write(cannon_fire_c)
print(f"Created cannon_fire.c ({cannon_fire_c.count(chr(10))} lines)")

# ============================================================================
# Step 5: Modify websocket_server_internal.h - add two lines at end
# ============================================================================
internal_h = SERVER + r"\include\net\websocket_server_internal.h"
with open(internal_h, 'r', encoding='utf-8') as f:
    internal_content = f.read()

# Check if already added
if 'void broadcast_json_all' not in internal_content:
    # Add after last line
    if not internal_content.endswith('\n'):
        internal_content += '\n'
    internal_content += 'void broadcast_json_all(const char* json);\n'
    internal_content += 'void update_flame_waves(uint32_t time_elapsed);\n'
    with open(internal_h, 'w', encoding='utf-8') as f:
        f.write(internal_content)
    print("Modified websocket_server_internal.h")
else:
    print("websocket_server_internal.h already has broadcast_json_all declaration")

# ============================================================================
# Step 6: Modify websocket_server.c
# ============================================================================
ws_content = ''.join(ws_lines)

# --- Change A: Replace ship control block ---
# Find the ship control section header comment through the closing } of handle_ship_sail_angle_control
# The block starts at "// ============================================================================\n// SHIP CONTROL HANDLERS"
# and ends at line 1025's "}\n" followed by a blank line

# Build exact anchor text for start
ship_section_start = (
    '// ============================================================================\n'
    '// SHIP CONTROL HANDLERS\n'
    '// ============================================================================\n'
)

# We need to find where it ends - at line 1025 which is the closing } of handle_ship_sail_angle_control
# followed by "\n\n" (blank line before cannon section)
# Line 1025 content: "}\n"
# Line 1026: "\n" (blank)
# Line 1027: "// ===..." (cannon section start)

# Get the exact text of the ship control block
# From line 850 to line 1026 (inclusive), indices 849-1025
ship_block_text = ''.join(ws_lines[849:1026])
# ship_block_text starts with "// ==...SHIP CONTROL HANDLERS..." and ends with "}\n\n"
# (line 1025 = "}\n", line 1026 = "\n")

replacement_a = (
    '// \u2500\u2500 Ship control (sail/rudder) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n'
    '#include "net/ship_control.h"\n'
    '\n'
)

if ship_block_text in ws_content:
    ws_content = ws_content.replace(ship_block_text, replacement_a, 1)
    print("Change A applied: ship control block replaced")
else:
    print("ERROR: Could not find ship control block for Change A")
    print("First 200 chars of expected block:")
    print(repr(ship_block_text[:200]))

# --- Change B: Replace cannon control block ---
# Lines 1027-2508 (1-based) => indices 1026-2507
# But after Change A, the content has shifted. Use string search instead.

cannon_section_start_comment = (
    '// ============================================================================\n'
    '// CANNON CONTROL HANDLERS\n'
    '// ============================================================================\n'
)
cannon_section_end_comment = (
    '// ============================================================================\n'
    '// END CANNON CONTROL HANDLERS\n'
    '// ============================================================================\n'
)

# Find start and end positions
cs_start = ws_content.find(cannon_section_start_comment)
ce_end = ws_content.find(cannon_section_end_comment)
if cs_start != -1 and ce_end != -1:
    ce_end_pos = ce_end + len(cannon_section_end_comment)
    # Check if there's a trailing newline after end comment
    cannon_block = ws_content[cs_start:ce_end_pos]
    replacement_b = (
        '// \u2500\u2500 Cannon aim, fire, weapon groups \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n'
        '#include "net/cannon_fire.h"\n'
        '\n'
        '// Forward declarations for functions defined later in this file\n'
        'static void tick_sinking_ships(void);\n'
        'static void tick_ghost_ships(float dt);\n'
        'static void ship_init_default_weapon_groups(SimpleShip* ship);\n'
    )
    ws_content = ws_content[:cs_start] + replacement_b + ws_content[ce_end_pos:]
    print("Change B applied: cannon control block replaced")
else:
    print(f"ERROR: Could not find cannon section. cs_start={cs_start}, ce_end={ce_end}")

# --- Change C: Replace flame wave block ---
flame_wave_start = '        /* ===== FLAME WAVE UPDATE (every 100ms) ===== */\n'
flame_wave_end_marker = '        } /* end FLAME WAVE UPDATE */'

fw_start_pos = ws_content.find(flame_wave_start)
if fw_start_pos != -1:
    fw_end_pos = ws_content.find(flame_wave_end_marker, fw_start_pos)
    if fw_end_pos != -1:
        fw_end_pos += len(flame_wave_end_marker)
        # Include trailing newline if present
        if ws_content[fw_end_pos:fw_end_pos+1] == '\n':
            fw_end_pos += 1
        flame_block = ws_content[fw_start_pos:fw_end_pos]
        replacement_c = (
            '        /* ===== FLAME WAVE UPDATE (every 100ms) ===== */\n'
            '        update_flame_waves(time_elapsed);\n'
        )
        ws_content = ws_content[:fw_start_pos] + replacement_c + ws_content[fw_end_pos:]
        print("Change C applied: flame wave block replaced")
    else:
        print("ERROR: Could not find flame wave end marker")
else:
    print("ERROR: Could not find flame wave start")

# Write modified websocket_server.c
with open(WS_SERVER, 'w', encoding='utf-8') as f:
    f.write(ws_content)
print(f"websocket_server.c written ({ws_content.count(chr(10))} lines)")

# ============================================================================
# Step 7: Modify Makefile
# ============================================================================
makefile = SERVER + r"\Makefile"
with open(makefile, 'r', encoding='utf-8') as f:
    mk_content = f.read()

old_net = (
    'NET_SOURCES = $(SRCDIR)/net/network.c $(SRCDIR)/net/protocol.c '
    '$(SRCDIR)/net/reliability.c $(SRCDIR)/net/snapshot.c '
    '$(SRCDIR)/net/websocket_server.c $(SRCDIR)/net/websocket_protocol.c '
    '$(SRCDIR)/net/websocket_auth.c $(SRCDIR)/net/player_persistence.c '
    '$(SRCDIR)/net/dock_physics.c $(SRCDIR)/net/module_interactions.c '
    '$(SRCDIR)/net/harvesting.c $(SRCDIR)/net/npc_agents.c $(SRCDIR)/net/npc_world.c'
)
new_net = old_net + ' $(SRCDIR)/net/ship_control.c $(SRCDIR)/net/cannon_fire.c'

if old_net in mk_content:
    mk_content = mk_content.replace(old_net, new_net, 1)
    with open(makefile, 'w', encoding='utf-8') as f:
        f.write(mk_content)
    print("Makefile updated")
else:
    print("ERROR: Could not find NET_SOURCES line in Makefile")
    # Try to find the actual line
    for line in mk_content.split('\n'):
        if 'NET_SOURCES' in line:
            print(f"Actual NET_SOURCES line: {repr(line[:120])}")

print("\nDone!")
