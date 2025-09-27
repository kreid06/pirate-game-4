#ifndef UTIL_TIME_H
#define UTIL_TIME_H

#include <stdint.h>
#include <time.h>

// High-resolution time utilities for deterministic server timing
void time_init(void);
uint64_t get_time_us(void);
uint32_t get_time_ms(void);
void sleep_until_time(uint64_t target_us);

// Precise timing for server tick scheduling
struct TickTimer {
    uint64_t tick_duration_us;
    uint64_t next_tick_time;
    uint32_t tick_count;
    uint64_t total_sleep_time;
    uint64_t total_overrun_time;
};

void tick_timer_init(struct TickTimer* timer, uint32_t rate_hz);
bool tick_timer_should_tick(struct TickTimer* timer);
void tick_timer_advance(struct TickTimer* timer);
uint64_t tick_timer_sleep_until_next(struct TickTimer* timer);

#endif /* UTIL_TIME_H */