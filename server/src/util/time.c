#include "util/time.h"
#include <time.h>
#include <errno.h>
#include <unistd.h>

static struct timespec start_time;
static bool time_initialized = false;

void time_init(void) {
    if (time_initialized) return;
    
    clock_gettime(CLOCK_MONOTONIC, &start_time);
    time_initialized = true;
}

uint64_t get_time_us(void) {
    if (!time_initialized) time_init();
    
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    
    uint64_t elapsed_sec = now.tv_sec - start_time.tv_sec;
    int64_t elapsed_nsec = now.tv_nsec - start_time.tv_nsec;
    
    if (elapsed_nsec < 0) {
        elapsed_sec--;
        elapsed_nsec += 1000000000;
    }
    
    return elapsed_sec * 1000000 + elapsed_nsec / 1000;
}

uint32_t get_time_ms(void) {
    return (uint32_t)(get_time_us() / 1000);
}

void sleep_until_time(uint64_t target_us) {
    uint64_t current_us = get_time_us();
    
    if (target_us <= current_us) {
        return; // Already past target time
    }
    
    uint64_t sleep_us = target_us - current_us;
    
    // For precise timing, use nanosleep with high resolution
    struct timespec sleep_time = {
        .tv_sec = sleep_us / 1000000,
        .tv_nsec = (sleep_us % 1000000) * 1000
    };
    
    nanosleep(&sleep_time, NULL);
}

void tick_timer_init(struct TickTimer* timer, uint32_t rate_hz) {
    if (!timer || rate_hz == 0) return;
    
    timer->tick_duration_us = 1000000 / rate_hz;
    timer->next_tick_time = get_time_us() + timer->tick_duration_us;
    timer->tick_count = 0;
    timer->total_sleep_time = 0;
    timer->total_overrun_time = 0;
}

bool tick_timer_should_tick(struct TickTimer* timer) {
    if (!timer) return false;
    
    uint64_t current_time = get_time_us();
    return current_time >= timer->next_tick_time;
}

void tick_timer_advance(struct TickTimer* timer) {
    if (!timer) return;
    
    uint64_t current_time = get_time_us();
    
    if (current_time > timer->next_tick_time) {
        // Track overrun for performance monitoring
        timer->total_overrun_time += current_time - timer->next_tick_time;
    }
    
    timer->next_tick_time += timer->tick_duration_us;
    timer->tick_count++;
    
    // Prevent accumulating drift if we fall behind
    if (timer->next_tick_time < current_time) {
        timer->next_tick_time = current_time + timer->tick_duration_us;
    }
}

uint64_t tick_timer_sleep_until_next(struct TickTimer* timer) {
    if (!timer) return 0;
    
    uint64_t current_time = get_time_us();
    uint64_t sleep_start = current_time;
    
    if (timer->next_tick_time > current_time) {
        sleep_until_time(timer->next_tick_time);
        timer->total_sleep_time += timer->next_tick_time - current_time;
        return timer->next_tick_time - current_time;
    }
    
    return 0;
}