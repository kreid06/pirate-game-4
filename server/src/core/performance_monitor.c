/**
 * Performance Monitoring System Implementation
 */

#include "core/performance_monitor.h"
#include "util/time.h"
#include "util/log.h"
#include <string.h>
#include <math.h>
#include <stdio.h>

/**
 * Initialize performance monitoring
 */
void perf_monitor_init(performance_monitor_t* monitor) {
    memset(monitor, 0, sizeof(performance_monitor_t));
    
    // Initialize histograms with reasonable ranges
    monitor->tick_time_histogram.min_value = 0.0f;
    monitor->tick_time_histogram.max_value = 50.0f; // 0-50ms
    
    monitor->physics_time_histogram.min_value = 0.0f;
    monitor->physics_time_histogram.max_value = 30.0f; // 0-30ms
    
    monitor->contacts_histogram.min_value = 0.0f;
    monitor->contacts_histogram.max_value = 5000.0f; // 0-5000 contacts
    
    monitor->snapshot_bytes_histogram.min_value = 0.0f;
    monitor->snapshot_bytes_histogram.max_value = 10000.0f; // 0-10KB
    
    log_info("📊 Performance monitor initialized");
}

/**
 * Start a performance timer for a category
 */
void perf_timer_start(performance_monitor_t* monitor, perf_category_t category) {
    if (category >= PERF_CATEGORY_COUNT) return;
    
    monitor->timer_start[category] = get_time_us();
    monitor->timer_active[category] = true;
}

/**
 * Stop a performance timer and record the duration
 */
float perf_timer_stop(performance_monitor_t* monitor, perf_category_t category) {
    if (category >= PERF_CATEGORY_COUNT || !monitor->timer_active[category]) {
        return 0.0f;
    }
    
    uint64_t end_time = get_time_us();
    uint64_t duration_us = end_time - monitor->timer_start[category];
    float duration_ms = duration_us / 1000.0f;
    
    monitor->timer_active[category] = false;
    return duration_ms;
}

/**
 * Begin a new frame sample
 */
void perf_begin_frame(performance_monitor_t* monitor) {
    perf_timer_start(monitor, PERF_CATEGORY_TOTAL_TICK);
}

/**
 * Add value to a histogram
 */
void perf_histogram_add(performance_histogram_t* hist, float value) {
    hist->total_samples++;
    hist->sum += value;
    hist->sum_squared += value * value;
    
    // Clamp value to histogram range
    if (value < hist->min_value) value = hist->min_value;
    if (value > hist->max_value) value = hist->max_value;
    
    // Calculate bucket index
    float range = hist->max_value - hist->min_value;
    float normalized = (value - hist->min_value) / range;
    int bucket = (int)(normalized * (PERF_HISTOGRAM_BUCKETS - 1));
    
    if (bucket >= 0 && bucket < PERF_HISTOGRAM_BUCKETS) {
        hist->buckets[bucket]++;
    }
}

/**
 * Get percentile from histogram
 */
static float get_percentile(const performance_histogram_t* hist, float percentile) {
    if (hist->total_samples == 0) return 0.0f;
    
    uint32_t target_samples = (uint32_t)(hist->total_samples * percentile);
    uint32_t accumulated = 0;
    
    for (int i = 0; i < PERF_HISTOGRAM_BUCKETS; i++) {
        accumulated += hist->buckets[i];
        if (accumulated >= target_samples) {
            float range = hist->max_value - hist->min_value;
            return hist->min_value + (range * i / (PERF_HISTOGRAM_BUCKETS - 1));
        }
    }
    
    return hist->max_value;
}

/**
 * Get histogram statistics
 */
void perf_histogram_get_stats(const performance_histogram_t* hist,
                              float* avg, float* stddev,
                              float* p50, float* p95, float* p99) {
    if (hist->total_samples == 0) {
        *avg = 0.0f;
        *stddev = 0.0f;
        *p50 = 0.0f;
        *p95 = 0.0f;
        *p99 = 0.0f;
        return;
    }
    
    *avg = hist->sum / hist->total_samples;
    
    float variance = (hist->sum_squared / hist->total_samples) - (*avg * *avg);
    *stddev = sqrtf(variance > 0.0f ? variance : 0.0f);
    
    *p50 = get_percentile(hist, 0.50f);
    *p95 = get_percentile(hist, 0.95f);
    *p99 = get_percentile(hist, 0.99f);
}

/**
 * End frame and compute statistics
 */
void perf_end_frame(performance_monitor_t* monitor, const performance_sample_t* sample) {
    // Add sample to ring buffer
    monitor->samples[monitor->sample_index] = *sample;
    monitor->sample_index = (monitor->sample_index + 1) % PERF_SAMPLE_HISTORY;
    monitor->total_samples++;
    
    // Update histograms
    perf_histogram_add(&monitor->tick_time_histogram, sample->tick_time_ms);
    perf_histogram_add(&monitor->physics_time_histogram, sample->physics_time_ms);
    perf_histogram_add(&monitor->contacts_histogram, (float)sample->active_contacts);
    perf_histogram_add(&monitor->snapshot_bytes_histogram, (float)sample->total_snapshot_bytes);
    
    // Update running statistics
    float avg, stddev, p50, p95, p99;
    perf_histogram_get_stats(&monitor->tick_time_histogram, &avg, &stddev, &p50, &p95, &p99);
    
    monitor->avg_tick_time_ms = avg;
    monitor->p95_tick_time_ms = p95;
    monitor->p99_tick_time_ms = p99;
    
    // Track max
    if (sample->tick_time_ms > monitor->max_tick_time_ms) {
        monitor->max_tick_time_ms = sample->tick_time_ms;
    }
    
    // Check for budget exceeded (33ms = 30Hz budget)
    if (sample->tick_time_ms > 33.0f) {
        monitor->budget_exceeded_count++;
    }
}

/**
 * Get current performance summary
 */
void perf_get_summary(const performance_monitor_t* monitor,
                     float* avg_tick, float* max_tick,
                     float* p95_tick, float* p99_tick,
                     uint32_t* budget_exceeded) {
    *avg_tick = monitor->avg_tick_time_ms;
    *max_tick = monitor->max_tick_time_ms;
    *p95_tick = monitor->p95_tick_time_ms;
    *p99_tick = monitor->p99_tick_time_ms;
    *budget_exceeded = monitor->budget_exceeded_count;
}

/**
 * Get recent samples (for visualization)
 */
const performance_sample_t* perf_get_samples(const performance_monitor_t* monitor,
                                            uint32_t* count) {
    *count = (monitor->total_samples < PERF_SAMPLE_HISTORY) ? 
             monitor->total_samples : PERF_SAMPLE_HISTORY;
    return monitor->samples;
}

/**
 * Check if performance budget is exceeded
 */
bool perf_is_budget_exceeded(const performance_monitor_t* monitor, float budget_ms) {
    return monitor->avg_tick_time_ms > budget_ms;
}

/**
 * Export performance data as JSON
 */
int perf_export_json(const performance_monitor_t* monitor, char* buffer, size_t buffer_size) {
    float avg_tick, stddev, p50, p95, p99;
    perf_histogram_get_stats(&monitor->tick_time_histogram, &avg_tick, &stddev, &p50, &p95, &p99);
    
    float avg_physics, stddev_physics, p50_physics, p95_physics, p99_physics;
    perf_histogram_get_stats(&monitor->physics_time_histogram, &avg_physics, &stddev_physics, 
                            &p50_physics, &p95_physics, &p99_physics);
    
    int len = snprintf(buffer, buffer_size,
        "{\n"
        "  \"tick_time_ms\": {\n"
        "    \"avg\": %.2f,\n"
        "    \"max\": %.2f,\n"
        "    \"stddev\": %.2f,\n"
        "    \"p50\": %.2f,\n"
        "    \"p95\": %.2f,\n"
        "    \"p99\": %.2f\n"
        "  },\n"
        "  \"physics_time_ms\": {\n"
        "    \"avg\": %.2f,\n"
        "    \"p95\": %.2f,\n"
        "    \"p99\": %.2f\n"
        "  },\n"
        "  \"budget\": {\n"
        "    \"target_ms\": 33.0,\n"
        "    \"exceeded_count\": %u,\n"
        "    \"total_samples\": %u,\n"
        "    \"exceeded_percent\": %.2f\n"
        "  },\n"
        "  \"samples_collected\": %u\n"
        "}",
        avg_tick, monitor->max_tick_time_ms, stddev, p50, p95, p99,
        avg_physics, p95_physics, p99_physics,
        monitor->budget_exceeded_count,
        monitor->tick_time_histogram.total_samples,
        (monitor->tick_time_histogram.total_samples > 0) ? 
            (100.0f * monitor->budget_exceeded_count / monitor->tick_time_histogram.total_samples) : 0.0f,
        monitor->tick_time_histogram.total_samples
    );
    
    return (len >= (int)buffer_size) ? -1 : 0;
}
