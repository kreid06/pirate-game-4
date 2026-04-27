#!/usr/bin/env python3
"""
Final comprehensive fix for websocket_server.c modifications.
This script completely rebuilds the section by:
1. Reading the original file
2. Keeping everything up to the forward declarations
3. Skipping all cannon control implementations
4. Resuming from "Handle harvest_resource" onwards
5. Replacing FLAME WAVE UPDATE block
"""

import re

file_path = r"c:\Users\kevin\Documents\Projects\pirate-game-4\server\src\net\websocket_server.c"

with open(file_path, 'r', encoding='utf-8') as f:
    lines = f.readlines()

print("Reading file...")
print(f"Total lines: {len(lines)}")

# Find key boundaries
fwd_decl_end = None
harvest_comment = None

for i, line in enumerate(lines):
    if "// Forward declarations for functions defined later in this file" in line:
        # Find the end of the forward declarations (after the 3 static void declarations)
        j = i
        count = 0
        while j < len(lines) and count < 4:
            if "static void" in lines[j]:
                count += 1
            j += 1
        fwd_decl_end = j
    
    if "Handle harvest_resource request from client" in line:
        harvest_comment = i
        break

if fwd_decl_end is None or harvest_comment is None:
    print(f"ERROR: Could not find boundaries. fwd={fwd_decl_end}, harvest={harvest_comment}")
    exit(1)

print(f"Forward decl end: line {fwd_decl_end + 1}")
print(f"Harvest comment: line {harvest_comment + 1}")

# Reconstruct: keep up to forward decls, skip to harvest comment
new_lines = lines[:fwd_decl_end] + lines[harvest_comment-5:]  # Include some context before harvest

# Now replace FLAME WAVE UPDATE
content = ''.join(new_lines)
pattern = r"        /\* ===== FLAME WAVE UPDATE \(every 100ms\) ===== \*/\n        /\* Advance each active flamethrower wave, apply fire to newly-reached\n         \* targets, and broadcast the current wave state to clients for\n         \* smooth client-side interpolation\. \*/\n        if \(flame_waves_initialized\) \{.*?\n        \} /\* end FLAME WAVE UPDATE \*/"
replacement = """        /* ===== FLAME WAVE UPDATE (every 100ms) ===== */
        update_flame_waves(time_elapsed);"""

if re.search(pattern, content, re.DOTALL):
    content = re.sub(pattern, replacement, content, flags=re.DOTALL)
    print("Replaced FLAME WAVE UPDATE")

# Write
with open(file_path, 'w', encoding='utf-8') as f:
    f.write(content)

final_lines = len(content.splitlines())
print(f"\nFinal line count: {final_lines}")
print(f"Original: {len(lines)}")
print(f"Removed: {len(lines) - final_lines} lines")
print("\nDone!")
