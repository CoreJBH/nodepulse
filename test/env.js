/* Shared environment for the browser-based harnesses (fill-truth, perf, shots,
   offline, probe). Everything is resolved relative to the repository, so the
   scripts run from a clean checkout: build the app first (`python3 build.py`),
   then point PLAYWRIGHT_PKG at a Playwright installation if it is not on the
   default module path, and CHROME at a Chrome/Chromium binary if Playwright's
   bundled one is not installed.
   Run: node test/<harness>.js */
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');

function loadChromium() {
  const candidates = [
    process.env.PLAYWRIGHT_PKG,
    'playwright',
    'playwright-core',
  ].filter(Boolean);
  for (const id of candidates) {
    try { return require(id).chromium; } catch (e) { /* try next */ }
  }
  throw new Error('Playwright not found. Set PLAYWRIGHT_PKG to a playwright/playwright-core module.');
}

const BUILT = [
  path.join(ROOT, 'dist', 'nodepulse.html'),
  path.resolve(ROOT, '..', '..', 'bitcoin-network-monitor.html'),
].find(p => fs.existsSync(p));

if (!BUILT) throw new Error('Built app not found. Run `python3 build.py` first.');

module.exports = {
  ROOT,
  chromium: loadChromium(),
  CHROME: process.env.CHROME || undefined,
  BUILT,
  URL: 'file://' + BUILT,
  SHOTS: path.join(ROOT, 'shots'),
};
