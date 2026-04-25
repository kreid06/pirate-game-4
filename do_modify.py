#!/usr/bin/env python3
import sys

file_path = r"c:\Users\kevin\Documents\Projects\pirate-game-4\server\src\net\websocket_server.c"

try:
    # Read the file
    with open(file_path, 'r', encoding='utf-8') as f:
        content = f.read()
    
    original_line_count = len(content.splitlines())
    print(f"Original line count: {original_line_count}")
    
    # ============================================================================
    # CHANGE B: Replace cannon control section
    # ============================================================================
    
    start_marker = "// ============================================================================\n// CANNON CONTROL HANDLERS\n// ============================================================================\n"
    end_marker = "// ============================================================================\n// END CANNON CONTROL HANDLERS\n// ============================================================================\n"
    
    replacement_b = """// ── Cannon aim, fire, weapon groups ─────────────────────────────────────────
#include "net/cannon_fire.h"

// Forward declarations for functions defined later in this file
static void tick_sinking_ships(void);
static void tick_ghost_ships(float dt);
static void ship_init_default_weapon_groups(SimpleShip* ship);
"""
    
    start_idx = content.find(start_marker)
    end_idx = content.find(end_marker)
    
    if start_idx != -1 and end_idx != -1:
        end_idx += len(end_marker)
        content = content[:start_idx] + replacement_b + content[end_idx:]
        print("✓ Change B applied: Cannon control section replaced")
    else:
        print("✗ Change B FAILED")
        if start_idx == -1:
            print("  - Start marker not found")
        if end_idx == -1:
            print("  - End marker not found")
        sys.exit(1)
    
    # ============================================================================
    # CHANGE C: Replace flame wave update block
    # ============================================================================
    
    import re
    
    pattern_c = r"        /\* ===== FLAME WAVE UPDATE \(every 100ms\) ===== \*/\n        /\* Advance each active flamethrower wave, apply fire to newly-reached\n         \* targets, and broadcast the current wave state to clients for\n         \* smooth client-side interpolation\. \*/\n        if \(flame_waves_initialized\) \{.*?\n        \} /\* end FLAME WAVE UPDATE \*/"
    
    replacement_c = """        /* ===== FLAME WAVE UPDATE (every 100ms) ===== */
        update_flame_waves(time_elapsed);"""
    
    if re.search(pattern_c, content, re.DOTALL):
        content = re.sub(pattern_c, replacement_c, content, flags=re.DOTALL)
        print("✓ Change C applied: Flame wave update block replaced")
    else:
        print("✗ Change C FAILED: Could not find the flame wave update pattern")
        sys.exit(1)
    
    # ============================================================================
    # Write the modified content back
    # ============================================================================
    
    with open(file_path, 'w', encoding='utf-8') as f:
        f.write(content)
    
    new_line_count = len(content.splitlines())
    print(f"New line count: {new_line_count}")
    print(f"Lines removed: {original_line_count - new_line_count}")
    
    print("\n✓ File successfully modified and saved")
    sys.exit(0)

except Exception as e:
    print(f"Error: {e}")
    import traceback
    traceback.print_exc()
    sys.exit(1)
