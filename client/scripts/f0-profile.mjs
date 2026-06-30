/**
 * F0 open-ocean idle baseline — collects window.__frameAuditStats after guest login.
 * Usage: node scripts/f0-profile.mjs [--url URL] [--warmup-ms MS] [--sample-ms MS]
 */
import { chromium } from 'playwright';

const url = process.argv.includes('--url')
  ? process.argv[process.argv.indexOf('--url') + 1]
  : 'http://127.0.0.1:5173/pirate-game-4/?debug=true&perfstats=true';
const warmupMs = Number(
  process.argv.includes('--warmup-ms')
    ? process.argv[process.argv.indexOf('--warmup-ms') + 1]
    : 35000
);
const sampleMs = Number(
  process.argv.includes('--sample-ms')
    ? process.argv[process.argv.indexOf('--sample-ms') + 1]
    : 5000
);

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader-webgl'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.setDefaultTimeout(120000);

const consoleLogs = [];
page.on('console', (msg) => {
  const t = msg.text();
  if (t.includes('[INTERP]') || t.includes('[FRAME]') || t.includes('Client Started')) {
    consoleLogs.push(t);
  }
});

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

// Guest login flow
await page.click('.auth-tab[data-panel="guest"]');
await page.click('#guest-submit');

// Wait for game canvas + frame audit stats
await page.waitForFunction(
  () => {
    const fa = window.__frameAuditStats;
    const canvas = document.getElementById('gameCanvas');
    const overlay = document.getElementById('loading-overlay');
    const loadingHidden =
      !overlay || overlay.style.display === 'none' || overlay.classList.contains('hidden');
    return canvas && fa && fa.fps > 0 && loadingHidden;
  },
  { timeout: 120000 }
);

// Reset hitch counter after load for cleaner F0 sample
await page.evaluate(() => {
  if (typeof window.__resetFrameAudit === 'function') window.__resetFrameAudit();
});

console.log(`Sampling ${warmupMs}ms warmup + ${sampleMs}ms final sample…`);
await page.waitForTimeout(warmupMs);

const before = await page.evaluate(() => ({
  frame: { ...window.__frameAuditStats },
  network: window.__networkAuditStats ? { ...window.__networkAuditStats } : null,
}));

await page.waitForTimeout(sampleMs);

const after = await page.evaluate(() => ({
  frame: { ...window.__frameAuditStats },
  network: window.__networkAuditStats ? { ...window.__networkAuditStats } : null,
}));

const hitchDelta =
  (after.frame?.hitchCount ?? 0) - (before.frame?.hitchCount ?? 0);

const result = {
  scenario: 'F0',
  url,
  warmupMs,
  sampleMs,
  timestamp: new Date().toISOString(),
  frameAudit: after.frame,
  networkAudit: after.network,
  hitchDuringSample: hitchDelta,
  consoleSnippets: consoleLogs.slice(-5),
};

console.log(JSON.stringify(result, null, 2));
await browser.close();
