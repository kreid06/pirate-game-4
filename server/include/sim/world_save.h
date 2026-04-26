#pragma once
/* world_save.h — Save and load complete world state to/from JSON.
 *
 * Saved:  ships, world_npcs, placed_structures, island resources.
 * Format: human-readable JSON written to data/world_state.json by default.
 *
 * Hourly archive copies are stored under data/world_saves/ as
 *   world_YYYY-MM-DD_HH-MM-SS.json
 * keeping at most WORLD_ARCHIVE_MAX_FILES files (oldest pruned first).
 */

#define WORLD_SAVE_DEFAULT_PATH  "data/world_state.json"
#define WORLD_SAVE_ARCHIVE_DIR   "data/world_saves"
#define WORLD_ARCHIVE_MAX_FILES  48   /* 48 hourlies = 48 h of history */

/** Serialise the current world state to the given path.
 *  Creates the file (or truncates an existing one).
 *  Returns 0 on success, -1 on error. */
int world_save(const char *path);

/** Restore world state from the given path.
 *  Clears all ships, NPCs, structures and resource health before loading.
 *  Returns 0 on success, -1 if the file cannot be opened or is malformed. */
int world_load(const char *path);

/** Write a timestamped archive snapshot to WORLD_SAVE_ARCHIVE_DIR, then
 *  prune the oldest files so at most WORLD_ARCHIVE_MAX_FILES remain.
 *  Returns 0 on success, -1 on error. */
int world_save_archive(void);
