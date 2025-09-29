#ifndef SERVER_H
#define SERVER_H

#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>
#include <time.h>

// Forward declarations
struct ServerContext;
struct Sim;
struct NetManager;
struct AOISystem;
struct RewindBuffer;
struct AntiCheat;
struct MetricsCollector;
struct ReplayRecorder;
struct AdminServer;

// Configuration constants
#define MAX_PLAYERS 100
#define MAX_SHIPS 50
#define MAX_PROJECTILES 500
#define TICK_RATE_HZ 30
#define TICK_DURATION_MS (1000 / TICK_RATE_HZ)
#define TICK_DURATION_US (TICK_DURATION_MS * 1000)
// FIXED_DT_Q16 is defined in sim/types.h

// Server initialization and lifecycle
int server_init(struct ServerContext** ctx);
void server_shutdown(struct ServerContext* ctx);
int server_run(struct ServerContext* ctx);
void server_request_shutdown(struct ServerContext* ctx);

// Main loop functions
void server_tick(struct ServerContext* ctx);
bool server_should_run(const struct ServerContext* ctx);

// Utility functions
uint64_t get_time_us(void);
uint32_t get_time_ms(void);
void sleep_until_next_tick(uint64_t tick_start_us);

#endif /* SERVER_H */