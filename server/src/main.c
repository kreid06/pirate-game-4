#include <stdio.h>
#include <stdlib.h>
#include <signal.h>
#include <unistd.h>
#include "server.h"

static int running = 1;

void signal_handler(int sig) {
    printf("\nReceived signal %d, shutting down...\n", sig);
    running = 0;
}

int main(int argc, char *argv[]) {
    printf("Pirate Game Server starting...\n");
    
    // Setup signal handlers
    signal(SIGINT, signal_handler);
    signal(SIGTERM, signal_handler);
    
    // Initialize server
    if (server_init() != 0) {
        fprintf(stderr, "Failed to initialize server\n");
        return 1;
    }
    
    printf("Server initialized successfully\n");
    printf("Server running on port 8080\n");
    printf("Press Ctrl+C to stop\n");
    
    // Main server loop
    while (running) {
        server_update();
        usleep(16667); // ~60 FPS (16.667ms)
    }
    
    // Cleanup
    server_shutdown();
    printf("Server shut down successfully\n");
    
    return 0;
}