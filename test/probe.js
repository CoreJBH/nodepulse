/* Per-layer cost probe: hides one render layer at a time and measures the frame
   cadence, so we know where the phone's time actually goes. Run: node test/probe.js */
const { chromium, URL: APP_URL, SHOTS } = require('./env');
const CHROME = require('./env').CHROME;
const FILE = APP_URL + '?v=' + Date.now();

const PROBE = (ms) => new Promise(resolve => {
  const frames = [];
  let last = 0;
  const t0 = performance.now();
  function tick(ts) {
    if (last) frames.push(ts - last);
    last = ts;
    if (ts - t0 > ms) return done();
    requestAnimationFrame(tick);
  }
  function done() {
    const avg = frames.reduce((a, b) => a + b, 0) / Math.max(1, frames.length);
    resolve(+(1000 / avg).toFixed(1));
  }
  requestAnimationFrame(tick);
});

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 });
  const page = await ctx.newPage();
  await page.goto(FILE, { waitUntil: 'load' });
  await page.waitForTimeout(3000);
  await page.evaluate(() => { window.NODEPULSE.globe.slow = false; });

  const out = {};
  const combos = [
    ['all', {}],
    ['no-arcs', { arcs: 1 }],
    ['no-land', { land: 1 }],
    ['no-grid', { grid: 1 }],
    ['no-nodes', { nodes: 1 }],
    ['no-stars', { stars: 1 }],
    ['no-sphere', { sphere: 1 }],
    ['no-bloom', { bloom: 1 }],
    ['no-packets', { packets: 1 }],
    ['no-landfill', { landFill: 1 }],
    ['no-landglow', { landGlow: 1 }],
    ['only-backdrop', { arcs: 1, land: 1, grid: 1, nodes: 1 }],
    ['nothing', { arcs: 1, land: 1, grid: 1, nodes: 1, stars: 1, sphere: 1 }]
  ];
  for (const [name, hide] of combos) {
    await page.evaluate(h => { window.NODEPULSE.globe.hide = h; window.NODEPULSE.globe.slow = false; }, hide);
    await page.waitForTimeout(400);
    out[name] = await page.evaluate(PROBE, 2200);
  }
  console.log(JSON.stringify(out, null, 1));
  await browser.close();
})();
