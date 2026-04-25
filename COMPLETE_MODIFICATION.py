#!/usr/bin/env python3
"""
Complete the websocket_server.c modification since PowerShell/Python execution
is unavailable in the sandboxed environment. Run this script directly:

    python3 COMPLETE_MODIFICATION.py

This script:
1. Removes all orphaned code from handle_cannon_aim and handle_cannon_fire between 
   the forward declarations and the END CANNON CONTROL HANDLERS marker
2. Replaces the FLAME WAVE UPDATE block with a single function call
"""

import re

file_path = r"c:\Users\kevin\Documents\Projects\pirate-game-4\server\src\net\websocket_server.c"

print("=" * 70)
print("COMPLETING WEBSOCKET_SERVER.C MODIFICATIONS")
print("=" * 70)

# Read the file
with open(file_path, 'r', encoding='utf-8') as f:
    content = f.read()

original_line_count = len(content.splitlines())
print(f"\n1. Reading file... Original line count: {original_line_count:,} lines")

# ============================================================================
# CHANGE B: Remove remaining orphaned code between forward decls and END marker
# ============================================================================
print("\n2. Removing remaining orphaned cannon control functions...")

# Find forward declarations end and END marker
fwd_decl_line = "// Forward declarations for functions defined later in this file\nstatic void tick_sinking_ships(void);\nstatic void tick_ghost_ships(float dt);\nstatic void ship_init_default_weapon_groups(SimpleShip* ship);"
end_marker = "// ============================================================================\n// END CANNON CONTROL HANDLERS\n// ============================================================================"

fwd_pos = content.find(fwd_decl_line)
end_pos = content.find(end_marker)

if fwd_pos == -1 or end_pos == -1:
    print(f"ERROR: Could not find boundaries. fwd_pos={fwd_pos}, end_pos={end_pos}")
    exit(1)

# Find the end of the forward declaration lines
after_fwd = content.find('\n', fwd_pos) + 1
after_fwd = content.find('\n', after_fwd) + 1
after_fwd = content.find('\n', after_fwd) + 1
after_fwd = content.find('\n', after_fwd) + 1
after_fwd = content.find('\n', after_fwd) + 1

# Keep: up to end of forward decls
# Skip: all orphaned code
# Keep: from END marker onwards
content_part1 = content[:after_fwd]
content_part2 = content[end_pos:]

content = content_part1 + "\n" + content_part2
print("✓ Removed orphaned code")

# ============================================================================
# CHANGE C: Replace FLAME WAVE UPDATE block
# ============================================================================
print("3. Replacing FLAME WAVE UPDATE block...")

pattern = r"        /\* ===== FLAME WAVE UPDATE \(every 100ms\) ===== \*/\n        /\* Advance each active flamethrower wave, apply fire to newly-reached\n         \* targets, and broadcast the current wave state to clients for\n         \* smooth client-side interpolation\. \*/\n        if \(flame_waves_initialized\) \{.*?\n        \} /\* end FLAME WAVE UPDATE \*/"

replacement = """        /* ===== FLAME WAVE UPDATE (every 100ms) ===== */
        update_flame_waves(time_elapsed);"""

matches = len(re.findall(pattern, content, re.DOTALL))
if matches > 0:
    content = re.sub(pattern, replacement, content, flags=re.DOTALL)
    print(f"✓ Replaced FLAME WAVE UPDATE block ({matches} occurrence{'' if matches == 1 else 's'})")
else:
    print("✗ WARNING: FLAME WAVE UPDATE block not found")

# ============================================================================
# Verification
# ============================================================================
print("\n4. Verifying changes...")

has_cannon_header = "// CANNON CONTROL HANDLERS" in content
has_cannon_footer = "// END CANNON CONTROL HANDLERS" in content
has_flame_init = "flame_waves_initialized" in content

print(f"   - Contains '// CANNON CONTROL HANDLERS': {has_cannon_header} (should be False)")
print(f"   - Contains '// END CANNON CONTROL HANDLERS': {has_cannon_footer} (should be False)")
print(f"   - Contains 'flame_waves_initialized': {has_flame_init} (may be True if in declarations)")

# ============================================================================
# Save
# ============================================================================
print("\n5. Saving modified file...")

with open(file_path, 'w', encoding='utf-8') as f:
    f.write(content)

new_line_count = len(content.splitlines())
lines_removed = original_line_count - new_line_count

print(f"   Original line count:  {original_line_count:,}")
print(f"   New line count:       {new_line_count:,}")
print(f"   Lines removed:        {lines_removed:,} ({100*lines_removed/original_line_count:.1f}%)")

print("\n" + "=" * 70)
if not has_cannon_header and not has_cannon_footer:
    print("✓ MODIFICATIONS COMPLETE!")
else:
    print("⚠ WARNING: Markers still exist. May need manual cleanup.")
print("=" * 70)
