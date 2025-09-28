#include <stdio.h>
#include <stdlib.h>
#include <signal.h>
#include <unistd.h>
#include <errno.h>
#include "server.h"

static volatile int running = 1;
static struct ServerContext* server_ctx = NULL;

void signal_handler(int sig) {
    printf("\nReceived signal %d, shutting down gracefully...\n", sig);
    running = 0;
}

int main(int argc, char *argv[]) {
    (void)argc; // Unused
    (void)argv; // Unused
    
    printf("Pirate Game Server v1.0 - Deterministic 30Hz Physics Server\n");
    printf("Built: %s %s\n", __DATE__, __TIME__);
    
    // Setup signal handlers for graceful shutdown
    signal(SIGINT, signal_handler);
    signal(SIGTERM, signal_handler);
    signal(SIGPIPE, SIG_IGN); // Ignore broken pipe
    
    // Initialize server context
    int result = server_init(&server_ctx);
    if (result != 0) {
        fprintf(stderr, "Failed to initialize server: %d\n", result);
        return EXIT_FAILURE;
    }
    
    printf("\n🌊 ═══════════════════ PIRATE GAME SERVER READY ═══════════════════\n");
    printf("🚀 Server initialized successfully with Week 3-4 enhancements\n");
    printf("\n🌐 WebSocket Server (Browser Clients): ws://localhost:8080\n");
    printf("   → Ready for JavaScript/TypeScript clients\n");
    printf("   → JSON message protocol with UDP compatibility\n");
    printf("📡 UDP Server (Native Clients): udp://localhost:8081\n");  
    printf("   → Binary protocol for high-performance clients\n");
    printf("⚙️  Admin Panel: http://localhost:8082\n");
    printf("   → Server statistics and management interface\n");
    printf("\n⚡ Simulation: %d Hz (%.3f ms per tick)\n", TICK_RATE_HZ, 
           (float)TICK_DURATION_MS);
    printf("═══════════════════════════════════════════════════════════════════\n");
    printf("Press Ctrl+C to stop\n");
    
    // Run main server loop
    result = server_run(server_ctx);
    
    // Cleanup
    server_shutdown(server_ctx);
    
    if (result == 0) {
        printf("Server shut down successfully\n");
        return EXIT_SUCCESS;
    } else {
        fprintf(stderr, "Server exited with error: %d\n", result);
        return EXIT_FAILURE;
    }
}