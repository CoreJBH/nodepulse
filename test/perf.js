/* Frame-time probe: boots the built file in Chromium at a phone viewport (3x DPR,
   which the app clamps to 2), measures rAF cadence for a few seconds, then repeats
   with 4x CPU throttling to approximate a mid-range Android phone.
   Run: node test/perf.js */
const { chromium, URL: APP_URL, SHOTS } = require('./env');
const path = require('path');

const FILE = APP_URL + '?v=' + Date.now();

const PROBE = (ms) => new Promise(resolve => {
  const frames = [];
  let last = 0, stop = false;
  const t0 = performance.now();
  function tick(ts) {
    if (last) frames.push(ts - last);
    last = ts;
    if (stop || ts - t0 > ms) { finish(); return; }
    requestAnimationFrame(tick);
  }
  function finish() {
    stop = true;
    const s = frames.slice().sort((a, b) => a - b);
    const avg = frames.reduce((a, b) => a + b, 0) / Math.max(1, frames.length);
    resolve({
      frames: frames.length,
      fps: +(1000 / avg).toFixed(1),
      avg: +avg.toFixed(2),
      p50: +(s[Math.floor(s.length * 0.5)] || 0).toFixed(2),
      p95: +(s[Math.floor(s.length * 0.95)] || 0).toFixed(2),
      worst: +(s[s.length - 1] || 0).toFixed(2),
      over20: frames.filter(f => f > 20).length,
      over33: frames.filter(f => f > 33).length
    });
  }
  requestAnimationFrame(tick);
});

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(FILE, { waitUntil: 'load' });
  await page.waitForTimeout(3500);           // let live data land

  const info = await page.evaluate(() => ({
    dpr: window.devicePixelRatio,
    canvas: [document.getElementById('globe').width, document.getElementById('globe').height],
    nodes: window.NODEPULSE.nodes().length,
    arcs: window.NODEPULSE.links().length,
    slow: window.NODEPULSE.globe.slow
  }));

  const plain = await page.evaluate(PROBE, 5000);

  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.waitForTimeout(800);
  const throttled = await page.evaluate(PROBE, 5000);

  /* same probe with the panel open and a node card open */
  await page.click('#toggle');
  await page.waitForTimeout(700);
  const withPanel = await page.evaluate(PROBE, 2500);

  console.log(JSON.stringify({
    info,
    plain,
    cpuThrottle4x: throttled,
    panelOpen: withPanel,
    errors: [...new Set(errors)]
  }, null, 1));

  await browser.close();
})();
