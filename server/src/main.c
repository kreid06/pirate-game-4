// Pirate Game Server - Production Deployment
#include <stdio.h>
#include <stdlib.h>
#include <signal.h>
#include <unistd.h>
#include <errno.h>
#include "server.h"
#include "sim/world_save.h"

static volatile int running = 1;
static struct ServerContext* server_ctx = NULL;

void signal_handler(int sig) {
    if (sig == SIGUSR1) {
        printf("\n💾 SIGUSR1: saving world state...\n");
        world_save(WORLD_SAVE_DEFAULT_PATH);
        return;
    }
    printf("\n🛑 Received signal %d, initiating graceful shutdown...\n", sig);
    running = 0;
    
    // Signal the server to stop
    if (server_ctx != NULL) {
        server_request_shutdown(server_ctx);
    }
    
    // If we get a second signal, force exit
    if (sig == SIGINT) {
        signal(SIGINT, SIG_DFL);
    }
}

int main(int argc, char *argv[]) {
    (void)argc;
    
    printf("Pirate Game Server v1.0 - Deterministic 30Hz Physics Server\n");
    printf("Built: %s %s\n", __DATE__, __TIME__);
    
    // Setup signal handlers for graceful shutdown
    signal(SIGINT,  signal_handler);
    signal(SIGTERM, signal_handler);
    signal(SIGUSR1, signal_handler);  /* kill -USR1 <pid> to save world */
    signal(SIGPIPE, SIG_IGN); // Ignore broken pipe
    
    // Initialize server context
    int result = server_init(&server_ctx);
    if (result != 0) {
        fprintf(stderr, "Failed to initialize server: %d\n", result);
        return EXIT_FAILURE;
    }
    
    printf("\n🌊 ═══════════════════ PIRATE GAME SERVER READY ═══════════════════\n");
    printf("🚀 Server initialized successfully with Week 3-4 enhancements\n");
    printf("\n🌐 WebSocket Server (Browser Clients): ws://localhost:8082\n");
    printf("   → Ready for JavaScript/TypeScript clients\n");
    printf("   → JSON message protocol with UDP compatibility\n");
    printf("📡 UDP Server (Native Clients): udp://localhost:8080\n");  
    printf("   → Binary protocol for high-performance clients\n");
    printf("⚙️  Admin Panel: http://localhost:8081\n");
    printf("   → Server statistics and management interface\n");
    printf("\n⚡ Simulation: %d Hz (%.3f ms per tick)\n", TICK_RATE_HZ, 
           (float)TICK_DURATION_MS);
    printf("═══════════════════════════════════════════════════════════════════\n");
    printf("Press Ctrl+C to stop\n");
    
    // Run main server loop
    result = server_run(server_ctx);

    printf("\n🔄 Shutting down server components...\n");

    /* Auto-save world state on clean shutdown */
    printf("💾 Auto-saving world state...\n");
    world_save(WORLD_SAVE_DEFAULT_PATH);

    // Set alarm for forced shutdown after 5 seconds
    signal(SIGALRM, SIG_DFL);
    alarm(5);

    // Cleanup
    server_shutdown(server_ctx);

    // Cancel the alarm - we finished cleanup in time
    alarm(0);

    /* ── Restart: re-exec the same binary ── */
    if (g_server_restart_requested) {
        printf("♻️  Restarting server...\n");
        alarm(0);
        execv("/proc/self/exe", argv);
        /* execv only returns on error */
        perror("execv restart failed");
    }

    if (result == 0) {
        printf("✅ Server shut down successfully\n");
        return EXIT_SUCCESS;
    } else {
        fprintf(stderr, "❌ Server exited with error: %d\n", result);
        return EXIT_FAILURE;
    }
}