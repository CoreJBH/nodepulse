/* Boot: the refresh cadence, the UI bindings, the clock and the start of the app. */

  /* ------------------------------------------------------------------ boot */
  function refreshCore() {
    Promise.all([
      loadTip().catch(noop), loadBlocks().catch(noop), loadMem().catch(noop),
      loadRecentTxs().catch(noop), loadFees().catch(noop), loadHashrate().catch(noop),
      loadDiff().catch(noop), loadPools().catch(noop)
    ]).then(function () { schedulePaint(); });
  }

  function refreshSlow() {
    loadLightning().catch(noop);
    loadCountries().catch(noop);
  }

  function noop() { }

  function bindUI() {
    var btn = $('toggle'), panel = $('panel');
    if (btn) btn.addEventListener('click', function () { setPanel(!S.panelOpen); });
    var strip = $('strip');
    if (strip) strip.addEventListener('click', function () { setPanel(true); if (panel) panel.scrollTop = 0; });
    ['mHeight', 'mMem', 'mFee', 'mNodes', 'mChans', 'mCap'].forEach(function (id) {
      var el = $(id);
      if (el) el.addEventListener('click', function () { setPanel(true); });
    });
    var b1 = $('layerL1'), b2 = $('layerLN');
    if (b1) b1.addEventListener('click', function () { setLayer('l1'); });
    if (b2) b2.addEventListener('click', function () { setLayer('ln'); });
    var wp = $('watchPill');
    if (wp) {
      function openWatch() {
        setPanel(true);
        var w = $('watch');
        if (w && w.scrollIntoView) w.scrollIntoView({ block: 'center' });
      }
      wp.addEventListener('click', openWatch);
      wp.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openWatch(); }
      });
    }
    var modal = $('modal');
    if (modal) modal.addEventListener('click', function (e) { if (e.target === modal) closeNodeCard(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeNodeCard(); });
    /* The card and the panel are the shell's dismissible layers: tell it what is open so
       the back gesture can close them instead of leaving the app. */
    syncBack();
  }

  function tickClock() {
    var d = new Date();
    txt('clock', pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ':' + pad2(d.getUTCSeconds()));
    var kst = new Date(d.getTime() + 9 * 3600 * 1000);
    txt('clockKst', 'KST ' + pad2(kst.getUTCHours()) + ':' + pad2(kst.getUTCMinutes()));
  }

  /* Every repeating timer registers through here and does nothing while the page is
     hidden: a background tab or a screen-off phone used to keep polling, refetching,
     repainting the panel and advancing the clock that nobody saw. The globe's own
     requestAnimationFrame loop already stopped on visibilitychange, so the timers were
     the only work still running behind a hidden page. The next visible tick picks each
     job back up on its own cadence, and returning to the page repaints the clock, the
     status and the open panel at once so the resumed screen is never a stale one. */
  var bgTimers = [];
  function every(ms, fn) {
    var t = setInterval(function () { if (!document.hidden) fn(); }, ms);
    bgTimers.push(t);
    return t;
  }
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) return;
    tickClock();
    paintStatus();
    if (S.panelOpen) paintPanel();
    /* a reconnect that came due while the page was hidden was held, not dropped */
    if (wsHeld) { wsHeld = false; connectWS(); }
  });

  function boot() {
    loadPref();
    BR.init();
    var hadCache = restoreCache();
    Globe.init();
    bindUI();
    document.body.classList.toggle('l1', S.layer === 'l1');
    document.body.classList.toggle('ln', S.layer === 'ln');

    /* every layer gets a truthful first paint from real bundled data before the
       network answers: the Bitnodes snapshot for L1, the channel snapshot for LN */
    applySnapshotL1('boot');
    applySeed();
    setLayer(S.layer);
    tickClock();
    every(1000, tickClock);
    paint();
    if (hadCache) toast(L('tCached'));

    refreshCore();
    refreshSlow();
    loadL1();
    refreshNodes(false);
    connectWS();

    every(20000, function () { if (S.ws !== 'open') refreshCore(); });
    every(90000, function () { if (S.ws === 'open') { loadTip().catch(noop); loadMem().catch(noop); } });
    every(60000, function () { loadBlocks().catch(noop); loadRecentTxs().catch(noop); });
    every(300000, function () { loadHashrate().catch(noop); loadDiff().catch(noop); });
    every(POOL_TTL, function () { loadPools().catch(noop); });
    every(60000, function () { if (Date.now() - S.l1Tried > L1_TTL) loadL1(); });
    every(1800000, refreshSlow);
    every(6 * 3600 * 1000, function () { refreshNodes(false); });
    every(45000, function () { if (stale()) { refreshCore(); if (S.ws !== 'open') connectWS(); } });
    every(15000, function () { paintStatus(); if (S.panelOpen) paintPanel(); });

    var hint = $('hint');
    if (hint) {
      setTimeout(function () { hint.classList.add('on'); }, 900);
      setTimeout(function () { hint.classList.remove('on'); }, 7600);
    }

    /*__TEST_HOOK__*/
    /* The test hook: build.py keeps this block only in a --test build and strips it from
       dist/nodepulse.html, so the page that ships carries no switch that can read or drive
       its state from outside. test/headless.js runs the test build. */
    window.NODEPULSE = {
      state: S, globe: Globe.state, project: Globe.projectPoint,
      nodes: function () { return Globe.state.clusters; },
      links: function () { return Globe.state.links; },
      setRes: function (s) { Globe.state.adaptive = false; Globe.setRes(s); },
      full: function () { Globe.state.forceFull = true; Globe.state.adaptive = false; Globe.setRes(1); },
      channels: function () {
        return { rows: S.chanRows, at: S.chanAt, links: S.links, drawn: Globe.state.links.length, src: S.nodeSrc };
      },
      panel: function (open) { var b = $('toggle'); if (b && (open !== S.panelOpen)) b.click(); },
      pulse: function () { Globe.pulse(); },
      geoProbe: Globe.geoProbe,
      packets: Globe.packets,
      openNode: function (i) { var c = Globe.state.clusters[i]; if (c) showNodeCard(c); },
      conts: aggregateContinents,
      layer: function (l) { if (l) setLayer(l); return S.layer; },
      loadL1: loadL1,
      bridge: function () { return BR.on; },
      bridgeMs: function () { return BRIDGE_MS; },
      bridgeGet: function (url, ms) { return BR.get(url, ms); },
      loadLightning: loadLightning,
      timers: function () { return bgTimers.length; },
      wsUrl: wsUrl,
      connect: function () { connectWS(); },
      wsConnectMs: function (v) { if (num(v)) WS_CONNECT_MS = v; return WS_CONNECT_MS; },
      fetchMs: function (v) { if (num(v)) FETCH_MS = v; return FETCH_MS; },
      loadTip: loadTip,
      loadBlocks: loadBlocks,
      loadCountries: loadCountries,
      l1Platforms: l1Platforms,
      l1Versions: l1Versions,
      offline: function () { return offline(); },
      reqBudgetMs: function () { return REQ_BUDGET_MS; },
      wsHeld: function () { return wsHeld; },
      wsTimerPending: function () { return !!wsTimer; },
      loadHashrate: loadHashrate,
      push: handleWS,
      refreshNodes: refreshNodes,
      graph: function (rows) {
        var t0 = Date.now();
        var g = graphFrom(rows);
        var picked = pickChannelNodes(g);
        var capped = capLinks(linksAmong(g, picked), g);
        return {
          ms: Date.now() - t0, nodes: g.keys.length, picked: picked.length, links: capped.length,
          pickedPks: picked.map(function (n) { return n.pk; })
        };
      },
      mblocks: function () { return S.mblocks; },
      cluster: Cluster,
      watch: function () { evalWatch(); return { list: S.wd ? S.wd.list : [], alerts: (S.wd ? S.wd.alerts : []) || [], sig: S.alertSig }; },
      reorg: reorgEvent
    };
    /*__TEST_HOOK_END__*/
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();

