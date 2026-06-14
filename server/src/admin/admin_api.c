#include "admin/admin_server.h"
#include "sim/types.h"
#include "sim/island.h"
#include "net/network.h"
#include "net/websocket_server.h"
#include "net/ship_init.h"
#include "input_validation.h"
#include "util/log.h"
#include "util/time.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <json-c/json.h>

// Static buffer for JSON responses (to avoid dynamic allocation)
static char json_buffer[32768];

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
        -500.0f, -500.0f, 9500.0f, 8500.0f // World bounds (client pixel space)
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

    // Count ghost ships for dashboard
    uint32_t ghost_count = 0;
    for (uint32_t i = 0; i < sim->ship_count; i++) {
        if (sim->ships[i].id != 0 && sim->ships[i].company_id == COMPANY_GHOST) ghost_count++;
    }
    // Fetch simple ships for npc_level lookup
    SimpleShip* ws_ships = NULL;
    int ws_ship_count = 0;
    websocket_server_get_ships(&ws_ships, &ws_ship_count);

    offset += snprintf(json_buffer + offset, sizeof(json_buffer) - offset,
        "{\n  \"world\": {\n    \"width\": 1000,\n    \"height\": 1000\n  },\n  \"ghost_count\": %u,\n",
        ghost_count);

    // Ships
    offset += snprintf(json_buffer + offset, sizeof(json_buffer) - offset,
        "  \"ships\": [\n");
    
    for (uint32_t i = 0; i < sim->ship_count && offset < (int)sizeof(json_buffer) - 200; i++) {
        const struct Ship* ship = &sim->ships[i];
        if (ship->id == 0) continue; // Skip invalid ships
        
        // Convert Q16.16 fixed-point to float and scale back to client coordinates
        float pos_x = SERVER_TO_CLIENT((float)ship->position.x / 65536.0f);
        float pos_y = SERVER_TO_CLIENT((float)ship->position.y / 65536.0f);
        float rotation = (float)ship->rotation / 65536.0f;
        float vel_x = SERVER_TO_CLIENT((float)ship->velocity.x / 65536.0f);
        float vel_y = SERVER_TO_CLIENT((float)ship->velocity.y / 65536.0f);

        // Look up npc_level from websocket simple ships
        uint8_t npc_level = 0;
        for (int ws = 0; ws_ships && ws < ws_ship_count; ws++) {
            if (ws_ships[ws].ship_id == ship->id) { npc_level = ws_ships[ws].npc_level; break; }
        }
        
        offset += snprintf(json_buffer + offset, sizeof(json_buffer) - offset,
            "    {\n"
            "      \"id\": %u,\n"
            "      \"type\": \"ship\",\n"
            "      \"x\": %.2f,\n"
            "      \"y\": %.2f,\n"
            "      \"rotation\": %.2f,\n"
            "      \"velocity\": {\"x\": %.2f, \"y\": %.2f},\n"
            "      \"health\": %u,\n"
            "      \"company_id\": %u,\n"
            "      \"npc_level\": %u,\n"
            "      \"hull\": [",
            ship->id, pos_x, pos_y, rotation, vel_x, vel_y, Q16_TO_INT(ship->hull_health),
            ship->company_id, npc_level
        );
        
        // Add hull vertices (scale back to client coordinates)
        for (uint8_t v = 0; v < ship->hull_vertex_count && offset < (int)sizeof(json_buffer) - 200; v++) {
            float vx = SERVER_TO_CLIENT((float)ship->hull_vertices[v].x / 65536.0f);
            float vy = SERVER_TO_CLIENT((float)ship->hull_vertices[v].y / 65536.0f);
            offset += snprintf(json_buffer + offset, sizeof(json_buffer) - offset,
                "{\"x\":%.2f,\"y\":%.2f}%s",
                vx, vy, (v + 1 < ship->hull_vertex_count) ? "," : ""
            );
        }
        
        offset += snprintf(json_buffer + offset, sizeof(json_buffer) - offset, "],\n      \"modules\": [");
        
        // Add modules
        // Planks (100-109) and deck (200): only send health, client generates positions from hull
        // Gameplay modules (1000+): send full transform data
        for (uint8_t m = 0; m < ship->module_count && offset < (int)sizeof(json_buffer) - 300; m++) {
            const ShipModule* module = &ship->modules[m];
            
            if (module->type_id == MODULE_TYPE_PLANK) {
                // Plank: send only ID and health (client has hard-coded positions)
                offset += snprintf(json_buffer + offset, sizeof(json_buffer) - offset,
                    "{\"id\":%u,\"typeId\":%u,\"health\":%d,\"maxHealth\":%d}%s",
                    module->id, module->type_id, (int)module->health, (int)module->max_health,
                    (m + 1 < ship->module_count) ? "," : ""
                );
            } else if (module->type_id == MODULE_TYPE_DECK) {
                // Deck: send only ID and type (client generates polygon from hull)
                offset += snprintf(json_buffer + offset, sizeof(json_buffer) - offset,
                    "{\"id\":%u,\"typeId\":%u}%s",
                    module->id, module->type_id,
                    (m + 1 < ship->module_count) ? "," : ""
                );
            } else {
                // Gameplay modules: send full transform
                float module_x = SERVER_TO_CLIENT((float)module->local_pos.x / 65536.0f);
                float module_y = SERVER_TO_CLIENT((float)module->local_pos.y / 65536.0f);
                float module_rot = (float)module->local_rot / 65536.0f;
                
                offset += snprintf(json_buffer + offset, sizeof(json_buffer) - offset,
                    "{\"id\":%u,\"typeId\":%u,\"x\":%.2f,\"y\":%.2f,\"rotation\":%.2f}%s",
                    module->id, module->type_id, module_x, module_y, module_rot,
                    (m + 1 < ship->module_count) ? "," : ""
                );
            }
        }
        
        offset += snprintf(json_buffer + offset, sizeof(json_buffer) - offset,
            "]\n    }%s\n",
            (i + 1 < sim->ship_count) ? "," : ""
        );
    }
    
    offset += snprintf(json_buffer + offset, sizeof(json_buffer) - offset,
        "  ],\n  \"players\": [\n");
    
    // Players
    for (uint32_t i = 0; i < sim->player_count && offset < (int)sizeof(json_buffer) - 200; i++) {
        const struct Player* player = &sim->players[i];
        if (player->id == 0) continue; // Skip invalid players
        
        // Scale back to client coordinates
        float pos_x = SERVER_TO_CLIENT((float)player->position.x / 65536.0f);
        float pos_y = SERVER_TO_CLIENT((float)player->position.y / 65536.0f);
        
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
        
        // Scale back to client coordinates
        float pos_x = SERVER_TO_CLIENT((float)proj->position.x / 65536.0f);
        float pos_y = SERVER_TO_CLIENT((float)proj->position.y / 65536.0f);
        float vel_x = SERVER_TO_CLIENT((float)proj->velocity.x / 65536.0f);
        float vel_y = SERVER_TO_CLIENT((float)proj->velocity.y / 65536.0f);
        
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
        "  ],\n  \"islands\": [\n");

    // Islands (static world data from ISLAND_PRESETS)
    for (int ii = 0; ii < ISLAND_COUNT && offset < (int)sizeof(json_buffer) - 2048; ii++) {
        const IslandDef *isl = &ISLAND_PRESETS[ii];
        if (ii > 0)
            offset += snprintf(json_buffer + offset, sizeof(json_buffer) - offset, ",\n");
        offset += snprintf(json_buffer + offset, sizeof(json_buffer) - offset,
            "    {\"id\":%d,\"x\":%.2f,\"y\":%.2f"
            ",\"beachRadius\":%.2f,\"grassRadius\":%.2f"
            ",\"beachMaxBump\":%.2f,\"grassMaxBump\":%.2f"
            ",\"beachBumps\":[%.2f,%.2f,%.2f,%.2f,%.2f,%.2f,%.2f,%.2f,%.2f,%.2f,%.2f,%.2f,%.2f,%.2f,%.2f,%.2f]"
            ",\"grassBumps\":[%.2f,%.2f,%.2f,%.2f,%.2f,%.2f,%.2f,%.2f,%.2f,%.2f,%.2f,%.2f,%.2f,%.2f,%.2f,%.2f]",
            isl->id, isl->x, isl->y,
            isl->beach_radius_px, isl->grass_radius_px,
            isl->beach_max_bump, isl->grass_max_bump,
            isl->beach_bumps[0],  isl->beach_bumps[1],  isl->beach_bumps[2],  isl->beach_bumps[3],
            isl->beach_bumps[4],  isl->beach_bumps[5],  isl->beach_bumps[6],  isl->beach_bumps[7],
            isl->beach_bumps[8],  isl->beach_bumps[9],  isl->beach_bumps[10], isl->beach_bumps[11],
            isl->beach_bumps[12], isl->beach_bumps[13], isl->beach_bumps[14], isl->beach_bumps[15],
            isl->grass_bumps[0],  isl->grass_bumps[1],  isl->grass_bumps[2],  isl->grass_bumps[3],
            isl->grass_bumps[4],  isl->grass_bumps[5],  isl->grass_bumps[6],  isl->grass_bumps[7],
            isl->grass_bumps[8],  isl->grass_bumps[9],  isl->grass_bumps[10], isl->grass_bumps[11],
            isl->grass_bumps[12], isl->grass_bumps[13], isl->grass_bumps[14], isl->grass_bumps[15]
        );
        /* Polygon islands: append vertices array */
        if (isl->vertex_count > 0) {
            offset += snprintf(json_buffer + offset, sizeof(json_buffer) - offset, ",\"vertices\":[");
            for (int vi = 0; vi < isl->vertex_count && offset < (int)sizeof(json_buffer) - 64; vi++) {
                offset += snprintf(json_buffer + offset, sizeof(json_buffer) - offset,
                    "%s{\"x\":%.1f,\"y\":%.1f}",
                    vi ? "," : "",
                    isl->x + isl->vx[vi], isl->y + isl->vy[vi]);
            }
            offset += snprintf(json_buffer + offset, sizeof(json_buffer) - offset, "]");
        }
        offset += snprintf(json_buffer + offset, sizeof(json_buffer) - offset, "}");
    }

    /* Placed structures (shipyards, claim structures, etc.) */
    offset += snprintf(json_buffer + offset, sizeof(json_buffer) - offset,
        "\n  ],\n  \"structures\": [\n");
    {
        PlacedStructure *ps = NULL;
        uint32_t ps_count = 0;
        bool ps_first = true;
        if (websocket_server_get_placed_structures(&ps, &ps_count) == 0) {
            for (uint32_t si = 0; si < ps_count && offset < (int)sizeof(json_buffer) - 512; si++) {
                if (!ps[si].active) continue;
                const char *stype =
                    ps[si].type == STRUCT_WOODEN_FLOOR    ? "wooden_floor" :
                    ps[si].type == STRUCT_WORKBENCH       ? "workbench" :
                    ps[si].type == STRUCT_WALL            ? "wall" :
                    ps[si].type == STRUCT_DOOR_FRAME      ? "door_frame" :
                    ps[si].type == STRUCT_DOOR            ? "door" :
                    ps[si].type == STRUCT_SHIPYARD        ? "shipyard" :
                    ps[si].type == STRUCT_FLAG_FORT       ? "flag_fort" :
                    ps[si].type == STRUCT_CLAIM_FLAG      ? "claim_flag" :
                    ps[si].type == STRUCT_COMPANY_FORTRESS? "company_fortress" :
                    ps[si].type == STRUCT_CHEST           ? "chest" : "unknown";
                /* Base fields for all structures — claim_orphaned included for all
                 * because the BFS graph sweep sets it on any disconnected structure */
                offset += snprintf(json_buffer + offset, sizeof(json_buffer) - offset,
                    "%s    {\"id\":%u,\"type\":\"%s\",\"x\":%.2f,\"y\":%.2f"
                    ",\"rotation\":%.2f,\"company_id\":%u,\"hp\":%u,\"max_hp\":%u"
                    ",\"claim_orphaned\":%s",
                    ps_first ? "" : ",\n",
                    ps[si].id, stype, ps[si].x, ps[si].y,
                    ps[si].rotation, ps[si].company_id, ps[si].hp, ps[si].max_hp,
                    ps[si].claim_orphaned ? "true" : "false");
                /* Extra fields for claim / territory structures */
                if (ps[si].type == STRUCT_FLAG_FORT ||
                    ps[si].type == STRUCT_CLAIM_FLAG ||
                    ps[si].type == STRUCT_COMPANY_FORTRESS) {
                    offset += snprintf(json_buffer + offset, sizeof(json_buffer) - offset,
                        ",\"fortress_complete\":%s"
                        ",\"claim_phase\":%u,\"claim_state\":%u",
                        ps[si].fortress_complete ? "true" : "false",
                        ps[si].claim_phase, ps[si].claim_state);
                }
                /* Claim flag targeting: expose source structure IDs so the
                 * admin panel can map the flag to its contest section */
                if (ps[si].type == STRUCT_CLAIM_FLAG) {
                    offset += snprintf(json_buffer + offset, sizeof(json_buffer) - offset,
                        ",\"claim_linked_fort\":%u,\"claim_source_enemy\":%u",
                        ps[si].claim_linked_fort, ps[si].claim_source_enemy);
                }
                /* dominators array — emitted for all DOM-eligible types:
                 * wooden_floor, flag_fort, company_fortress */
                if (ps[si].type == STRUCT_WOODEN_FLOOR ||
                    ps[si].type == STRUCT_FLAG_FORT ||
                    ps[si].type == STRUCT_COMPANY_FORTRESS) {
                    offset += snprintf(json_buffer + offset, sizeof(json_buffer) - offset,
                        ",\"dominators\":[");
                    for (uint8_t di = 0; di < ps[si].dominator_count && offset < (int)sizeof(json_buffer) - 64; di++) {
                        offset += snprintf(json_buffer + offset, sizeof(json_buffer) - offset,
                            "%s%u", di ? "," : "", ps[si].dominators[di]);
                    }
                    offset += snprintf(json_buffer + offset, sizeof(json_buffer) - offset, "]");
                }
                offset += snprintf(json_buffer + offset, sizeof(json_buffer) - offset, "}");
                ps_first = false;
            }
        }
    }
    offset += snprintf(json_buffer + offset, sizeof(json_buffer) - offset,
        "\n  ]\n}\n");

    resp->status_code = 200;
    resp->content_type = "application/json";
    resp->body = json_buffer;
    resp->body_length = offset;
    resp->cache_control = false;  /* always fresh — map data changes every tick */
    
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

int admin_api_websocket_entities(struct HttpResponse* resp) {
    if (!resp) return -1;
    
    SimpleShip* ships = NULL;
    WebSocketPlayer* players = NULL;
    int ship_count = 0;
    int player_count = 0;
    
    websocket_server_get_ships(&ships, &ship_count);
    websocket_server_get_players(&players, &player_count);
    
    // Start JSON
    int offset = snprintf(json_buffer, sizeof(json_buffer),
        "{\n  \"ships\": [\n");
    
    // Add ships
    for (int i = 0; i < ship_count && offset < (int)sizeof(json_buffer) - 500; i++) {
        if (i > 0) offset += snprintf(json_buffer + offset, sizeof(json_buffer) - offset, ",\n");
        
        offset += snprintf(json_buffer + offset, sizeof(json_buffer) - offset,
            "    {\n"
            "      \"id\": %u,\n"
            "      \"type\": %u,\n"
            "      \"x\": %.1f,\n"
            "      \"y\": %.1f,\n"
            "      \"rotation\": %.3f,\n"
            "      \"velocity_x\": %.2f,\n"
            "      \"velocity_y\": %.2f,\n"
            "      \"deck_bounds\": {\"min_x\": %.1f, \"max_x\": %.1f, \"min_y\": %.1f, \"max_y\": %.1f}\n"
            "    }",
            ships[i].ship_id,
            ships[i].ship_type,
            ships[i].x, ships[i].y,
            ships[i].rotation,
            ships[i].velocity_x, ships[i].velocity_y,
            ships[i].deck_min_x, ships[i].deck_max_x,
            ships[i].deck_min_y, ships[i].deck_max_y);
    }
    
    offset += snprintf(json_buffer + offset, sizeof(json_buffer) - offset,
        "\n  ],\n  \"players\": [\n");
    
    // Add active players
    bool first_player = true;
    for (int i = 0; i < 100 && offset < (int)sizeof(json_buffer) - 500; i++) {
        if (!players[i].active) continue;
        
        if (!first_player) offset += snprintf(json_buffer + offset, sizeof(json_buffer) - offset, ",\n");
        first_player = false;
        
        const char* state_str = "UNKNOWN";
        switch(players[i].movement_state) {
            case PLAYER_STATE_WALKING: state_str = "WALKING"; break;
            case PLAYER_STATE_SWIMMING: state_str = "SWIMMING"; break;
            case PLAYER_STATE_FALLING: state_str = "FALLING"; break;
            case PLAYER_STATE_IDLE: state_str = "IDLE"; break;
            default: break;
        }
        
        offset += snprintf(json_buffer + offset, sizeof(json_buffer) - offset,
            "    {\n"
            "      \"id\": %u,\n"
            "      \"name\": \"%s\",\n"
            "      \"world_x\": %.1f,\n"
            "      \"world_y\": %.1f,\n"
            "      \"rotation\": %.3f,\n"
            "      \"velocity_x\": %.2f,\n"
            "      \"velocity_y\": %.2f,\n"
            "      \"ship_id\": %u,\n"
            "      \"local_x\": %.1f,\n"
            "      \"local_y\": %.1f,\n"
            "      \"company\": %u,\n"
            "      \"state\": \"%s\"\n"
            "    }",
            players[i].player_id,
            players[i].name,
            players[i].x, players[i].y,
            players[i].rotation,
            players[i].velocity_x, players[i].velocity_y,
            players[i].parent_ship_id,
            players[i].local_x, players[i].local_y,
            (unsigned)players[i].company_id,
            state_str);
    }
    
    offset += snprintf(json_buffer + offset, sizeof(json_buffer) - offset,
        "\n  ]\n}");
    
    if (offset >= (int)sizeof(json_buffer)) return -1;
    
    resp->status_code = 200;
    resp->content_type = "application/json";
    resp->body = json_buffer;
    resp->body_length = offset;
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

int admin_api_create_ship(struct HttpResponse* resp, float x, float y, uint8_t company) {
    if (!resp) return -1;

    uint32_t new_id = websocket_server_create_ship(x, y, company, 0xFF);

    int len;
    if (new_id == 0) {
        resp->status_code = 503;
        resp->content_type = "application/json";
        len = snprintf(json_buffer, sizeof(json_buffer),
            "{\"success\":false,\"error\":\"Failed to create ship (sim full or not linked)\"}");
    } else {
        resp->status_code = 200;
        resp->content_type = "application/json";
        len = snprintf(json_buffer, sizeof(json_buffer),
            "{\"success\":true,\"shipId\":%u,\"x\":%.1f,\"y\":%.1f,\"company\":%u}",
            new_id, x, y, (unsigned)company);
    }

    if (len < 0 || len >= (int)sizeof(json_buffer)) return -1;
    resp->body = json_buffer;
    resp->body_length = (size_t)len;
    resp->cache_control = false;
    return 0;
}

int admin_api_create_phantom_brig(struct HttpResponse* resp, float x, float y, uint8_t level) {
    if (!resp) return -1;
    if (level < 1)  level = 1;
    if (level > 60) level = 60;

    uint32_t new_id = websocket_server_create_ghost_ship(x, y, level);

    int len;
    if (new_id == 0) {
        resp->status_code = 503;
        resp->content_type = "application/json";
        len = snprintf(json_buffer, sizeof(json_buffer),
            "{\"success\":false,\"error\":\"Failed to spawn Phantom Brig (sim full or not linked)\"}");
    } else {
        resp->status_code = 200;
        resp->content_type = "application/json";
        len = snprintf(json_buffer, sizeof(json_buffer),
            "{\"success\":true,\"shipId\":%u,\"x\":%.1f,\"y\":%.1f,\"name\":\"Phantom Brig\",\"level\":%u}",
            new_id, x, y, (unsigned)level);
    }

    if (len < 0 || len >= (int)sizeof(json_buffer)) return -1;
    resp->body = json_buffer;
    resp->body_length = (size_t)len;
    resp->cache_control = false;
    return 0;
}

int admin_api_set_player_company(struct HttpResponse* resp, uint32_t player_id, uint8_t company_id) {
    if (!resp) return -1;

    int result = websocket_server_set_player_company(player_id, company_id);

    int len;
    if (result == 0) {
        resp->status_code = 200;
        len = snprintf(json_buffer, sizeof(json_buffer),
            "{\"success\":true,\"playerId\":%u,\"company\":%u}",
            player_id, (unsigned)company_id);
    } else {
        resp->status_code = 404;
        len = snprintf(json_buffer, sizeof(json_buffer),
            "{\"success\":false,\"error\":\"Player not found\"}");
    }

    if (len < 0 || len >= (int)sizeof(json_buffer)) return -1;
    resp->content_type = "application/json";
    resp->body = json_buffer;
    resp->body_length = (size_t)len;
    resp->cache_control = false;
    return 0;
}

/* Island schema endpoint — returns shape vertices + metadata for all islands.
 * Used by the standalone island editor to keep itself in sync with the server. */
static char islands_json_buffer[262144]; /* 256KB — accommodates large polygon islands */

int admin_api_islands(struct HttpResponse* resp) {
    if (!resp) return -1;

#define ISL_APPEND(...) do { \
    if (pos < buf_size - 1) \
        pos += snprintf(islands_json_buffer + pos, (size_t)(buf_size - pos), __VA_ARGS__); \
} while(0)

    int pos = 0;
    int buf_size = (int)sizeof(islands_json_buffer);
    ISL_APPEND("{\"islands\":[");

    for (int ii = 0; ii < ISLAND_COUNT; ii++) {
        const IslandDef *isl = &ISLAND_PRESETS[ii];
        if (pos >= buf_size - 8192) {
            /* Buffer nearly full — stop safely */
            break;
        }
        if (ii > 0)
            ISL_APPEND(",");

        ISL_APPEND("{\"id\":%d,\"cx\":%.1f,\"cy\":%.1f,\"rotation_deg\":%.4f,\"preset\":\"%s\"",
            isl->id, isl->x, isl->y, isl->rotation_deg, isl->preset);
        if (isl->template_name[0] != '\0')
            ISL_APPEND(",\"template\":\"%s\"", isl->template_name);

        if (isl->vertex_count > 0) {
            /* Polygon island — emit shape vertices as local offsets from centre */
            ISL_APPEND(",\"grassPolyScale\":%.4f,\"vertexCount\":%d,\"outerVerts\":[",
                isl->grass_poly_scale, isl->vertex_count);
            for (int vi = 0; vi < isl->vertex_count; vi++) {
                if (vi > 0) ISL_APPEND(",");
                ISL_APPEND("{\"x\":%.1f,\"y\":%.1f}", isl->vx[vi], isl->vy[vi]);
            }
            ISL_APPEND("]");
            if (isl->grass_vertex_count > 0) {
                ISL_APPEND(",\"grassVertCount\":%d,\"grassVerts\":[", isl->grass_vertex_count);
                for (int vi = 0; vi < isl->grass_vertex_count; vi++) {
                    if (vi > 0) ISL_APPEND(",");
                    ISL_APPEND("{\"x\":%.1f,\"y\":%.1f}", isl->gvx[vi], isl->gvy[vi]);
                }
                ISL_APPEND("]");
            }
            if (isl->shallow_vertex_count > 0) {
                ISL_APPEND(",\"shallowVertCount\":%d,\"shallowVerts\":[", isl->shallow_vertex_count);
                for (int vi = 0; vi < isl->shallow_vertex_count; vi++) {
                    if (vi > 0) ISL_APPEND(",");
                    ISL_APPEND("{\"x\":%.1f,\"y\":%.1f}", isl->svx[vi], isl->svy[vi]);
                }
                ISL_APPEND("]");
            }
            if (isl->stone_poly_count > 0) {
                ISL_APPEND(",\"stonePolys\":[");
                for (int pi = 0; pi < isl->stone_poly_count; pi++) {
                    if (pi > 0) ISL_APPEND(",");
                    ISL_APPEND("[");
                    for (int vi = 0; vi < isl->stone_vc[pi]; vi++) {
                        if (vi > 0) ISL_APPEND(",");
                        ISL_APPEND("{\"x\":%.1f,\"y\":%.1f}", isl->stone_vx[pi][vi], isl->stone_vy[pi][vi]);
                    }
                    ISL_APPEND("]");
                }
                ISL_APPEND("]");
            }
            if (isl->metal_poly_count > 0) {
                ISL_APPEND(",\"metalPolys\":[");
                for (int pi = 0; pi < isl->metal_poly_count; pi++) {
                    if (pi > 0) ISL_APPEND(",");
                    ISL_APPEND("[");
                    for (int vi = 0; vi < isl->metal_vc[pi]; vi++) {
                        if (vi > 0) ISL_APPEND(",");
                        ISL_APPEND("{\"x\":%.1f,\"y\":%.1f}", isl->metal_vx[pi][vi], isl->metal_vy[pi][vi]);
                    }
                    ISL_APPEND("]");
                }
                ISL_APPEND("]");
            }
        } else {
            /* Bump-circle island */
            ISL_APPEND(",\"beachRadius\":%.1f,\"grassRadius\":%.1f",
                isl->beach_radius_px, isl->grass_radius_px);
        }

        ISL_APPEND("}");
    }

    ISL_APPEND("]}");

#undef ISL_APPEND

    resp->status_code = 200;
    resp->content_type = "application/json";
    resp->body = islands_json_buffer;
    resp->body_length = (size_t)pos;
    resp->cache_control = false;
    return 0;
}

/* ── Island save endpoint ────────────────────────────────────────────────── *
 * POST /api/islands/save                                                      *
 * Body: the full island JSON schema (same format as the editor export).       *
 *                                                                             *
 * If the island uses a named template, writes to                              *
 *   data/islands/templates/<template>.json  (template format).               *
 * Otherwise writes to data/islands/island_<id>.json (standalone).            */
static char save_resp_buf[512];

int admin_api_islands_save(struct HttpResponse *resp, const char *body, size_t body_len)
{
    if (!resp || !body || body_len == 0) {
        resp->status_code = 400;
        resp->body = (char *)"{\"error\":\"empty body\"}";
        resp->body_length = 21;
        resp->content_type = "application/json";
        return -1;
    }

    /* Parse the posted schema so we can extract vertex fields cleanly */
    struct json_object *posted = json_tokener_parse(body);
    if (!posted) {
        resp->status_code = 400;
        resp->body = (char *)"{\"error\":\"invalid JSON\"}";
        resp->body_length = 23;
        resp->content_type = "application/json";
        return -1;
    }

    struct json_object *id_j = NULL;
    json_object_object_get_ex(posted, "islandId", &id_j);
    int island_id = id_j ? json_object_get_int(id_j) : 0;
    if (island_id <= 0) {
        json_object_put(posted);
        resp->status_code = 400;
        resp->body = (char *)"{\"error\":\"missing or invalid islandId\"}";
        resp->body_length = 38;
        resp->content_type = "application/json";
        return -1;
    }

    /* Find the matching IslandDef */
    IslandDef *isl = NULL;
    for (int k = 0; k < ISLAND_COUNT; k++) {
        if (ISLAND_PRESETS[k].id == island_id) { isl = &ISLAND_PRESETS[k]; break; }
    }

    char path[512];

    if (isl && isl->template_name[0] != '\0') {
        /* ── Template island — save vertex/biome data to templates/<name>.json ─ */
        snprintf(path, sizeof(path), "data/islands/templates/%s.json", isl->template_name);

        struct json_object *tmpl = json_object_new_object();

        /* Metadata from live ISLAND_PRESETS */
        json_object_object_add(tmpl, "name",
            json_object_new_string(isl->template_name));
        json_object_object_add(tmpl, "poly_bound_r",
            json_object_new_double((double)isl->poly_bound_r));
        json_object_object_add(tmpl, "grass_poly_scale",
            json_object_new_double((double)isl->grass_poly_scale));
        json_object_object_add(tmpl, "shallow_poly_scale",
            json_object_new_double((double)isl->shallow_poly_scale));

        /* Vertex/biome fields — copied from posted body */
        static const char *const VERT_KEYS[] = {
            "sand_verts_JSON", "grass_verts_JSON", "shallow_verts_JSON",
            "stone_polys_JSON", "metal_polys_JSON", NULL
        };
        for (int k = 0; VERT_KEYS[k]; k++) {
            struct json_object *field = NULL;
            if (json_object_object_get_ex(posted, VERT_KEYS[k], &field))
                json_object_object_add(tmpl, VERT_KEYS[k], json_object_get(field));
        }

        int rc = json_object_to_file_ext(path, tmpl, JSON_C_TO_STRING_PRETTY);
        json_object_put(tmpl);
        json_object_put(posted);

        if (rc != 0) {
            int len = snprintf(save_resp_buf, sizeof(save_resp_buf),
                               "{\"error\":\"cannot write %s\"}", path);
            resp->status_code = 500;
            resp->body = save_resp_buf;
            resp->body_length = (size_t)len;
            resp->content_type = "application/json";
            return -1;
        }

        int len = snprintf(save_resp_buf, sizeof(save_resp_buf),
                           "{\"ok\":true,\"file\":\"%s\"}", path);
        resp->status_code = 200;
        resp->content_type = "application/json";
        resp->body = save_resp_buf;
        resp->body_length = (size_t)len;
        return 0;
    }

    /* ── Standalone island — write raw JSON to island_<id>.json ────────────── */
    json_object_put(posted);
    snprintf(path, sizeof(path), "data/islands/island_%d.json", island_id);

    FILE *f = fopen(path, "wb");
    if (!f) {
        int len = snprintf(save_resp_buf, sizeof(save_resp_buf),
                           "{\"error\":\"cannot write %s\"}", path);
        resp->status_code = 500;
        resp->body = save_resp_buf;
        resp->body_length = (size_t)len;
        resp->content_type = "application/json";
        return -1;
    }
    fwrite(body, 1, body_len, f);
    fclose(f);

    int len = snprintf(save_resp_buf, sizeof(save_resp_buf),
                       "{\"ok\":true,\"file\":\"%s\"}", path);
    resp->status_code = 200;
    resp->content_type = "application/json";
    resp->body = save_resp_buf;
    resp->body_length = (size_t)len;
    return 0;
}

/* ── Ghost spawn-point API (world editor) ───────────────────────────────── */

static char ghost_spawn_json_buf[65536];

int admin_api_get_ghost_spawns(struct HttpResponse *resp) {
    int written = ghost_spawns_to_json(ghost_spawn_json_buf, sizeof(ghost_spawn_json_buf));
    if (written < 0) {
        resp->status_code = 500;
        resp->content_type = "application/json";
        resp->body = "{\"error\":\"buffer overflow\"}";
        resp->body_length = 26;
        return -1;
    }
    resp->status_code = 200;
    resp->content_type = "application/json";
    resp->body = ghost_spawn_json_buf;
    resp->body_length = (size_t)written;
    return 0;
}

int admin_api_save_ghost_spawns(struct HttpResponse *resp, const char *body, size_t body_len) {
    static char save_gs_buf[256];
    const char *path = "data/ghost_spawns.json";

    json_object *test = json_tokener_parse(body);
    if (!test) {
        int len = snprintf(save_gs_buf, sizeof(save_gs_buf), "{\"error\":\"invalid JSON\"}");
        resp->status_code = 400;
        resp->content_type = "application/json";
        resp->body = save_gs_buf;
        resp->body_length = (size_t)len;
        return -1;
    }
    json_object_put(test);

    FILE *f = fopen(path, "w");
    if (!f) {
        int len = snprintf(save_gs_buf, sizeof(save_gs_buf), "{\"error\":\"cannot write %s\"}", path);
        resp->status_code = 500;
        resp->content_type = "application/json";
        resp->body = save_gs_buf;
        resp->body_length = (size_t)len;
        return -1;
    }
    fwrite(body, 1, body_len, f);
    fclose(f);

    load_ghost_spawns(path);

    int len = snprintf(save_gs_buf, sizeof(save_gs_buf), "{\"ok\":true}");
    resp->status_code = 200;
    resp->content_type = "application/json";
    resp->body = save_gs_buf;
    resp->body_length = (size_t)len;
    return 0;
}

/* ── Island reposition endpoint ──────────────────────────────────────────── */
/* ── Island reposition endpoint ──────────────────────────────────────────── *
 * POST /api/islands/reposition                                                *
 * Body: [{id, x, y}, ...]                                                    *
 * Updates the centre positions in data/islands/islands.json.                 */
static char reposition_resp_buf[512];

int admin_api_islands_reposition(struct HttpResponse *resp, const char *body, size_t body_len)
{
    if (!resp || !body || body_len == 0) {
        resp->status_code = 400;
        resp->body = (char *)"{\"error\":\"empty body\"}";
        resp->body_length = 22;
        resp->content_type = "application/json";
        return -1;
    }

    struct json_object *arr = json_tokener_parse(body);
    if (!arr || !json_object_is_type(arr, json_type_array)) {
        if (arr) json_object_put(arr);
        resp->status_code = 400;
        resp->body = (char *)"{\"error\":\"expected JSON array\"}";
        resp->body_length = 30;
        resp->content_type = "application/json";
        return -1;
    }

    /* Load the current islands.json */
    const char *islands_path = "data/islands/islands.json";
    struct json_object *islands_arr = NULL;
    {
        FILE *f = fopen(islands_path, "r");
        if (f) {
            fseek(f, 0, SEEK_END);
            long fsz = ftell(f);
            rewind(f);
            if (fsz > 0 && fsz < 65536) {
                char *buf = (char *)malloc((size_t)fsz + 1);
                if (buf) {
                    size_t fgot = fread(buf, 1, (size_t)fsz, f);
                    buf[fgot] = '\0';
                    islands_arr = json_tokener_parse(buf);
                    free(buf);
                }
            }
            fclose(f);
        }
    }

    if (!islands_arr || !json_object_is_type(islands_arr, json_type_array)) {
        if (islands_arr) json_object_put(islands_arr);
        json_object_put(arr);
        resp->status_code = 500;
        resp->body = (char *)"{\"error\":\"cannot read islands.json\"}";
        resp->body_length = 36;
        resp->content_type = "application/json";
        return -1;
    }

    /* Apply the requested position/rotation changes */
    int updates = 0;
    int count = (int)json_object_array_length(arr);
    for (int i = 0; i < count; i++) {
        struct json_object *entry = json_object_array_get_idx(arr, i);
        struct json_object *id_j = NULL, *x_j = NULL, *y_j = NULL, *rot_j = NULL;
        json_object_object_get_ex(entry, "id",           &id_j);
        json_object_object_get_ex(entry, "x",            &x_j);
        json_object_object_get_ex(entry, "y",            &y_j);
        json_object_object_get_ex(entry, "rotation_deg", &rot_j);
        if (!id_j) continue;
        int target_id = json_object_get_int(id_j);

        int n = (int)json_object_array_length(islands_arr);
        for (int k = 0; k < n; k++) {
            struct json_object *isle = json_object_array_get_idx(islands_arr, k);
            struct json_object *isle_id = NULL;
            json_object_object_get_ex(isle, "id", &isle_id);
            if (!isle_id || json_object_get_int(isle_id) != target_id) continue;

            /* Update centre position (x, y) if provided */
            if (x_j && y_j) {
                double nx = json_object_get_double(x_j);
                double ny = json_object_get_double(y_j);
                struct json_object *centre = NULL;
                if (!json_object_object_get_ex(isle, "centre", &centre)) {
                    centre = json_object_new_object();
                    json_object_object_add(isle, "centre", centre);
                }
                json_object_object_add(centre, "x", json_object_new_double(nx));
                json_object_object_add(centre, "y", json_object_new_double(ny));
            }

            /* Update rotation_deg if provided */
            if (rot_j) {
                double new_rot = fmod(json_object_get_double(rot_j) + 360.0, 360.0);
                json_object_object_add(isle, "rotation_deg", json_object_new_double(new_rot));
            }

            updates++;
            break;
        }
    }

    /* Write back */
    int rc = json_object_to_file_ext(islands_path, islands_arr, JSON_C_TO_STRING_PRETTY);
    json_object_put(islands_arr);
    json_object_put(arr);

    if (rc != 0) {
        resp->status_code = 500;
        resp->body = (char *)"{\"error\":\"failed to write islands.json\"}";
        resp->body_length = 40;
        resp->content_type = "application/json";
        return -1;
    }

    int len = snprintf(reposition_resp_buf, sizeof(reposition_resp_buf),
                       "{\"ok\":true,\"updated\":%d}", updates);
    resp->status_code = 200;
    resp->content_type = "application/json";
    resp->body = reposition_resp_buf;
    resp->body_length = (size_t)len;
    return 0;
}

/* ── Island positions API (world editor full-save) ──────────────────────── */
int admin_api_save_island_positions(struct HttpResponse *resp, const char *body, size_t body_len) {
    static char save_ip_buf[256];
    const char *path = "data/islands/islands.json";

    json_object *root = json_tokener_parse(body);
    if (!root) {
        int len = snprintf(save_ip_buf, sizeof(save_ip_buf), "{\"error\":\"invalid JSON\"}");
        resp->status_code = 400;
        resp->content_type = "application/json";
        resp->body = save_ip_buf;
        resp->body_length = (size_t)len;
        return -1;
    }
    json_object_put(root);

    FILE *f = fopen(path, "w");
    if (!f) {
        int len = snprintf(save_ip_buf, sizeof(save_ip_buf), "{\"error\":\"cannot write %s\"}", path);
        resp->status_code = 500;
        resp->content_type = "application/json";
        resp->body = save_ip_buf;
        resp->body_length = (size_t)len;
        return -1;
    }
    fwrite(body, 1, body_len, f);
    fclose(f);

    int len = snprintf(save_ip_buf, sizeof(save_ip_buf), "{\"ok\":true}");
    resp->status_code = 200;
    resp->content_type = "application/json";
    resp->body = save_ip_buf;
    resp->body_length = (size_t)len;
    return 0;
}

