/* Regression test: sim_destroy_entity must preserve id-sorted arrays.
 *
 * Commit d75a2c0 switched sim_get_* to binary search, assuming arrays stay
 * sorted between sim_update_* passes.  sim_destroy_entity used swap-with-last
 * removal (ship sink, player disconnect), breaking sort until the next tick.
 * sim_get_ship() then returned NULL for valid ships — wrong cannon damage
 * multipliers, missed XP awards, etc. */

#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

typedef uint16_t entity_id;

typedef struct {
    entity_id id;
} Ship;

static bool find_ship_sorted(const Ship *ships, uint32_t count, entity_id id) {
    int lo = 0, hi = (int)count - 1;
    while (lo <= hi) {
        int mid = lo + (hi - lo) / 2;
        entity_id mid_id = ships[mid].id;
        if (mid_id == id) return true;
        if (mid_id < id) lo = mid + 1;
        else hi = mid - 1;
    }
    return false;
}

static void destroy_swap_with_last(Ship *ships, uint32_t *count, entity_id id) {
    for (uint32_t i = 0; i < *count; i++) {
        if (ships[i].id == id) {
            if (i + 1 < *count)
                ships[i] = ships[*count - 1];
            (*count)--;
            return;
        }
    }
}

static void destroy_memmove(Ship *ships, uint32_t *count, entity_id id) {
    for (uint32_t i = 0; i < *count; i++) {
        if (ships[i].id == id) {
            if (i + 1 < *count) {
                memmove(&ships[i], &ships[i + 1],
                        (size_t)(*count - i - 1) * sizeof(Ship));
            }
            (*count)--;
            return;
        }
    }
}

int main(void) {
    Ship ships[8];
    uint32_t count = 5;
    for (uint32_t i = 0; i < count; i++)
        ships[i].id = (entity_id)(i + 1); /* ids 1..5 sorted */

    /* Remove middle ship (id=3) the way sim_destroy_entity used to. */
    destroy_swap_with_last(ships, &count, 3);
    assert(count == 4);
    /* Array becomes [1,2,5,4] — id=4 is present but binary search misses it. */
    if (find_ship_sorted(ships, count, 4)) {
        fprintf(stderr, "unexpected: swap-with-last did not break lookup\n");
        return 1;
    }
    printf("  reproduced missed sim_get_ship(id=4) after swap-with-last destroy\n");

    /* Fixed removal keeps sorted order so binary search still works. */
    for (uint32_t i = 0; i < count; i++)
        ships[i].id = (entity_id)(i + 1);
    count = 5;
    destroy_memmove(ships, &count, 3);
    assert(count == 4);
    assert(find_ship_sorted(ships, count, 1));
    assert(find_ship_sorted(ships, count, 2));
    assert(!find_ship_sorted(ships, count, 3));
    assert(find_ship_sorted(ships, count, 4));
    assert(find_ship_sorted(ships, count, 5));

    printf("test_sim_destroy_entity_sort: OK\n");
    return 0;
}
