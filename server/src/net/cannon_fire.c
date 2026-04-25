#include <math.h>
#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#define _USE_MATH_DEFINES
#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif
#include "net/websocket_server_internal.h"
#include "net/cannon_fire.h"
#include "net/npc_agents.h"
#include "net/npc_world.h"
#include "net/module_interactions.h"
#include "net/dock_physics.h"
#include "sim/island.h"

int parse_json_uint32_array(const char* json, const char* key, uint32_t* out, int max_out) {
    // Build search pattern: "key":[
    char pattern[64];

    snprintf(pattern, sizeof(pattern), "\"%s\":[", key);
    const char* start = strstr(json, pattern);
    if (!start) return 0;
    start += strlen(pattern);
    int count = 0;
    while (count < max_out) {
        while (*start == ' ' || *start == '\t') start++;
        if (*start == ']' || *start == '\0') break;
        char* end;
        unsigned long val = strtoul(start, &end, 10);
        if (end == start) break; // no digits
        out[count++] = (uint32_t)val;
        start = end;
        while (*start == ' ' || *start == '\t') start++;
        if (*start == ',') start++;
    }
    return count;
}

/**
 * Configure a weapon control group on the ship.
 * Called when a client sends "cannon_group_config".  The group is stored per-ship
 * so all players on the same ship share authoritative group state.
 *
 * Enforces:
 *  - cannon IDs must be real cannon modules on this ship (invalid IDs stripped)
 *  - exclusive ownership: each cannon can only belong to one group at a time
 *    (cannon is removed from any other group before being added here)
 */
void handle_cannon_group_config(WebSocketPlayer* player, int group_index,
                                       WeaponGroupMode mode, module_id_t* weapon_ids,
                                       int weapon_count, uint16_t target_ship_id) {
    if (group_index < 0 || group_index >= MAX_WEAPON_GROUPS) return;
    if (player->parent_ship_id == 0) return;
    SimpleShip* ship = find_ship(player->parent_ship_id);
    if (!ship) return;

    /* Which company slot does this player write to?  Players of each company
     * maintain their own independent group config so enemy boarders cannot
     * read or corrupt the original crew's setup. */
    uint8_t cid = (player->company_id < MAX_COMPANIES) ? player->company_id : 0;

    /* ── Validate: strip any ID not belonging to a cannon or swivel on
     *    this ship.  Prevents clients from referencing foreign-ship weapons. ── */
    module_id_t valid_ids[MAX_WEAPONS_PER_GROUP];
    int         valid_count = 0;
    int      limit = (weapon_count > MAX_WEAPONS_PER_GROUP) ? MAX_WEAPONS_PER_GROUP : weapon_count;
    for (int i = 0; i < limit; i++) {
        ShipModule* mod = find_module_on_ship(ship, weapon_ids[i]);
        if (mod && (mod->type_id == MODULE_TYPE_CANNON || mod->type_id == MODULE_TYPE_SWIVEL)) {
            valid_ids[valid_count++] = weapon_ids[i];
        }
    }

    /* ── Exclusive ownership: remove each validated cannon from every other group
     *    so a cannon can never appear in two groups simultaneously. ── */
    for (int i = 0; i < valid_count; i++) {
        for (int g = 0; g < MAX_WEAPON_GROUPS; g++) {
            if (g == group_index) continue;
            WeaponGroup* other = &ship->weapon_groups[cid][g];
            for (int c = 0; c < other->weapon_count; c++) {
                if (other->weapon_ids[c] == valid_ids[i]) {
                    /* Compact: overwrite with last entry */
                    other->weapon_ids[c] = other->weapon_ids[other->weapon_count - 1];
                    other->weapon_count--;
                    break;
                }
            }
        }
    }

    WeaponGroup* group = &ship->weapon_groups[cid][group_index];
    group->mode         = mode;
    group->weapon_count = (uint8_t)valid_count;
    for (int i = 0; i < valid_count; i++) {
        group->weapon_ids[i] = valid_ids[i];
    }
    group->target_ship_id = (mode == WEAPON_GROUP_MODE_TARGETFIRE) ? target_ship_id : 0;

    /* For all modes, NPCs remain stationed at their assigned cannon.
     * Mode only controls what the NPC does while there (aim/fire guards
     * in tick_npc_agents enforce HALTFIRE / AIMING / etc. per tick).
     * Immediately ensure any unmanned group cannons get a crew member. */

    /* Clear MODULE_STATE_NEEDED on suppressed-mode cannons.
     * When the player reverts from AIMING to HALTFIRE or TARGETFIRE
     * (e.g. right-click released, or hotbar mode cycle), NEEDED bits that
     * were set by handle_cannon_aim while the group was AIMING would
     * otherwise linger and keep driving NPCs toward those cannons.
     * Also covers multi-group onAimEnd: each group sends its own config
     * message, and all need their NEEDED bits cleaned up. */
    if (mode == WEAPON_GROUP_MODE_HALTFIRE || mode == WEAPON_GROUP_MODE_TARGETFIRE) {
        for (int ci = 0; ci < group->weapon_count; ci++) {
            ShipModule* mod = find_module_on_ship(ship, group->weapon_ids[ci]);
            if (mod) mod->state_bits &= ~MODULE_STATE_NEEDED;
        }
    }

    /* NEEDED is set purely by the sector check in handle_cannon_aim Pass 1.
     * We do NOT set NEEDED unconditionally here — that would cause all cannons
     * in the group to show NEED even when the aim angle only covers one side. */

    assign_weapon_group_crew(ship);

    /* When a group switches to AIMING, immediately re-evaluate NPC routing.
     * This covers the case where the player re-activates aiming at exactly the
     * same angle as before (delta = 0 → below the 3° gate in handle_cannon_aim),
     * so update_npc_cannon_sector would not fire from handle_cannon_aim.
     * Calling it here ensures any free NPCs are dispatched to the right side
     * as soon as the AIMING mode is applied, before the first aim message
     * arrives. */
    if (mode == WEAPON_GROUP_MODE_AIMING) {
        update_npc_cannon_sector(ship, ship->active_aim_angle);
    }

    log_info("🎯 Player %u group %d → mode=%d cannons=%d target=%u",
             player->player_id, group_index, mode, group->weapon_count, group->target_ship_id);

    /* Defer the broadcast: mark the sender's client slot as dirty so that all
     * group-config messages in one frame collapse into a single broadcast at
     * the end of this connection's message processing.  This prevents a burst
     * of rapid config messages (e.g. switching two groups to AIMING at once)
     * from echoing an intermediate state back to the sender before all groups
     * have been updated on the server. */
    for (int ci = 0; ci < WS_MAX_CLIENTS; ci++) {
        struct WebSocketClient* c = &ws_server.clients[ci];
        if (c->connected && c->player_id == player->player_id) {
            c->pending_group_broadcast_ship_id    = ship->ship_id;
            c->pending_group_broadcast_company_id = cid;
            break;
        }
    }
}

/**
 * Per-tick update: for each player's TARGETFIRE weapon groups, auto-aim the
 * group's cannons toward the locked target ship using npc_aim_cannon_at_world().
 */

/**
 * Find the WeaponGroup that owns cannon_id on ship_id, from any active player.
 * Returns NULL if no weapon group claims this cannon.
 */
WeaponGroup* find_weapon_group(uint16_t ship_id, uint32_t cannon_id, uint8_t company_id) {
    SimpleShip* ship = find_ship(ship_id);
    if (!ship) return NULL;
    uint8_t cid = (company_id < MAX_COMPANIES) ? company_id : 0;
    for (int g = 0; g < MAX_WEAPON_GROUPS; g++) {
        WeaponGroup* grp = &ship->weapon_groups[cid][g];
        for (int c = 0; c < grp->weapon_count; c++) {
            if (grp->weapon_ids[c] == cannon_id) return grp;
        }
    }
    return NULL;
}

void tick_ship_weapon_groups(void) {
    for (int si = 0; si < ship_count; si++) {
        SimpleShip* ship = &ships[si];
        if (!ship->active) continue;
        if (ship->is_sinking) continue; /* no auto-fire while sinking */

        for (int g = 0; g < MAX_WEAPON_GROUPS; g++) {
            WeaponGroup* group = &ship->weapon_groups[ship->company_id][g];
            if (group->mode != WEAPON_GROUP_MODE_TARGETFIRE) continue;
            if (group->target_ship_id == 0 || group->weapon_count == 0) continue;

            SimpleShip* target = find_ship(group->target_ship_id);
            if (!target || !target->active) continue;

            for (int c = 0; c < group->weapon_count; c++) {
                ShipModule* cannon = find_module_on_ship(ship, group->weapon_ids[c]);
                if (!cannon || cannon->type_id != MODULE_TYPE_CANNON) continue;
                npc_aim_cannon_at_world(ship, cannon, target->x, target->y);
            }
        }
    }
}

/**
 * Handle cannon aim from player
 * Updates player's aim angle and cannon aim_direction for all cannons within range
 */
void handle_cannon_aim(WebSocketPlayer* player, float aim_angle,
                              uint32_t* active_group_indices, int active_group_count) {
    if (player->parent_ship_id == 0) {
        return; // Player not on a ship
    }

    // Only helm-mounted or cannon-mounted players may aim cannons.
    bool at_helm   = player->is_mounted &&
                     (find_ship(player->parent_ship_id) != NULL) &&
                     ({  ShipModule* _m = find_module_by_id(find_ship(player->parent_ship_id), player->mounted_module_id);
                         _m && (_m->type_id == MODULE_TYPE_HELM || _m->type_id == MODULE_TYPE_STEERING_WHEEL); });
    bool at_cannon = player->is_mounted &&
                     (find_ship(player->parent_ship_id) != NULL) &&
                     ({  ShipModule* _m = find_module_by_id(find_ship(player->parent_ship_id), player->mounted_module_id);
                         _m && _m->type_id == MODULE_TYPE_CANNON; });

    if (!at_helm && !at_cannon) {
        return; // Not at a valid control station
    }

    // Client already sends a ship-relative angle (worldAngle - shipRotation)
    player->cannon_aim_angle = aim_angle;

    SimpleShip* ship = find_ship(player->parent_ship_id);
    if (!ship) return;

    // Use directly — do NOT subtract ship->rotation again (client already did so)
    player->cannon_aim_angle_relative = aim_angle;

    // Normalize to -PI to +PI range
    while (player->cannon_aim_angle_relative > M_PI) player->cannon_aim_angle_relative -= 2.0f * M_PI;
    while (player->cannon_aim_angle_relative < -M_PI) player->cannon_aim_angle_relative += 2.0f * M_PI;

    /* Update cannon priority dispatch on any meaningful aim change (>3°).
     * We record the delta here but defer the actual update_npc_cannon_sector
     * call until AFTER Pass 1 (NEEDED flags) and Pass 3 (NPC dismissal) so
     * that the dispatcher sees the freshly computed flags and freed NPCs. */
    bool do_sector_update = false;
    {
        float prev = ship->active_aim_angle;
        ship->active_aim_angle = player->cannon_aim_angle_relative;
        float delta = ship->active_aim_angle - prev;
        while (delta >  (float)M_PI) delta -= 2.0f * (float)M_PI;
        while (delta < -(float)M_PI) delta += 2.0f * (float)M_PI;
        if (fabsf(delta) > (3.0f * (float)M_PI / 180.0f)) {
            do_sector_update = true;
        }
    }

    // Update cannon aim_direction for all cannons within ±30° range
    const float CANNON_AIM_RANGE = 30.0f * (M_PI / 180.0f); // ±30 degrees

    // Get simulation ship to update cannon modules
    struct Ship* sim_ship = find_sim_ship(ship->ship_id);
    if (!sim_ship) return;

    // Update cannon(s) depending on how the player is mounted:
    //   - helm → update all cannons (broadside targeting)
    //   - cannon mount → update only the mounted cannon
    
    /* ── Determine whether this player has ANY weapon groups configured ──────
     * If at least one group has cannons assigned, we enter "group mode":
     * only cannons that are explicitly listed in an AIMING or FREEFIRE group
     * for this player will receive aim updates.  Cannons in other groups, or
     * ungrouped cannons, are completely ignored while group mode is active.
     *
     * If no groups have any cannons at all, fall back to the legacy path
     * (all occupied cannons in arc receive aim updates).
     * ────────────────────────────────────────────────────────────────────── */
    bool player_has_groups = false;
    for (int g = 0; g < MAX_WEAPON_GROUPS; g++) {
        if (ship->weapon_groups[player->company_id][g].weapon_count > 0) {
            player_has_groups = true;
            break;
        }
    }

    for (uint8_t m = 0; m < sim_ship->module_count; m++) {
        if (sim_ship->modules[m].type_id != MODULE_TYPE_CANNON) continue;

        ShipModule* cannon = &sim_ship->modules[m];

        /* Resolve weapon group membership once for this cannon */
        WeaponGroup* grp = find_weapon_group(ship->ship_id, cannon->id, player->company_id);

        /* ── Pass 1: MODULE_STATE_NEEDED update (SET-ONLY / sticky) ───────────
         *
         * NEEDED is a sticky flag: once set it stays on until the timeout
         * expires (tick_cannon_needed_expiry clears it after
         * CANNON_NEEDED_TIMEOUT_MS of inactivity).  This pass only SETS
         * the flag and refreshes the cannon_last_needed_ms timestamp.
         * It never clears NEEDED — that is exclusively the tick's job.
         *
         * This eliminates the old bug where moving the cursor away from a
         * group's sector instantly cleared NEEDED and dismissed all NPCs.
         * ──────────────────────────────────────────────────────────────────── */
        {
            bool do_needed_update;
            if (!grp) {
                if (player_has_groups) {
                    /* Ungrouped cannon in group mode — do not touch NEEDED */
                }
                /* Legacy (no groups at all): sector-based staffing applies */
                do_needed_update = !player_has_groups;
            } else {
                bool in_active = false;
                for (int ag = 0; ag < active_group_count && !in_active; ag++) {
                    uint32_t tg = active_group_indices[ag];
                    if (tg >= MAX_WEAPON_GROUPS) continue;
                    WeaponGroup* chk = &ship->weapon_groups[player->company_id][tg];
                    for (int ci = 0; ci < chk->weapon_count && !in_active; ci++) {
                        if (chk->weapon_ids[ci] == cannon->id) in_active = true;
                    }
                }
                if (active_group_count == 0) {
                    in_active = (grp->mode == WEAPON_GROUP_MODE_AIMING);
                }
                do_needed_update = in_active;
            }

            if (do_needed_update) {
                /* NEEDED is set only when the aim angle is within the cannon's
                 * lateral limits (±CANNON_AIM_RANGE from its fire direction).
                 * This applies to ALL cannons — grouped or ungrouped.
                 * NEEDED is sticky: once set it stays for CANNON_NEEDED_TIMEOUT_MS
                 * after the last in-sector aim or fire event.
                 *
                 * NEEDED controls NPC dispatch only — it does NOT gate aim
                 * propagation (Pass 2 handles that separately).  This keeps
                 * NPC movement efficient: crew only walks to cannons the
                 * player is actually pointing at. */
                float fire_dir = Q16_TO_FLOAT(cannon->local_rot) - (float)(M_PI / 2.0f);
                float diff = aim_angle - fire_dir;
                while (diff >  (float)M_PI) diff -= 2.0f * (float)M_PI;
                while (diff < -(float)M_PI) diff += 2.0f * (float)M_PI;
                bool in_sector = fabsf(diff) <= CANNON_AIM_RANGE;

                if (in_sector) {
                    ShipModule* smod = find_module_on_ship(ship, cannon->id);
                    if (smod) {
                        smod->state_bits |= MODULE_STATE_NEEDED;
                        uint32_t now = get_time_ms();
                        for (int mi = 0; mi < ship->module_count; mi++) {
                            if (ship->modules[mi].id == cannon->id) {
                                ship->cannon_last_needed_ms[mi] = now;
                                break;
                            }
                        }
                    }
                }
                /* NOTE: we intentionally do NOT clear NEEDED when out of sector.
                 * tick_cannon_needed_expiry handles expiry after the timeout. */
            }
        }

        /* ── Pass 2: Aim-direction propagation (with all original gates) ────
         *
         * Now apply the at_cannon and group-mode filters that restrict which
         * cannons physically track the cursor.
         * ──────────────────────────────────────────────────────────────────── */

        // If mounted to a specific cannon, propagate aim only to that cannon
        if (at_cannon && cannon->id != player->mounted_module_id) {
            log_info("🔫 P2 c%u: SKIP at_cannon gate (mounted=%u)", cannon->id, player->mounted_module_id);
            continue;
        }

        /* ── Weapon-group aim priority ──────────────────────────────────────
         * AIMING     → player aim IS the authority for this cannon; propagate.
         * FREEFIRE   → player can steer the aim; propagate.
         * HALTFIRE   → suppressed; never track the player's cursor.
         * TARGETFIRE → auto-aim owns it; skip here to avoid fighting it.
         * Not in any group (no_group):
         *   - If player_has_groups → cannon is outside all groups; skip it.
         *   - If !player_has_groups → legacy path; propagate normally.
         * ──────────────────────────────────────────────────────────────────── */
        bool in_active_pass2 = false;
        if (grp) {
            /* If this cannon's group is in the active list from the aim
             * message, allow aim propagation regardless of stored mode
             * (fixes race between cannon_group_config and cannon_aim). */
            for (int ag = 0; ag < active_group_count && !in_active_pass2; ag++) {
                uint32_t tg = active_group_indices[ag];
                if (tg >= MAX_WEAPON_GROUPS) continue;
                WeaponGroup* chk = &ship->weapon_groups[player->company_id][tg];
                for (int ci = 0; ci < chk->weapon_count && !in_active_pass2; ci++) {
                    if (chk->weapon_ids[ci] == cannon->id) in_active_pass2 = true;
                }
            }
            if (!in_active_pass2) {
                if (grp->mode == WEAPON_GROUP_MODE_HALTFIRE) {
                    log_info("🔫 P2 c%u: SKIP haltfire (not in active list)", cannon->id);
                    continue;
                }
                if (grp->mode == WEAPON_GROUP_MODE_TARGETFIRE) {
                    log_info("🔫 P2 c%u: SKIP targetfire (not in active list)", cannon->id);
                    continue;
                }
            }
        } else if (player_has_groups) {
            log_info("🔫 P2 c%u: SKIP ungrouped cannon in group mode", cannon->id);
            continue; /* ungrouped cannon in group mode — already handled in pass 1 */
        }

        // Only move a cannon if it is occupied (player mounted or WorldNpc AT_GUN).
        // Cannons cannot aim without crew present.
        bool cannon_has_occupant = (cannon->state_bits & MODULE_STATE_OCCUPIED) != 0;
        if (!cannon_has_occupant) {
            for (int ni = 0; ni < world_npc_count; ni++) {
                WorldNpc* wnpc = &world_npcs[ni];
                if (wnpc->active && wnpc->role == NPC_ROLE_GUNNER &&
                    wnpc->ship_id == ship->ship_id &&
                    wnpc->assigned_weapon_id == cannon->id &&
                    wnpc->state == WORLD_NPC_STATE_AT_GUN) {
                    cannon_has_occupant = true;
                    break;
                }
            }
        }
        if (!cannon_has_occupant) {
            /* Find NPC state for diagnostics */
            int npc_state = -1; uint32_t npc_assigned = 0;
            for (int ni = 0; ni < world_npc_count; ni++) {
                WorldNpc* wnpc = &world_npcs[ni];
                if (wnpc->active && wnpc->role == NPC_ROLE_GUNNER &&
                    wnpc->ship_id == ship->ship_id &&
                    wnpc->assigned_weapon_id == cannon->id) {
                    npc_state = wnpc->state;
                    npc_assigned = wnpc->id;
                    break;
                }
            }
            int grp_idx = -1;
            if (grp) { for (int gg = 0; gg < MAX_WEAPON_GROUPS; gg++) { if (&ship->weapon_groups[player->company_id][gg] == grp) { grp_idx = gg; break; } } }
            log_info("🔫 P2 c%u g%d: SKIP no_occupant (sim_occ=%d npc_id=%u npc_state=%d in_active=%d)",
                     cannon->id, grp_idx,
                     (cannon->state_bits & MODULE_STATE_OCCUPIED) ? 1 : 0,
                     npc_assigned, npc_state, in_active_pass2 ? 1 : 0);
            continue;
        }

        /* Skip cannons the player has placed in a haltfire group — they should not track the cursor.
         * BUT: if in_active_pass2 is set, the client's aim message explicitly lists this cannon's
         * group as active.  This overrides the stored mode to handle the race where the aim
         * message arrives before the cannon_group_config that switches the group to AIMING. */
        if (!in_active_pass2) {
            bool in_haltfire = false;
            for (int g = 0; g < MAX_WEAPON_GROUPS && !in_haltfire; g++) {
                WeaponGroup* wg = &ship->weapon_groups[player->company_id][g];
                if (wg->mode != WEAPON_GROUP_MODE_HALTFIRE) continue;
                for (int ci = 0; ci < wg->weapon_count; ci++) {
                    if (wg->weapon_ids[ci] == cannon->id) { in_haltfire = true; break; }
                }
            }
            if (in_haltfire) {
                log_info("🔫 P2 c%u: SKIP in_haltfire check", cannon->id);
                continue;
            }
        }

        {
            int grp_idx = -1;
            if (grp) { for (int gg = 0; gg < MAX_WEAPON_GROUPS; gg++) { if (&ship->weapon_groups[player->company_id][gg] == grp) { grp_idx = gg; break; } } }
            log_info("🔫 P2 c%u g%d: AIM PROPAGATED (in_active=%d mode=%d)",
                     cannon->id, grp_idx, in_active_pass2 ? 1 : 0, grp ? grp->mode : -1);
        }

        float cannon_base_angle = Q16_TO_FLOAT(cannon->local_rot);

        // Calculate desired aim offset.
        // cannon_base_angle is in rendering convention; add PI/2 to shift into physics convention
        // so that aim_direction=0 means the cannon fires along its natural barrel direction.
        float desired_offset = player->cannon_aim_angle_relative - cannon_base_angle + (float)(M_PI / 2.0);

        // Normalize
        while (desired_offset > M_PI) desired_offset -= 2.0f * M_PI;
        while (desired_offset < -M_PI) desired_offset += 2.0f * M_PI;

        // Three zones:
        //  ≤ ±30°           — track normally
        //  ±30° to ±45°     — clamp to arc limit so cannon stays at its lateral edge
        //  > ±45°           — reset to neutral (cursor is clearly pointing away)
        const float CANNON_AIM_RESET_MARGIN = 15.0f * ((float)M_PI / 180.0f);
        if (fabsf(desired_offset) > CANNON_AIM_RANGE + CANNON_AIM_RESET_MARGIN) {
            desired_offset = 0.0f; // Past grace zone — return to neutral
        } else if (fabsf(desired_offset) > CANNON_AIM_RANGE) {
            desired_offset = (desired_offset > 0.0f) ? CANNON_AIM_RANGE : -CANNON_AIM_RANGE;
        }

        // Update cannon's aim_direction
        cannon->data.cannon.desired_aim_direction = Q16_FROM_FLOAT(desired_offset);

        // Also update simple ship for sync
        for (int i = 0; i < ship->module_count; i++) {
            if (ship->modules[i].id == cannon->id) {
                ship->modules[i].data.cannon.desired_aim_direction = Q16_FROM_FLOAT(desired_offset);
                break;
            }
        }
    }

    /* ── After Pass 1 set sticky NEEDED flags and Pass 2 propagated aim,
     * dispatch any free NPCs to NEEDED cannons.  The tick also does this
     * every frame, but running it here gives immediate responsiveness when
     * the player first aims into a new sector. */

    /* Diagnostic: log NEEDED status of all cannons after Pass 1 */
    {
        char nbuf[256]; int npos = 0;
        for (int dm = 0; dm < ship->module_count && npos < 240; dm++) {
            ShipModule* dm_mod = &ship->modules[dm];
            if (dm_mod->type_id != MODULE_TYPE_CANNON) continue;
            int needed = (dm_mod->state_bits & MODULE_STATE_NEEDED) ? 1 : 0;
            WeaponGroup* dg = find_weapon_group(ship->ship_id, dm_mod->id, player->company_id);
            int gi = -1;
            if (dg) { for (int gg = 0; gg < MAX_WEAPON_GROUPS; gg++) { if (&ship->weapon_groups[player->company_id][gg] == dg) { gi = gg; break; } } }
            npos += snprintf(nbuf + npos, (size_t)(256 - npos), " c%u:g%d:%s",
                             dm_mod->id, gi, needed ? "NEED" : "----");
        }
        log_info("📊 Ship %u NEEDED map:%s", ship->ship_id, nbuf);
    }

    /* ── Swivel pass: NEEDED + aim-propagation (mirrors cannon logic above) ─────
     * Pass 1 — set MODULE_STATE_NEEDED when the aim angle is within the swivel's
     *          ±45° arc and the swivel is in an active AIMING group (or ungrouped
     *          when player_has_groups is false).
     * Pass 2 — propagate desired_aim_direction from the helm so NPC-manned swivels
     *          track the player cursor.  Only applies when at_helm; swivel-mounted
     *          players already receive direct aim updates via handle_swivel_aim. ── */
    for (uint8_t m = 0; m < sim_ship->module_count; m++) {
        ShipModule* sw = &sim_ship->modules[m];
        if (sw->type_id != MODULE_TYPE_SWIVEL) continue;

        WeaponGroup* grp = find_weapon_group(ship->ship_id, sw->id, player->company_id);

        /* ── Swivel Pass 1: NEEDED ─────────────────────────────────────────── */
        {
            bool do_needed_update;
            if (!grp) {
                do_needed_update = !player_has_groups;
            } else {
                bool in_active = false;
                for (int ag = 0; ag < active_group_count && !in_active; ag++) {
                    uint32_t tg = active_group_indices[ag];
                    if (tg >= MAX_WEAPON_GROUPS) continue;
                    WeaponGroup* chk = &ship->weapon_groups[player->company_id][tg];
                    for (int ci = 0; ci < chk->weapon_count && !in_active; ci++) {
                        if (chk->weapon_ids[ci] == sw->id) in_active = true;
                    }
                }
                if (active_group_count == 0)
                    in_active = (grp->mode == WEAPON_GROUP_MODE_AIMING);
                do_needed_update = in_active;
            }
            if (do_needed_update) {
                const float SWIVEL_NEEDED_RANGE = 45.0f * ((float)M_PI / 180.0f);
                float fire_dir = Q16_TO_FLOAT(sw->local_rot) - (float)(M_PI / 2.0f);
                float diff = aim_angle - fire_dir;
                while (diff >  (float)M_PI) diff -= 2.0f * (float)M_PI;
                while (diff < -(float)M_PI) diff += 2.0f * (float)M_PI;
                if (fabsf(diff) <= SWIVEL_NEEDED_RANGE) {
                    ShipModule* ssw = find_module_on_ship(ship, sw->id);
                    if (ssw) {
                        ssw->state_bits |= MODULE_STATE_NEEDED;
                        uint32_t now = get_time_ms();
                        for (int mi = 0; mi < ship->module_count; mi++) {
                            if (ship->modules[mi].id == sw->id) {
                                ship->cannon_last_needed_ms[mi] = now;
                                break;
                            }
                        }
                    }
                }
            }
        }

        /* ── Swivel Pass 2: aim propagation (helm only) ────────────────────── */
        if (at_cannon) continue; /* player on specific cannon — skip swivels */

        /* Group-mode filter */
        if (grp) {
            if (grp->mode == WEAPON_GROUP_MODE_HALTFIRE)   continue; /* suppressed */
            if (grp->mode == WEAPON_GROUP_MODE_TARGETFIRE) continue; /* auto-aim owns it */
            bool sw_in_active = false;
            for (int ag = 0; ag < active_group_count && !sw_in_active; ag++) {
                uint32_t tg = active_group_indices[ag];
                if (tg >= MAX_WEAPON_GROUPS) continue;
                WeaponGroup* chk = &ship->weapon_groups[player->company_id][tg];
                for (int ci = 0; ci < chk->weapon_count && !sw_in_active; ci++) {
                    if (chk->weapon_ids[ci] == sw->id) sw_in_active = true;
                }
            }
            if (active_group_count == 0)
                sw_in_active = (grp->mode == WEAPON_GROUP_MODE_AIMING ||
                                grp->mode == WEAPON_GROUP_MODE_FREEFIRE);
            if (!sw_in_active) continue;
        } else if (player_has_groups) {
            continue; /* ungrouped swivel in group mode */
        }

        /* Only aim a swivel when a crew member is physically present at the station
         * (same gate as the cannon Pass 2 occupant check above).
         * A WorldNpc in WORLD_NPC_STATE_AT_GUN counts as present. */
        {
            bool swivel_has_occupant = false;
            for (int ni = 0; ni < world_npc_count; ni++) {
                WorldNpc* wnpc = &world_npcs[ni];
                if (wnpc->active && wnpc->role == NPC_ROLE_GUNNER &&
                    wnpc->ship_id == ship->ship_id &&
                    wnpc->assigned_weapon_id == sw->id &&
                    wnpc->state == WORLD_NPC_STATE_AT_GUN) {
                    swivel_has_occupant = true;
                    break;
                }
            }
            if (!swivel_has_occupant) continue;
        }

        /* Propagate helm aim angle onto swivel desired_aim_direction.
         * Uses the same offset convention as handle_swivel_aim. */
        float sw_base     = Q16_TO_FLOAT(sw->local_rot);
        float desired_off = aim_angle - sw_base + (float)(M_PI / 2.0f);
        while (desired_off >  (float)M_PI) desired_off -= 2.0f * (float)M_PI;
        while (desired_off < -(float)M_PI) desired_off += 2.0f * (float)M_PI;
        const float SWIVEL_AIM_LIMIT = 45.0f * ((float)M_PI / 180.0f);
        if (desired_off >  SWIVEL_AIM_LIMIT) desired_off =  SWIVEL_AIM_LIMIT;
        if (desired_off < -SWIVEL_AIM_LIMIT) desired_off = -SWIVEL_AIM_LIMIT;
        sw->data.swivel.desired_aim_direction = Q16_FROM_FLOAT(desired_off);
        ShipModule* ssw = find_module_on_ship(ship, sw->id);
        if (ssw) ssw->data.swivel.desired_aim_direction = Q16_FROM_FLOAT(desired_off);
    }

    if (do_sector_update) {
        update_npc_cannon_sector(ship, ship->active_aim_angle);
    }
}

/* Forward declaration */
static void broadcast_cannon_fire(uint32_t cannon_id, uint16_t ship_id, float world_x, float world_y,
                                  float angle, entity_id projectile_id, uint8_t ammo_type);

/**
 * Fire a single cannon, spawning projectile
 */
void fire_cannon(SimpleShip* ship, ShipModule* cannon, WebSocketPlayer* player, bool manually_fired, uint8_t ammo_type) {
    // Consume ship-level ammo (unless infinite ammo mode is on)
    if (!ship->infinite_ammo) {
        if (ship->cannon_ammo == 0) return; // No ammo — should have been caught earlier
        ship->cannon_ammo--;
    }
    cannon->data.cannon.time_since_fire = 0;
    cannon->state_bits |= MODULE_STATE_RELOADING;
    cannon->state_bits &= ~MODULE_STATE_FIRING;
    /* Record wall-clock fire time on the SimpleShip copy (lookup by ID — cannon
     * may point into sim_ship->modules which is a different array).
     * Also refresh cannon_last_needed_ms so the NPC stays during the full
     * reload cycle + CANNON_NEEDED_TIMEOUT_MS grace period. */
    {
        uint32_t now = get_time_ms();
        for (int _fi = 0; _fi < ship->module_count; _fi++) {
            if (ship->modules[_fi].id == cannon->id) {
                ship->cannon_last_fire_ms[_fi] = now;
                ship->cannon_last_needed_ms[_fi] = now;
                ship->modules[_fi].state_bits |= MODULE_STATE_NEEDED;
                break;
            }
        }
    }
    
    // Calculate cannon world position (ship transform + cannon local position)
    // NOTE: ship->x/y are in CLIENT PIXELS, cannon->local_pos is in SERVER UNITS (Q16)
    float cos_rot = cosf(ship->rotation);
    float sin_rot = sinf(ship->rotation);
    
    // Convert cannon local position from server units to client pixels
    float cannon_local_x = SERVER_TO_CLIENT(Q16_TO_FLOAT(cannon->local_pos.x));
    float cannon_local_y = SERVER_TO_CLIENT(Q16_TO_FLOAT(cannon->local_pos.y));
    
    // Transform to world space (in client pixels)
    float cannon_world_x = ship->x + (cannon_local_x * cos_rot - cannon_local_y * sin_rot);
    float cannon_world_y = ship->y + (cannon_local_x * sin_rot + cannon_local_y * cos_rot);
    
    // Calculate projectile direction.
    // cannon->local_rot is stored in "rendering convention" (0 = barrel faces -Y/up, rotated from there).
    // cos/sin physics use "math convention" (0 = +X/right).
    // Converting: physics_angle = rendering_angle - PI/2
    float cannon_local_rot = Q16_TO_FLOAT(cannon->local_rot);
    float aim_offset = Q16_TO_FLOAT(cannon->data.cannon.aim_direction);
    float projectile_angle = ship->rotation + (cannon_local_rot - (float)(M_PI / 2.0)) + aim_offset;
    
    // Spawn projectile at the end of the cannon barrel (outside the ship)
    // All positions in CLIENT PIXELS at this point
    const float BARREL_LENGTH = 30.0f; // 30 pixels barrel extension
    float barrel_offset_x = cosf(projectile_angle) * BARREL_LENGTH;
    float barrel_offset_y = sinf(projectile_angle) * BARREL_LENGTH;
    
    float spawn_x = cannon_world_x + barrel_offset_x;
    float spawn_y = cannon_world_y + barrel_offset_y;
    
    // Cannonball base speed (server units/s)
    const float CANNONBALL_SPEED = CLIENT_TO_SERVER(500.0f);
    
    // ship->velocity_x/y is stored in client pixels/s — convert to server units/s before adding
    float ship_vx = CLIENT_TO_SERVER(ship->velocity_x);
    float ship_vy = CLIENT_TO_SERVER(ship->velocity_y);
    
    // Calculate projectile velocity (inherit ship velocity + cannon muzzle velocity)
    float projectile_vx = cosf(projectile_angle) * CANNONBALL_SPEED + ship_vx;
    float projectile_vy = sinf(projectile_angle) * CANNONBALL_SPEED + ship_vy;
    
    // Determine owner for projectile tracking (player can be NULL for NPC-fired cannons)
    uint32_t owner_id = (manually_fired && player != NULL) ? player->player_id : ship->ship_id;
    
    // Spawn projectile in simulation (convert from client pixels to server units)
    if (global_sim) {
        Vec2Q16 proj_pos = {
            Q16_FROM_FLOAT(CLIENT_TO_SERVER(spawn_x)),
            Q16_FROM_FLOAT(CLIENT_TO_SERVER(spawn_y))
        };
        Vec2Q16 proj_vel = {
            Q16_FROM_FLOAT(projectile_vx),
            Q16_FROM_FLOAT(projectile_vy)
        };
        
        // log_info("🎯 Before spawn: projectile_count=%u, max=%d", global_sim->projectile_count, MAX_PROJECTILES);
        
        entity_id projectile_id = sim_create_projectile(global_sim, proj_pos, proj_vel, owner_id, ammo_type);
        
        // Stamp the firing ship's company and ship-id so the sim can skip friendly-fire
        // collisions and award XP correctly.
        if (projectile_id != INVALID_ENTITY_ID) {
            struct Projectile* proj = sim_get_projectile(global_sim, projectile_id);
            if (proj) {
                proj->firing_company = ship->company_id;
                proj->firing_ship_id = (entity_id)ship->ship_id;
                proj->type = ammo_type;
                // Cannonball and bar shot: 5-second lifetime (then water splash on client)
                if (ammo_type == PROJ_TYPE_CANNONBALL || ammo_type == PROJ_TYPE_BAR_SHOT) {
                    proj->lifetime = Q16_FROM_FLOAT(5.0f);
                }
                // Apply the firing ship's Damage level multiplier
                struct Ship* sim_ship = sim_get_ship(global_sim, (entity_id)ship->ship_id);
                if (sim_ship) {
                    float dmg_mult = ship_level_damage_mult(&sim_ship->level_stats);
                    proj->damage = Q16_FROM_FLOAT(Q16_TO_FLOAT(proj->damage) * dmg_mult);
                }
            }
        }
        
        // log_info("🎯 After spawn: projectile_count=%u, projectile_id=%u", global_sim->projectile_count, projectile_id);
        
        if (projectile_id != INVALID_ENTITY_ID) {
            // log_info("💥 Cannon %u fired! ship_pos=(%.1f,%.1f) cannon_pos=(%.1f,%.1f) projectile_id=%u spawn_pos=(%.1f,%.1f) angle=%.2f° vel=(%.1f,%.1f) owner=%u manual=%s",
            //          cannon->id,
            //          ship->x, ship->y,
            //          cannon_world_x, cannon_world_y,
            //          projectile_id,
            //          spawn_x, spawn_y,
            //          projectile_angle * (180.0f / M_PI),
            //          SERVER_TO_CLIENT(projectile_vx), SERVER_TO_CLIENT(projectile_vy),
            //          owner_id, manually_fired ? "yes" : "no");
            
            // Broadcast cannon fire event to all clients (use cannon position for visual effect)
            broadcast_cannon_fire(cannon->id, ship->ship_id, cannon_world_x, cannon_world_y, 
                                projectile_angle, projectile_id, ammo_type);
        } else {
            log_warn("Failed to spawn projectile for cannon %u (max projectiles reached)", cannon->id);
        }
    } else {
        log_error("❌ Cannot spawn projectile - global_sim is NULL!");
    }
}

/**
 * Broadcast cannon fire event to all connected clients
 */

/* ══════════════════════════════════════════════════════════════════════════
 * Flamethrower wave state
 *
 * Instead of spawning projectiles, the flamethrower maintains a per-swivel
 * advancing "wave front".  Each server tick the front moves outward at
 * FLAME_WAVE_SPEED px/s and fire is applied to anything newly in range.
 * When the player releases (no fire pulse for > FLAME_STALE_MS), a retreat
 * front sweeps from barrel to tip at the same speed, driving the client
 * visual.  Fire DoT timers run naturally after the wave passes.
 * ══════════════════════════════════════════════════════════════════════════ */
#define MAX_FLAME_WAVES   16
#define FLAME_WAVE_SPEED  350.0f    /* px/s — fast travel-time feel           */
#define FLAME_RANGE       280.0f    /* max reach, client px                  */
#define FLAME_HALF_CONE   (15.0f * (float)(M_PI / 180.0f))  /* ±15°         */
#define FLAME_STALE_MS    250u      /* ms without a pulse → start retreating  */
#define FLAME_RETREAT_SPEED 700.0f  /* px/s — retreat 2× faster than advance */
/* FIRE_DURATION_MS now defined in cannon_fire.h */
#define FLAME_HALF_CONE_MODULE (25.0f * (float)(M_PI / 180.0f)) /* wider test vs ±15° entity cone */

typedef struct {
    bool     active;
    uint32_t swivel_id;
    uint16_t ship_id;
    float    origin_x, origin_y;
    float    fire_angle;
    float    wave_dist;      /* leading wave front (px):  0 → FLAME_RANGE */
    bool     retreating;
    float    retreat_dist;   /* trailing edge during retreat (px) */
    uint32_t last_fire_ms;   /* wall-clock ms of last fire_swivel call */
} FlameWave;

static FlameWave  flame_waves[MAX_FLAME_WAVES];
static bool       flame_waves_initialized = false;

/** Broadcast a raw JSON string to every connected WebSocket client. */
void broadcast_json_all(const char* json) {
    char frame[1024];
    size_t flen = websocket_create_frame(WS_OPCODE_TEXT, json, strlen(json), frame, sizeof(frame));
    if (flen == 0) return;
    for (int i = 0; i < WS_MAX_CLIENTS; i++) {
        struct WebSocketClient* wc = &ws_server.clients[i];
        if (wc->connected && wc->handshake_complete)
            send(wc->fd, frame, flen, 0);
    }
}

static void broadcast_cannon_fire(uint32_t cannon_id, uint16_t ship_id, float world_x, float world_y, 
                                  float angle, entity_id projectile_id, uint8_t ammo_type) {
    char message[512];
    snprintf(message, sizeof(message),
            "{\"type\":\"CANNON_FIRE_EVENT\",\"cannonId\":%u,\"shipId\":%u,"
            "\"x\":%.1f,\"y\":%.1f,\"angle\":%.3f,\"projectileId\":%u,\"ammoType\":%u}",
            cannon_id, ship_id, world_x, world_y, angle, projectile_id, (unsigned)ammo_type);
    
    char frame[1024];
    size_t frame_len = websocket_create_frame(WS_OPCODE_TEXT, message, strlen(message), frame, sizeof(frame));
    
    if (frame_len > 0) {
        // Send to all connected clients
        for (int i = 0; i < WS_MAX_CLIENTS; i++) {
            struct WebSocketClient* client = &ws_server.clients[i];
            if (client->connected && client->handshake_complete) {
                send(client->fd, frame, frame_len, 0);
            }
        }
    }
}

/**
 * Broadcast authoritative weapon group state for ship to ALL connected clients.
 * Clients on other ships will ignore this message by checking shipId.
 */
void broadcast_cannon_group_state(SimpleShip* ship, uint8_t company_id) {
    if (!ship) return;
    uint8_t cid = (company_id < MAX_COMPANIES) ? company_id : 0;
    static const char* mode_names[] = { "aiming", "freefire", "haltfire", "targetfire" };
    char message[4096];
    int pos = snprintf(message, sizeof(message),
        "{\"type\":\"cannon_group_state\",\"shipId\":%u,\"groups\":[", ship->ship_id);
    for (int g = 0; g < MAX_WEAPON_GROUPS && pos < (int)sizeof(message) - 64; g++) {
        WeaponGroup* grp = &ship->weapon_groups[cid][g];
        const char* mode_str = (grp->mode < 4) ? mode_names[grp->mode] : "haltfire";
        pos += snprintf(message + pos, sizeof(message) - pos,
            "%s{\"index\":%d,\"mode\":\"%s\",\"cannonIds\":[",
            (g > 0 ? "," : ""), g, mode_str);
        for (int c = 0; c < grp->weapon_count && pos < (int)sizeof(message) - 32; c++) {
            pos += snprintf(message + pos, sizeof(message) - pos,
                "%s%u", (c > 0 ? "," : ""), grp->weapon_ids[c]);
        }
        pos += snprintf(message + pos, sizeof(message) - pos,
            "],\"targetShipId\":%u}", grp->target_ship_id);
    }
    if (pos < (int)sizeof(message) - 2)
        pos += snprintf(message + pos, sizeof(message) - pos, "]}");

    char frame[5120];
    size_t frame_len = websocket_create_frame(WS_OPCODE_TEXT, message, strlen(message), frame, sizeof(frame));
    if (frame_len > 0) {
        for (int i = 0; i < WS_MAX_CLIENTS; i++) {
            struct WebSocketClient* cl = &ws_server.clients[i];
            if (!cl->connected || !cl->handshake_complete) continue;
            /* Only send to players of the same company (or neutral) */
            WebSocketPlayer* p = find_player(cl->player_id);
            if (p && p->company_id != COMPANY_NEUTRAL && cid != COMPANY_NEUTRAL &&
                p->company_id != cid) continue;
            send(cl->fd, frame, frame_len, 0);
        }
    }
}

/**
 * Send authoritative weapon group state for ship to a single connected client.
 * Called after a player mounts to a helm/cannon or boards a ship so they
 * immediately have the current per-ship group configuration without waiting
 * for another player to trigger a broadcast.
 */
void send_cannon_group_state_to_client(struct WebSocketClient* client, SimpleShip* ship) {
    if (!client || !ship) return;
    if (!client->connected || !client->handshake_complete) return;
    /* Determine which company slot to show: look up the client's player. */
    WebSocketPlayer* pl = find_player(client->player_id);
    uint8_t cid = (pl && pl->company_id < MAX_COMPANIES) ? pl->company_id : 0;
    static const char* mode_names[] = { "aiming", "freefire", "haltfire", "targetfire" };
    char message[4096];
    int pos = snprintf(message, sizeof(message),
        "{\"type\":\"cannon_group_state\",\"shipId\":%u,\"groups\":[", ship->ship_id);
    for (int g = 0; g < MAX_WEAPON_GROUPS && pos < (int)sizeof(message) - 64; g++) {
        WeaponGroup* grp = &ship->weapon_groups[cid][g];
        const char* mode_str = (grp->mode < 4) ? mode_names[grp->mode] : "haltfire";
        pos += snprintf(message + pos, sizeof(message) - pos,
            "%s{\"index\":%d,\"mode\":\"%s\",\"cannonIds\":[",
            (g > 0 ? "," : ""), g, mode_str);
        for (int c = 0; c < grp->weapon_count && pos < (int)sizeof(message) - 32; c++) {
            pos += snprintf(message + pos, sizeof(message) - pos,
                "%s%u", (c > 0 ? "," : ""), grp->weapon_ids[c]);
        }
        pos += snprintf(message + pos, sizeof(message) - pos,
            "],\"targetShipId\":%u}", grp->target_ship_id);
    }
    if (pos < (int)sizeof(message) - 2)
        pos += snprintf(message + pos, sizeof(message) - pos, "]}");

    char frame[5120];
    size_t frame_len = websocket_create_frame(WS_OPCODE_TEXT, message, strlen(message), frame, sizeof(frame));
    if (frame_len > 0)
        send(client->fd, frame, frame_len, 0);
}

/**
 * Handle force-reload request from player.
 * Resets the reload timer on the player's manned cannon (or all nearest cannons
 * when at the helm) and marks them as RELOADING so they cannot fire immediately.
 * This lets a player discard the currently loaded round and reload a different ammo type.
 */
void handle_cannon_force_reload(WebSocketPlayer* player) {
    if (player->parent_ship_id == 0 || !player->is_mounted) return;

    SimpleShip* ship = find_ship(player->parent_ship_id);
    if (!ship) return;

    struct Ship* sim_ship = find_sim_ship(ship->ship_id);
    if (!sim_ship) return;

    ShipModule* mmod = find_module_by_id(ship, player->mounted_module_id);
    if (!mmod) return;

    bool at_cannon = (mmod->type_id == MODULE_TYPE_CANNON);
    bool at_helm   = (mmod->type_id == MODULE_TYPE_HELM ||
                      mmod->type_id == MODULE_TYPE_STEERING_WHEEL);

    if (!at_cannon && !at_helm) return;

    int reloaded = 0;
    for (uint8_t m = 0; m < sim_ship->module_count; m++) {
        ShipModule* module = &sim_ship->modules[m];
        if (module->type_id != MODULE_TYPE_CANNON) continue;

        /* For a cannon-mounted player only reset their specific cannon */
        if (at_cannon && module->id != mmod->id) continue;

        /* Reset reload timer and set RELOADING flag */
        module->data.cannon.time_since_fire = 0;
        module->state_bits |= MODULE_STATE_RELOADING;
        module->state_bits &= ~MODULE_STATE_FIRING;
        reloaded++;
    }

    log_info("⚡ Force-reload: player %u reset %d cannon(s) on ship %u",
             player->player_id, reloaded, ship->ship_id);
}

/**
 * Fire the swivel gun a player is currently mounted to.
 *
 * ammo_type PROJ_TYPE_GRAPESHOT    (10) → hit-scan, ±18° cone, 60 dmg/target
 * ammo_type PROJ_TYPE_LIQUID_FLAME (11) → flame wave projection
 * ammo_type PROJ_TYPE_CANISTER_SHOT(12) → 3 spread projectiles
 */
void fire_swivel(SimpleShip* ship, ShipModule* sw, ShipModule* gsw,
                        WebSocketPlayer* player, uint8_t ammo_type) {
    if (!global_sim) { log_error("Cannot fire swivel — global_sim is NULL"); return; }

    /* Reset reload on SimpleShip copy */
    sw->data.swivel.time_since_fire = 0;
    sw->data.swivel.loaded_ammo     = ammo_type;
    sw->state_bits |= MODULE_STATE_RELOADING;
    sw->state_bits &= ~MODULE_STATE_FIRING;

    /* Refresh crew-dispatch timestamps — same as fire_cannon() does for cannons.
     * Marks the swivel NEEDED and resets both fire and needed timestamps so the
     * NPC crew member stays at this swivel for the full reload + grace period. */
    {
        uint32_t now_sw = get_time_ms();
        for (int _sfi = 0; _sfi < ship->module_count; _sfi++) {
            if (ship->modules[_sfi].id == sw->id) {
                ship->cannon_last_fire_ms[_sfi]   = now_sw;
                ship->cannon_last_needed_ms[_sfi] = now_sw;
                ship->modules[_sfi].state_bits   |= MODULE_STATE_NEEDED;
                break;
            }
        }
    }

    /* Mirror state to global_sim copy */
    if (gsw) {
        gsw->data.swivel.time_since_fire = 0;
        gsw->data.swivel.loaded_ammo     = ammo_type;
        gsw->state_bits = sw->state_bits;
    }

    /* World position of the swivel pivot */
    float cos_r   = cosf(ship->rotation);
    float sin_r   = sinf(ship->rotation);
    float local_x = SERVER_TO_CLIENT(Q16_TO_FLOAT(sw->local_pos.x));
    float local_y = SERVER_TO_CLIENT(Q16_TO_FLOAT(sw->local_pos.y));
    float world_x = ship->x + (local_x * cos_r - local_y * sin_r);
    float world_y = ship->y + (local_x * sin_r + local_y * cos_r);

    /* Fire angle: same barrel convention as cannons (local_rot - PI/2 + aim_offset) */
    float sw_base    = Q16_TO_FLOAT(sw->local_rot);
    float aim_off    = Q16_TO_FLOAT(sw->data.swivel.aim_direction);
    float fire_angle = ship->rotation + (sw_base - (float)(M_PI / 2.0)) + aim_off;

    const float SWIVEL_SPEED = CLIENT_TO_SERVER(350.0f); /* px/s — slower than cannon's 500 */
    const float BARREL_LEN   = 22.0f;                    /* client pixels — matches visual barrel tip (fillRect 22px) */
    float ship_vx = CLIENT_TO_SERVER(ship->velocity_x);
    float ship_vy = CLIENT_TO_SERVER(ship->velocity_y);
    uint32_t owner_id = (player != NULL) ? player->player_id : ship->ship_id;

    if (ammo_type == PROJ_TYPE_GRAPESHOT) {
        /* Pure hit-scan anti-personnel burst — 3 rays at -12°, 0°, +12°.
         * No projectiles are spawned; modules are intentionally immune.
         * Range: 250 px, damage: 60 HP per pellet hit. */
        const float GRAPE_RANGE    = 250.0f;
        const float GRAPE_DAMAGE   = 60.0f;
        const float SPREAD_STEP    = 12.0f * (float)(M_PI / 180.0f);
        const int   NUM_PELLETS    = 3;

        /* Offset origin to barrel tip so tracers and hit-scan start from the muzzle */
        const float BARREL_LEN = 20.0f;
        float muzzle_x = world_x + cosf(fire_angle) * BARREL_LEN;
        float muzzle_y = world_y + sinf(fire_angle) * BARREL_LEN;

        /* Broadcast the visual shot event (reuses CANNON_FIRE format) so clients
         * show the muzzle flash / tracer for each ray. Use id=0 for projectile
         * since there is no real projectile entity. */
        for (int p = 0; p < NUM_PELLETS; p++) {
            float angle = fire_angle + SPREAD_STEP * (float)(p - 1);
            broadcast_cannon_fire(sw->id, ship->ship_id, muzzle_x, muzzle_y, angle, 0, PROJ_TYPE_GRAPESHOT);
        }

        /* Scan NPCs */
        for (int ni = 0; ni < world_npc_count; ni++) {
            WorldNpc* npc = &world_npcs[ni];
            if (!npc->active) continue;
            if (npc->ship_id == ship->ship_id) continue; /* friendly */
            float dx = npc->x - muzzle_x, dy = npc->y - muzzle_y;
            float dist = sqrtf(dx*dx + dy*dy);
            if (dist > GRAPE_RANGE) continue;
            if (dist < 0.01f) { dx = 1.0f; dy = 0.0f; dist = 1.0f; }
            float nx = dx / dist, ny = dy / dist;
            float fdir_x = cosf(fire_angle), fdir_y = sinf(fire_angle);
            /* Check if NPC falls within any of the 3 pellet rays (cone ±18°) */
            float half_cone = 18.0f * (float)(M_PI / 180.0f);
            float dot = nx * fdir_x + ny * fdir_y;
            if (dot < cosf(half_cone)) continue;
            uint16_t dmg = (uint16_t)GRAPE_DAMAGE;
            bool killed = false;
            if (npc->health <= dmg) { npc->health = 0; npc->active = false; killed = true; }
            else { npc->health -= dmg; }
            char hit_msg[256];
            snprintf(hit_msg, sizeof(hit_msg),
                "{\"type\":\"ENTITY_HIT\",\"entityType\":\"npc\",\"id\":%u,"
                "\"x\":%.1f,\"y\":%.1f,\"damage\":%.0f,"
                "\"health\":%u,\"maxHealth\":%u,\"killed\":%s}",
                npc->id, npc->x, npc->y, GRAPE_DAMAGE,
                (unsigned)npc->health, (unsigned)npc->max_health,
                killed ? "true" : "false");
            broadcast_json_all(hit_msg);
        }

        /* Scan players */
        for (int wpi = 0; wpi < WS_MAX_CLIENTS; wpi++) {
            WebSocketPlayer* wp = &players[wpi];
            if (!wp->active || wp->parent_ship_id == ship->ship_id) continue;
            float dx = wp->x - muzzle_x, dy = wp->y - muzzle_y;
            float dist = sqrtf(dx*dx + dy*dy);
            if (dist > GRAPE_RANGE) continue;
            if (dist < 0.01f) { dx = 1.0f; dy = 0.0f; dist = 1.0f; }
            float nx = dx / dist, ny = dy / dist;
            float fdir_x = cosf(fire_angle), fdir_y = sinf(fire_angle);
            float half_cone = 18.0f * (float)(M_PI / 180.0f);
            float dot = nx * fdir_x + ny * fdir_y;
            if (dot < cosf(half_cone)) continue;
            uint16_t dmg = (uint16_t)GRAPE_DAMAGE;
            if (wp->health <= dmg) wp->health = 0; else wp->health -= dmg;
            char hit_msg[256];
            snprintf(hit_msg, sizeof(hit_msg),
                "{\"type\":\"ENTITY_HIT\",\"entityType\":\"player\",\"id\":%u,"
                "\"x\":%.1f,\"y\":%.1f,\"damage\":%.0f,"
                "\"health\":%u,\"maxHealth\":%u,\"killed\":%s}",
                wp->player_id, wp->x, wp->y, GRAPE_DAMAGE,
                (unsigned)wp->health, (unsigned)wp->max_health,
                wp->health == 0 ? "true" : "false");
            broadcast_json_all(hit_msg);
        }

        log_info("Swivel %u fired GRAPESHOT (hit-scan) on ship %u", sw->id, ship->ship_id);
    } else if (ammo_type == PROJ_TYPE_LIQUID_FLAME) {
        /* ── Flamethrower wave: register / refresh this swivel's wave entry ──────
         * Hit application happens in update_flame_waves() each server tick so
         * that fire reaches distant targets progressively (travel-time feel). */
        {
        if (!flame_waves_initialized) {
            memset(flame_waves, 0, sizeof(flame_waves));
            flame_waves_initialized = true;
        }
        uint32_t now_fw = get_time_ms();
        /* Barrel-tip origin for the flame wave — matches visual and hit-scan */
        float flame_ox = world_x + cosf(fire_angle) * BARREL_LEN;
        float flame_oy = world_y + sinf(fire_angle) * BARREL_LEN;
        /* Find existing slot for this swivel */
        bool fw_handled = false;
        for (int fi = 0; fi < MAX_FLAME_WAVES; fi++) {
            if (!flame_waves[fi].active || flame_waves[fi].swivel_id != sw->id) continue;
            if (!flame_waves[fi].retreating) {
                /* Continuous hold — refresh heartbeat and aim; wave keeps advancing */
                flame_waves[fi].origin_x     = flame_ox;
                flame_waves[fi].origin_y     = flame_oy;
                flame_waves[fi].fire_angle   = fire_angle;
                flame_waves[fi].last_fire_ms = now_fw;
                fw_handled = true;
            } else {
                /* Was retreating — kill it; fall through to spawn a fresh wave */
                flame_waves[fi].active = false;
            }
            break;
        }
        if (!fw_handled) {
            /* Allocate a fresh slot (new fire or re-fire after retreat) */
            for (int fi = 0; fi < MAX_FLAME_WAVES; fi++) {
                if (flame_waves[fi].active) continue;
                FlameWave* fw = &flame_waves[fi];
                memset(fw, 0, sizeof(*fw));
                fw->active       = true;
                fw->swivel_id    = sw->id;
                fw->ship_id      = ship->ship_id;
                fw->wave_dist    = 0.0f;
                fw->retreat_dist = 0.0f;
                fw->retreating   = false;
                fw->origin_x     = flame_ox;
                fw->origin_y     = flame_oy;
                fw->fire_angle   = fire_angle;
                fw->last_fire_ms = now_fw;
                break;
            }
        }
        } /* end LIQUID_FLAME wave registration */
    } else if (ammo_type == PROJ_TYPE_CANISTER_SHOT) {
        /* 5 pellets spread ±20° — wide anti-personnel sweep */
        const int   NUM_PELLETS = 5;
        const float HALF_SPREAD = 20.0f * (float)(M_PI / 180.0f);
        for (int p = 0; p < NUM_PELLETS; p++) {
            float t     = (NUM_PELLETS > 1) ? (float)p / (float)(NUM_PELLETS - 1) : 0.5f;
            float angle = fire_angle + HALF_SPREAD * (2.0f * t - 1.0f);
            float sx = world_x + cosf(angle) * BARREL_LEN;
            float sy = world_y + sinf(angle) * BARREL_LEN;
            Vec2Q16 pos = { Q16_FROM_FLOAT(CLIENT_TO_SERVER(sx)),
                            Q16_FROM_FLOAT(CLIENT_TO_SERVER(sy)) };
            Vec2Q16 vel = { Q16_FROM_FLOAT(cosf(angle) * SWIVEL_SPEED + ship_vx),
                            Q16_FROM_FLOAT(sinf(angle) * SWIVEL_SPEED + ship_vy) };
            entity_id pid = sim_create_projectile(global_sim, pos, vel, owner_id, PROJ_TYPE_CANISTER_SHOT);
            if (pid != INVALID_ENTITY_ID) {
                struct Projectile* proj = sim_get_projectile(global_sim, pid);
                if (proj) {
                    proj->damage         = Q16_FROM_FLOAT(300.0f);
                    proj->lifetime       = Q16_FROM_FLOAT(1.2f);
                    proj->firing_company = ship->company_id;
                    proj->firing_ship_id = (entity_id)ship->ship_id;
                    proj->type           = PROJ_TYPE_CANISTER_SHOT;
                }
                broadcast_cannon_fire(sw->id, ship->ship_id, sx, sy, angle, pid, PROJ_TYPE_CANISTER_SHOT);
            }
        }
        log_info("Swivel %u fired CANISTER SHOT (5 pellets) on ship %u", sw->id, ship->ship_id);
    } else {
        /* Unknown/invalid ammo type: default to grapeshot */
        log_info("Swivel %u: unknown ammo_type %u, defaulting to grapeshot", sw->id, (unsigned)ammo_type);
        const float SPREAD_STEP = 12.0f * (float)(M_PI / 180.0f);
        for (int p = 0; p < 3; p++) {
            float angle = fire_angle + SPREAD_STEP * (float)(p - 1);
            float sx = world_x + cosf(angle) * BARREL_LEN;
            float sy = world_y + sinf(angle) * BARREL_LEN;
            Vec2Q16 pos = { Q16_FROM_FLOAT(CLIENT_TO_SERVER(sx)),
                            Q16_FROM_FLOAT(CLIENT_TO_SERVER(sy)) };
            Vec2Q16 vel = { Q16_FROM_FLOAT(cosf(angle) * SWIVEL_SPEED + ship_vx),
                            Q16_FROM_FLOAT(sinf(angle) * SWIVEL_SPEED + ship_vy) };
            entity_id pid = sim_create_projectile(global_sim, pos, vel, owner_id, PROJ_TYPE_GRAPESHOT);
            if (pid != INVALID_ENTITY_ID) {
                struct Projectile* proj = sim_get_projectile(global_sim, pid);
                if (proj) {
                    proj->damage         = Q16_FROM_FLOAT(450.0f);
                    proj->lifetime       = Q16_FROM_FLOAT(1.5f);
                    proj->firing_company = ship->company_id;
                    proj->firing_ship_id = (entity_id)ship->ship_id;
                    proj->type           = PROJ_TYPE_GRAPESHOT;
                }
                broadcast_cannon_fire(sw->id, ship->ship_id, world_x, world_y, angle, pid, PROJ_TYPE_GRAPESHOT);
            }
        }
    }
}

/**
 * Handle a fire_weapon request when the player is mounted to a swivel gun.
 */
static void handle_swivel_fire(WebSocketPlayer* player, uint8_t ammo_type) {
    if (!player->is_mounted || player->parent_ship_id == 0) return;
    SimpleShip* ship = find_ship(player->parent_ship_id);
    if (!ship || ship->is_sinking) return;

    /* Defense-in-depth: refuse fire if player company doesn't match ship company */
    if (ship->company_id != COMPANY_NEUTRAL &&
        player->company_id != COMPANY_NEUTRAL &&
        player->company_id != ship->company_id) return;

    /* SimpleShip module — reload timer ticks ships[] so check here */
    ShipModule* sw = find_module_by_id(ship, player->mounted_module_id);
    if (!sw || sw->type_id != MODULE_TYPE_SWIVEL) return;

    /* Also locate global_sim copy so fire_swivel can reset it */
    ShipModule* gsw = NULL;
    {
        struct Ship* _ss = find_sim_ship(ship->ship_id);
        if (_ss) {
            for (uint8_t mi = 0; mi < _ss->module_count; mi++) {
                if (_ss->modules[mi].id == sw->id) { gsw = &_ss->modules[mi]; break; }
            }
        }
    }

    /* Liquid flame uses a short per-shot interval; other ammo needs a full reload */
    uint32_t effective_cooldown = (ammo_type == PROJ_TYPE_LIQUID_FLAME)
                                  ? SWIVEL_FLAME_INTERVAL_MS
                                  : sw->data.swivel.reload_time;
    if (sw->data.swivel.time_since_fire < effective_cooldown) {
        return; /* still cooling down */
    }

    fire_swivel(ship, sw, gsw, player, ammo_type);
}

/**
 * Handle cannon fire from player.
 *
 * @param fire_all        True → broadside (fire every loaded cannon with crew).
 * @param ammo_type       PROJ_TYPE_CANNONBALL or PROJ_TYPE_BAR_SHOT.
 * @param explicit_ids    Non-NULL → fire only these cannon module IDs (weapon-group fire).
 * @param explicit_count  Length of explicit_ids array (0 when explicit_ids is NULL).
 * @param skip_aim_check  True → skip the aim-angle tolerance check (freefire / targetfire).
 */
void handle_cannon_fire(WebSocketPlayer* player, bool fire_all, uint8_t ammo_type,
                               module_id_t* explicit_ids, int explicit_count, bool skip_aim_check) {
    if (player->parent_ship_id == 0) {
        log_warn("Player %u tried to fire cannons while not on a ship", player->player_id);
        return;
    }

    // Determine what the player is currently mounted to
    SimpleShip* ship = find_ship(player->parent_ship_id);
    if (!ship) {
        log_warn("Player %u parent ship %u not found", player->player_id, player->parent_ship_id);
        return;
    }

    /* Prevent firing while ship is sinking */
    if (ship->is_sinking) return;

    bool at_helm = false;
    bool at_cannon = false;
    uint32_t mounted_cannon_id = 0;

    if (player->is_mounted) {
        ShipModule* mmod = find_module_by_id(ship, player->mounted_module_id);
        if (mmod) {
            if (mmod->type_id == MODULE_TYPE_HELM || mmod->type_id == MODULE_TYPE_STEERING_WHEEL) {
                at_helm = true;
            } else if (mmod->type_id == MODULE_TYPE_CANNON) {
                at_cannon = true;
                mounted_cannon_id = mmod->id;
            } else if (mmod->type_id == MODULE_TYPE_SWIVEL) {
                /* Route to swivel-specific handler */
                handle_swivel_fire(player, ammo_type);
                return;
            }
        }
    }

    if (!at_helm && !at_cannon) {
        log_warn("Player %u tried to fire weapon but is not at helm, cannon, or swivel", player->player_id);
        return;
    }

    int cannons_fired = 0;
    // Helm-triggered shots are considered automated (broadside volleys);
    // cannon-mounted shots are manually aimed.
    bool manually_fired = at_cannon;
    
    // Get simulation ship for up-to-date cannon data
    struct Ship* sim_ship = find_sim_ship(ship->ship_id);
    if (!sim_ship) {
        log_warn("Simulation ship %u not found", ship->ship_id);
        return;
    }
    
    // Iterate through all modules to find cannons and NPC-manned swivels
    for (uint8_t m = 0; m < sim_ship->module_count; m++) {
        ShipModule* module = &sim_ship->modules[m];
        
        if (module->type_id != MODULE_TYPE_CANNON && module->type_id != MODULE_TYPE_SWIVEL) continue;

        // If the client sent an explicit id-list (weapon-group fire), only
        // fire modules that appear in that list.
        if (explicit_ids && explicit_count > 0) {
            bool in_list = false;
            for (int ei = 0; ei < explicit_count; ei++) {
                if (explicit_ids[ei] == module->id) { in_list = true; break; }
            }
            if (!in_list) continue;
        } else if (at_cannon && module->id != mounted_cannon_id) {
            // If mounted to a specific cannon, skip every other cannon/swivel
            continue;
        }

        /* ── Swivel branch: only fires when an NPC gunner is physically at the station ── */
        if (module->type_id == MODULE_TYPE_SWIVEL) {
            bool swivel_occupied = false;
            for (int wn = 0; wn < world_npc_count; wn++) {
                WorldNpc* wnpc = &world_npcs[wn];
                if (wnpc->active && wnpc->role == NPC_ROLE_GUNNER &&
                    wnpc->ship_id == ship->ship_id &&
                    wnpc->assigned_weapon_id == module->id &&
                    wnpc->state == WORLD_NPC_STATE_AT_GUN) {
                    swivel_occupied = true;
                    break;
                }
            }
            if (!swivel_occupied) continue;
            /* Find SimpleShip copy for timer check and fire_swivel() */
            ShipModule* sw = find_module_by_id(ship, module->id);
            if (!sw) continue;
            /* NPC swivels must always use swivel ammo (10-12).
             * If the incoming ammo_type is a cannon ammo (0-1), fall back to the
             * swivel's own loaded ammo; default to grapeshot if not yet set. */
            uint8_t swivel_ammo = (ammo_type >= PROJ_TYPE_GRAPESHOT) ? ammo_type
                                : (sw->data.swivel.loaded_ammo >= PROJ_TYPE_GRAPESHOT
                                   ? sw->data.swivel.loaded_ammo : PROJ_TYPE_GRAPESHOT);
            uint32_t eff_cd = (swivel_ammo == PROJ_TYPE_LIQUID_FLAME)
                              ? SWIVEL_FLAME_INTERVAL_MS
                              : sw->data.swivel.reload_time;
            if (sw->data.swivel.time_since_fire < eff_cd) continue;
            fire_swivel(ship, sw, module, player, swivel_ammo);
            cannons_fired++;
            continue;
        }

        // Check ammo and reload status
        if (!ship->infinite_ammo && ship->cannon_ammo == 0) {
            // log_info("  ⚠️  Ship %u: No ammo", ship->ship_id);
            break; // No point checking remaining cannons
        }
        
        if (module->data.cannon.time_since_fire < module->data.cannon.reload_time) {
            // log_info("  ⚠️  Cannon %u: Reloading (%.1fs remaining)", 
            //          module->id,
            //          (module->data.cannon.reload_time - module->data.cannon.time_since_fire) / 1000.0f);
            continue;
        }

        // Require a player or NPC to be mounted at this cannon before it can fire.
        // When the firing player is already mounted to this cannon (at_cannon), it counts.
        // Otherwise check for a WorldNpc gunner stationed here.
        if (!at_cannon || module->id != mounted_cannon_id) {
            bool cannon_occupied = false;
            // Check if another player is mounted here
            for (int pi = 0; pi < WS_MAX_CLIENTS; pi++) {
                WebSocketPlayer* op = &players[pi];
                if (op->active && op->is_mounted && op->mounted_module_id == module->id) {
                    cannon_occupied = true;
                    break;
                }
            }
            // Check if a WorldNpc gunner is stationed here
            if (!cannon_occupied) {
                for (int wn = 0; wn < world_npc_count; wn++) {
                    WorldNpc* wnpc = &world_npcs[wn];
                    if (wnpc->active && wnpc->role == NPC_ROLE_GUNNER &&
                        wnpc->ship_id == ship->ship_id &&
                        wnpc->assigned_weapon_id == module->id &&
                        wnpc->state == WORLD_NPC_STATE_AT_GUN) {
                        cannon_occupied = true;
                        break;
                    }
                }
            }
            if (!cannon_occupied) {
                // log_info("  ⏭️  Cannon %u: No crew mounted — skipping", module->id);
                continue;
            }
        }
        
        bool should_fire = fire_all || skip_aim_check;
        
        if (!fire_all && !skip_aim_check) {
            // Single click with aim check: only fire cannons within player's aim arc
            // Cannon can aim ±30° from its base rotation
            float cannon_base_angle = Q16_TO_FLOAT(module->local_rot); // Cannon's base rotation relative to ship
            float cannon_current_aim = Q16_TO_FLOAT(module->data.cannon.aim_direction); // Current aim offset
            // Convert base angle from rendering convention to physics convention (subtract PI/2)
            float cannon_absolute_aim = (cannon_base_angle - (float)(M_PI / 2.0)) + cannon_current_aim;
            
            // Player's aim direction (ship-relative)
            float player_aim = player->cannon_aim_angle_relative;
            
            // Calculate difference
            float aim_difference = fabsf(cannon_absolute_aim - player_aim);
            
            // Normalize to -PI to +PI
            while (aim_difference > M_PI) aim_difference -= 2.0f * M_PI;
            while (aim_difference < -M_PI) aim_difference += 2.0f * M_PI;
            aim_difference = fabsf(aim_difference);
            
            // Check if cannon is currently aimed at player's target
            // Cannons have ±30° range, so check if player's aim is within that cone
            const float AIM_TOLERANCE = 0.35f; // ~20 degrees tolerance for "being aimed"
            
            should_fire = (aim_difference < AIM_TOLERANCE);
            
            if (!should_fire) {
                // log_info("  ⏭️  Cannon %u: Not aimed (diff=%.1f°, tolerance=±%.1f°)", 
                //          module->id, aim_difference * (180.0f / M_PI), AIM_TOLERANCE * (180.0f / M_PI));
            }
        }
        
        if (should_fire) {
            /* Cannons only accept cannon-valid ammo types; swivel-only ammo
             * (grapeshot=2, liquid_flame=3, canister=4) is silently clamped
             * to cannonball so mixed weapon groups can't fire flame from cannons. */
            uint8_t cannon_ammo = (ammo_type <= PROJ_TYPE_BAR_SHOT) ? ammo_type : PROJ_TYPE_CANNONBALL;
            fire_cannon(ship, module, player, manually_fired, cannon_ammo);
            cannons_fired++;
            
            // Also update simple ship module for sync
            for (int i = 0; i < ship->module_count; i++) {
                if (ship->modules[i].id == module->id) {
                    ship->modules[i].data.cannon.ammunition = module->data.cannon.ammunition;
                    ship->modules[i].data.cannon.time_since_fire = 0;
                    break;
                }
            }
        }
    }
    
    log_info("💥 Player %u fired %d cannon(s) on ship %u (%s%s)", 
             player->player_id, cannons_fired, ship->ship_id,
             fire_all ? "BROADSIDE" : (explicit_ids ? "GROUP" : "AIMED"),
             skip_aim_check ? "/FREEFIRE" : "");
}

/**
 * Advance all active flamethrower waves, apply fire to newly-reached targets,
 * and broadcast the current wave state to clients.
 * Called every cannon-update tick (every 100 ms).
 */
void update_flame_waves(uint32_t time_elapsed) {
        if (flame_waves_initialized) {
            const float cos_hc = cosf(FLAME_HALF_CONE);
            const float dt_s   = (float)time_elapsed / 1000.0f;
            for (int fi = 0; fi < MAX_FLAME_WAVES; fi++) {
                FlameWave* fw = &flame_waves[fi];
                if (!fw->active) continue;

                /* Check staleness — start retreating if no pulse for > FLAME_STALE_MS */
                uint32_t now_fw2 = get_time_ms();
                if (!fw->retreating && (now_fw2 - fw->last_fire_ms) > FLAME_STALE_MS) {
                    fw->retreating   = true;
                    fw->retreat_dist = 0.0f;
                }

                /* Advance leading edge */
                if (!fw->retreating) {
                    fw->wave_dist += dt_s * FLAME_WAVE_SPEED;
                    if (fw->wave_dist > FLAME_RANGE) fw->wave_dist = FLAME_RANGE;
                }

                /* Advance retreat front — faster than advance so flame snaps off */
                if (fw->retreating) {
                    fw->retreat_dist += dt_s * FLAME_RETREAT_SPEED;
                    if (fw->retreat_dist >= FLAME_RANGE) {
                        /* Fully retreated — deactivate */
                        fw->active = false;
                        char dead_msg[128];
                        snprintf(dead_msg, sizeof(dead_msg),
                            "{\"type\":\"FLAME_WAVE_UPDATE\",\"cannonId\":%u,\"dead\":true}",
                            fw->swivel_id);
                        broadcast_json_all(dead_msg);
                        continue;
                    }
                }

                /* ── Apply fire to targets within the leading wave front ── */
                if (!fw->retreating) {
                    float fdir_x = cosf(fw->fire_angle);
                    float fdir_y = sinf(fw->fire_angle);

                    /* NPCs */
                    for (int ni = 0; ni < world_npc_count; ni++) {
                        WorldNpc* npc = &world_npcs[ni];
                        if (!npc->active) continue;
                        if (npc->ship_id == fw->ship_id) continue;
                        if (npc->in_water) continue; /* NPC is in water */
                        float dx = npc->x - fw->origin_x, dy = npc->y - fw->origin_y;
                        float dist = sqrtf(dx*dx + dy*dy);
                        if (dist > fw->wave_dist + 30.0f) continue;
                        float dot = (dist > 0.01f) ? (dx/dist*fdir_x + dy/dist*fdir_y) : 1.0f;
                        if (dot < cos_hc) continue;
                        /* Plank-occlusion check: if an intact plank on the NPC's own ship lies
                         * between the flame origin and the NPC, the plank shields them. */
                        {
                            SimpleShip* npc_ship = find_ship_by_id(npc->ship_id);
                            if (npc_ship && plank_occludes_ray(npc_ship, fw->origin_x, fw->origin_y,
                                                               npc->x, npc->y)) continue;
                        }
                        npc->fire_timer_ms = FIRE_DURATION_MS;
                        {
                            char fmsg[256];
                            snprintf(fmsg, sizeof(fmsg),
                                "{\"type\":\"FIRE_EFFECT\",\"entityType\":\"npc\",\"id\":%u,"
                                "\"x\":%.1f,\"y\":%.1f,\"durationMs\":%u}",
                                npc->id, npc->x, npc->y, FIRE_DURATION_MS);
                            broadcast_json_all(fmsg);
                        }
                    }

                    /* Players */
                    for (int wpi = 0; wpi < WS_MAX_CLIENTS; wpi++) {
                        WebSocketPlayer* wp = &players[wpi];
                        if (!wp->active) continue;
                        if (wp->parent_ship_id == fw->ship_id) continue;
                        if (wp->movement_state == PLAYER_STATE_SWIMMING) continue; /* player is in water */
                        float dx = wp->x - fw->origin_x, dy = wp->y - fw->origin_y;
                        float dist = sqrtf(dx*dx + dy*dy);
                        if (dist > fw->wave_dist + 30.0f) continue;
                        float dot = (dist > 0.01f) ? (dx/dist*fdir_x + dy/dist*fdir_y) : 1.0f;
                        if (dot < cos_hc) continue;
                        /* Same plank-occlusion check for players as for NPCs */
                        {
                            SimpleShip* pl_ship = find_ship_by_id(wp->parent_ship_id);
                            if (pl_ship && plank_occludes_ray(pl_ship, fw->origin_x, fw->origin_y,
                                                              wp->x, wp->y)) continue;
                        }
                        wp->fire_timer_ms = FIRE_DURATION_MS;
                        {
                            char fmsg[256];
                            snprintf(fmsg, sizeof(fmsg),
                                "{\"type\":\"FIRE_EFFECT\",\"entityType\":\"player\",\"id\":%u,"
                                "\"x\":%.1f,\"y\":%.1f,\"durationMs\":%u}",
                                wp->player_id, wp->x, wp->y, FIRE_DURATION_MS);
                            broadcast_json_all(fmsg);
                        }
                    }

                    /* Wooden modules — any ship (including firing ship; fire doesn't pick sides) */
                    const float cos_hc_mod = cosf(FLAME_HALF_CONE_MODULE);
                    for (int s = 0; s < ship_count; s++) {
                        if (!ships[s].active) continue;
                        SimpleShip* fship = &ships[s];
                        float cos_r = cosf(fship->rotation);
                        float sin_r = sinf(fship->rotation);
                        for (int m = 0; m < fship->module_count; m++) {
                            ShipModule* mod = &fship->modules[m];
                            ModuleTypeId mt = mod->type_id;
                            if (mt != MODULE_TYPE_PLANK && mt != MODULE_TYPE_DECK &&
                                mt != MODULE_TYPE_MAST) continue;
                            if (mod->state_bits & MODULE_STATE_DESTROYED) continue;
                            /* Compute world-space module position for the flame check.
                             * Deck modules use per-zone ignition; other modules use their centre. */
                            float lx, ly, wx, wy, dist = 0.0f;
                            if (mt == MODULE_TYPE_DECK) {
                                /* Test each of the 3 deck zone centres independently.
                                 * Zone 0 = bow (+160 client), 1 = mid, 2 = stern (-160 client).
                                 * Bits 11-13 are set for each zone that the flame reaches.
                                 * A zone is not ignited if an intact plank on fship lies between
                                 * the flame origin and the zone centre (plank-occlusion rule). */
                                const float zone_lx3[3] = { 160.0f, 0.0f, -160.0f };
                                bool any_zone = false;
                                for (int z = 0; z < 3; z++) {
                                    float z_wx = fship->x + zone_lx3[z] * cos_r;
                                    float z_wy = fship->y + zone_lx3[z] * sin_r;
                                    float zdx = z_wx - fw->origin_x, zdy = z_wy - fw->origin_y;
                                    float zdist = sqrtf(zdx*zdx + zdy*zdy);
                                    if (zdist > fw->wave_dist + 40.0f) continue;
                                    float zdot = (zdist > 0.01f)
                                        ? (zdx/zdist*fdir_x + zdy/zdist*fdir_y) : 1.0f;
                                    if (zdot < cos_hc_mod) continue;
                                    /* Skip if an intact plank blocks flame→zone centre */
                                    if (plank_occludes_ray(fship, fw->origin_x, fw->origin_y,
                                                           z_wx, z_wy)) continue;
                                    mod->state_bits |= (uint16_t)(1u << (11 + z));
                                    any_zone = true;
                                }
                                if (!any_zone) continue;
                                /* Use ship centre for FIRE_EFFECT position broadcast */
                                lx = 0.0f; ly = 0.0f;
                                wx = fship->x; wy = fship->y;
                            } else {
                                lx = SERVER_TO_CLIENT(Q16_TO_FLOAT(mod->local_pos.x));
                                ly = SERVER_TO_CLIENT(Q16_TO_FLOAT(mod->local_pos.y));
                                wx = fship->x + (lx * cos_r - ly * sin_r);
                                wy = fship->y + (lx * sin_r + ly * cos_r);
                                float dx = wx - fw->origin_x, dy = wy - fw->origin_y;
                                dist = sqrtf(dx*dx + dy*dy);
                                if (dist > fw->wave_dist + 40.0f) continue;
                                float dot = (dist > 0.01f) ? (dx/dist*fdir_x + dy/dist*fdir_y) : 1.0f;
                                if (dot < cos_hc_mod) continue;
                                /* Sail fiber plank occlusion: skip if an intact plank
                                 * lies between the flame origin and the mast centre. */
                                if (mt == MODULE_TYPE_MAST &&
                                    plank_occludes_ray(fship, fw->origin_x, fw->origin_y, wx, wy))
                                    continue;
                            }
                            /* Sail fiber ignition: boost intensity on each flame contact */
                            if (mt == MODULE_TYPE_MAST) {
                                int ni = (int)mod->data.mast.sail_fire_intensity + 25;
                                if (ni > 100) ni = 100;
                                mod->data.mast.sail_fire_intensity = (uint8_t)ni;
                            }
                            bool first = (mod->fire_timer_ms == 0);
                            mod->fire_timer_ms = FIRE_DURATION_MS;
                            if (global_sim) {
                                struct Ship* _fss = find_sim_ship(fship->ship_id);
                                if (_fss) {
                                    for (uint8_t mi = 0; mi < _fss->module_count; mi++) {
                                        if (_fss->modules[mi].id == mod->id) {
                                            _fss->modules[mi].fire_timer_ms = FIRE_DURATION_MS;
                                            _fss->modules[mi].state_bits    = mod->state_bits;
                                            if (mod->type_id == MODULE_TYPE_MAST)
                                                _fss->modules[mi].data.mast.sail_fire_intensity =
                                                    mod->data.mast.sail_fire_intensity;
                                            break;
                                        }
                                    }
                                }
                            }
                            /* Always broadcast FIRE_EFFECT — refreshes client timer on every
                               flame contact, preventing client/server desync where client timer
                               expires while server keeps module burning. */
                            log_info("🔥 Module %u (ship %u type %d) %s by flame wave (dist=%.1f wave=%.1f)",
                                     mod->id, fship->ship_id, (int)mt,
                                     first ? "ignited" : "re-ignited", dist, fw->wave_dist);
                            {
                                char fmsg[256];
                                snprintf(fmsg, sizeof(fmsg),
                                    "{\"type\":\"FIRE_EFFECT\",\"entityType\":\"module\","
                                    "\"shipId\":%u,\"moduleId\":%u,"
                                    "\"x\":%.1f,\"y\":%.1f,\"durationMs\":%u}",
                                    fship->ship_id, mod->id, wx, wy, FIRE_DURATION_MS);
                                broadcast_json_all(fmsg);
                            }
                        }
                    }
                } /* end !retreating fire application */

                /* Broadcast current wave state — client interpolates between ticks */
                {
                    char state_msg[320];
                    snprintf(state_msg, sizeof(state_msg),
                        "{\"type\":\"FLAME_WAVE_UPDATE\","
                        "\"cannonId\":%u,\"shipId\":%u,"
                        "\"x\":%.1f,\"y\":%.1f,\"angle\":%.3f,"
                        "\"halfCone\":%.4f,\"waveDist\":%.1f,"
                        "\"retreating\":%s,\"retreatDist\":%.1f}",
                        fw->swivel_id, fw->ship_id,
                        fw->origin_x, fw->origin_y, fw->fire_angle,
                        FLAME_HALF_CONE, fw->wave_dist,
                        fw->retreating ? "true" : "false",
                        fw->retreat_dist);
                    broadcast_json_all(state_msg);
                }
            }
        } /* end FLAME WAVE UPDATE */
}

/* ────────────────────────────────────────────────────────────────────────────
 * Cannonball vs. static-world collision: placed structures and island trees.
 * Called once per tick before processing network I/O. Projectile positions
 * are in Q16 server units (1/10 of client pixels); convert with SERVER_TO_CLIENT.
 * Damage per cannonball hit on a structure: 25 HP (4 shots to destroy).
 * Trees are indestructible — they simply stop the cannonball.
 * ────────────────────────────────────────────────────────────────────────────*/
#define PROJ_HIT_STRUCT_DAMAGE      25u     /* HP deducted per cannonball hit      */
#define TREE_COLLISION_R_PX         22.0f   /* tree stop radius, client pixels     */
/* TREE_TRUNK_R_PX now defined in cannon_fire.h */
#define STRUCT_FLOOR_HALF_EXT       25.0f   /* floor tile half-extent (50px tile)  */
#define STRUCT_WB_HALF_W            22.0f   /* workbench half-width  (44px wide)   */
#define STRUCT_WB_HALF_H            15.5f   /* workbench half-height (31px tall)   */
#define STRUCT_WB_BROAD_R           26.5f   /* broad-phase radius (AABB diagonal)  */

void check_projectile_static_collisions(struct Sim* sim) {
    if (!sim) return;
    int i = 0;
    while (i < (int)sim->projectile_count) {
        struct Projectile* proj = &sim->projectiles[i];
        /* Convert projectile world position from server units → client pixels */
        float px = SERVER_TO_CLIENT(Q16_TO_FLOAT(proj->position.x));
        float py = SERVER_TO_CLIENT(Q16_TO_FLOAT(proj->position.y));
        bool removed = false;

        /* ── Island broad-phase: skip projectiles that are out at sea ────── */
        /* Only run structure/tree checks when the cannonball is within the
         * outer boundary of at least one island (beach_radius + max_bump). */
        bool near_island = false;
        for (int ii = 0; ii < ISLAND_COUNT && !near_island; ii++) {
            const IslandDef* isl = &ISLAND_PRESETS[ii];
            float broad_r = (isl->vertex_count > 0) ? isl->poly_bound_r
                                                       : (isl->beach_radius_px + isl->beach_max_bump);
            float idx = px - isl->x;
            float idy = py - isl->y;
            if (idx * idx + idy * idy <= broad_r * broad_r) near_island = true;
        }
        if (!near_island) { i++; continue; }

        /* ── Test vs. placed structures ──────────────────────────────────── */
        /* Pass 0: walls — thin hard barriers, hit before workbenches/floors. */
        for (uint32_t si = 0; si < placed_structure_count && !removed; si++) {
            PlacedStructure* s = &placed_structures[si];
            if (!s->active || s->type != STRUCT_WALL) continue;
            /* OBB test in wall-local space */
            float wrad = wall_get_rad(s->x, s->y);
            float wc = cosf(-wrad), wsn = sinf(-wrad);
            float dx = px - s->x, dy = py - s->y;
            float lx = dx * wc - dy * wsn;
            float ly = dx * wsn + dy * wc;
            if (fabsf(lx) > 25.0f || fabsf(ly) > 5.0f) continue;
            /* Hit wall */
            uint16_t dmg = PROJ_HIT_STRUCT_DAMAGE;
            s->hp = (s->hp > dmg) ? (uint16_t)(s->hp - dmg) : 0u;
            char msg[192];
            if (s->hp == 0) {
                s->active = false;
                snprintf(msg, sizeof(msg),
                         "{\"type\":\"structure_demolished\",\"structure_id\":%u"
                         ",\"x\":%.1f,\"y\":%.1f}",
                         s->id, s->x, s->y);
            } else {
                snprintf(msg, sizeof(msg),
                         "{\"type\":\"structure_hp_changed\","
                         "\"structure_id\":%u,\"hp\":%u,\"max_hp\":%u"
                         ",\"x\":%.1f,\"y\":%.1f}",
                         s->id, (unsigned)s->hp, (unsigned)s->max_hp, s->x, s->y);
            }
            websocket_server_broadcast(msg);
            memmove(&sim->projectiles[i], &sim->projectiles[i + 1],
                    ((size_t)sim->projectile_count - (size_t)i - 1u)
                    * sizeof(struct Projectile));
            sim->projectile_count--;
            removed = true;
        }

        /* Pass 1: workbenches — checked first so they can be independently
         * hit and damaged even when a floor tile below overlaps the same area. */
        for (uint32_t si = 0; si < placed_structure_count && !removed; si++) {
            PlacedStructure* s = &placed_structures[si];
            if (!s->active || s->type != STRUCT_WORKBENCH) continue;
            float dx = px - s->x;
            float dy = py - s->y;
            /* Broad-phase radial cull, then narrow AABB (44×31px footprint) */
            if (dx * dx + dy * dy > STRUCT_WB_BROAD_R * STRUCT_WB_BROAD_R) continue;
            if (!(dx >= -STRUCT_WB_HALF_W && dx <= STRUCT_WB_HALF_W &&
                  dy >= -STRUCT_WB_HALF_H && dy <= STRUCT_WB_HALF_H)) continue;
            /* Hit workbench */
            uint16_t dmg = PROJ_HIT_STRUCT_DAMAGE;
            s->hp = (s->hp > dmg) ? (uint16_t)(s->hp - dmg) : 0u;
            char msg[192];
            if (s->hp == 0) {
                s->active = false;
                snprintf(msg, sizeof(msg),
                         "{\"type\":\"structure_demolished\",\"structure_id\":%u"
                         ",\"x\":%.1f,\"y\":%.1f}",
                         s->id, s->x, s->y);
            } else {
                snprintf(msg, sizeof(msg),
                         "{\"type\":\"structure_hp_changed\","
                         "\"structure_id\":%u,\"hp\":%u,\"max_hp\":%u"
                         ",\"x\":%.1f,\"y\":%.1f}",
                         s->id, (unsigned)s->hp, (unsigned)s->max_hp, s->x, s->y);
            }
            websocket_server_broadcast(msg);
            memmove(&sim->projectiles[i], &sim->projectiles[i + 1],
                    ((size_t)sim->projectile_count - (size_t)i - 1u)
                    * sizeof(struct Projectile));
            sim->projectile_count--;
            removed = true;
        }

        /* Pass 2: floors (only if no workbench was hit in Pass 1) */
        for (uint32_t si = 0; si < placed_structure_count && !removed; si++) {
            PlacedStructure* s = &placed_structures[si];
            if (!s->active || s->type != STRUCT_WOODEN_FLOOR) continue;
            float dx = px - s->x;
            float dy = py - s->y;
            /* Wooden floor: AABB check (square 50×50 tile, ±25px) */
            if (!(dx >= -STRUCT_FLOOR_HALF_EXT && dx <= STRUCT_FLOOR_HALF_EXT &&
                  dy >= -STRUCT_FLOOR_HALF_EXT && dy <= STRUCT_FLOOR_HALF_EXT)) continue;
            /* Hit floor */
            uint16_t dmg = PROJ_HIT_STRUCT_DAMAGE;
            s->hp = (s->hp > dmg) ? (uint16_t)(s->hp - dmg) : 0u;
            char msg[192];
            if (s->hp == 0) {
                float kx = s->x, ky = s->y;
                s->active = false;
                snprintf(msg, sizeof(msg),
                         "{\"type\":\"structure_demolished\",\"structure_id\":%u"
                         ",\"x\":%.1f,\"y\":%.1f}",
                         s->id, kx, ky);
                websocket_server_broadcast(msg);
                /* Cascade: floor destroyed — demolish workbenches that were resting
                 * on this floor and have no other active floor still supporting them,
                 * and demolish walls at its edges with no other supporting floor.
                 * (The killed floor is already inactive so the inner scan finds only
                 * surviving floors.) */
                for (uint32_t ci = 0; ci < placed_structure_count; ci++) {
                    PlacedStructure* wb = &placed_structures[ci];
                    if (!wb->active) continue;
                    if (wb->type == STRUCT_WORKBENCH) {
                        if (fabsf(wb->x - kx) > 25.0f || fabsf(wb->y - ky) > 25.0f) continue;
                        bool has_support = false;
                        for (uint32_t fi = 0; fi < placed_structure_count && !has_support; fi++) {
                            PlacedStructure* f = &placed_structures[fi];
                            if (!f->active || f->type != STRUCT_WOODEN_FLOOR) continue;
                            if (fabsf(wb->x - f->x) <= 25.0f && fabsf(wb->y - f->y) <= 25.0f)
                                has_support = true;
                        }
                        if (!has_support) {
                            wb->active = false;
                            char cwmsg[192];
                            snprintf(cwmsg, sizeof(cwmsg),
                                     "{\"type\":\"structure_demolished\","
                                     "\"structure_id\":%u,\"x\":%.1f,\"y\":%.1f}",
                                     wb->id, wb->x, wb->y);
                            websocket_server_broadcast(cwmsg);
                        }
                    } else if (wb->type == STRUCT_WALL || wb->type == STRUCT_DOOR_FRAME) {
                        /* Is this wall/door_frame adjacent to the demolished floor? */
                        float _at_dx = wb->x - kx, _at_dy = wb->y - ky;
                        if (_at_dx*_at_dx + _at_dy*_at_dy > 30.0f * 30.0f) continue;
                        bool has_support = wall_has_support(wb->x, wb->y);
                        if (!has_support) {
                            float dfx = wb->x, dfy = wb->y;
                            bool is_frame = (wb->type == STRUCT_DOOR_FRAME);
                            wb->active = false;
                            char cwmsg[192];
                            snprintf(cwmsg, sizeof(cwmsg),
                                     "{\"type\":\"structure_demolished\","
                                     "\"structure_id\":%u,\"x\":%.1f,\"y\":%.1f}",
                                     wb->id, wb->x, wb->y);
                            websocket_server_broadcast(cwmsg);
                            /* If a door_frame was lost, cascade any door sitting on it */
                            if (is_frame) {
                                for (uint32_t di = 0; di < placed_structure_count; di++) {
                                    PlacedStructure* dp = &placed_structures[di];
                                    if (!dp->active || dp->type != STRUCT_DOOR) continue;
                                    if (fabsf(dp->x - dfx) >= 3.0f || fabsf(dp->y - dfy) >= 3.0f) continue;
                                    dp->active = false;
                                    char dmsg[128];
                                    snprintf(dmsg, sizeof(dmsg),
                                             "{\"type\":\"structure_demolished\",\"structure_id\":%u}",
                                             dp->id);
                                    websocket_server_broadcast(dmsg);
                                    break;
                                }
                            }
                        }
                    }
                }
            } else {
                snprintf(msg, sizeof(msg),
                         "{\"type\":\"structure_hp_changed\","
                         "\"structure_id\":%u,\"hp\":%u,\"max_hp\":%u"
                         ",\"x\":%.1f,\"y\":%.1f}",
                         s->id, (unsigned)s->hp, (unsigned)s->max_hp, s->x, s->y);
                websocket_server_broadcast(msg);
            }
            memmove(&sim->projectiles[i], &sim->projectiles[i + 1],
                    ((size_t)sim->projectile_count - (size_t)i - 1u)
                    * sizeof(struct Projectile));
            sim->projectile_count--;
            removed = true;
        }

        /* ── Test vs. island trees (spatial grid lookup) ────────────────── */
        if (!removed) {
            for (int ii = 0; ii < ISLAND_COUNT && !removed; ii++) {
                IslandDef* isl = &ISLAND_PRESETS[ii];
                if (isl->grid_w == 0) continue; /* no wood nodes */

                /* Compute the 3×3 neighbourhood of cells around the projectile */
                int center_col = (int)((px - isl->grid_ox) / ISLAND_GRID_CELL_PX);
                int center_row = (int)((py - isl->grid_oy) / ISLAND_GRID_CELL_PX);

                for (int dr = -1; dr <= 1 && !removed; dr++) {
                    int row = center_row + dr;
                    if (row < 0 || row >= isl->grid_h) continue;
                    for (int dc = -1; dc <= 1 && !removed; dc++) {
                        int col = center_col + dc;
                        if (col < 0 || col >= isl->grid_w) continue;
                        const IslandGridCell *cell = &isl->wood_grid[row][col];
                        for (int k = 0; k < cell->count && !removed; k++) {
                            int ri = cell->ri[k];
                            IslandResource* res = &isl->resources[ri];
                            if (res->health <= 0) continue;
                            float tx = isl->x + res->ox;
                            float ty = isl->y + res->oy;
                            float dx = px - tx;
                            float dy = py - ty;
                            if (dx * dx + dy * dy <= TREE_COLLISION_R_PX * TREE_COLLISION_R_PX) {
                                const int CANNON_TREE_DMG = 30;
                                res->health -= CANNON_TREE_DMG;
                                if (res->health < 0) res->health = 0;
                                if (res->health == 0) island_mark_tree_dead(isl, ri);
                                char tmsg[160];
                                snprintf(tmsg, sizeof(tmsg),
                                         "{\"type\":\"resource_damaged\",\"island_id\":%u"
                                         ",\"ri\":%d,\"ox\":%.1f,\"oy\":%.1f,\"hp\":%d,\"maxHp\":%d}",
                                         (unsigned)isl->id, ri, res->ox, res->oy, res->health, res->max_health);
                                websocket_server_broadcast(tmsg);
                                char htmsg[96];
                                snprintf(htmsg, sizeof(htmsg),
                                         "{\"type\":\"tree_cannonball_hit\",\"x\":%.1f,\"y\":%.1f}",
                                         tx, ty);
                                websocket_server_broadcast(htmsg);
                                memmove(&sim->projectiles[i], &sim->projectiles[i + 1],
                                        ((size_t)sim->projectile_count - (size_t)i - 1u)
                                        * sizeof(struct Projectile));
                                sim->projectile_count--;
                                removed = true;
                            }
                        }
                    }
                }
            }
        }

        if (!removed) i++;
    }
}
