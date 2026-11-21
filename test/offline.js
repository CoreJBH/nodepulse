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
    const NP = window.NODEPULSE, S = NP.state;
    const l1 = {
      src: S.l1 && S.l1.src, total: S.l1 && S.l1.total,
      coords: S.l1 && S.l1.coords.length, versions: S.l1 && S.l1.vers.length,
      cells: NP.nodes().length, arcs: NP.links().length,
      vHeight: t('vHeight'), vMem: t('vMem'), vFee: t('vFee'), strip: t('sMem')
    };
    NP.layer('ln');
    const ln = {
      src: S.nodeSrc, nodes: S.nodes.length, clusters: NP.nodes().length,
      arcs: NP.links().length, vNodes: t('vNodes'), vChans: t('vChans')
    };
    return { tip: S.tip, live: t('liveTxt'), ws: t('wsTxt'), sync: t('syncTxt'), l1, ln };
  });
  console.log(JSON.stringify({ errs, out }, null, 1));
  await p.screenshot({ path: SHOTS + '/v6-offline.png' });
  await b.close();
})();
