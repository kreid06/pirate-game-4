#include "admin/admin_server.h"
#include "sim/types.h"
#include "net/network.h"
#include "net/websocket_server.h"
#include "input_validation.h"
#include "sim/physics_lod.h"
#include "core/performance_monitor.h"
#include "util/log.h"
#include "util/time.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// External global instances (will be set by server)
// For now, these are NULL pointers - server will initialize them
physics_lod_manager_t* g_physics_lod_manager = NULL;
performance_monitor_t* g_performance_monitor = NULL;

// Static buffer for JSON responses (to avoid dynamic allocation)
static char json_buffer[4096];

int admin_api_status(struct HttpResponse* resp, const struct Sim* sim,
                    const struct NetworkManager* net_mgr) {
    if (!resp || !sim) return -1;
    
    (void)net_mgr; // Unused parameter
    uint32_t current_time = get_time_ms();
    uint32_t uptime = current_time - 0; // TODO: Get actual start time
    
    // Get WebSocket player count for more accurate count
    struct WebSocketStats ws_stats;
    uint32_t total_players = sim->player_count;
    if (websocket_server_get_stats(&ws_stats) == 0) {
        total_players = ws_stats.connected_clients;
    }
    
    int len = snprintf(json_buffer, sizeof(json_buffer),
        "{\n"
        "  \"uptime_seconds\": %u,\n"
        "  \"tick_rate\": %d,\n"
        "  \"current_tick\": %u,\n"
        "  \"player_count\": %u,\n"
        "  \"server_time\": %u,\n"
        "  \"status\": \"running\"\n"
        "}",
        uptime / 1000,
        TICK_RATE_HZ,
        sim->tick,
        total_players,
        current_time
    );
    
    if (len >= (int)sizeof(json_buffer)) return -1;
    
    resp->status_code = 200;
    resp->content_type = "application/json";
    resp->body = json_buffer;
    resp->body_length = len;
    resp->cache_control = true;
    
    return 0;
}

int admin_api_entities(struct HttpResponse* resp, const struct Sim* sim) {
    if (!resp || !sim) return -1;
    
    // Start JSON array
    int offset = snprintf(json_buffer, sizeof(json_buffer), 
        "{\n  \"entities\": [\n");
    
    bool first = true;
    
    // Add ships
    for (uint32_t i = 0; i < sim->ship_count && offset < (int)sizeof(json_buffer) - 200; i++) {
        const struct Ship* ship = &sim->ships[i];
        
        if (!first) {
            offset += snprintf(json_buffer + offset, sizeof(json_buffer) - offset, ",\n");
        }
        first = false;
        
        offset += snprintf(json_buffer + offset, sizeof(json_buffer) - offset,
            "    {\n"
            "      \"id\": %u,\n"
            "      \"type\": \"ship\",\n"
            "      \"position\": {\"x\": %.2f, \"y\": %.2f},\n"
            "      \"velocity\": {\"x\": %.2f, \"y\": %.2f},\n"
            "      \"rotation\": %.3f,\n"
            "      \"angular_velocity\": %.3f,\n"
            "      \"mass\": %.1f\n"
            "    }",
            ship->id,
            (float)ship->position.x / Q16_ONE,
            (float)ship->position.y / Q16_ONE,
            (float)ship->velocity.x / Q16_ONE,
            (float)ship->velocity.y / Q16_ONE,
            (float)ship->rotation / Q16_ONE,
            (float)ship->angular_velocity / Q16_ONE,
            (float)ship->mass / Q16_ONE
        );
    }
    
    // Add players
    for (uint32_t i = 0; i < sim->player_count && offset < (int)sizeof(json_buffer) - 200; i++) {
        const struct Player* player = &sim->players[i];
        
        if (!first) {
            offset += snprintf(json_buffer + offset, sizeof(json_buffer) - offset, ",\n");
        }
        first = false;
        
        offset += snprintf(json_buffer + offset, sizeof(json_buffer) - offset,
            "    {\n"
            "      \"id\": %u,\n"
            "      \"type\": \"player\",\n"
            "      \"position\": {\"x\": %.2f, \"y\": %.2f},\n"
            "      \"ship_id\": %u,\n"
            "      \"health\": %u\n"
            "    }",
            player->id,
            (float)player->position.x / Q16_ONE,
            (float)player->position.y / Q16_ONE,
            player->ship_id,
            player->health
        );
    }
    
    // Add projectiles
    for (uint32_t i = 0; i < sim->projectile_count && offset < (int)sizeof(json_buffer) - 200; i++) {
        const struct Projectile* proj = &sim->projectiles[i];
        
        if (!first) {
            offset += snprintf(json_buffer + offset, sizeof(json_buffer) - offset, ",\n");
        }
        first = false;
        
        offset += snprintf(json_buffer + offset, sizeof(json_buffer) - offset,
            "    {\n"
            "      \"id\": %u,\n"
            "      \"type\": \"projectile\",\n"
            "      \"position\": {\"x\": %.2f, \"y\": %.2f},\n"
            "      \"velocity\": {\"x\": %.2f, \"y\": %.2f},\n"
            "      \"damage\": %u,\n"
            "      \"shooter_id\": %u\n"
            "    }",
            proj->id,
            (float)proj->position.x / Q16_ONE,
            (float)proj->position.y / Q16_ONE,
            (float)proj->velocity.x / Q16_ONE,
            (float)proj->velocity.y / Q16_ONE,
            proj->damage,
            proj->owner_id
        );
    }
    
    // Close JSON
    offset += snprintf(json_buffer + offset, sizeof(json_buffer) - offset, "\n  ]\n}");
    
    if (offset >= (int)sizeof(json_buffer)) return -1;
    
    resp->status_code = 200;
    resp->content_type = "application/json";
    resp->body = json_buffer;
    resp->body_length = offset;
    resp->cache_control = true;
    
    return 0;
}

int admin_api_physics_objects(struct HttpResponse* resp, const struct Sim* sim) {
    if (!resp || !sim) return -1;
    
    // Get accurate player count from WebSocket server
    struct WebSocketStats ws_stats;
    uint32_t websocket_players = 0;
    if (websocket_server_get_stats(&ws_stats) == 0) {
        websocket_players = ws_stats.connected_clients;
    }
    
    // Calculate physics statistics
    uint32_t total_objects = sim->ship_count + websocket_players + sim->projectile_count;
    uint32_t collisions_per_second = 0; // TODO: Track collision rate
    
    int len = snprintf(json_buffer, sizeof(json_buffer),
        "{\n"
        "  \"ship_count\": %u,\n"
        "  \"player_count\": %u,\n"
        "  \"projectile_count\": %u,\n"
        "  \"total_objects\": %u,\n"
        "  \"collisions_per_second\": %u,\n"
        "  \"physics_time_step\": %.6f,\n"
        "  \"world_bounds\": {\n"
        "    \"min_x\": %.1f,\n"
        "    \"min_y\": %.1f,\n"
        "    \"max_x\": %.1f,\n"
        "    \"max_y\": %.1f\n"
        "  }\n"
        "}",
        sim->ship_count,
        websocket_players,
        sim->projectile_count,
        total_objects,
        collisions_per_second,
        (float)FIXED_DT_Q16 / Q16_ONE,
        -4096.0f, -4096.0f, 4096.0f, 4096.0f // World bounds
    );
    
    if (len >= (int)sizeof(json_buffer)) return -1;
    
    resp->status_code = 200;
    resp->content_type = "application/json";
    resp->body = json_buffer;
    resp->body_length = len;
    resp->cache_control = true;
    
    return 0;
}

int admin_api_network_stats(struct HttpResponse* resp, const struct NetworkManager* net_mgr) {
    if (!resp || !net_mgr) return -1;
    
    uint32_t packets_sent, packets_received, bytes_sent, bytes_received;
    float packet_loss;
    uint16_t avg_rtt;
    
    network_get_stats(net_mgr, &packets_sent, &packets_received,
                     &bytes_sent, &bytes_received, &packet_loss, &avg_rtt);
    
    int len = snprintf(json_buffer, sizeof(json_buffer),
        "{\n"
        "  \"packets_sent\": %u,\n"
        "  \"packets_received\": %u,\n"
        "  \"bytes_sent\": %u,\n"
        "  \"bytes_received\": %u,\n"
        "  \"packet_loss\": %.2f,\n"
        "  \"avg_rtt\": %u,\n"
        "  \"active_connections\": %u,\n"
        "  \"bandwidth_usage_kbps\": %.1f\n"
        "}",
        packets_sent,
        packets_received,
        bytes_sent,
        bytes_received,
        packet_loss,
        avg_rtt,
        net_mgr->reliability_mgr.active_connection_count,
        (float)net_mgr->bandwidth_used / 1024.0f
    );
    
    if (len >= (int)sizeof(json_buffer)) return -1;
    
    resp->status_code = 200;
    resp->content_type = "application/json";
    resp->body = json_buffer;
    resp->body_length = len;
    resp->cache_control = true;
    
    return 0;
}

int admin_api_performance(struct HttpResponse* resp, const struct Sim* sim) {
    if (!resp || !sim) return -1;

    // Simulate performance metrics for now
    int len = snprintf(json_buffer, sizeof(json_buffer),
        "{\n"
        "  \"cpu_usage\": 45.2,\n"
        "  \"memory_usage\": 128.5,\n"
        "  \"tick_time_avg\": 0.89,\n"
        "  \"tick_time_max\": 2.34,\n"
        "  \"fps\": 30,\n"
        "  \"heap_size\": 4096,\n"
        "  \"active_threads\": 1\n"
        "}\n"
    );
    
    resp->status_code = 200;
    resp->content_type = "application/json";
    resp->body = json_buffer;
    resp->body_length = len;
    resp->cache_control = true;
    
    return 0;
}

// Map data API - provides real-time positions of all entities
int admin_api_map_data(struct HttpResponse* resp, const struct Sim* sim) {
    if (!resp || !sim) return -1;

    int offset = 0;
    offset += snprintf(json_buffer + offset, sizeof(json_buffer) - offset,
        "{\n  \"world\": {\n    \"width\": 1000,\n    \"height\": 1000\n  },\n");

    // Ships
    offset += snprintf(json_buffer + offset, sizeof(json_buffer) - offset,
        "  \"ships\": [\n");
    
    for (uint32_t i = 0; i < sim->ship_count && offset < (int)sizeof(json_buffer) - 200; i++) {
        const struct Ship* ship = &sim->ships[i];
        if (ship->id == 0) continue; // Skip invalid ships
        
        // Convert Q16.16 fixed-point to float for JSON
        float pos_x = (float)ship->position.x / 65536.0f;
        float pos_y = (float)ship->position.y / 65536.0f;
        float rotation = (float)ship->rotation / 65536.0f;
        float vel_x = (float)ship->velocity.x / 65536.0f;
        float vel_y = (float)ship->velocity.y / 65536.0f;
        
        offset += snprintf(json_buffer + offset, sizeof(json_buffer) - offset,
            "    {\n"
            "      \"id\": %u,\n"
            "      \"type\": \"ship\",\n"
            "      \"x\": %.2f,\n"
            "      \"y\": %.2f,\n"
            "      \"rotation\": %.2f,\n"
            "      \"velocity\": {\"x\": %.2f, \"y\": %.2f},\n"
            "      \"health\": %u\n"
            "    }%s\n",
            ship->id, pos_x, pos_y, rotation, vel_x, vel_y, Q16_TO_INT(ship->hull_health),
            (i + 1 < sim->ship_count) ? "," : ""
        );
    }
    
    offset += snprintf(json_buffer + offset, sizeof(json_buffer) - offset,
        "  ],\n  \"players\": [\n");
    
    // Players
    for (uint32_t i = 0; i < sim->player_count && offset < (int)sizeof(json_buffer) - 200; i++) {
        const struct Player* player = &sim->players[i];
        if (player->id == 0) continue; // Skip invalid players
        
        float pos_x = (float)player->position.x / 65536.0f;
        float pos_y = (float)player->position.y / 65536.0f;
        
        offset += snprintf(json_buffer + offset, sizeof(json_buffer) - offset,
            "    {\n"
            "      \"id\": %u,\n"
            "      \"type\": \"player\",\n"
            "      \"x\": %.2f,\n"
            "      \"y\": %.2f,\n"
            "      \"ship_id\": %u,\n"
            "      \"health\": %u\n"
            "    }%s\n",
            player->id, pos_x, pos_y, player->ship_id, player->health,
            (i + 1 < sim->player_count) ? "," : ""
        );
    }
    
    offset += snprintf(json_buffer + offset, sizeof(json_buffer) - offset,
        "  ],\n  \"projectiles\": [\n");
    
    // Projectiles (cannonballs)
    for (uint32_t i = 0; i < sim->projectile_count && offset < (int)sizeof(json_buffer) - 200; i++) {
        const struct Projectile* proj = &sim->projectiles[i];
        if (proj->id == 0) continue; // Skip invalid projectiles
        
        float pos_x = (float)proj->position.x / 65536.0f;
        float pos_y = (float)proj->position.y / 65536.0f;
        float vel_x = (float)proj->velocity.x / 65536.0f;
        float vel_y = (float)proj->velocity.y / 65536.0f;
        
        offset += snprintf(json_buffer + offset, sizeof(json_buffer) - offset,
            "    {\n"
            "      \"id\": %u,\n"
            "      \"type\": \"projectile\",\n"
            "      \"x\": %.2f,\n"
            "      \"y\": %.2f,\n"
            "      \"velocity\": {\"x\": %.2f, \"y\": %.2f},\n"
            "      \"shooter_id\": %u\n"
            "    }%s\n",
            proj->id, pos_x, pos_y, vel_x, vel_y, proj->owner_id,
            (i + 1 < sim->projectile_count) ? "," : ""
        );
    }
    
    offset += snprintf(json_buffer + offset, sizeof(json_buffer) - offset,
        "  ]\n}\n");
    
    resp->status_code = 200;
    resp->content_type = "application/json";
    resp->body = json_buffer;
    resp->body_length = offset;
    resp->cache_control = true;
    
    return 0;
}

int admin_api_message_stats(struct HttpResponse* resp) {
    if (!resp) return -1;
    
    struct WebSocketStats ws_stats;
    if (websocket_server_get_stats(&ws_stats) != 0) {
        // WebSocket server not available, return empty stats
        int len = snprintf(json_buffer, sizeof(json_buffer),
            "{\n"
            "  \"input_messages_received\": 0,\n"
            "  \"unknown_messages_received\": 0,\n"
            "  \"last_input_time\": 0,\n"
            "  \"last_unknown_time\": 0,\n"
            "  \"last_input_age_ms\": 0,\n"
            "  \"last_unknown_age_ms\": 0,\n"
            "  \"websocket_available\": false\n"
            "}");
        
        resp->status_code = 200;
        resp->content_type = "application/json";
        resp->body = json_buffer;
        resp->body_length = len;
        resp->cache_control = true;
        return 0;
    }
    
    uint32_t current_time = get_time_ms();
    uint32_t last_input_age = (ws_stats.last_input_time > 0) ? (current_time - ws_stats.last_input_time) : 0;
    uint32_t last_unknown_age = (ws_stats.last_unknown_time > 0) ? (current_time - ws_stats.last_unknown_time) : 0;
    
    int len = snprintf(json_buffer, sizeof(json_buffer),
        "{\n"
        "  \"input_messages_received\": %llu,\n"
        "  \"unknown_messages_received\": %llu,\n"
        "  \"last_input_time\": %u,\n"
        "  \"last_unknown_time\": %u,\n"
        "  \"last_input_age_ms\": %u,\n"
        "  \"last_unknown_age_ms\": %u,\n"
        "  \"websocket_available\": true\n"
        "}",
        (unsigned long long)ws_stats.input_messages_received,
        (unsigned long long)ws_stats.unknown_messages_received,
        ws_stats.last_input_time,
        ws_stats.last_unknown_time,
        last_input_age,
        last_unknown_age
    );
    
    if (len >= (int)sizeof(json_buffer)) return -1;
    
    resp->status_code = 200;
    resp->content_type = "application/json";
    resp->body = json_buffer;
    resp->body_length = len;
    resp->cache_control = true;

    return 0;
}

// Input tier statistics API endpoint
int admin_api_input_tiers(struct HttpResponse* resp) {
    if (!resp) return -1;
    
    // Get global tier statistics
    extern input_tier_config_t g_tier_config[INPUT_TIER_COUNT];
    extern int tier_player_counts[INPUT_TIER_COUNT];
    
    // Calculate total processed inputs per tier
    int total_inputs = 0;
    int tier_inputs[INPUT_TIER_COUNT] = {0};
    
    for (int i = 0; i < INPUT_TIER_COUNT; i++) {
        tier_inputs[i] = tier_player_counts[i] * g_tier_config[i].max_rate_hz;
        total_inputs += tier_inputs[i];
    }
    
    // Get total player count for efficiency calculation
    int total_players = tier_player_counts[INPUT_TIER_IDLE] + tier_player_counts[INPUT_TIER_BACKGROUND] + 
                       tier_player_counts[INPUT_TIER_NORMAL] + tier_player_counts[INPUT_TIER_CRITICAL];
    
    // Calculate efficiency (reduction compared to all players at 30Hz)
    float efficiency = 0.0f;
    if (total_players > 0) {
        int baseline_inputs = total_players * 30; // All players at 30Hz
        efficiency = 100.0f - ((float)total_inputs / baseline_inputs * 100.0f);
    }
    
    // Build JSON response
    int len = snprintf(json_buffer, sizeof(json_buffer),
        "{\n"
        "  \"tier_stats\": {\n"
        "    \"IDLE\": {\"players\": %d, \"rate_hz\": %d, \"inputs_per_sec\": %d},\n"
        "    \"BACKGROUND\": {\"players\": %d, \"rate_hz\": %d, \"inputs_per_sec\": %d},\n"
        "    \"NORMAL\": {\"players\": %d, \"rate_hz\": %d, \"inputs_per_sec\": %d},\n"
        "    \"CRITICAL\": {\"players\": %d, \"rate_hz\": %d, \"inputs_per_sec\": %d}\n"
        "  },\n"
        "  \"summary\": {\n"
        "    \"total_players\": %d,\n"
        "    \"total_inputs_per_sec\": %d,\n"
        "    \"baseline_inputs_per_sec\": %d,\n"
        "    \"efficiency_percent\": %.1f\n"
        "  }\n"
        "}",
        tier_player_counts[INPUT_TIER_IDLE], g_tier_config[INPUT_TIER_IDLE].max_rate_hz, tier_inputs[INPUT_TIER_IDLE],
        tier_player_counts[INPUT_TIER_BACKGROUND], g_tier_config[INPUT_TIER_BACKGROUND].max_rate_hz, tier_inputs[INPUT_TIER_BACKGROUND],
        tier_player_counts[INPUT_TIER_NORMAL], g_tier_config[INPUT_TIER_NORMAL].max_rate_hz, tier_inputs[INPUT_TIER_NORMAL],
        tier_player_counts[INPUT_TIER_CRITICAL], g_tier_config[INPUT_TIER_CRITICAL].max_rate_hz, tier_inputs[INPUT_TIER_CRITICAL],
        total_players,
        total_inputs,
        total_players * 30,
        efficiency
    );
    
    if (len >= (int)sizeof(json_buffer)) return -1;
    
    resp->status_code = 200;
    resp->content_type = "application/json";
    resp->body = json_buffer;
    resp->body_length = len;
    resp->cache_control = true;

    return 0;
}
// Physics LOD statistics API endpoint
int admin_api_physics_lod(struct HttpResponse* resp) {
    if (!resp) return -1;
    
    // Check if physics LOD manager is available
    if (g_physics_lod_manager == NULL) {
        int len = snprintf(json_buffer, sizeof(json_buffer),
            "{\"error\": \"Physics LOD system not initialized\", \"enabled\": false}");
        
        resp->status_code = 200;
        resp->content_type = "application/json";
        resp->body = json_buffer;
        resp->body_length = len;
        resp->cache_control = true;
        return 0;
    }
    
    // Export LOD stats as JSON
    if (physics_lod_export_json(g_physics_lod_manager, json_buffer, sizeof(json_buffer)) != 0) {
        return -1;
    }
    
    resp->status_code = 200;
    resp->content_type = "application/json";
    resp->body = json_buffer;
    resp->body_length = strlen(json_buffer);
    resp->cache_control = true;
    
    return 0;
}

// Performance monitor statistics API endpoint
int admin_api_performance_monitor(struct HttpResponse* resp) {
    if (!resp) return -1;
    
    // Check if performance monitor is available
    if (g_performance_monitor == NULL) {
        int len = snprintf(json_buffer, sizeof(json_buffer),
            "{\"error\": \"Performance monitor not initialized\"}");
        
        resp->status_code = 200;
        resp->content_type = "application/json";
        resp->body = json_buffer;
        resp->body_length = len;
        resp->cache_control = true;
        return 0;
    }
    
    // Export performance stats as JSON
    if (perf_export_json(g_performance_monitor, json_buffer, sizeof(json_buffer)) != 0) {
        return -1;
    }
    
    resp->status_code = 200;
    resp->content_type = "application/json";
    resp->body = json_buffer;
    resp->body_length = strlen(json_buffer);
    resp->cache_control = true;
    
    return 0;
}
