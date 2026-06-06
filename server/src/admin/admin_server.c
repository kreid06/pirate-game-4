#include "admin/admin_server.h"
#include "sim/types.h"
#include "net/network.h"
#include "net/claim.h"
#include "util/log.h"
#include "util/time.h"
#include "sim/world_save.h"
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
"<div style=\"margin-bottom:8px;display:flex;gap:18px;align-items:center\">\n"
"<label style=\"color:#ccc;font-size:0.9rem;cursor:pointer\">"
"<input type=\"checkbox\" id=\"chk-claim-areas\" checked style=\"margin-right:6px\">Show Claim Areas</label>\n"
"<label style=\"color:#ccc;font-size:0.9rem;cursor:pointer\">"
"<input type=\"checkbox\" id=\"chk-struct-ids\" checked style=\"margin-right:6px\">Show IDs</label>\n"
"<label style=\"color:#ccc;font-size:0.9rem;cursor:pointer\">"
"<input type=\"checkbox\" id=\"chk-contest-zones\" checked style=\"margin-right:6px\">Show Contest Pairs</label>\n"
"</div>\n"
"<div style=\"display:flex;gap:12px;align-items:flex-start\">\n"
"<div id=\"map-container\" style=\"flex:1;min-width:0\">\n"
"<canvas id=\"map-canvas\" width=\"800\" height=\"400\"></canvas>\n"
"</div>\n"
"<div id=\"contest-panel\" style=\"width:260px;flex-shrink:0\">\n"
"<details id=\"contest-details\" open>\n"
"<summary style=\"cursor:pointer;color:#eee;font-weight:bold;padding:6px 8px;"
"background:rgba(255,255,255,0.08);border-radius:4px;user-select:none;"
"display:flex;justify-content:space-between;align-items:center\">\n"
"&#x2694; Contest Pairs"
"<span id=\"contest-count\" style=\"color:#ffd86e;font-size:0.85rem;font-weight:normal;margin-left:6px\">(0)</span>\n"
"</summary>\n"
"<div id=\"contest-list\" style=\"max-height:420px;overflow-y:auto;margin-top:6px;font-size:0.82rem\">\n"
"<div style=\"text-align:center;color:#666;padding:10px\">No active contests</div>\n"
"</div></details></div>\n"
"</div></div>\n"
"</div></div>\n"
"<script>\n"
"let mapCanvas, mapCtx, mapData = null;\n"
"let mapOffsetX = 0, mapOffsetY = 0, mapScale = 0.5;\n"
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
"// Size canvas pixel buffer to match its container\n"
"const mc = document.getElementById('map-container');\n"
"if (mc) { mapCanvas.width = mc.offsetWidth; mapCanvas.height = mc.offsetHeight; }\n"
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
"// Scroll to zoom (centered on mouse position)\n"
"mapCanvas.addEventListener('wheel', (e) => {\n"
"e.preventDefault();\n"
"const rect = mapCanvas.getBoundingClientRect();\n"
"const mx = e.clientX - rect.left;\n"
"const my = e.clientY - rect.top;\n"
"const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;\n"
"mapOffsetX = mx - factor * (mx - mapOffsetX);\n"
"mapOffsetY = my - factor * (my - mapOffsetY);\n"
"mapScale = Math.max(0.05, Math.min(5, mapScale * factor));\n"
"drawMap();\n"
"}, { passive: false });\n"
"updateMap();\n"
"}\n"
"// Auto-fit viewport to encompass all islands and structures\n"
"function fitAll() {\n"
"if (!mapData || !mapData.islands || !mapCanvas) return;\n"
"let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;\n"
"mapData.islands.forEach(isl => {\n"
"const pad=(isl.vertices&&isl.vertices.length)?3600:((isl.beachRadius||200)+(isl.beachMaxBump||25)+150);\n"
"minX=Math.min(minX,isl.x-pad); minY=Math.min(minY,isl.y-pad);\n"
"maxX=Math.max(maxX,isl.x+pad); maxY=Math.max(maxY,isl.y+pad);\n"
"});\n"
"if (mapData.structures) mapData.structures.forEach(s => {\n"
"minX=Math.min(minX,s.x-700); minY=Math.min(minY,s.y-700);\n"
"maxX=Math.max(maxX,s.x+700); maxY=Math.max(maxY,s.y+700);\n"
"});\n"
"if (!isFinite(minX)) return;\n"
"const worldW=maxX-minX, worldH=maxY-minY;\n"
"const scaleX=mapCanvas.width/worldW, scaleY=mapCanvas.height/worldH;\n"
"mapScale=Math.min(scaleX,scaleY)*0.88;\n"
"mapOffsetX=mapCanvas.width/2-(minX+maxX)/2*mapScale;\n"
"mapOffsetY=mapCanvas.height/2-(minY+maxY)/2*mapScale;\n"
"}\n"
"async function updateMap() {\n"
"if (!mapCanvas) return;\n"
"const data = await fetchJson('/api/map');\n"
"if (!data) return;\n"
"const firstLoad = !mapData;\n"
"mapData = data;\n"
"if (firstLoad) fitAll();\n"
"drawMap();\n"
"updateContestTable();\n"
"}\n"
"function updateContestTable() {\n"
"  const list = document.getElementById('contest-list');\n"
"  const countEl = document.getElementById('contest-count');\n"
"  if (!list || !mapData || !mapData.structures) return;\n"
"  const CNAME = { 0:'Neutral', 1:'Solo', 2:'Pirates', 3:'Navy', 99:'Ghost' };\n"
"  const CCSS  = { 0:'#8c8c8c', 1:'#ffcc44', 2:'#e74c3c', 3:'#3498db', 99:'#9b59b6' };\n"
"  const allById = {};\n"
"  mapData.structures.forEach(s => { allById[s.id] = s; });\n"
"  // Collect deduplicated pairs and group by company-pair section\n"
"  const sections = new Map(); // 'cidA_cidB' -> { cidA, cidB, pairs[] }\n"
"  const seen = new Set();\n"
"  mapData.structures.forEach(s => {\n"
"    if (!s.dominators || !s.dominators.length) return;\n"
"    s.dominators.forEach(did => {\n"
"      const dom = allById[did]; if (!dom) return;\n"
"      const pairKey = `${Math.min(s.id,did)}_${Math.max(s.id,did)}`;\n"
"      if (seen.has(pairKey)) return; seen.add(pairKey);\n"
"      const ca = s.company_id||0, cb = dom.company_id||0;\n"
"      const sectKey = `${Math.min(ca,cb)}_${Math.max(ca,cb)}`;\n"
"      if (!sections.has(sectKey)) sections.set(sectKey,{cidA:Math.min(ca,cb),cidB:Math.max(ca,cb),pairs:[]});\n"
"      sections.get(sectKey).pairs.push({ a: s, b: dom });\n"
"    });\n"
"  });\n"
"  const totalPairs = [...sections.values()].reduce((n,s)=>n+s.pairs.length,0);\n"
"  if (countEl) countEl.textContent = `(${sections.size} section${sections.size!==1?'s':''}, ${totalPairs} pair${totalPairs!==1?'s':''})`;\n"
"  if (!sections.size) {\n"
"    list.innerHTML = '<div style=\"text-align:center;color:#666;padding:10px\">No active contests</div>';\n"
"    return;\n"
"  }\n"
"  const shorten = t => t.replace(/_/g,' ').replace('wooden ','').replace('company ','co.');\n"
"  list.innerHTML = [...sections.values()].map(({cidA,cidB,pairs}) => {\n"
"    const colA=CCSS[cidA]||'#aaa', colB=CCSS[cidB]||'#aaa';\n"
"    const nmA=CNAME[cidA]||`cid${cidA}`, nmB=CNAME[cidB]||`cid${cidB}`;\n"
"    const pairRows = pairs.map(({a,b}) =>\n"
"      `<div style=\"padding:3px 8px 3px 14px;display:flex;gap:6px;border-bottom:1px solid #222\">\n"
"        <span style=\"font-family:monospace;color:#ffe;flex-shrink:0\">#${a.id}&#x2194;#${b.id}</span>\n"
"        <span style=\"color:#888;font-size:0.78rem\">${shorten(a.type)} / ${shorten(b.type)}</span>\n"
"      </div>`\n"
"    ).join('');\n"
"    // Active claim flags targeting this section\n"
"    const flags = mapData.structures.filter(f => {\n"
"      if (f.type !== 'claim_flag') return false;\n"
"      const mine  = allById[f.claim_linked_fort];\n"
"      const enemy = allById[f.claim_source_enemy];\n"
"      if (!mine || !enemy) return false;\n"
"      const fc = mine.company_id||0, ec = enemy.company_id||0;\n"
"      return Math.min(fc,ec)===cidA && Math.max(fc,ec)===cidB;\n"
"    });\n"
"    const flagRows = flags.map(f => {\n"
"      const pct = f.max_hp > 0 ? Math.round((1 - f.hp/f.max_hp)*100) : 0;\n"
"      const stateNames = {0:'Contest',1:'Grace',2:'Claiming',3:'Rev.Grace',4:'Reversing'};\n"
"      const CCSS_F = { 0:'#8c8c8c', 1:'#ffcc44', 2:'#e74c3c', 3:'#3498db', 99:'#9b59b6' };\n"
"      const col = CCSS_F[f.company_id||0]||'#aaa';\n"
"      const barW = Math.round(pct * 0.9);\n"
"      return `<div style=\"padding:4px 8px 4px 14px;border-bottom:1px solid #1a1a1a;display:flex;\n"
"        flex-direction:column;gap:2px\">\n"
"        <div style=\"display:flex;align-items:center;gap:6px\">\n"
"          <span style=\"color:${col};font-size:0.8rem\">&#x2691; Flag #${f.id}</span>\n"
"          <span style=\"color:#888;font-size:0.75rem\">${stateNames[f.claim_state]||f.claim_state}</span>\n"
"          <span style=\"color:#aaa;font-size:0.75rem;margin-left:auto\">${pct}%</span>\n"
"        </div>\n"
"        <div style=\"height:4px;background:#333;border-radius:2px\">\n"
"          <div style=\"height:4px;width:${barW}%;background:${col};border-radius:2px\"></div>\n"
"        </div>\n"
"      </div>`;\n"
"    }).join('');\n"
"    return `<details open style=\"margin-bottom:4px;background:rgba(255,255,255,0.04);border-radius:4px\">\n"
"      <summary style=\"cursor:pointer;padding:6px 8px;list-style:none;display:flex;\n"
"        justify-content:space-between;align-items:center;border-radius:4px;\n"
"        background:rgba(255,255,255,0.06)\">\n"
"        <label style=\"display:flex;align-items:center;gap:6px;cursor:pointer\" onclick=\"event.stopPropagation()\">\n"
"          <input type=\"checkbox\" id=\"chk-sect-${cidA}-${cidB}\" checked\n"
"            onchange=\"event.stopPropagation();drawMap()\" style=\"cursor:pointer;margin:0\">\n"
"          <span><span style=\"color:${colA};font-weight:bold\">${nmA}</span>\n"
"          <span style=\"color:#ffd86e;margin:0 4px\">&#x2694;</span>\n"
"          <span style=\"color:${colB};font-weight:bold\">${nmB}</span></span>\n"
"        </label>\n"
"        <span style=\"color:#888;font-size:0.78rem\">${pairs.length} pair${pairs.length!==1?'s':''}</span>\n"
"      </summary>\n"
"      ${flagRows}\n"
"      ${pairRows}\n"
"    </details>`;\n"
"  }).join('');\n"
"}\n"
"// Company colors for claim territory rendering\n"
"const CLAIM_COMPANY_FILL = {\n"
"  0: 'rgba(140,140,140,0.22)',  // unclaimed\n"
"  1: 'rgba(255,204,68,0.22)',   // solo (gold)\n"
"  2: 'rgba(231,76,60,0.22)',    // pirates (red)\n"
"  3: 'rgba(52,152,219,0.22)',   // navy (blue)\n"
"};\n"
"const CLAIM_COMPANY_STROKE = {\n"
"  0: 'rgba(140,140,140,0.75)',\n"
"  1: 'rgba(255,204,68,0.85)',\n"
"  2: 'rgba(231,76,60,0.85)',\n"
"  3: 'rgba(52,152,219,0.85)',\n"
"};\n"
"const CLAIM_COMPANY_SOLID = {\n"
"  0: [140,140,140],\n"
"  1: [255,204,68],\n"
"  2: [231,76,60],\n"
"  3: [52,152,219],\n"
"};\n"
"function claimRadius(type) {\n"
"  return (type === 'flag_fort' || type === 'company_fortress') ? 600 : 400;\n"
"}\n"
"// Draw dominance-aware claim territories onto the main canvas using\n"
"// per-disc offscreen compositing to carve enemy-dominator areas.\n"
"function drawClaimAreas(ctx) {\n"
"  if (!mapData || !mapData.structures) return;\n"
"  const chk = document.getElementById('chk-claim-areas');\n"
"  if (chk && !chk.checked) return;\n"
"  const W = mapCanvas.width, H = mapCanvas.height;\n"
"  // Border width in screen pixels (scales with zoom)\n"
"  const BORDER_PX = Math.max(4, Math.round(10 * mapScale));\n"
"  // Convert world coords/radius to screen space\n"
"  function sx(wx) { return wx * mapScale + mapOffsetX; }\n"
"  function sy(wy) { return wy * mapScale + mapOffsetY; }\n"
"  function sr(r)  { return r  * mapScale; }\n"
"  // Build id -> structure lookup\n"
"  const allById = {};\n"
"  mapData.structures.forEach(s => { allById[s.id] = s; });\n"
"  // DOM-eligible types have dominator carving\n"
"  const DOM_ELIGIBLE = new Set(['wooden_floor','flag_fort','company_fortress']);\n"
"  // Group non-orphaned company structures by company_id\n"
"  const byCompany = {};\n"
"  mapData.structures.forEach(s => {\n"
"    if (s.type === 'claim_flag') return;\n"
"    if (s.claim_orphaned) return;\n"
"    const cid = s.company_id || 0;\n"
"    if (!cid) return;\n"
"    if (!byCompany[cid]) byCompany[cid] = [];\n"
"    byCompany[cid].push(s);\n"
"  });\n"
"  const companies = Object.keys(byCompany).map(Number);\n"
"  if (!companies.length) return;\n"
"  // Helper: build a white-on-transparent mask canvas from a set of discs\n"
"  // (union of all discs, no color — used as a stencil)\n"
"  function buildUnionMask(structs) {\n"
"    const cv = document.createElement('canvas');\n"
"    cv.width = W; cv.height = H;\n"
"    const c = cv.getContext('2d');\n"
"    for (const s of structs) {\n"
"      const domElig = DOM_ELIGIBLE.has(s.type);\n"
"      if (domElig && s.dominators && s.dominators.length > 0) {\n"
"        // Per-disc canvas so destination-out only carves this disc\n"
"        const dc = document.createElement('canvas');\n"
"        dc.width = W; dc.height = H;\n"
"        const dctx = dc.getContext('2d');\n"
"        dctx.fillStyle = 'white';\n"
"        dctx.beginPath(); dctx.arc(sx(s.x), sy(s.y), sr(claimRadius(s.type)), 0, 2*Math.PI); dctx.fill();\n"
"        dctx.globalCompositeOperation = 'destination-out';\n"
"        s.dominators.forEach(did => {\n"
"          const dom = allById[did];\n"
"          if (!dom || (dom.company_id || 0) === (s.company_id || 0)) return;\n"
"          dctx.beginPath(); dctx.arc(sx(dom.x), sy(dom.y), sr(claimRadius(dom.type)), 0, 2*Math.PI); dctx.fill();\n"
"        });\n"
"        c.drawImage(dc, 0, 0);\n"
"      } else {\n"
"        c.fillStyle = 'white';\n"
"        c.beginPath(); c.arc(sx(s.x), sy(s.y), sr(claimRadius(s.type)), 0, 2*Math.PI); c.fill();\n"
"      }\n"
"    }\n"
"    return cv;\n"
"  }\n"
"  // Helper: colorize a mask canvas with a given rgba fill\n"
"  function colorize(maskCv, r, g, b, a) {\n"
"    const cv = document.createElement('canvas');\n"
"    cv.width = W; cv.height = H;\n"
"    const c = cv.getContext('2d');\n"
"    c.fillStyle = `rgba(${r},${g},${b},${a})`;\n"
"    c.fillRect(0, 0, W, H);\n"
"    c.globalCompositeOperation = 'destination-in';\n"
"    c.drawImage(maskCv, 0, 0);\n"
"    return cv;\n"
"  }\n"
"  // Build a raw (uncarved) union mask for a set of structures\n"
"  function buildRawUnion(structs) {\n"
"    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;\n"
"    const c = cv.getContext('2d'); c.fillStyle = 'white';\n"
"    structs.forEach(s => { c.beginPath(); c.arc(sx(s.x), sy(s.y), sr(claimRadius(s.type)), 0, 2*Math.PI); c.fill(); });\n"
"    return cv;\n"
"  }\n"
"  for (const cid of companies) {\n"
"    const structs = byCompany[cid];\n"
"    const rgb = CLAIM_COMPANY_SOLID[cid] || [150,150,150];\n"
"    // Build union fill mask\n"
"    const unionMask = buildUnionMask(structs);\n"
"    // Build border mask = dilated union - union\n"
"    const borderMask = document.createElement('canvas');\n"
"    borderMask.width = W; borderMask.height = H;\n"
"    const bmc = borderMask.getContext('2d');\n"
"    bmc.fillStyle = 'white';\n"
"    structs.forEach(s => {\n"
"      bmc.beginPath();\n"
"      bmc.arc(sx(s.x), sy(s.y), sr(claimRadius(s.type)) + BORDER_PX, 0, 2*Math.PI);\n"
"      bmc.fill();\n"
"    });\n"
"    bmc.globalCompositeOperation = 'destination-out';\n"
"    bmc.drawImage(unionMask, 0, 0);\n"
"    // Draw colored fill (semi-transparent)\n"
"    const fillCv = colorize(unionMask, rgb[0], rgb[1], rgb[2], 0.20);\n"
"    ctx.save(); ctx.setTransform(1,0,0,1,0,0); ctx.drawImage(fillCv, 0, 0); ctx.restore();\n"
"    // Draw colored border (solid)\n"
"    const borderCv = colorize(borderMask, rgb[0], rgb[1], rgb[2], 0.85);\n"
"    ctx.save(); ctx.setTransform(1,0,0,1,0,0); ctx.drawImage(borderCv, 0, 0); ctx.restore();\n"
"  }\n"
"  // ── Contest sections: raw union intersection per company pair ──\n"
"  const chkCS = document.getElementById('chk-contest-zones');\n"
"  if (!chkCS || chkCS.checked) {\n"
"    const CNAME_S = {0:'Neutral',1:'Solo',2:'Pirates',3:'Navy',99:'Ghost'};\n"
"    const sectSeen = new Set();\n"
"    companies.forEach(cid => {\n"
"      (byCompany[cid]||[]).forEach(s => {\n"
"        if (!s.dominators) return;\n"
"        s.dominators.forEach(did => {\n"
"          const dom = allById[did]; if (!dom) return;\n"
"          const oc = dom.company_id||0; if (!oc || oc === cid) return;\n"
"          const sk = `${Math.min(cid,oc)}_${Math.max(cid,oc)}`;\n"
"          if (sectSeen.has(sk)) return; sectSeen.add(sk);\n"
"          const cidA = Math.min(cid,oc), cidB = Math.max(cid,oc);\n"
"          const sA = byCompany[cidA]||[], sB = byCompany[cidB]||[];\n"
"          if (!sA.length || !sB.length) return;\n"
"          // Skip if this section's highlight checkbox is unchecked\n"
"          const sectChk = document.getElementById(`chk-sect-${cidA}-${cidB}`);\n"
"          if (sectChk && !sectChk.checked) return;\n"
"          // Intersection of raw unions = contested zone\n"
"          const rawA = buildRawUnion(sA), rawB = buildRawUnion(sB);\n"
"          const isect = document.createElement('canvas'); isect.width=W; isect.height=H;\n"
"          const ic = isect.getContext('2d');\n"
"          ic.drawImage(rawA,0,0); ic.globalCompositeOperation='destination-in'; ic.drawImage(rawB,0,0);\n"
"          // Hatch overlay — diagonal stripes clipped to intersection\n"
"          const hatch = document.createElement('canvas'); hatch.width=W; hatch.height=H;\n"
"          const hc = hatch.getContext('2d');\n"
"          const stripe = document.createElement('canvas'); stripe.width=8; stripe.height=8;\n"
"          const sc = stripe.getContext('2d');\n"
"          sc.strokeStyle='rgba(255,210,0,0.55)'; sc.lineWidth=2;\n"
"          sc.beginPath(); sc.moveTo(0,8); sc.lineTo(8,0); sc.stroke();\n"
"          sc.beginPath(); sc.moveTo(-4,8); sc.lineTo(4,0); sc.stroke();\n"
"          sc.beginPath(); sc.moveTo(4,8); sc.lineTo(12,0); sc.stroke();\n"
"          hc.fillStyle = hc.createPattern(stripe,'repeat');\n"
"          hc.fillRect(0,0,W,H);\n"
"          hc.globalCompositeOperation='destination-in'; hc.drawImage(isect,0,0);\n"
"          ctx.save(); ctx.setTransform(1,0,0,1,0,0); ctx.drawImage(hatch,0,0); ctx.restore();\n"
"          // Section label at centroid of overlapping disc midpoints\n"
"          const ols = [];\n"
"          sA.forEach(a => { sB.forEach(b => {\n"
"            const dx=a.x-b.x, dy=a.y-b.y, rs=claimRadius(a.type)+claimRadius(b.type);\n"
"            if (dx*dx+dy*dy < rs*rs) ols.push([(a.x+b.x)/2,(a.y+b.y)/2]);\n"
"          }); });\n"
"          if (!ols.length) return;\n"
"          const lxw=ols.reduce((t,p)=>t+p[0],0)/ols.length;\n"
"          const lyw=ols.reduce((t,p)=>t+p[1],0)/ols.length;\n"
"          const lx=lxw*mapScale+mapOffsetX, ly=lyw*mapScale+mapOffsetY;\n"
"          const rgbA=CLAIM_COMPANY_SOLID[cidA]||[150,150,150];\n"
"          const rgbB=CLAIM_COMPANY_SOLID[cidB]||[150,150,150];\n"
"          const lbl=`${CNAME_S[cidA]||cidA} \\u2694 ${CNAME_S[cidB]||cidB}`;\n"
"          const fs=Math.max(9,Math.min(13,Math.round(11*mapScale)));\n"
"          ctx.save(); ctx.setTransform(1,0,0,1,0,0);\n"
"          ctx.font=`bold ${fs}px sans-serif`;\n"
"          const tw=ctx.measureText(lbl).width, pad=5, bh=fs+pad*2, bw=tw+pad*2;\n"
"          ctx.fillStyle='rgba(15,15,15,0.88)';\n"
"          ctx.beginPath(); ctx.roundRect(lx-bw/2,ly-bh/2,bw,bh,4); ctx.fill();\n"
"          // Two-tone border: left half company A color, right half company B color\n"
"          ctx.strokeStyle=`rgba(${rgbA[0]},${rgbA[1]},${rgbA[2]},0.9)`;\n"
"          ctx.lineWidth=1.5; ctx.stroke();\n"
"          ctx.fillStyle='rgba(255,230,80,0.95)';\n"
"          ctx.textAlign='center'; ctx.textBaseline='middle';\n"
"          ctx.fillText(lbl,lx,ly);\n"
"          ctx.restore();\n"
"        });\n"
"      });\n"
"    });\n"
"  }\n"
"  // ── Fort / fortress icons drawn in world space ──\n"
"  mapData.structures.forEach(s => {\n"
"    if (s.type !== 'flag_fort' && s.type !== 'company_fortress') return;\n"
"    const cid = s.company_id || 0;\n"
"    const rgb = CLAIM_COMPANY_SOLID[cid] || [150,150,150];\n"
"    ctx.fillStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},1)`;\n"
"    ctx.beginPath(); ctx.arc(s.x, s.y, 14, 0, 2*Math.PI); ctx.fill();\n"
"    ctx.strokeStyle = 'rgba(0,0,0,0.7)'; ctx.lineWidth = 2; ctx.stroke();\n"
"    ctx.font = 'bold 12px sans-serif';\n"
"    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';\n"
"    ctx.fillStyle = 'white';\n"
"    ctx.fillText(s.type === 'flag_fort' ? '\\u2691' : '\\u2302', s.x, s.y);\n"
"    ctx.textBaseline = 'alphabetic';\n"
"    ctx.font = '10px sans-serif'; ctx.fillStyle = 'white';\n"
"    ctx.fillText(`${s.hp}/${s.max_hp}`, s.x, s.y + 24);\n"
"  });\n"
"  // ── Claim flag markers (pole + pennant + progress ring, screen-space) ──\n"
"  mapData.structures.filter(s => s.type === 'claim_flag').forEach(s => {\n"
"    const cid = s.company_id || 0;\n"
"    const rgb = CLAIM_COMPANY_SOLID[cid] || [150,150,150];\n"
"    const state = s.claim_state ?? 0;\n"
"    // State-based arc/ring color\n"
"    let arcR = rgb[0], arcG = rgb[1], arcB = rgb[2];\n"
"    if      (state === 0) { arcR=136; arcG=136; arcB=136; }  // CONTEST: grey\n"
"    else if (state === 1) { arcR=255; arcG=210; arcB=74;  }  // CLAIMING_GRACE: yellow\n"
"    else if (state === 3) { arcR=255; arcG=153; arcB=102; }  // REVERSING_GRACE: orange\n"
"    else if (state === 4) { arcR=255; arcG=48;  arcB=48;  }  // REVERSING: red\n"
"    // Section label from linked structures\n"
"    const mineStruct  = allById[s.claim_linked_fort];\n"
"    const enemyStruct = allById[s.claim_source_enemy];\n"
"    const CNAME_F = {0:'Neutral',1:'Solo',2:'Pirates',3:'Navy',99:'Ghost'};\n"
"    const mineC  = mineStruct  ? (mineStruct.company_id||0)  : cid;\n"
"    const enemyC = enemyStruct ? (enemyStruct.company_id||0) : 0;\n"
"    const sectLabel = enemyC ? `${CNAME_F[mineC]||mineC}\\u2192${CNAME_F[enemyC]||enemyC}` : null;\n"
"    // Progress: hp counts down from max_hp (ms) to 0 = captured\n"
"    const pct = s.max_hp > 0 ? Math.max(0, Math.min(1, 1 - s.hp / s.max_hp)) : 0;\n"
"    const secsLeft = Math.round((s.hp||0) / 1000);\n"
"    const mins = Math.floor(secsLeft/60), secs = secsLeft%60;\n"
"    const timerStr = `${mins}:${secs.toString().padStart(2,'0')}`;\n"
"    // ── Draw in screen space (fixed pixel size, zoom-independent) ──\n"
"    ctx.save();\n"
"    ctx.setTransform(1, 0, 0, 1, 0, 0);\n"
"    const fx = sx(s.x), fy = sy(s.y);\n"
"    const R = 12;        // ring radius, px\n"
"    const POLE = 32;     // pole height above ring center, px\n"
"    const ptopY = fy - R - POLE;\n"
"    // Background ring track\n"
"    ctx.strokeStyle = `rgba(${arcR},${arcG},${arcB},0.25)`;\n"
"    ctx.lineWidth = 2.5;\n"
"    ctx.beginPath(); ctx.arc(fx, fy, R, 0, 2*Math.PI); ctx.stroke();\n"
"    // Progress arc (clockwise from top)\n"
"    if (pct > 0) {\n"
"      ctx.strokeStyle = `rgb(${arcR},${arcG},${arcB})`;\n"
"      ctx.lineWidth = 2.5;\n"
"      ctx.beginPath();\n"
"      ctx.arc(fx, fy, R, -Math.PI/2, -Math.PI/2 + pct*2*Math.PI);\n"
"      ctx.stroke();\n"
"    }\n"
"    // Flag pole (dark wood)\n"
"    ctx.strokeStyle = 'rgba(55,35,15,0.9)';\n"
"    ctx.lineWidth = 1.5;\n"
"    ctx.beginPath();\n"
"    ctx.moveTo(fx, fy + R * 0.45);\n"
"    ctx.lineTo(fx, ptopY);\n"
"    ctx.stroke();\n"
"    // Pennant (filled triangle in company color)\n"
"    ctx.fillStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.92)`;\n"
"    ctx.beginPath();\n"
"    ctx.moveTo(fx,      ptopY);\n"
"    ctx.lineTo(fx + 14, ptopY + 7);\n"
"    ctx.lineTo(fx,      ptopY + 13);\n"
"    ctx.closePath();\n"
"    ctx.fill();\n"
"    ctx.strokeStyle = 'rgba(0,0,0,0.4)';\n"
"    ctx.lineWidth = 0.8;\n"
"    ctx.stroke();\n"
"    // Small disc at ring center\n"
"    ctx.fillStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.88)`;\n"
"    ctx.beginPath(); ctx.arc(fx, fy, 5, 0, 2*Math.PI); ctx.fill();\n"
"    ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 1; ctx.stroke();\n"
"    // Section label badge above pennant\n"
"    if (sectLabel) {\n"
"      const fs = Math.max(7, Math.min(10, Math.round(8 * mapScale)));\n"
"      ctx.font = `bold ${fs}px sans-serif`;\n"
"      const tw = ctx.measureText(sectLabel).width;\n"
"      const badgeY = ptopY - fs - 5;\n"
"      ctx.fillStyle = 'rgba(15,15,15,0.85)';\n"
"      ctx.fillRect(fx - tw/2 - 3, badgeY - 1, tw + 6, fs + 2);\n"
"      ctx.fillStyle = 'rgba(255,220,80,0.95)';\n"
"      ctx.textAlign = 'center'; ctx.textBaseline = 'top';\n"
"      ctx.fillText(sectLabel, fx, badgeY);\n"
"    }\n"
"    // Timer text below ring\n"
"    const timerColor = state===4 ? 'rgba(255,80,80,0.95)'\n"
"                     : state===3 ? 'rgba(255,153,102,0.95)'\n"
"                     : state===0 ? 'rgba(180,180,180,0.85)'\n"
"                     : 'rgba(220,220,170,0.9)';\n"
"    ctx.font = '8px sans-serif';\n"
"    ctx.textAlign = 'center'; ctx.textBaseline = 'top';\n"
"    ctx.fillStyle = timerColor;\n"
"    ctx.fillText(timerStr, fx, fy + R + 3);\n"
"    ctx.restore();\n"
"  });\n"
"  // ── Structure IDs (all projector types) ──\n"
"  const chkIds = document.getElementById('chk-struct-ids');\n"
"  if (!chkIds || chkIds.checked) {\n"
"    const projectors = mapData.structures.filter(s =>\n"
"      s.type !== 'claim_flag' && !s.claim_orphaned && (s.company_id || 0) > 0\n"
"    );\n"
"    const pxPerWorld = mapScale;\n"
"    const fontSize = Math.max(8, Math.min(13, Math.round(11 * pxPerWorld)));\n"
"    ctx.save();\n"
"    ctx.setTransform(1, 0, 0, 1, 0, 0);\n"
"    projectors.forEach(s => {\n"
"      const labelX = sx(s.x), labelY = sy(s.y);\n"
"      ctx.font = `bold ${fontSize}px monospace`;\n"
"      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';\n"
"      // Dark shadow for readability\n"
"      ctx.fillStyle = 'rgba(0,0,0,0.7)';\n"
"      ctx.fillText(`#${s.id}`, labelX + 1, labelY + 1);\n"
"      ctx.fillStyle = 'rgba(255,255,255,0.95)';\n"
"      ctx.fillText(`#${s.id}`, labelX, labelY);\n"
"    });\n"
"    ctx.restore();\n"
"  }\n"
"  // ── Contest zone ID pairs ──\n"
"  const chkContest = document.getElementById('chk-contest-zones');\n"
"  if (!chkContest || chkContest.checked) {\n"
"    const allById2 = {};\n"
"    mapData.structures.forEach(s => { allById2[s.id] = s; });\n"
"    const seen = new Set();\n"
"    const pairs = [];\n"
"    mapData.structures.forEach(s => {\n"
"      if (!s.dominators || !s.dominators.length) return;\n"
"      s.dominators.forEach(did => {\n"
"        const dom = allById2[did];\n"
"        if (!dom) return;\n"
"        const key = `${Math.min(s.id, did)}_${Math.max(s.id, did)}`;\n"
"        if (seen.has(key)) return;\n"
"        seen.add(key);\n"
"        pairs.push({ a: s, b: dom });\n"
"      });\n"
"    });\n"
"    if (pairs.length) {\n"
"      ctx.save();\n"
"      ctx.setTransform(1, 0, 0, 1, 0, 0);\n"
"      pairs.forEach(({ a, b }) => {\n"
"        const ax = sx(a.x), ay = sy(a.y);\n"
"        const bx = sx(b.x), by = sy(b.y);\n"
"        const mx = (ax + bx) / 2, my = (ay + by) / 2;\n"
"        // Dashed line connecting the two contested structures\n"
"        ctx.strokeStyle = 'rgba(255,255,255,0.35)';\n"
"        ctx.lineWidth = 1;\n"
"        ctx.setLineDash([4, 4]);\n"
"        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();\n"
"        ctx.setLineDash([]);\n"
"        // Badge at midpoint\n"
"        const label = `#${a.id}\\u2194#${b.id}`;\n"
"        const fs = Math.max(8, Math.min(11, Math.round(9 * mapScale)));\n"
"        ctx.font = `bold ${fs}px monospace`;\n"
"        const tw = ctx.measureText(label).width;\n"
"        const pad = 3, bh = fs + pad * 2, bw = tw + pad * 2;\n"
"        ctx.fillStyle = 'rgba(20,20,20,0.82)';\n"
"        ctx.beginPath();\n"
"        ctx.roundRect(mx - bw/2, my - bh/2, bw, bh, 3);\n"
"        ctx.fill();\n"
"        ctx.strokeStyle = 'rgba(255,220,80,0.8)';\n"
"        ctx.lineWidth = 1;\n"
"        ctx.stroke();\n"
"        ctx.fillStyle = 'rgba(255,220,80,0.95)';\n"
"        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';\n"
"        ctx.fillText(label, mx, my);\n"
"      });\n"
"      ctx.restore();\n"
"    }\n"
"  }\n"
"}\n"
"function drawMap() {\n"
"if (!mapData || !mapCtx) return;\n"
"const ctx = mapCtx;\n"
"// Clear canvas with ocean blue\n"
"ctx.fillStyle = '#2c5aa0'; ctx.fillRect(0, 0, mapCanvas.width, mapCanvas.height);\n"
"ctx.save();\n"
"// Apply pan + zoom\n"
"ctx.translate(mapOffsetX, mapOffsetY);\n"
"ctx.scale(mapScale, mapScale);\n"
"// Draw grid for reference\n"
"ctx.strokeStyle = 'rgba(255,255,255,0.1)';\n"
"ctx.lineWidth = 1;\n"
"for (let i = -500; i < 12000; i += 250) {\n"
"ctx.beginPath(); ctx.moveTo(i, -500); ctx.lineTo(i, 12000); ctx.stroke();\n"
"}\n"
"for (let i = -500; i < 12000; i += 250) {\n"
"ctx.beginPath(); ctx.moveTo(-500, i); ctx.lineTo(12000, i); ctx.stroke();\n"
"}\n"
"// Helper: sample bumpy island boundary (mirrors server island_boundary_r)\n"
"function islandBndR(bumps, baseR, angle) {\n"
"const TWO_PI = Math.PI * 2;\n"
"let a = angle - TWO_PI * Math.floor(angle / TWO_PI);\n"
"const t = a / TWO_PI * 16;\n"
"const i0 = Math.floor(t) % 16;\n"
"const i1 = (i0 + 1) % 16;\n"
"const f = t - Math.floor(t);\n"
"return baseR + bumps[i0] + f * (bumps[i1] - bumps[i0]);\n"
"}\n"
"// Draw islands (behind ships)\n"
"if (mapData.islands) {\n"
"const N = 64;\n"
"const GRASS_POLY_SCALE = 0.82;\n"
"mapData.islands.forEach(isl => {\n"
"if (isl.vertices && isl.vertices.length >= 3) {\n"
"// ── Polygon island (e.g. continental) ──\n"
"// Beach polygon (sand fill)\n"
"ctx.fillStyle = '#c8a85c';\n"
"ctx.beginPath();\n"
"isl.vertices.forEach((v, vi) => { vi===0 ? ctx.moveTo(v.x,v.y) : ctx.lineTo(v.x,v.y); });\n"
"ctx.closePath(); ctx.fill();\n"
"// Grass (scaled inward polygon)\n"
"ctx.fillStyle = '#4a7a3a';\n"
"ctx.beginPath();\n"
"isl.vertices.forEach((v, vi) => {\n"
"const gx = isl.x + (v.x - isl.x) * GRASS_POLY_SCALE;\n"
"const gy = isl.y + (v.y - isl.y) * GRASS_POLY_SCALE;\n"
"vi===0 ? ctx.moveTo(gx,gy) : ctx.lineTo(gx,gy);\n"
"});\n"
"ctx.closePath(); ctx.fill();\n"
"} else {\n"
"// ── Bumpy-circle island ──\n"
"ctx.fillStyle = '#c8a85c';\n"
"ctx.beginPath();\n"
"for (let k = 0; k < N; k++) {\n"
"const a = k / N * Math.PI * 2;\n"
"const r = islandBndR(isl.beachBumps, isl.beachRadius, a);\n"
"const px = isl.x + Math.cos(a) * r;\n"
"const py = isl.y + Math.sin(a) * r;\n"
"k === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);\n"
"}\n"
"ctx.closePath(); ctx.fill();\n"
"ctx.fillStyle = '#4a7a3a';\n"
"ctx.beginPath();\n"
"for (let k = 0; k < N; k++) {\n"
"const a = k / N * Math.PI * 2;\n"
"const r = islandBndR(isl.grassBumps, isl.grassRadius, a);\n"
"const px = isl.x + Math.cos(a) * r;\n"
"const py = isl.y + Math.sin(a) * r;\n"
"k === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);\n"
"}\n"
"ctx.closePath(); ctx.fill();\n"
"}\n"
"// Island label\n"
"ctx.fillStyle = 'rgba(255,255,255,0.85)';\n"
"ctx.font = 'bold 12px sans-serif';\n"
"ctx.textAlign = 'center';\n"
"ctx.fillText('Island ' + isl.id, isl.x, isl.y + 4);\n"
"});\n"
"}\n"
"// Draw shipyards\n"
"if (mapData.structures) {\n"
"// Dock OBBs in local space (client px, mirror of server DOCK_* constants)\n"
"const DOCK_OBBS = [\n"
"// [local_cx, local_cy, half_w, half_h, fill, stroke]\n"
"[-145, 0,   25, 445, 'rgba(80,160,255,0.25)', 'rgba(80,160,255,0.9)'], // left arm\n"
"[ 145, 0,   25, 445, 'rgba(80,160,255,0.25)', 'rgba(80,160,255,0.9)'], // right arm\n"
"[   0,-420, 170,  25, 'rgba(80,220,130,0.25)', 'rgba(80,220,130,0.9)'], // back wall\n"
"];\n"
"function drawDockedOBB(ox, oy, rotDeg, lcx, lcy, hw, hh, fill, stroke) {\n"
"const rad = rotDeg * Math.PI / 180;\n"
"const c = Math.cos(rad), s = Math.sin(rad);\n"
"// Standard matrix matching ctx.rotate(): wx = ox+lx*c-ly*s, wy = oy+lx*s+ly*c\n"
"function lw(lx,ly) {\n"
"return {x: ox + lx*c - ly*s, y: oy + lx*s + ly*c};\n"
"}\n"
"const corners = [lw(lcx-hw,lcy-hh),lw(lcx+hw,lcy-hh),lw(lcx+hw,lcy+hh),lw(lcx-hw,lcy+hh)];\n"
"ctx.fillStyle = fill;\n"
"ctx.strokeStyle = stroke;\n"
"ctx.lineWidth = 2;\n"
"ctx.beginPath();\n"
"ctx.moveTo(corners[0].x, corners[0].y);\n"
"corners.slice(1).forEach(p => ctx.lineTo(p.x, p.y));\n"
"ctx.closePath();\n"
"ctx.fill();\n"
"ctx.stroke();\n"
"}\n"
"mapData.structures.forEach(s => {\n"
"if (s.type !== 'shipyard') return;\n"
"const rot = s.rotation || 0;\n"
"DOCK_OBBS.forEach(([lcx,lcy,hw,hh,fill,stroke]) => {\n"
"drawDockedOBB(s.x, s.y, rot, lcx, lcy, hw, hh, fill, stroke);\n"
"});\n"
"// Centre dot + label\n"
"ctx.fillStyle = '#ffd700';\n"
"ctx.beginPath(); ctx.arc(s.x, s.y, 5, 0, 2*Math.PI); ctx.fill();\n"
"ctx.fillStyle = 'rgba(255,215,0,0.9)';\n"
"ctx.font = '11px sans-serif';\n"
"ctx.textAlign = 'center';\n"
"ctx.fillText('Shipyard #' + s.id, s.x, s.y - 12);\n"
"});\n"
"}\n"
"// Draw ships first (background layer)\n"
"mapData.ships.forEach(ship => {\n"
"const x = ship.x; const y = ship.y;\n"
"const isGhost = ship.company_id === 99;\n"
"ctx.save();\n"
"ctx.translate(x, y);\n"
"ctx.rotate(ship.rotation);\n"
"// Draw ship hull polygon (if available)\n"
"if (ship.hull && ship.hull.length > 0) {\n"
"ctx.fillStyle = isGhost ? 'rgba(180,80,255,0.55)' : '#8B4513';\n"
"ctx.beginPath();\n"
"ctx.moveTo(ship.hull[0].x, ship.hull[0].y);\n"
"for (let i = 1; i < ship.hull.length; i++) {\n"
"ctx.lineTo(ship.hull[i].x, ship.hull[i].y);\n"
"}\n"
"ctx.closePath();\n"
"ctx.fill();\n"
"ctx.strokeStyle = isGhost ? '#dd77ff' : '#654321';\n"
"ctx.lineWidth = isGhost ? 3 : 2;\n"
"ctx.stroke();\n"
"} else {\n"
"// Fallback to simple rectangle\n"
"ctx.fillStyle = isGhost ? 'rgba(180,80,255,0.55)' : '#8B4513';\n"
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
"ctx.fillStyle = isGhost ? '#dd77ff' : 'white';\n"
"ctx.font = 'bold 12px Arial';\n"
"const shipLabel = isGhost ? '👻 Ghost #'+ship.id+(ship.npc_level?' Lv'+ship.npc_level:'') : '⚓ Ship '+ship.id;\n"
"ctx.fillText(shipLabel, x+12, y-10);\n"
"ctx.font = '10px Arial';\n"
"ctx.fillStyle = isGhost ? '#dd77ff' : 'white';\n"
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
"// Draw claim territory areas (dominance-aware) — top layer\n"
"drawClaimAreas(ctx);\n"
"ctx.restore();\n"
"// Draw legend (outside pan area)\n"
"ctx.fillStyle = 'rgba(0,0,0,0.7)';\n"
"ctx.fillRect(10, 10, 180, 230);\n"
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
"ctx.fillStyle = '#c8a85c';\n"
"ctx.fillRect(20, 120, 8, 8);\n"
"ctx.fillStyle = 'white';\n"
"ctx.fillText('Island (beach)', 38, 128);\n"
"ctx.fillStyle = '#4a7a3a';\n"
"ctx.fillRect(20, 134, 8, 8);\n"
"ctx.fillStyle = 'white';\n"
"ctx.fillText('Island (grass)', 38, 142);\n""ctx.fillStyle = 'rgba(80,160,255,0.5)';"
"ctx.fillRect(20, 148, 8, 8);"
"ctx.strokeStyle = 'rgba(80,160,255,0.9)'; ctx.lineWidth=1;"
"ctx.strokeRect(20, 148, 8, 8);"
"ctx.fillStyle = 'white';"
"ctx.fillText('Shipyard arms', 38, 156);"
"ctx.fillStyle = 'rgba(80,220,130,0.5)';"
"ctx.fillRect(20, 162, 8, 8);"
"ctx.strokeStyle = 'rgba(80,220,130,0.9)'; ctx.lineWidth=1;"
"ctx.strokeRect(20, 162, 8, 8);"
"ctx.fillStyle = 'white';"
"ctx.fillText('Shipyard back', 38, 170);"
"// Claim area legend\n"
"ctx.fillStyle = 'rgba(255,204,68,0.3)';"
"ctx.fillRect(20, 176, 8, 8);"
"ctx.strokeStyle = 'rgba(255,204,68,0.85)'; ctx.lineWidth=1;"
"ctx.strokeRect(20, 176, 8, 8);"
"ctx.fillStyle = 'white';"
"ctx.fillText('Solo territory', 38, 184);"
"ctx.fillStyle = 'rgba(231,76,60,0.3)';"
"ctx.fillRect(20, 190, 8, 8);"
"ctx.strokeStyle = 'rgba(231,76,60,0.85)'; ctx.lineWidth=1;"
"ctx.strokeRect(20, 190, 8, 8);"
"ctx.fillStyle = 'white';"
"ctx.fillText('Pirate territory', 38, 198);"
"ctx.fillStyle = 'rgba(52,152,219,0.3)';"
"ctx.fillRect(20, 204, 8, 8);"
"ctx.strokeStyle = 'rgba(52,152,219,0.85)'; ctx.lineWidth=1;"
"ctx.strokeRect(20, 204, 8, 8);"
"ctx.fillStyle = 'white';"
"ctx.fillText('Navy territory', 38, 212);\n"
"ctx.fillStyle = 'rgba(180,80,255,0.55)';\n"
"ctx.fillRect(20, 218, 8, 8);\n"
"ctx.strokeStyle = '#dd77ff'; ctx.lineWidth=1;\n"
"ctx.strokeRect(20, 218, 8, 8);\n"
"ctx.fillStyle = 'white';\n"
"ctx.fillText('👻 Ghost ship', 38, 226);\n"
"// Resize legend background to fit\n"
"ctx.fillStyle = 'rgba(0,0,0,0.7)';\n"
"// (already drawn at top, update height would require predraw — skip)\n"
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
        /* ── Read full HTTP request (headers + body) ─────────────────────
         * Use a fixed header buffer for the first recv, then malloc a larger
         * buffer if Content-Length indicates more body bytes are on the way.
         * This fixes truncation for large POSTs (e.g. island save JSON).    */
#define ADMIN_HDR_BUF  4096
#define ADMIN_MAX_BODY (512 * 1024)   /* 512 KB max request body */

        char hdr_buf[ADMIN_HDR_BUF];
        ssize_t hdr_recv = recv(client_fd, hdr_buf, ADMIN_HDR_BUF - 1, 0);
        char *dyn_buf = NULL;
        char *buffer;                 /* unified pointer used throughout routing */

        if (hdr_recv <= 0) {
            close(client_fd);
            return 0;
        }
        hdr_buf[hdr_recv] = '\0';

        /* Parse Content-Length and locate header/body boundary */
        char  *body_sep = strstr(hdr_buf, "\r\n\r\n");
        size_t cl = 0;
        {
            const char *p = strstr(hdr_buf, "Content-Length: ");
            if (!p) p = strstr(hdr_buf, "content-length: ");
            if (p) cl = (size_t)strtoul(p + 16, NULL, 10);
        }

        if (cl > 0 && body_sep) {
            size_t hdr_len   = (size_t)(body_sep + 4 - hdr_buf);
            size_t in_buf    = (size_t)hdr_recv - hdr_len;          /* body bytes already in hdr_buf */
            size_t remaining = cl > in_buf ? cl - in_buf : 0;       /* bytes still on the wire */
            size_t total     = hdr_len + cl;

            if (remaining > 0 && total <= (size_t)(ADMIN_HDR_BUF + ADMIN_MAX_BODY)) {
                dyn_buf = (char *)malloc(total + 1);
                if (dyn_buf) {
                    memcpy(dyn_buf, hdr_buf, (size_t)hdr_recv);
                    size_t done = (size_t)hdr_recv;
                    while (done < total) {
                        ssize_t n = recv(client_fd, dyn_buf + done, total - done, 0);
                        if (n <= 0) break;
                        done += (size_t)n;
                    }
                    dyn_buf[done] = '\0';
                    buffer = dyn_buf;
                } else {
                    buffer = hdr_buf;  /* malloc failed; fall back to partial buffer */
                }
            } else {
                buffer = hdr_buf;
            }
        } else {
            buffer = hdr_buf;
        }

        ssize_t received = (ssize_t)strlen(buffer);  /* satisfy existing `received > 0` check */
        if (received > 0) {
            // Parse request path for GET
            char *options_start = strstr(buffer, "OPTIONS ");
            char *path_start = strstr(buffer, "GET ");
            char *post_start = strstr(buffer, "POST ");
            if (options_start) {
                /* CORS preflight — reply with all necessary headers */
                const char *preflight =
                    "HTTP/1.1 204 No Content\r\n"
                    "Access-Control-Allow-Origin: *\r\n"
                    "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
                    "Access-Control-Allow-Headers: Content-Type\r\n"
                    "Access-Control-Max-Age: 86400\r\n"
                    "Content-Length: 0\r\n"
                    "Connection: close\r\n"
                    "\r\n";
                send(client_fd, preflight, strlen(preflight), 0);
            } else if (path_start) {
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
                    } else if (strcmp(path_start, "/api/islands") == 0) {
                        admin_api_islands(&resp);
                    } else if (strcmp(path_start, "/api/world/state") == 0) {
                        /* Return the current save file as JSON */
                        static char world_state_buf[524288]; /* 512 KB */
                        FILE *wf = fopen(WORLD_SAVE_DEFAULT_PATH, "r");
                        if (wf) {
                            size_t n = fread(world_state_buf,
                                             1, sizeof(world_state_buf) - 1, wf);
                            fclose(wf);
                            world_state_buf[n] = '\0';
                            resp.status_code   = 200;
                            resp.content_type  = "application/json";
                            resp.body          = world_state_buf;
                            resp.body_length   = n;
                        } else {
                            resp.status_code  = 404;
                            resp.body         = "{\"error\":\"No save file found\"}";
                            resp.body_length  = 30;
                        }
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
                    if (strcmp(post_start, "/api/world/save") == 0) {
                        int sr = world_save(WORLD_SAVE_DEFAULT_PATH);
                        if (sr == 0) {
                            resp.status_code = 200;
                            resp.content_type = "application/json";
                            resp.body = "{\"ok\":true,\"path\":\"" WORLD_SAVE_DEFAULT_PATH "\"}";
                            resp.body_length = strlen(resp.body);
                        } else {
                            resp.status_code = 500;
                            resp.body = "{\"ok\":false,\"error\":\"save failed\"}";
                            resp.body_length = strlen(resp.body);
                        }
                    } else if (strcmp(post_start, "/api/world/load") == 0) {
                        int lr = world_load(WORLD_SAVE_DEFAULT_PATH);
                        if (lr == 0) {
                            claim_dominators_sanity_sweep();
                            resp.status_code = 200;
                            resp.content_type = "application/json";
                            resp.body = "{\"ok\":true}";
                            resp.body_length = 12;
                        } else {
                            resp.status_code = 500;
                            resp.body = "{\"ok\":false,\"error\":\"load failed\"}";
                            resp.body_length = strlen(resp.body);
                        }
                    } else if (strcmp(post_start, "/api/islands/save") == 0) {
                        size_t blen = body ? strlen(body) : 0;
                        admin_api_islands_save(&resp, body, blen);
                    } else if (strcmp(post_start, "/api/admin/ship") == 0) {
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
                        uint8_t level = 1;
                        if (body) {
                            char *p;
                            p = strstr(body, "\"x\"");
                            if (p) { p = strchr(p, ':'); if (p) x = (float)atof(p + 1); }
                            p = strstr(body, "\"y\"");
                            if (p) { p = strchr(p, ':'); if (p) y = (float)atof(p + 1); }
                            p = strstr(body, "\"level\"");
                            if (p) { p = strchr(p, ':'); if (p) { int lv = atoi(p + 1); if (lv >= 1 && lv <= 60) level = (uint8_t)lv; } }
                        }
                        admin_api_create_phantom_brig(&resp, x, y, level);
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
        free(dyn_buf);
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
        "Access-Control-Allow-Origin: *\r\n"
        "Connection: close\r\n"
        "\r\n",
        resp->status_code,
        resp->status_code == 200 ? "OK" :
        resp->status_code == 204 ? "No Content" :
        resp->status_code == 404 ? "Not Found" :
        resp->status_code == 503 ? "Service Unavailable" : "Internal Server Error",
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