/* Regression test: blob snapshot copy must clear stale active slots.
 *
 * Commit 97a50fc broke this by breaking out of the copy loop once
 * active >= live_count.  Higher-index slots that were active on a prior
 * tick but are now inactive were never visited, leaving ghost tombstones
 * in GAME_STATE JSON. */

#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#define MAX_TOMBSTONES 64u

typedef struct {
    uint32_t id;
    bool     active;
} Tombstone;

typedef struct {
    uint32_t id;
    bool     active;
} BlobTombstone;

static int copy_tombstones_broken(const Tombstone *src, BlobTombstone *dst, int live_count) {
    if (live_count == 0)
        return 0;
    int active = 0;
    for (int i = 0; i < (int)MAX_TOMBSTONES; i++) {
        if (!src[i].active) {
            dst[i].active = false;
            continue;
        }
        dst[i].active = true;
        dst[i].id     = src[i].id;
        active++;
        if (active >= live_count)
            break;
    }
    return active;
}

/* Mirrors production: when live_count hits zero, still clear stale blob slots. */
static int copy_tombstones_fixed(const Tombstone *src, BlobTombstone *dst, int live_count) {
    if (live_count == 0) {
        for (int i = 0; i < (int)MAX_TOMBSTONES; i++)
            dst[i].active = false;
        return 0;
    }
    int active = 0;
    for (int i = 0; i < (int)MAX_TOMBSTONES; i++) {
        if (!src[i].active) {
            dst[i].active = false;
            continue;
        }
        dst[i].active = true;
        dst[i].id     = src[i].id;
        active++;
    }
    return active;
}

int main(void) {
    Tombstone src[MAX_TOMBSTONES];
    BlobTombstone dst[MAX_TOMBSTONES];
    memset(src, 0, sizeof(src));
    memset(dst, 0, sizeof(dst));

    /* Prior tick: tombstones at slots 5 and 30. */
    dst[5].active  = true;
    dst[5].id      = 101u;
    dst[30].active = true;
    dst[30].id     = 102u;

    /* Current tick: only slot 5 remains; slot 30 expired. */
    src[5].active  = true;
    src[5].id      = 101u;

    int n = copy_tombstones_broken(src, dst, /*live_count=*/1);
    assert(n == 1);
    assert(dst[5].active && dst[5].id == 101u);
    if (!dst[30].active) {
        fprintf(stderr, "unexpected: broken copy cleared slot 30\n");
        return 1;
    }
    printf("  reproduced stale slot 30 (id=%u) with broken early-exit copy\n", dst[30].id);

    /* Reset dst to stale state and verify the fixed full scan clears it. */
    dst[30].active = true;
    dst[30].id     = 102u;
    n = copy_tombstones_fixed(src, dst, /*live_count=*/1);
    assert(n == 1);
    assert(dst[5].active && dst[5].id == 101u);
    assert(!dst[30].active);

    /* live_count==0 early path must still clear every stale slot. */
    memset(src, 0, sizeof(src));
    dst[5].active  = true;
    dst[5].id      = 101u;
    dst[30].active = true;
    dst[30].id     = 102u;
    n = copy_tombstones_fixed(src, dst, /*live_count=*/0);
    assert(n == 0);
    assert(!dst[5].active);
    assert(!dst[30].active);

    printf("test_tombstone_blob_copy: OK\n");
    return 0;
}
