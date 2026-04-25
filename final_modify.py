#!/usr/bin/env python3
"""
Modify websocket_server.c by:
1. Removing everything between forward declarations and END CANNON CONTROL HANDLERS
2. Replacing the FLAME WAVE UPDATE block
"""

import re

file_path = r"c:\Users\kevin\Documents\Projects\pirate-game-4\server\src\net\websocket_server.c"

# Read the file
with open(file_path, 'r', encoding='utf-8') as f:
    content = f.read()

original_line_count = len(content.splitlines())
print(f"Original line count: {original_line_count}")

# Step 1: Find and remove everything from line 861 onwards until the END marker
# The forward declarations end at "static void ship_init_default_weapon_groups(SimpleShip* ship);"
# We need to keep that line and remove everything after it until "// END CANNON CONTROL HANDLERS"

forward_decl_end = "static void ship_init_default_weapon_groups(SimpleShip* ship);"
end_marker = "// ============================================================================\n// END CANNON CONTROL HANDLERS\n// ============================================================================\n"

# Find the position of the forward declarations
fwd_pos = content.find(forward_decl_end)
if fwd_pos == -1:
    print("ERROR: Could not find forward declaration end")
    exit(1)

# Find the end of that line
fwd_line_end = content.find('\n', fwd_pos) + 1

# Find the END marker
end_pos = content.find(end_marker)
if end_pos == -1:
    print("ERROR: Could not find END CANNON CONTROL HANDLERS marker")
    exit(1)

# Remove everything between the forward declarations and the END marker
# But keep newlines for formatting
content = content[:fwd_line_end] + "\n" + content[end_pos:]
print("✓ Change B Part 1: Removed all cannon control function implementations")

# Step 2: Replace FLAME WAVE UPDATE block
pattern = r"        /\* ===== FLAME WAVE UPDATE \(every 100ms\) ===== \*/\n        /\* Advance each active flamethrower wave, apply fire to newly-reached\n         \* targets, and broadcast the current wave state to clients for\n         \* smooth client-side interpolation\. \*/\n        if \(flame_waves_initialized\) \{.*?\n        \} /\* end FLAME WAVE UPDATE \*/"

replacement = """        /* ===== FLAME WAVE UPDATE (every 100ms) ===== */
        update_flame_waves(time_elapsed);"""

if re.search(pattern, content, re.DOTALL):
    content = re.sub(pattern, replacement, content, flags=re.DOTALL)
    print("✓ Change C: Replaced FLAME WAVE UPDATE block")
else:
    print("✗ Change C FAILED: Could not find FLAME WAVE UPDATE pattern")
    exit(1)

# Write back
with open(file_path, 'w', encoding='utf-8') as f:
    f.write(content)

new_line_count = len(content.splitlines())
print(f"New line count: {new_line_count}")
print(f"Lines removed: {original_line_count - new_line_count}")

# Verify
if "// CANNON CONTROL HANDLERS" in content:
    print("✗ ERROR: CANNON CONTROL HANDLERS header still exists!")
    exit(1)
if "// END CANNON CONTROL HANDLERS" in content:
    print("✗ ERROR: END CANNON CONTROL HANDLERS footer still exists!")
    exit(1)
if "flame_waves_initialized" in content.split("int websocket_server_tick(void)")[1] if "int websocket_server_tick(void)" in content else False:
    print("✗ WARNING: flame_waves_initialized still found in tick loop")
else:
    print("✓ Verification: No flame_waves_initialized in tick loop")

print("\n✓ File successfully modified!")
