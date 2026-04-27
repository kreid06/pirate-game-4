#!/usr/bin/env python3
"""
Script to modify websocket_server.c with two specific changes:
- Change B: Replace cannon control handlers section header/footer
- Change C: Replace flame wave update block in tick loop
"""

import re

# File path
file_path = r"c:\Users\kevin\Documents\Projects\pirate-game-4\server\src\net\websocket_server.c"

# Read the file
with open(file_path, 'r', encoding='utf-8') as f:
    content = f.read()

original_line_count = len(content.splitlines())
print(f"Original line count: {original_line_count}")

# ============================================================================
# CHANGE B: Replace cannon control section
# ============================================================================

# Define the start and end markers for Change B
start_marker = "// ============================================================================\n// CANNON CONTROL HANDLERS\n// ============================================================================\n"
end_marker = "// ============================================================================\n// END CANNON CONTROL HANDLERS\n// ============================================================================\n"

# Replacement text for Change B
replacement_b = """// ── Cannon aim, fire, weapon groups ─────────────────────────────────────────
#include "net/cannon_fire.h"

// Forward declarations for functions defined later in this file
static void tick_sinking_ships(void);
static void tick_ghost_ships(float dt);
static void ship_init_default_weapon_groups(SimpleShip* ship);
"""

# Find and replace Change B
start_idx = content.find(start_marker)
end_idx = content.find(end_marker)

if start_idx != -1 and end_idx != -1:
    # Include the end marker in the replacement range
    end_idx += len(end_marker)
    content = content[:start_idx] + replacement_b + content[end_idx:]
    print("✓ Change B applied: Cannon control section replaced")
else:
    print("✗ Change B FAILED: Could not find start/end markers")
    if start_idx == -1:
        print("  - Start marker not found")
    if end_idx == -1:
        print("  - End marker not found")

# ============================================================================
# CHANGE C: Replace flame wave update block
# ============================================================================

# Pattern for Change C - using regex with DOTALL to match across lines
# The pattern starts with the comment and ends with the closing brace
pattern_c = r"        /\* ===== FLAME WAVE UPDATE \(every 100ms\) ===== \*/\n        /\* Advance each active flamethrower wave, apply fire to newly-reached\n         \* targets, and broadcast the current wave state to clients for\n         \* smooth client-side interpolation\. \*/\n        if \(flame_waves_initialized\) \{.*?\n        \} /\* end FLAME WAVE UPDATE \*/"

replacement_c = """        /* ===== FLAME WAVE UPDATE (every 100ms) ===== */
        update_flame_waves(time_elapsed);"""

# Use DOTALL flag to make . match newlines
if re.search(pattern_c, content, re.DOTALL):
    content = re.sub(pattern_c, replacement_c, content, flags=re.DOTALL)
    print("✓ Change C applied: Flame wave update block replaced")
else:
    print("✗ Change C FAILED: Could not find the flame wave update pattern")

# ============================================================================
# Write the modified content back
# ============================================================================

with open(file_path, 'w', encoding='utf-8') as f:
    f.write(content)

new_line_count = len(content.splitlines())
print(f"New line count: {new_line_count}")
print(f"Lines removed: {original_line_count - new_line_count}")

print("\n✓ File successfully modified and saved")
