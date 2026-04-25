#!/usr/bin/env python3
"""
Fix the websocket_server.c file by removing duplicated cannon handler code.
"""

file_path = r'c:\Users\kevin\Documents\Projects\pirate-game-4\server\src\net\websocket_server.c'

with open(file_path, 'r', encoding='utf-8') as f:
    lines = f.readlines()

print(f"Total lines before: {len(lines)}")

# Find the declaration line
decl_line = -1
for i, line in enumerate(lines):
    if 'static void ship_init_default_weapon_groups(SimpleShip* ship);' in line and 'static void' in line and 'fire_cannon' not in line:
        decl_line = i
        print(f"Found declaration at line {i+1}: {line.rstrip()}")
        break

# Find the harvest_resource comment (the REAL one with full documentation)
harvest_line = -1
for i in range(len(lines) - 1, -1, -1):
    if '* Handle harvest_resource request from client.' in lines[i]:
        # Look back to find the /** start
        j = i
        while j > 0 and '/**' not in lines[j]:
            j -= 1
        # Check if this looks like the REAL harvest comment (multiple lines of docs)
        if i - j > 2:  # Real comment has more lines than just the /
            harvest_line = j
            print(f"Found harvest_resource comment at line {j+1}: {lines[j].rstrip()}")
            break

if decl_line == -1 or harvest_line == -1:
    print(f"ERROR: Could not find markers! decl_line={decl_line}, harvest_line={harvest_line}")
    import sys
    sys.exit(1)

# Create new content: keep everything up to declaration, then skip to harvest
new_lines = lines[:decl_line + 1]
new_lines.append('\n')
new_lines.extend(lines[harvest_line:])

# Write back
with open(file_path, 'w', encoding='utf-8') as f:
    f.writelines(new_lines)

removed_count = harvest_line - decl_line - 1
print(f"Removed {removed_count} lines of garbage")
print(f"Fixed file: {len(new_lines)} lines")
print("SUCCESS!")
