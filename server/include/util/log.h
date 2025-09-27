#ifndef UTIL_LOG_H
#define UTIL_LOG_H

#include <stdarg.h>

typedef enum {
    LOG_LEVEL_DEBUG = 0,
    LOG_LEVEL_INFO = 1,
    LOG_LEVEL_WARN = 2,
    LOG_LEVEL_ERROR = 3
} log_level_t;

// Logging functions
void log_init(log_level_t min_level);
void log_message(log_level_t level, const char* file, int line, const char* fmt, ...);

// Convenience macros
#define log_debug(fmt, ...) log_message(LOG_LEVEL_DEBUG, __FILE__, __LINE__, fmt, ##__VA_ARGS__)
#define log_info(fmt, ...)  log_message(LOG_LEVEL_INFO,  __FILE__, __LINE__, fmt, ##__VA_ARGS__)
#define log_warn(fmt, ...)  log_message(LOG_LEVEL_WARN,  __FILE__, __LINE__, fmt, ##__VA_ARGS__)
#define log_error(fmt, ...) log_message(LOG_LEVEL_ERROR, __FILE__, __LINE__, fmt, ##__VA_ARGS__)

#endif /* UTIL_LOG_H */