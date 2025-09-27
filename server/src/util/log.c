#include "util/log.h"
#include <stdio.h>
#include <time.h>
#include <string.h>

static log_level_t current_min_level = LOG_LEVEL_INFO;

// Use __attribute__((unused)) to suppress unused variable warning  
static const char* level_names[] __attribute__((unused)) = {
    "DEBUG", "INFO", "WARN", "ERROR"  
};

// Use __attribute__((unused)) to suppress unused variable warning
static const char* level_colors[] __attribute__((unused)) = {
    "\033[36m", // Cyan for DEBUG
    "\033[32m", // Green for INFO  
    "\033[33m", // Yellow for WARN
    "\033[31m"  // Red for ERROR
};

void log_init(log_level_t min_level) {
    current_min_level = min_level;
}

void log_message(log_level_t level, const char* file, int line, const char* fmt, ...) {
    if (level < current_min_level) {
        return;
    }
    
    // Get current time
    time_t now = time(NULL);
    struct tm* local_time = localtime(&now);
    
    // Extract filename from path
    const char* filename = strrchr(file, '/');
    if (filename) {
        filename++; // Skip the '/'
    } else {
        filename = file;
    }
    
    // Print timestamp and level
    printf("%s[%02d:%02d:%02d %s:%d] ",
           level_colors[level],
           local_time->tm_hour,
           local_time->tm_min, 
           local_time->tm_sec,
           filename,
           line);
    
    // Print the actual message
    va_list args;
    va_start(args, fmt);
    vprintf(fmt, args);
    va_end(args);
    
    // Reset color and newline
    printf("\033[0m\n");
    fflush(stdout);
}