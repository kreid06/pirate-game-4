#!/usr/bin/env python3
import re

file_path = r"c:\Users\kevin\Documents\Projects\pirate-game-4\server\src\net\websocket_server.c"

with open(file_path, 'r', encoding='utf-8') as f:
    lines = f.readlines()

original_count = len(lines)

# Strategy: Find line numbers that are boundaries
# We need to find the line with "// Forward declarations for functions defined later in this file"
# and the line with "// END CANNON CONTROL HANDLERS"

fwd_decl_line = None
end_cannon_line = None

for i, line in enumerate(lines):
    if "// Forward declarations for functions defined later in this file" in line:
        fwd_decl_line = i
    if "// END CANNON CONTROL HANDLERS" in line:
        end_cannon_line = i
        break

print(f"Forward declarations at line {fwd_decl_line + 1}")
print(f"END CANNON CONTROL at line {end_cannon_line + 1}")

if fwd_decl_line is None or end_cannon_line is None:
    print("ERROR: Could not find boundaries")
    exit(1)

# We want to keep lines 0 to (fwd_decl_line + 3), which includes the 3 forward declaration lines
# Then jump to the END CANNON CONTROL HANDLERS marker
# Then replace the FLAME WAVE UPDATE block

# First, reconstruct: keep up to end of forward decls, then skip to END marker
new_lines = lines[:fwd_decl_line+4] + lines[end_cannon_line-2:]

# Now we need to handle the FLAME WAVE UPDATE block
content = ''.join(new_lines)

# Replace FLAME WAVE UPDATE
pattern = r"        /\* ===== FLAME WAVE UPDATE \(every 100ms\) ===== \*/\n        /\* Advance each active flamethrower wave, apply fire to newly-reached\n         \* targets, and broadcast the current wave state to clients for\n         \* smooth client-side interpolation\. \*/\n        if \(flame_waves_initialized\) \{.*?\n        \} /\* end FLAME WAVE UPDATE \*/"

replacement = """        /* ===== FLAME WAVE UPDATE (every 100ms) ===== */
        update_flame_waves(time_elapsed);"""

if re.search(pattern, content, re.DOTALL):
    content = re.sub(pattern, replacement, content, flags=re.DOTALL)
    print("✓ FLAME WAVE UPDATE replaced")
else:
    print("✗ FLAME WAVE UPDATE not found")

with open(file_path, 'w', encoding='utf-8') as f:
    f.write(content)

new_count = len(content.splitlines())
print(f"Original lines: {original_count}")
print(f"New lines: {new_count}")
print(f"Removed: {original_count - new_count}")

print("\n✓ Done!")
