#include "admin/admin_server.h"
#include "sim/types.h"
#include "net/network.h"
#include "util/log.h"
#include "util/time.h"
#include <string.h>
#include <errno.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <stdio.h>
#include <stdlib.h>

// Simple HTML dashboard with map tab
static const char* dashboard_html = 
"<!DOCTYPE html>\n"
"<html><head><title>Pirate Admin Panel</title><meta charset=\"utf-8\"><style>\n"
"body { font-family: Arial, sans-serif; margin: 0; background: #f5f5f5; }\n"
".header { background: #2c3e50; color: white; padding: 1rem; text-align: center; }\n"
".container { max-width: 1200px; margin: 0 auto; padding: 1rem; }\n"
".tabs { display: flex; background: white; border-radius: 8px 8px 0 0; }\n"
".tab { background: #ecf0f1; border: none; padding: 1rem 2rem; cursor: pointer; }\n"
".tab.active { background: white; border-bottom: 2px solid #3498db; }\n"
".tab-content { background: white; border-radius: 0 0 8px 8px; padding: 2rem; min-height: 600px; }\n"
".tab-pane { display: none; } .tab-pane.active { display: block; }\n"
".grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 1rem; }\n"
".card { background: #f8f9fa; border-radius: 8px; padding: 1.5rem; border: 1px solid #e9ecef; }\n"
".card h3 { margin-top: 0; color: #2c3e50; border-bottom: 2px solid #3498db; padding-bottom: 0.5rem; }\n"
".stat { display: flex; justify-content: space-between; margin: 0.5rem 0; }\n"
".stat-value { font-weight: bold; color: #27ae60; }\n"
".indicator { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-left: 5px; }\n"
".indicator.green { background: #27ae60; animation: pulse 2s infinite; }\n"
".indicator.red { background: #e74c3c; }\n"
".indicator.gray { background: #95a5a6; }\n"
"@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }\n"
"#map-container { position: relative; width: 100%; height: 500px; border: 2px solid #34495e; background: #2c5aa0; border-radius: 8px; }\n"
"#map-canvas { width: 100%; height: 100%; display: block; }\n"
".map-legend { position: absolute; top: 10px; right: 10px; background: rgba(0,0,0,0.8); color: white; padding: 1rem; border-radius: 8px; }\n"
".refresh-btn { background: #3498db; color: white; border: none; padding: 0.5rem 1rem; border-radius: 4px; cursor: pointer; margin-bottom: 1rem; }\n"
".spawn-btn { background: #27ae60; color: white; border: none; padding: 0.6rem 1.4rem; border-radius: 4px; cursor: pointer; font-weight: bold; font-size: 1rem; }\n"
".spawn-btn:hover { background: #219a52; }\n"
".spawn-btn:disabled { background: #95a5a6; cursor: not-allowed; }\n"
".form-row { display: flex; gap: 0.75rem; align-items: flex-end; flex-wrap: wrap; margin-top: 0.75rem; }\n"
".form-group { display: flex; flex-direction: column; gap: 0.25rem; }\n"
".form-group label { font-size: 0.8rem; color: #555; font-weight: bold; }\n"
".form-group input, .form-group select { padding: 0.4rem 0.6rem; border: 1px solid #ccc; border-radius: 4px; font-size: 0.9rem; width: 100px; }\n"
".spawn-result { margin-top: 0.75rem; padding: 0.5rem 0.75rem; border-radius: 4px; font-size: 0.9rem; display: none; }\n"
".spawn-result.ok { background: #d4edda; color: #155724; border: 1px solid #c3e6cb; }\n"
".spawn-result.err { background: #f8d7da; color: #721c24; border: 1px solid #f5c6cb; }\n"
"</style></head><body>\n"
"<div class=\"header\"><h1>🏴‍☠️ Pirate Game Admin Panel</h1></div>\n"
"<div class=\"container\">\n"
"<button class=\"refresh-btn\" onclick=\"refreshAll()\">🔄 Refresh</button>\n"
"<div class=\"tabs\">\n"
"<button class=\"tab active\" onclick=\"showTab('dashboard')\">📊 Dashboard</button>\n"
"<button class=\"tab\" onclick=\"showTab('map')\">🗺️ Live Map</button>\n"
"</div>\n"
"<div class=\"tab-content\">\n"
"<div id=\"dashboard\" class=\"tab-pane active\">\n"
"<div class=\"grid\">\n"
"<div class=\"card\"><h3>📊 Server Status</h3><div id=\"server-status\">Loading...</div></div>\n"
"<div class=\"card\"><h3>🎯 Physics Objects</h3><div id=\"physics-objects\">Loading...</div></div>\n"
"<div class=\"card\"><h3>🌐 Network Stats</h3><div id=\"network-stats\">Loading...</div></div>\n"
"<div class=\"card\"><h3>💬 Message Activity</h3><div id=\"message-stats\">Loading...</div></div>\n"
"<div class=\"card\"><h3>🚢 Spawn Ship</h3>\n"
"<p style=\"font-size:0.85rem;color:#555;margin-top:0\">Create a new brigantine on the fly. Coordinates are in client pixels.</p>\n"
"<div class=\"form-row\">\n"
"  <div class=\"form-group\"><label>X (px)</label><input id=\"spawn-x\" type=\"number\" value=\"400\"></div>\n"
"  <div class=\"form-group\"><label>Y (px)</label><input id=\"spawn-y\" type=\"number\" value=\"400\"></div>\n"
"  <div class=\"form-group\"><label>Company</label>\n"
"    <select id=\"spawn-company\">\n"
"      <option value=\"1\">⚔️ Pirates</option>\n"
"      <option value=\"2\">⚓ Navy</option>\n"
"      <option value=\"0\">🏳️ Neutral</option>\n"
"    </select>\n"
"  </div>\n"
"  <button class=\"spawn-btn\" onclick=\"spawnShip()\">⚓ Spawn</button>\n"
"</div>\n"
"<div id=\"spawn-result\" class=\"spawn-result\"></div>\n"
"</div>\n"
"<div class=\"card\"><h3>� Spawn Phantom Brig</h3>\n"
"<p style=\"font-size:0.85rem;color:#555;margin-top:0\">Spawn an autonomous spectral enemy brigantine. Attacks nearby player ships on sight.</p>\n"
"<div class=\"form-row\">\n"
"  <div class=\"form-group\"><label>X (px)</label><input id=\"pbrig-x\" type=\"number\" value=\"400\"></div>\n"
"  <div class=\"form-group\"><label>Y (px)</label><input id=\"pbrig-y\" type=\"number\" value=\"400\"></div>\n"
"  <button class=\"spawn-btn\" style=\"background:#4a1a7a\" onclick=\"spawnPhantomBrig()\">👻 Spawn Phantom Brig</button>\n"
"</div>\n"
"<div id=\"pbrig-result\" class=\"spawn-result\"></div>\n"
"</div>\n"
"<div class=\"card\"><h3>�👥 Players</h3><div id=\"player-list\">Loading...</div></div>\n"
"</div></div>\n"
"<div id=\"map\" class=\"tab-pane\">\n"
"<h2>🗺️ Live World Map</h2>\n"
"<div id=\"map-container\">\n"
"<canvas id=\"map-canvas\" width=\"800\" height=\"400\"></canvas>\n"
"</div></div>\n"
"</div></div>\n"
"<script>\n"
"let mapCanvas, mapCtx, mapData = null;\n"
"let mapOffsetX = 0, mapOffsetY = 0;\n"
"let isDragging = false, lastMouseX = 0, lastMouseY = 0;\n"
"function showTab(tabName) {\n"
"document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));\n"
"document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));\n"
"document.getElementById(tabName).classList.add('active');\n"
"event.target.classList.add('active');\n"
"if (tabName === 'map' && !mapCanvas) initMap();\n"
"}\n"
"function initMap() {\n"
"mapCanvas = document.getElementById('map-canvas');\n"
"mapCtx = mapCanvas.getContext('2d');\n"
"// Add mouse event listeners for panning\n"
"mapCanvas.addEventListener('mousedown', (e) => {\n"
"if (e.button === 2) { // Right mouse button\n"
"isDragging = true;\n"
"lastMouseX = e.clientX;\n"
"lastMouseY = e.clientY;\n"
"e.preventDefault();\n"
"}\n"
"});\n"
"mapCanvas.addEventListener('mousemove', (e) => {\n"
"if (isDragging) {\n"
"const dx = e.clientX - lastMouseX;\n"
"const dy = e.clientY - lastMouseY;\n"
"mapOffsetX += dx;\n"
"mapOffsetY += dy;\n"
"lastMouseX = e.clientX;\n"
"lastMouseY = e.clientY;\n"
"drawMap();\n"
"e.preventDefault();\n"
"}\n"
"});\n"
"mapCanvas.addEventListener('mouseup', (e) => {\n"
"if (e.button === 2) {\n"
"isDragging = false;\n"
"e.preventDefault();\n"
"}\n"
"});\n"
"mapCanvas.addEventListener('contextmenu', (e) => e.preventDefault());\n"
"updateMap();\n"
"}\n"
"async function updateMap() {\n"
"if (!mapCanvas) return;\n"
"const data = await fetchJson('/api/map');\n"
"if (!data) return;\n"
"mapData = data; drawMap();\n"
"}\n"
"function drawMap() {\n"
"if (!mapData || !mapCtx) return;\n"
"const ctx = mapCtx;\n"
"// Clear canvas with ocean blue\n"
"ctx.fillStyle = '#2c5aa0'; ctx.fillRect(0, 0, 800, 400);\n"
"ctx.save();\n"
"// Apply pan offset\n"
"ctx.translate(mapOffsetX, mapOffsetY);\n"
"// Draw grid for reference\n"
"ctx.strokeStyle = 'rgba(255,255,255,0.1)';\n"
"ctx.lineWidth = 1;\n"
"for (let i = -1000; i < 2000; i += 50) {\n"
"ctx.beginPath(); ctx.moveTo(i, -1000); ctx.lineTo(i, 1000); ctx.stroke();\n"
"}\n"
"for (let i = -1000; i < 1000; i += 50) {\n"
"ctx.beginPath(); ctx.moveTo(-1000, i); ctx.lineTo(2000, i); ctx.stroke();\n"
"}\n"
"// Draw ships first (background layer)\n"
"mapData.ships.forEach(ship => {\n"
"const x = ship.x; const y = ship.y;\n"
"ctx.save();\n"
"ctx.translate(x, y);\n"
"ctx.rotate(ship.rotation);\n"
"// Draw ship hull polygon (if available)\n"
"if (ship.hull && ship.hull.length > 0) {\n"
"ctx.fillStyle = '#8B4513';\n"
"ctx.beginPath();\n"
"ctx.moveTo(ship.hull[0].x, ship.hull[0].y);\n"
"for (let i = 1; i < ship.hull.length; i++) {\n"
"ctx.lineTo(ship.hull[i].x, ship.hull[i].y);\n"
"}\n"
"ctx.closePath();\n"
"ctx.fill();\n"
"ctx.strokeStyle = '#654321';\n"
"ctx.lineWidth = 2;\n"
"ctx.stroke();\n"
"} else {\n"
"// Fallback to simple rectangle\n"
"ctx.fillStyle = '#8B4513';\n"
"ctx.fillRect(-10, -8, 20, 16);\n"
"}\n"
"// Draw modules (cannons, masts, helm) on top of hull\n"
"if (ship.modules && ship.modules.length > 0) {\n"
"ship.modules.forEach(mod => {\n"
"ctx.save();\n"
"ctx.translate(mod.x, mod.y);\n"
"ctx.rotate(mod.rotation);\n"
"// Color and shape based on module type\n"
"// 0=HELM, 1=SEAT, 2=CANNON, 3=MAST, 5=LADDER, 6=PLANK, 7=DECK\n"
"if (mod.typeId === 0) { // HELM\n"
"ctx.fillStyle = '#FFD700'; // Gold\n"
"ctx.beginPath();\n"
"ctx.arc(0, 0, 4, 0, 2*Math.PI);\n"
"ctx.fill();\n"
"ctx.strokeStyle = '#B8860B';\n"
"ctx.lineWidth = 1;\n"
"ctx.stroke();\n"
"} else if (mod.typeId === 2) { // CANNON\n"
"ctx.fillStyle = '#696969'; // Dim gray\n"
"ctx.fillRect(-3, -2, 8, 4); // Barrel pointing forward\n"
"ctx.fillStyle = '#404040';\n"
"ctx.fillRect(-3, -3, 3, 6); // Base\n"
"} else if (mod.typeId === 3) { // MAST\n"
"ctx.strokeStyle = '#8B4513'; // Brown pole\n"
"ctx.lineWidth = 2;\n"
"ctx.beginPath();\n"
"ctx.moveTo(0, -12);\n"
"ctx.lineTo(0, 12);\n"
"ctx.stroke();\n"
"ctx.fillStyle = '#F5F5DC'; // Beige sail\n"
"ctx.fillRect(-8, -8, 8, 10);\n"
"ctx.strokeStyle = '#8B4513';\n"
"ctx.lineWidth = 1;\n"
"ctx.strokeRect(-8, -8, 8, 10);\n"
"} else if (mod.typeId === 1) { // SEAT\n"
"ctx.fillStyle = '#CD853F'; // Peru brown\n"
"ctx.fillRect(-3, -3, 6, 6);\n"
"} else { // Other modules\n"
"ctx.fillStyle = '#888888';\n"
"ctx.fillRect(-2, -2, 4, 4);\n"
"}\n"
"ctx.restore();\n"
"});\n"
"}\n"
"ctx.restore();\n"
"// Draw ship ID\n"
"ctx.fillStyle = 'white';\n"
"ctx.font = 'bold 12px Arial';\n"
"ctx.fillText('Ship '+ship.id, x+12, y-10);\n"
"ctx.font = '10px Arial';\n"
"ctx.fillText('('+Math.round(x)+','+Math.round(y)+')', x+12, y+2);\n"
"});\n"
"// Draw players on top (foreground layer)\n"
"if (mapData.players) {\n"
"mapData.players.forEach(p => {\n"
"const x = p.x || p.world_x; const y = p.y || p.world_y;\n"
"// Draw player circle\n"
"ctx.fillStyle = p.ship_id > 0 ? '#2ecc71' : '#3498db';\n"
"ctx.beginPath();\n"
"ctx.arc(x, y, 4, 0, 2*Math.PI);\n"
"ctx.fill();\n"
"// Draw player direction (if rotation available)\n"
"if (p.rotation !== undefined) {\n"
"ctx.strokeStyle = 'white';\n"
"ctx.lineWidth = 2;\n"
"ctx.beginPath();\n"
"ctx.moveTo(x, y);\n"
"ctx.lineTo(x + Math.cos(p.rotation) * 8, y + Math.sin(p.rotation) * 8);\n"
"ctx.stroke();\n"
"}\n"
"// Draw player info\n"
"ctx.fillStyle = 'white';\n"
"ctx.font = '10px Arial';\n"
"const playerLabel = (p.name || 'Player') + ' (' + p.id + ')';\n"
"ctx.fillText(playerLabel, x+6, y-6);\n"
"ctx.fillStyle = p.ship_id > 0 ? '#2ecc71' : '#3498db';\n"
"const stateLabel = p.state || (p.ship_id > 0 ? 'ON_SHIP' : 'SWIMMING');\n"
"ctx.fillText(stateLabel, x+6, y+4);\n"
"});\n"
"}\n"
"ctx.restore();\n"
"// Draw legend (outside pan area)\n"
"ctx.fillStyle = 'rgba(0,0,0,0.7)';\n"
"ctx.fillRect(10, 10, 180, 135);\n"
"ctx.fillStyle = 'white';\n"
"ctx.font = 'bold 12px Arial';\n"
"ctx.fillText('Legend', 20, 25);\n"
"ctx.font = '10px Arial';\n"
"ctx.fillStyle = '#8B4513';\n"
"ctx.fillRect(20, 30, 12, 12);\n"
"ctx.fillStyle = 'white';\n"
"ctx.fillText('Ship Hull', 38, 40);\n"
"ctx.fillStyle = '#FFD700'; // Helm\n"
"ctx.beginPath(); ctx.arc(26, 52, 4, 0, 2*Math.PI); ctx.fill();\n"
"ctx.fillStyle = 'white';\n"
"ctx.fillText('Helm', 38, 56);\n"
"ctx.fillStyle = '#696969'; // Cannon\n"
"ctx.fillRect(20, 60, 8, 4);\n"
"ctx.fillStyle = 'white';\n"
"ctx.fillText('Cannon', 38, 66);\n"
"ctx.fillStyle = '#F5F5DC'; // Mast\n"
"ctx.fillRect(20, 72, 8, 8);\n"
"ctx.strokeStyle = '#8B4513';\n"
"ctx.strokeRect(20, 72, 8, 8);\n"
"ctx.fillStyle = 'white';\n"
"ctx.fillText('Mast', 38, 79);\n"
"ctx.fillStyle = '#2ecc71';\n"
"ctx.beginPath(); ctx.arc(26, 92, 4, 0, 2*Math.PI); ctx.fill();\n"
"ctx.fillStyle = 'white';\n"
"ctx.fillText('Player (on ship)', 38, 96);\n"
"ctx.fillStyle = '#3498db';\n"
"ctx.beginPath(); ctx.arc(26, 108, 4, 0, 2*Math.PI); ctx.fill();\n"
"ctx.fillStyle = 'white';\n"
"ctx.fillText('Player (swimming)', 38, 112);\n"
"}\n"
"async function fetchJson(url) {\n"
"try { const r = await fetch(url); return await r.json(); } catch(e) { return null; }\n"
"}\n"
"async function updateServerStatus() {\n"
"const data = await fetchJson('/api/status');\n"
"if (!data) return;\n"
"document.getElementById('server-status').innerHTML = `\n"
"<div class=\"stat\"><span>Uptime:</span><span class=\"stat-value\">${data.uptime_seconds}s</span></div>\n"
"<div class=\"stat\"><span>Tick Rate:</span><span class=\"stat-value\">${data.tick_rate} Hz</span></div>\n"
"<div class=\"stat\"><span>Players:</span><span class=\"stat-value\">${data.player_count}</span></div>\n"
"`;\n"
"}\n"
"async function updatePhysicsObjects() {\n"
"const data = await fetchJson('/api/map');\n"
"if (!data) return;\n"
"const shipCount = data.ships ? data.ships.length : 0;\n"
"const playerCount = data.players ? data.players.length : 0;\n"
"document.getElementById('physics-objects').innerHTML = `\n"
"<div class=\"stat\"><span>🚢 Ships:</span><span class=\"stat-value\">${shipCount}</span></div>\n"
"<div class=\"stat\"><span>👤 Players:</span><span class=\"stat-value\">${playerCount}</span></div>\n"
"<div class=\"stat\"><span>🎯 Projectiles:</span><span class=\"stat-value\">${data.projectiles ? data.projectiles.length : 0}</span></div>\n"
"`;\n"
"}\n"
"async function updateNetworkStats() {\n"
"const data = await fetchJson('/api/network');\n"
"if (!data) return;\n"
"document.getElementById('network-stats').innerHTML = `\n"
"<div class=\"stat\"><span>Packets Sent:</span><span class=\"stat-value\">${data.packets_sent}</span></div>\n"
"<div class=\"stat\"><span>Bytes Sent:</span><span class=\"stat-value\">${data.bytes_sent}</span></div>\n"
"`;\n"
"}\n"
"async function updateMessageStats() {\n"
"const data = await fetchJson('/api/messages');\n"
"if (!data) return;\n"
"const inputAge = data.last_input_age_ms;\n"
"const unknownAge = data.last_unknown_age_ms;\n"
"const inputIndicator = inputAge < 5000 ? 'green' : 'gray';\n"
"const unknownIndicator = unknownAge < 5000 ? 'red' : 'gray';\n"
"document.getElementById('message-stats').innerHTML = `\n"
"<div class=\"stat\"><span>🎮 Player Inputs:</span><span class=\"stat-value\">${data.input_messages_received} <span class=\"indicator ${inputIndicator}\"></span></span></div>\n"
"<div class=\"stat\"><span>❓ Unknown Messages:</span><span class=\"stat-value\">${data.unknown_messages_received} <span class=\"indicator ${unknownIndicator}\"></span></span></div>\n"
"<div class=\"stat\"><span>Last Input:</span><span class=\"stat-value\">${inputAge}ms ago</span></div>\n"
"<div class=\"stat\"><span>Last Unknown:</span><span class=\"stat-value\">${unknownAge}ms ago</span></div>\n"
"`;\n"
"}\n"
"function refreshAll() {\n"
"updateServerStatus(); updatePhysicsObjects(); updateNetworkStats(); updateMessageStats();\n"
"if (document.getElementById('map').classList.contains('active')) updateMap();\n"
"// Players panel refreshes separately — skip if user is actively editing a dropdown\n"
"const playerList = document.getElementById('player-list');\n"
"const focused = playerList && playerList.querySelector('select:focus, button:focus');\n"
"if (!focused) updatePlayers();\n"
"}\n"
"const COMPANY_NAMES = ['Neutral', 'Pirates', 'Navy'];\n"
"const COMPANY_COLORS = ['#95a5a6', '#e74c3c', '#3498db'];\n"
"async function updatePlayers() {\n"
"const data = await fetchJson('/api/websocket');\n"
"const el = document.getElementById('player-list');\n"
"if (!el) return;\n"
"if (!data || !data.players || data.players.length === 0) {\n"
"  el.innerHTML = '<p style=\"color:#888;font-size:0.9rem\">No players connected.</p>';\n"
"  return;\n"
"}\n"
"// Don't rebuild if any select/button inside the panel is focused\n"
"if (el.querySelector('select:focus, button:focus')) return;\n"
"let html = '<table style=\"width:100%;border-collapse:collapse;font-size:0.88rem\">';\n"
"html += '<tr style=\"background:#dee2e6\">';\n"
"html += '<th style=\"padding:4px 8px;text-align:left\">ID</th>';\n"
"html += '<th style=\"padding:4px 8px;text-align:left\">Name</th>';\n"
"html += '<th style=\"padding:4px 8px;text-align:left\">Current Company</th>';\n"
"html += '<th style=\"padding:4px 8px;text-align:left\">Ship</th>';\n"
"html += '<th style=\"padding:4px 8px;text-align:left\">Change To</th>';\n"
"html += '</tr>';\n"
"data.players.forEach(p => {\n"
"  const company = typeof p.company === 'number' ? p.company : 0;\n"
"  const color = COMPANY_COLORS[company] || '#95a5a6';\n"
"  const companyName = COMPANY_NAMES[company] || 'Unknown';\n"
"  // Default the dropdown to the next company (not current), so it's obvious what will change\n"
"  const defaultNew = (company + 1) % COMPANY_NAMES.length;\n"
"  html += `<tr style=\"border-bottom:1px solid #dee2e6\">`;\n"
"  html += `<td style=\"padding:6px 8px\">${p.id}</td>`;\n"
"  html += `<td style=\"padding:6px 8px\">${p.name || 'Player'}</td>`;\n"
"  html += `<td style=\"padding:6px 8px\">`;\n"
"  html += `  <span style=\"background:${color};color:#fff;padding:3px 10px;border-radius:4px;font-size:0.82rem;font-weight:bold\">${companyName}</span>`;\n"
"  html += `</td>`;\n"
"  html += `<td style=\"padding:6px 8px\">${p.ship_id > 0 ? 'Ship #'+p.ship_id : '—'}</td>`;\n"
"  html += `<td style=\"padding:6px 8px;display:flex;gap:6px;align-items:center\">`;\n"
"  html += `<select id=\"pc-${p.id}\" style=\"padding:3px 6px;border-radius:4px;border:1px solid #aaa;font-size:0.85rem\">`;\n"
"  COMPANY_NAMES.forEach((name, idx) => {\n"
"    const sel = idx === defaultNew ? ' selected' : '';\n"
"    html += `<option value=\"${idx}\"${sel}>${name}</option>`;\n"
"  });\n"
"  html += `</select>`;\n"
"  html += `<button onclick=\"assignPlayerCompany(${p.id})\" style=\"padding:3px 12px;border-radius:4px;border:none;background:#27ae60;color:#fff;cursor:pointer;font-size:0.85rem;font-weight:bold\">Set</button>`;\n"
"  html += `</td>`;\n"
"  html += `</tr>`;\n"
"});\n"
"html += '</table>';\n"
"el.innerHTML = html;\n"
"}\n"
"async function assignPlayerCompany(playerId) {\n"
"const sel = document.getElementById('pc-'+playerId);\n"
"if (!sel) return;\n"
"const company = parseInt(sel.value);\n"
"const btn = sel.nextElementSibling;\n"
"if (btn) { btn.disabled = true; btn.textContent = '...'; }\n"
"try {\n"
"  const r = await fetch('/api/admin/player/company', {\n"
"    method: 'POST',\n"
"    headers: {'Content-Type': 'application/json'},\n"
"    body: JSON.stringify({playerId, company})\n"
"  });\n"
"  const data = await r.json();\n"
"  if (data.success) {\n"
"    // Brief success flash then force-refresh the player list\n"
"    if (btn) { btn.style.background='#2ecc71'; btn.textContent='✓'; }\n"
"    setTimeout(updatePlayers, 300);\n"
"  } else {\n"
"    if (btn) { btn.disabled=false; btn.style.background='#e74c3c'; btn.textContent='Set'; }\n"
"    alert('Failed: ' + (data.error || 'unknown'));\n"
"  }\n"
"} catch(e) {\n"
"  if (btn) { btn.disabled=false; btn.textContent='Set'; }\n"
"  alert('Request failed: ' + e.message);\n"
"}\n"
"}\n"
"async function spawnShip() {\n"
"const x = parseFloat(document.getElementById('spawn-x').value) || 400;\n"
"const y = parseFloat(document.getElementById('spawn-y').value) || 400;\n"
"const company = parseInt(document.getElementById('spawn-company').value);\n"
"const btn = document.querySelector('.spawn-btn');\n"
"const resultEl = document.getElementById('spawn-result');\n"
"btn.disabled = true;\n"
"resultEl.style.display = 'none';\n"
"try {\n"
"const r = await fetch('/api/admin/ship', {\n"
"  method: 'POST',\n"
"  headers: {'Content-Type': 'application/json'},\n"
"  body: JSON.stringify({x, y, company})\n"
"});\n"
"const data = await r.json();\n"
"if (data.success) {\n"
"  resultEl.className = 'spawn-result ok';\n"
"  resultEl.textContent = `✅ Ship #${data.shipId} spawned at (${x}, ${y})`;\n"
"} else {\n"
"  resultEl.className = 'spawn-result err';\n"
"  resultEl.textContent = `❌ ${data.error || 'Unknown error'}`;\n"
"}\n"
"} catch(e) {\n"
"resultEl.className = 'spawn-result err';\n"
"resultEl.textContent = '❌ Request failed: ' + e.message;\n"
"}\n"
"resultEl.style.display = 'block';\n"
"btn.disabled = false;\n"
"refreshAll();\n"
"}\n"
"async function spawnPhantomBrig() {\n"
"const x = parseFloat(document.getElementById('pbrig-x').value) || 400;\n"
"const y = parseFloat(document.getElementById('pbrig-y').value) || 400;\n"
"const resultEl = document.getElementById('pbrig-result');\n"
"resultEl.style.display = 'none';\n"
"try {\n"
"const r = await fetch('/api/admin/phantom-brig', {\n"
"  method: 'POST',\n"
"  headers: {'Content-Type': 'application/json'},\n"
"  body: JSON.stringify({x, y})\n"
"});\n"
"const data = await r.json();\n"
"if (data.success) {\n"
"  resultEl.className = 'spawn-result ok';\n"
"  resultEl.textContent = `✅ Phantom Brig #${data.shipId} spawned at (${x}, ${y})`;\n"
"} else {\n"
"  resultEl.className = 'spawn-result err';\n"
"  resultEl.textContent = `❌ ${data.error || 'Unknown error'}`;\n"
"}\n"
"} catch(e) {\n"
"resultEl.className = 'spawn-result err';\n"
"resultEl.textContent = '❌ Request failed: ' + e.message;\n"
"}\n"
"resultEl.style.display = 'block';\n"
"refreshAll();\n"
"}\n"
"refreshAll(); setInterval(refreshAll, 2000);\n"
"</script>\n"
"</body></html>";

int admin_server_init(struct AdminServer* admin, uint16_t port) {
    if (!admin) return -1;
    
    memset(admin, 0, sizeof(struct AdminServer));
    admin->port = port;
    admin->running = true;
    admin->start_time = get_time_ms();
    
    // Create HTTP socket
    admin->socket_fd = socket(AF_INET, SOCK_STREAM, 0);
    if (admin->socket_fd < 0) {
        log_error("Failed to create admin socket: %s", strerror(errno));
        return -1;
    }
    
    // Set socket options
    int reuse = 1;
    if (setsockopt(admin->socket_fd, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse)) < 0) {
        log_warn("Failed to set SO_REUSEADDR on admin socket: %s", strerror(errno));
    }
    
    // Set non-blocking
    int flags = fcntl(admin->socket_fd, F_GETFL, 0);
    if (flags == -1 || fcntl(admin->socket_fd, F_SETFL, flags | O_NONBLOCK) == -1) {
        log_error("Failed to set admin socket non-blocking: %s", strerror(errno));
        close(admin->socket_fd);
        return -1;
    }
    
    // Bind socket
    struct sockaddr_in addr = {0};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = INADDR_ANY;
    addr.sin_port = htons(port);
    
    if (bind(admin->socket_fd, (struct sockaddr*)&addr, sizeof(addr)) < 0) {
        log_error("Failed to bind admin socket to port %u: %s", port, strerror(errno));
        close(admin->socket_fd);
        return -1;
    }
    
    // Start listening
    if (listen(admin->socket_fd, ADMIN_MAX_CONNECTIONS) < 0) {
        log_error("Failed to listen on admin socket: %s", strerror(errno));
        close(admin->socket_fd);
        return -1;
    }
    
    log_info("Admin server initialized on port %u", port);
    return 0;
}

void admin_server_cleanup(struct AdminServer* admin) {
    if (!admin) return;
    
    log_info("📋 Starting admin server cleanup...");
    
    // Stop accepting new connections
    admin->running = false;
    
    if (admin->socket_fd >= 0) {
        // Shutdown the socket gracefully
        shutdown(admin->socket_fd, SHUT_RDWR);
        close(admin->socket_fd);
        admin->socket_fd = -1;
        log_info("🔌 Admin server socket closed");
    }
    
    log_info("✅ Admin server cleanup complete");
}

int admin_server_update(struct AdminServer* admin, const struct Sim* sim,
                       const struct NetworkManager* net_mgr) {
    if (!admin || !admin->running) return 0;
    
    // Accept new connections (simplified)
    struct sockaddr_in client_addr;
    socklen_t addr_len = sizeof(client_addr);
    int client_fd = accept(admin->socket_fd, (struct sockaddr*)&client_addr, &addr_len);
    
    if (client_fd >= 0) {
        // Handle simple HTTP requests
        char buffer[4096];
        ssize_t received = recv(client_fd, buffer, sizeof(buffer) - 1, 0);
        if (received > 0) {
            buffer[received] = '\0';
            
            // Parse request path for GET
            char *path_start = strstr(buffer, "GET ");
            char *post_start = strstr(buffer, "POST ");
            if (path_start) {
                path_start += 4;
                char *path_end = strchr(path_start, ' ');
                if (path_end) {
                    *path_end = '\0';
                    
                    // Route requests
                    struct HttpResponse resp = {0};
                    if (strcmp(path_start, "/") == 0) {
                        admin_serve_dashboard(&resp);
                    } else if (strcmp(path_start, "/api/status") == 0) {
                        admin_api_status(&resp, sim, net_mgr);
                    } else if (strcmp(path_start, "/api/physics") == 0) {
                        admin_api_physics_objects(&resp, sim);
                    } else if (strcmp(path_start, "/api/network") == 0) {
                        admin_api_network_stats(&resp, net_mgr);
                    } else if (strcmp(path_start, "/api/map") == 0) {
                        admin_api_map_data(&resp, sim);
                    } else if (strcmp(path_start, "/api/messages") == 0) {
                        admin_api_message_stats(&resp);
                    } else if (strcmp(path_start, "/api/input-tiers") == 0) {
                        admin_api_input_tiers(&resp);
                    } else if (strcmp(path_start, "/api/websocket") == 0) {
                        admin_api_websocket_entities(&resp);
                    } else {
                        resp.status_code = 404;
                        resp.body = "Not Found";
                        resp.body_length = 9;
                    }
                    
                    admin_send_response(client_fd, &resp);
                }
            } else if (post_start) {
                post_start += 5;
                char *path_end = strchr(post_start, ' ');
                if (path_end) {
                    // Search for the body BEFORE null-terminating the path, so strstr
                    // on the full buffer still works (inserting '\0' would cut it short).
                    char *body = strstr(path_end, "\r\n\r\n");
                    if (body) body += 4;

                    *path_end = '\0';

                    struct HttpResponse resp = {0};
                    if (strcmp(post_start, "/api/admin/ship") == 0) {
                        float x = 400.0f, y = 400.0f;
                        uint8_t company = 1; // COMPANY_PIRATES default
                        if (body) {
                            char *p;
                            p = strstr(body, "\"x\"");
                            if (p) { p = strchr(p, ':'); if (p) x = (float)atof(p + 1); }
                            p = strstr(body, "\"y\"");
                            if (p) { p = strchr(p, ':'); if (p) y = (float)atof(p + 1); }
                            p = strstr(body, "\"company\"");
                            if (p) { p = strchr(p, ':'); if (p) company = (uint8_t)atoi(p + 1); }
                        }
                        admin_api_create_ship(&resp, x, y, company);
                    } else if (strcmp(post_start, "/api/admin/phantom-brig") == 0) {
                        float x = 400.0f, y = 400.0f;
                        if (body) {
                            char *p;
                            p = strstr(body, "\"x\"");
                            if (p) { p = strchr(p, ':'); if (p) x = (float)atof(p + 1); }
                            p = strstr(body, "\"y\"");
                            if (p) { p = strchr(p, ':'); if (p) y = (float)atof(p + 1); }
                        }
                        admin_api_create_phantom_brig(&resp, x, y);
                    } else if (strcmp(post_start, "/api/admin/player/company") == 0) {
                        uint32_t player_id = 0;
                        uint8_t company = 0;
                        if (body) {
                            char *p;
                            p = strstr(body, "\"playerId\"");
                            if (p) { p = strchr(p, ':'); if (p) player_id = (uint32_t)atoi(p + 1); }
                            p = strstr(body, "\"company\"");
                            if (p) { p = strchr(p, ':'); if (p) company = (uint8_t)atoi(p + 1); }
                        }
                        admin_api_set_player_company(&resp, player_id, company);
                    } else {
                        resp.status_code = 404;
                        resp.body = "Not Found";
                        resp.body_length = 9;
                    }
                    admin_send_response(client_fd, &resp);
                }
            }
        }
        close(client_fd);
    }
    
    return 0;
}

int admin_parse_request(const char* request_data, size_t length, struct HttpRequest* req) {
    (void)request_data; (void)length; (void)req;
    return 0;  // Simplified
}

int admin_handle_request(const struct HttpRequest* req, struct HttpResponse* resp,
                        const struct Sim* sim, const struct NetworkManager* net_mgr) {
    (void)req; (void)resp; (void)sim; (void)net_mgr;
    return 0;  // Simplified
}

int admin_send_response(int client_fd, const struct HttpResponse* resp) {
    if (client_fd < 0 || !resp) return -1;
    
    char response_buffer[8192];
    int header_len = snprintf(response_buffer, sizeof(response_buffer),
        "HTTP/1.1 %d %s\r\n"
        "Content-Type: %s\r\n"
        "Content-Length: %zu\r\n"
        "Connection: close\r\n"
        "\r\n",
        resp->status_code,
        resp->status_code == 200 ? "OK" : "Not Found",
        resp->content_type ? resp->content_type : "text/plain",
        resp->body_length
    );
    
    // Send headers
    send(client_fd, response_buffer, header_len, 0);
    
    // Send body if present
    if (resp->body && resp->body_length > 0) {
        send(client_fd, resp->body, resp->body_length, 0);
    }
    
    return 0;
}

int admin_serve_dashboard(struct HttpResponse* resp) {
    if (!resp) return -1;
    
    resp->status_code = 200;
    resp->content_type = "text/html";
    resp->body = dashboard_html;
    resp->body_length = strlen(dashboard_html);
    resp->cache_control = false;
    
    return 0;
}