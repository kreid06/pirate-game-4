/**
 * Performance Monitoring System
 * Real-time tracking of server performance metrics
 */

#ifndef PERFORMANCE_MONITOR_H
#define PERFORMANCE_MONITOR_H

#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>

// Performance histogram for tracking distributions
#define PERF_HISTOGRAM_BUCKETS 20

typedef struct {
    float min_value;
    float max_value;
    uint32_t buckets[PERF_HISTOGRAM_BUCKETS];
    uint32_t total_samples;
    float sum;
    float sum_squared;
} performance_histogram_t;

// Performance categories
typedef enum {
    PERF_CATEGORY_PHYSICS,
    PERF_CATEGORY_NETWORKING,
    PERF_CATEGORY_AOI,
    PERF_CATEGORY_INPUT_VALIDATION,
    PERF_CATEGORY_SNAPSHOT_GEN,
    PERF_CATEGORY_TOTAL_TICK,
    PERF_CATEGORY_COUNT
} perf_category_t;

// Performance sample for a single frame
typedef struct {
    uint64_t timestamp_us;
    float tick_time_ms;
    float physics_time_ms;
    float network_time_ms;
    float aoi_time_ms;
    float input_validation_time_ms;
    float snapshot_time_ms;
    
    // Entity counts
    uint32_t active_bodies;
    uint32_t active_contacts;
    uint32_t active_constraints;
    uint32_t total_aoi_entities;
    
    // Network stats
    uint32_t snapshots_sent;
    uint32_t total_snapshot_bytes;
    
    // Input stats
    uint32_t inputs_processed;
    uint32_t inputs_dropped;
} performance_sample_t;

// Main performance monitor
#define PERF_SAMPLE_HISTORY 300  // Keep 10 seconds at 30Hz

typedef struct {
    // Ring buffer of samples
    performance_sample_t samples[PERF_SAMPLE_HISTORY];
    uint32_t sample_index;
    uint32_t total_samples;
    
    // Histograms for key metrics
    performance_histogram_t tick_time_histogram;
    performance_histogram_t physics_time_histogram;
    performance_histogram_t contacts_histogram;
    performance_histogram_t snapshot_bytes_histogram;
    
    // Running statistics
    float avg_tick_time_ms;
    float avg_physics_time_ms;
    float max_tick_time_ms;
    float p95_tick_time_ms;
    float p99_tick_time_ms;
    
    // Budget tracking
    uint32_t budget_exceeded_count;
    uint32_t frame_drops;
    
    // Profiling timers
    uint64_t timer_start[PERF_CATEGORY_COUNT];
    bool timer_active[PERF_CATEGORY_COUNT];
} performance_monitor_t;

/**
 * Initialize performance monitoring
 */
void perf_monitor_init(performance_monitor_t* monitor);

/**
 * Start a performance timer for a category
 */
void perf_timer_start(performance_monitor_t* monitor, perf_category_t category);

/**
 * Stop a performance timer and record the duration
 */
float perf_timer_stop(performance_monitor_t* monitor, perf_category_t category);

/**
 * Begin a new frame sample
 */
void perf_begin_frame(performance_monitor_t* monitor);

/**
 * End frame and compute statistics
 */
void perf_end_frame(performance_monitor_t* monitor, const performance_sample_t* sample);

/**
 * Add value to a histogram
 */
void perf_histogram_add(performance_histogram_t* hist, float value);

/**
 * Get histogram statistics
 */
void perf_histogram_get_stats(const performance_histogram_t* hist,
                              float* avg, float* stddev,
                              float* p50, float* p95, float* p99);

/**
 * Get current performance summary
 */
void perf_get_summary(const performance_monitor_t* monitor,
                     float* avg_tick, float* max_tick,
                     float* p95_tick, float* p99_tick,
                     uint32_t* budget_exceeded);

/**
 * Get recent samples (for visualization)
 */
const performance_sample_t* perf_get_samples(const performance_monitor_t* monitor,
                                            uint32_t* count);

/**
 * Check if performance budget is exceeded
 */
bool perf_is_budget_exceeded(const performance_monitor_t* monitor, float budget_ms);

/**
 * Export performance data as JSON
 */
int perf_export_json(const performance_monitor_t* monitor, char* buffer, size_t buffer_size);

#endif // PERFORMANCE_MONITOR_H
