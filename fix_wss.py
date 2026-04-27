#!/usr/bin/env python3
"""Fix corrupted websocket_server.c by removing garbage lines 860-2055"""

with open(r'c:\Users\kevin\Documents\Projects\pirate-game-4\server\src\net\websocket_server.c', 'r', encoding='utf-8') as f:
    lines = f.readlines()

print(f"Total lines before: {len(lines)}")

# Find the forward declaration ending (line 859)
end_of_new_header = -1
for i, line in enumerate(lines):
    if 'static void ship_init_default_weapon_groups(SimpleShip* ship);' in line:
        end_of_new_header = i
        print(f"Found end of new header at line {i+1}: {line.rstrip()}")
        break

# Find the harvest_resource comment block (should be around line 2056)
harvest_start = -1
for i in range(len(lines) - 1, -1, -1):
    if '* Handle harvest_resource request from client.' in lines[i]:
        # Go back to find the start of the comment block (/**) 
        j = i
        while j > 0 and '/**' not in lines[j]:
            j -= 1
        harvest_start = j
        print(f"Found harvest_resource at line {j+1}: {lines[j].rstrip()}")
        break

if end_of_new_header == -1 or harvest_start == -1:
    print("ERROR: Could not find markers!")
    import sys
    sys.exit(1)

# Build the fixed file by keeping:
# - Lines 0 to end_of_new_header (inclusive)
# - One blank line
# - Lines harvest_start to end
new_lines = lines[:end_of_new_header + 1]
new_lines.append('\n')  # blank line separator
new_lines.extend(lines[harvest_start:])

# Write back
with open(r'c:\Users\kevin\Documents\Projects\pirate-game-4\server\src\net\websocket_server.c', 'w', encoding='utf-8') as f:
    f.writelines(new_lines)

print(f"Fixed file: {len(new_lines)} lines")
print(f"Removed {harvest_start - end_of_new_header - 1} lines of garbage")
