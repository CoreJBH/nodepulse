const { chromium, URL: APP_URL, SHOTS } = require('./env');
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, offline: true });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  await p.route('https://**', r => r.abort());
  await p.route('wss://**', r => r.abort());
  await p.goto(APP_URL + '?v=' + Date.now(), { waitUntil: 'load' });
  await p.waitForTimeout(6000);
  const out = await p.evaluate(() => {
    const t = id => document.getElementById(id).textContent;
    return {
      tip: window.NODEPULSE.state.tip, src: window.NODEPULSE.state.nodeSrc,
      vHeight: t('vHeight'), vNodes: t('vNodes'), vHash: t('vHash'),
      live: t('liveTxt'), ws: t('wsTxt'), sync: t('syncTxt'),
      clusters: window.NODEPULSE.nodes().length,
      strip: t('sMem')
    };
  });
  console.log(JSON.stringify({ errs, out }, null, 1));
  await p.screenshot({ path: SHOTS + '/v6-offline.png' });
  await b.close();
})();
