#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <time.h>
#include "../include/net/protocol.h"

// Simple bot client for testing server load and protocol
struct BotClient {
    int socket_fd;
    struct sockaddr_in server_addr;
    uint16_t sequence;
    uint32_t client_time;
    bool connected;
};

int bot_connect(struct BotClient* bot, const char* server_ip, int port) {
    // Create UDP socket
    bot->socket_fd = socket(AF_INET, SOCK_DGRAM, 0);
    if (bot->socket_fd < 0) {
        perror("Failed to create socket");
        return -1;
    }
    
    // Setup server address
    memset(&bot->server_addr, 0, sizeof(bot->server_addr));
    bot->server_addr.sin_family = AF_INET;
    bot->server_addr.sin_port = htons(port);
    
    if (inet_pton(AF_INET, server_ip, &bot->server_addr.sin_addr) <= 0) {
        perror("Invalid server address");
        close(bot->socket_fd);
        return -1;
    }
    
    bot->sequence = 1;
    bot->client_time = 0;
    bot->connected = false;
    
    printf("Bot connected to %s:%d\n", server_ip, port);
    return 0;
}

void bot_send_handshake(struct BotClient* bot, const char* player_name) {
    struct ClientHandshake handshake = {0};
    handshake.type = PACKET_CLIENT_HANDSHAKE;
    handshake.version = PROTOCOL_VERSION;
    handshake.client_id = rand(); // Random client ID
    strncpy(handshake.player_name, player_name, sizeof(handshake.player_name) - 1);
    handshake.checksum = protocol_checksum(&handshake, sizeof(handshake) - sizeof(handshake.checksum));
    
    ssize_t sent = sendto(bot->socket_fd, &handshake, sizeof(handshake), 0,
                         (struct sockaddr*)&bot->server_addr, sizeof(bot->server_addr));
    
    if (sent == sizeof(handshake)) {
        printf("Bot sent handshake as '%s'\n", player_name);
        bot->connected = true;
    } else {
        perror("Failed to send handshake");
    }
}

void bot_send_input(struct BotClient* bot) {
    struct CmdPacket cmd = {0};
    cmd.type = PACKET_CLIENT_INPUT;
    cmd.version = PROTOCOL_VERSION;
    cmd.seq = bot->sequence++;
    cmd.dt_ms = 16; // Simulate ~60 FPS client
    
    // Generate some movement (circular pattern)
    float time_sec = bot->client_time / 1000.0f;
    cmd.thrust = (int16_t)(sin(time_sec * 0.5f) * 32767 * 0.5f); // Q0.15 format
    cmd.turn = (int16_t)(cos(time_sec * 0.3f) * 32767 * 0.3f);
    
    // Randomly trigger actions
    if (rand() % 100 < 5) { // 5% chance
        cmd.actions |= (1 << (rand() % 6)); // Random action bit
    }
    
    cmd.client_time = bot->client_time;
    cmd.checksum = protocol_checksum(&cmd, sizeof(cmd) - sizeof(cmd.checksum));
    
    ssize_t sent = sendto(bot->socket_fd, &cmd, sizeof(cmd), 0,
                         (struct sockaddr*)&bot->server_addr, sizeof(bot->server_addr));
    
    if (sent != sizeof(cmd)) {
        perror("Failed to send input");
    }
    
    bot->client_time += 16; // Advance client time
}

void bot_disconnect(struct BotClient* bot) {
    if (bot->socket_fd >= 0) {
        close(bot->socket_fd);
        bot->socket_fd = -1;
    }
    bot->connected = false;
    printf("Bot disconnected\n");
}

int main(int argc, char* argv[]) {
    const char* server_ip = "127.0.0.1";
    int server_port = 8080  // UDP native clients port
    int num_bots = 1;
    int duration_seconds = 60;
    
    if (argc > 1) num_bots = atoi(argv[1]);
    if (argc > 2) duration_seconds = atoi(argv[2]);
    if (argc > 3) server_ip = argv[3];
    if (argc > 4) server_port = atoi(argv[4]);
    
    printf("Bot Client Test\n");
    printf("Spawning %d bots for %d seconds\n", num_bots, duration_seconds);
    printf("Target server: %s:%d\n\n", server_ip, server_port);
    
    srand((unsigned int)time(NULL));
    
    // Create bot clients
    struct BotClient* bots = calloc(num_bots, sizeof(struct BotClient));
    if (!bots) {
        fprintf(stderr, "Failed to allocate bot array\n");
        return 1;
    }
    
    // Connect all bots
    for (int i = 0; i < num_bots; i++) {
        if (bot_connect(&bots[i], server_ip, server_port) != 0) {
            fprintf(stderr, "Failed to connect bot %d\n", i);
            continue;
        }
        
        char bot_name[16];
        snprintf(bot_name, sizeof(bot_name), "Bot_%03d", i);
        bot_send_handshake(&bots[i], bot_name);
        
        usleep(10000); // 10ms delay between connections
    }
    
    printf("All bots connected. Starting input simulation...\n");
    
    // Run simulation
    time_t start_time = time(NULL);
    time_t end_time = start_time + duration_seconds;
    
    uint64_t total_packets_sent = 0;
    
    while (time(NULL) < end_time) {
        for (int i = 0; i < num_bots; i++) {
            if (bots[i].connected) {
                bot_send_input(&bots[i]);
                total_packets_sent++;
            }
        }
        
        usleep(16667); // ~60 Hz input rate per bot
    }
    
    // Disconnect all bots
    for (int i = 0; i < num_bots; i++) {
        bot_disconnect(&bots[i]);
    }
    
    free(bots);
    
    printf("\nTest completed!\n");
    printf("Total packets sent: %lu\n", total_packets_sent);
    printf("Average packets/sec: %.1f\n", (double)total_packets_sent / duration_seconds);
    printf("Per-bot packets/sec: %.1f\n", (double)total_packets_sent / duration_seconds / num_bots);
    
    return 0;
}