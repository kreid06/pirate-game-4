#!/usr/bin/env python3
"""
Script to generate cannon_fire.c by extracting and modifying content from websocket_server.c
"""

import sys

# Define file paths
src_file = r"c:\Users\kevin\Documents\Projects\pirate-game-4\server\src\net\websocket_server.c"
dst_file = r"c:\Users\kevin\Documents\Projects\pirate-game-4\server\src\net\cannon_fire.c"

try:
    # Read the source file
    print(f"Reading {src_file}...")
    with open(src_file, 'r', encoding='utf-8') as f:
        lines = f.readlines()

    print(f"Source file has {len(lines)} lines")

    # Start building the content
    content_lines = []

    # Step 1: Add includes
    includes = """#include "net/websocket_server_internal.h"
#include "net/cannon_fire.h"
#include "net/npc_agents.h"
#include "net/npc_world.h"
#include "net/module_interactions.h"
"""
    content_lines.append(includes)

    # Step 2: Extract lines 1057-2505 (1-indexed) = lines[1056:2505] in Python
    print(f"Extracting lines 1057-2505 (1-indexed)...")
    if len(lines) < 2505:
        print(f"ERROR: Source file only has {len(lines)} lines, need at least 2505")
        sys.exit(1)
    
    extracted_section = lines[1056:2505]
    extracted_text = ''.join(extracted_section)

    # Step 3: Apply string replacements (only first occurrence of each)
    replacements = [
        ("static int parse_json_uint32_array(", "int parse_json_uint32_array("),
        ("static void handle_cannon_group_config(", "void handle_cannon_group_config("),
        ("static void tick_ship_weapon_groups(", "void tick_ship_weapon_groups("),
        ("static void handle_cannon_aim(", "void handle_cannon_aim("),
        ("static void broadcast_cannon_group_state(", "void broadcast_cannon_group_state("),
        ("static void handle_cannon_force_reload(", "void handle_cannon_force_reload("),
        ("static void broadcast_json_all(", "void broadcast_json_all("),
        ("static void handle_cannon_fire(", "void handle_cannon_fire("),
    ]

    print("Applying replacements...")
    replacements_made = []
    for old_str, new_str in replacements:
        if old_str in extracted_text:
            # Replace only the first occurrence
            extracted_text = extracted_text.replace(old_str, new_str, 1)
            replacements_made.append(f"  '{old_str}' → '{new_str}'")
            print(f"  ✓ {old_str}")
        else:
            print(f"  ⚠ WARNING: '{old_str}' not found in extracted section")

    content_lines.append(extracted_text)

    # Step 4: Add the new update_flame_waves function
    print("Adding update_flame_waves function...")
    if len(lines) < 11761:
        print(f"ERROR: Source file only has {len(lines)} lines, need at least 11761 for flame waves")
        sys.exit(1)
    
    flame_waves_start = """
/**
 * Advance all active flamethrower waves, apply fire to newly-reached targets,
 * and broadcast the current wave state to clients.
 * Called every cannon-update tick (every 100 ms).
 */
void update_flame_waves(uint32_t time_elapsed) {
"""
    content_lines.append(flame_waves_start)

    # Extract lines 11546-11761 (1-indexed) = lines[11545:11761] in Python
    print(f"Extracting lines 11546-11761 (1-indexed) for flame waves body...")
    flame_waves_body = lines[11545:11761]
    flame_waves_body_text = ''.join(flame_waves_body)
    content_lines.append(flame_waves_body_text)

    # Add closing brace
    content_lines.append("}\n")

    # Combine all content
    final_content = ''.join(content_lines)

    # Write to destination file
    print(f"\nWriting to {dst_file}...")
    with open(dst_file, 'w', encoding='utf-8') as f:
        f.write(final_content)

    # Count lines in output file
    output_lines = final_content.split('\n')
    output_line_count = len([line for line in output_lines if line.strip()])  # Count non-empty lines
    total_lines = len(output_lines)

    print(f"\n{'='*50}")
    print(f"✓ Summary")
    print(f"{'='*50}")
    print(f"Output file: {dst_file}")
    print(f"Total lines: {total_lines}")
    print(f"Non-empty lines: {output_line_count}")
    print(f"Replacements made: {len(replacements_made)}")
    if replacements_made:
        print("\nReplacements applied:")
        for replacement in replacements_made:
            print(replacement)
    print(f"\n✓ Script completed successfully!")
    sys.exit(0)

except Exception as e:
    print(f"\n✗ ERROR: {e}", file=sys.stderr)
    import traceback
    traceback.print_exc()
    sys.exit(1)
