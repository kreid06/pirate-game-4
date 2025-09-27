#ifndef SERVER_H
#define SERVER_H

/**
 * Initialize the server
 * @return 0 on success, -1 on error
 */
int server_init(void);

/**
 * Update the server (called each frame)
 */
void server_update(void);

/**
 * Shutdown the server and cleanup resources
 */
void server_shutdown(void);

#endif /* SERVER_H */