const { chromium, URL: APP_URL, SHOTS } = require('./env');
const fs = require('fs');
const path = require('path');

const FILE = APP_URL + '?v=' + Date.now();
const OUT = path.resolve(__dirname, '..', 'shots', 'final');
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const browser = await chromium.launch();
  const errors = [], failed = [];
  async function open(w, h) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(e.message));
    page.on('requestfailed', r => failed.push(r.url().slice(0, 80) + ' :: ' + (r.failure() && r.failure().errorText)));
    await page.goto(FILE, { waitUntil: 'load' });
    await page.waitForTimeout(4200);
    // screenshots are taken at full backing-store resolution, not the phone's adaptive tier
    await page.evaluate(() => { if (window.NODEPULSE && window.NODEPULSE.full) window.NODEPULSE.full(); });
    await page.waitForTimeout(900);
    return { ctx, page };
  }

  // 1 phone home
  let { ctx, page } = await open(390, 844);
  await page.screenshot({ path: path.join(OUT, 'p1-home.png') });

  // 2 pulse (new-block ripple)
  await page.evaluate(() => window.NODEPULSE.pulse());
  await page.waitForTimeout(320);
  await page.screenshot({ path: path.join(OUT, 'p2-pulse.png') });

  // 3 drag to rotate + zoom
  await page.mouse.move(195, 430);
  await page.mouse.down();
  await page.mouse.move(95, 400, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  const rot = await page.evaluate(() => ({ yaw: window.NODEPULSE.globe.yaw, pitch: window.NODEPULSE.globe.pitch }));
  await page.screenshot({ path: path.join(OUT, 'p3-rotated.png') });
  await page.mouse.wheel(0, -240);
  await page.waitForTimeout(600);
  const zoom = await page.evaluate(() => window.NODEPULSE.globe.zoomT);
  await page.screenshot({ path: path.join(OUT, 'p4-zoomed.png') });

  // 5 tap a node for real (find a visible cluster's screen position)
  const pos = await page.evaluate(() => {
    const cs = window.NODEPULSE.nodes().filter(c => c.on);
    if (!cs.length) return null;
    const c = cs[0];
    return { x: c.sx, y: c.sy };
  });
  if (pos) { await page.mouse.click(pos.x, pos.y); await page.waitForTimeout(900); }
  const cardOpen = await page.evaluate(() => document.getElementById('modal').classList.contains('on'));
  await page.screenshot({ path: path.join(OUT, 'p5-tapcard.png') });
  await page.evaluate(() => document.getElementById('cardClose').click());
  await page.waitForTimeout(300);

  // 5b the Lightning layer, same phone
  await page.click('#layerLN');
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(OUT, 'p5b-lightning.png') });
  await page.click('#layerL1');
  await page.waitForTimeout(600);

  // 6 panel
  await page.click('#toggle');
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(OUT, 'p6-panel.png') });
  await page.evaluate(() => { const p = document.getElementById('panel'); p.scrollTop = p.scrollHeight; });
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT, 'p7-panel-bottom.png') });
  const panelInfo = await page.evaluate(() => {
    const p = document.getElementById('panel');
    return { sh: p.scrollHeight, ch: p.clientHeight, top: p.scrollTop };
  });
  await ctx.close();

  // 8 desktop home + panel
  ({ ctx, page } = await open(1280, 820));
  await page.screenshot({ path: path.join(OUT, 'p8-desktop.png') });
  await page.click('#toggle');
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(OUT, 'p9-desktop-panel.png') });
  await ctx.close();

  // 10 small phone
  ({ ctx, page } = await open(320, 568));
  await page.screenshot({ path: path.join(OUT, 'p10-small.png') });
  await ctx.close();

  console.log(JSON.stringify({ errors, failed: [...new Set(failed)], cardOpen, rot, zoom, panelInfo }, null, 1));
  await browser.close();
})();
