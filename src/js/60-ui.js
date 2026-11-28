/* UI painting: the status pills, the HUD, the panel, the ledger lists, the data
   footnote and the toast. Nothing here reaches the network. */

  /* ------------------------------------------------------------- painting */
  var paintQueued = false, lastPaint = 0, noteDirty = true, lastSave = 0;

  function schedulePaint() {
    if (paintQueued) return;
    paintQueued = true;
    setTimeout(function () {
      paintQueued = false;
      var now = Date.now();
      if (now - lastPaint < 320) { schedulePaint(); return; }
      lastPaint = now;
      paint();
    }, 40);
  }

  function stale() { return !S.lastOk || (Date.now() - S.lastOk) > STALE_MS; }

  var lastHudH = 0;
  function paint() {
    evalWatch();
    paintStatus();
    paintMetrics();
    if (S.panelOpen) paintPanel();
    /* the entity sheet is throttled inside Ent.paint(), so calling it on every paint only
       queues one DOM pass — and it keeps the HUD, the subrow and an open card in step
       with a balance or a price that arrived since the last pass. */
    if (typeof Ent !== 'undefined' && Ent && Ent.paint) Ent.paint();
    var hud = document.querySelector('.hud');
    if (hud && Math.abs(hud.offsetHeight - lastHudH) > 2) {
      lastHudH = hud.offsetHeight;
      Globe.relayout();
    }
    if (Date.now() - lastSave > 15000) { lastSave = Date.now(); saveCache(); }
  }

  function paintStatus() {
    var live = $('livePill'), liveTxt = $('liveTxt'), wsPill = $('wsPill'), wsTxt = $('wsTxt');
    var bad = stale();
    mark(live, 'warn', bad);
    mark(live, 'pulse', !bad);
    if (liveTxt) liveTxt.textContent = bad ? (S.lastOk ? 'STALE' : 'WAIT') : 'LIVE';
    /* The pill above is the mempool feed. The L1 layer has its own answer, and the row
       under the title carries it, so a static snapshot is never read as a live network. */
    txt('subrow', subrowText());
    paintLegend();
    var wsLabel = S.ws === 'open' ? 'WS' : (S.ws === 'off' ? 'POLL' : 'POLL');
    if (wsTxt) wsTxt.textContent = wsLabel;
    mark(wsPill, 'off', S.ws !== 'open');
    mark(wsPill, 'warn', false);
    var sync = $('syncTxt');
    if (sync) {
      sync.textContent = bad ? L('retry') : (S.ws === 'open' ? L('syncing') : L('polling'));
      mark($('syncWrap'), 'warn', bad);
    }
    paintWatchPill();
  }

  /* The row under the title, the legend and the L1 block all answer the same question:
     is this live, a saved answer, or the bundled snapshot — and if it is the snapshot,
     is that because the request has not answered yet or because this browser can never
     read bitnodes.io at all. */
  function subrowText() {
    if (S.layer === 'entities') {
      var n = (typeof Ent !== 'undefined' && Ent && Ent.state && Ent.state.data) ? Ent.state.data.list.length : 0;
      return L('subEN') + (n ? ' · ' + n + ' ENTITIES' : '');
    }
    return S.layer === 'l1' ? L('subL1') + l1Badge() : L('subLN');
  }

  var legendSig = '';
  function paintLegend() {
    var html;
    if (S.layer === 'entities') {
      html = '<span class="l"><span class="dot"></span>' + esc(L('legENdot')) + '</span>' +
        '<span class="l">' + esc(L('legENnote')) + '</span>';
    } else {
      html = S.layer === 'l1'
        ? '<span class="l"><span class="dot"></span>' + esc(L('legL1dot')) + '</span><span class="l">' + esc(L('legL1note')) + '</span>' +
          ((!S.l1 || S.l1.src !== 'live') ? '<span class="l">' + esc(L('legL1static')) + '</span>' : '')
        : '<span class="l"><span class="dot"></span>' + esc(L('legLNdot')) + '</span><span class="l"><span class="line"></span>' + esc(L('legLNline')) + '</span>';
    }
    if (html === legendSig) return;
    legendSig = html;
    var el = $('legend');
    if (el) el.innerHTML = html;
  }

  function paintWatchPill() {
    var alerts = (S.wd && S.wd.list ? S.wd.list.filter(function (x) { return x.alert; }) : []);
    var pill = $('watchPill');
    if (!pill) return;
    txt('watchTxt', 'WDG ' + (alerts.length ? String(alerts.length) : '0'));
    mark(pill, 'warn', alerts.length > 0);
    mark(pill, 'off', alerts.length === 0);
  }

  function paintMetrics() {
    var l1 = S.l1;
    /* --- L1 HUD: height · mempool · fastest fee --- */
    txt('vHeight', S.tip === null ? '—' : fmtInt(S.tip));
    var memEl = $('vMem');
    if (memEl) {
      var mb = S.mem && num(S.mem.vsize) ? (S.mem.vsize / 1e6).toFixed(1) : null;
      var tx = S.mem && num(S.mem.count) ? fmtInt(S.mem.count) : null;
      var want = (mb === null ? '—' : mb) + '|' + (tx === null ? '—' : tx);
      if (memEl.getAttribute('data-v') !== want) {
        memEl.setAttribute('data-v', want);
        memEl.innerHTML = mb === null ? '—'
          : esc(mb) + '<span class="u">MB</span><span class="tx">' + esc(tx) + ' TX</span>';
      }
    }
    txt('vFee', S.fees && num(S.fees.fastestFee) ? String(Math.round(S.fees.fastestFee * 10) / 10) : '—');

    /* --- Lightning HUD: nodes · channels · capacity --- */
    txt('vNodes', S.ln && num(S.ln.node_count) ? fmtInt(S.ln.node_count) : '—');
    txt('vChans', S.ln && num(S.ln.channel_count) ? fmtInt(S.ln.channel_count) : '—');
    txt('vCap', S.ln && num(S.ln.total_capacity) ? fmtBtcCap(S.ln.total_capacity) : '—');

    [['mHeight', S.tip], ['mMem', S.mem], ['mFee', S.fees], ['mNodes', S.ln], ['mChans', S.ln], ['mCap', S.ln]].forEach(function (p) {
      var el = $(p[0]);
      if (!el) return;
      mark(el, 'pending', p[1] === null || p[1] === undefined);
      mark(el, 'stale', !!p[1] && stale());
    });
    if (S.layer === 'entities' && typeof Ent !== 'undefined' && Ent && Ent.paint) Ent.paint();

    var sMem = $('sMem'), sFee = $('sFee'), sNext = $('sNext');
    var memTxt = '—';
    if (S.mem && num(S.mem.vsize)) {
      memTxt = (S.mem.vsize / 1e6).toFixed(1) + ' MB · ' + fmtInt(S.mem.count) + ' TX';
    }
    if (sMem) sMem.textContent = memTxt;
    if (sFee) sFee.textContent = S.fees && num(S.fees.fastestFee) ? (Math.round(S.fees.fastestFee * 10) / 10) + ' sat/vB' : '—';
    if (sNext) sNext.textContent = S.mblocks.length ? L('nextBlock') + ' ' + fmtFixed(S.mblocks[0].median, 1) + ' sat/vB' : '—';
  }

  function paintPanel() {
    evalWatch();
    txt('pHeight', S.tip === null ? '—' : fmtInt(S.tip));
    var hrAvg = null;
    if (S.hr && S.hr.hashrates && S.hr.hashrates.length) {
      var sum = 0, k = 0;
      S.hr.hashrates.forEach(function (r) { if (num(r.avgHashrate)) { sum += r.avgHashrate; k++; } });
      if (k) hrAvg = sum / k;
    }
    var cur = hashParts(S.hr && S.hr.currentHashrate);
    var avg = hashParts(hrAvg);
    var ph = $('pHash');
    if (ph) ph.innerHTML = esc(cur.v) + '<span class="u">' + esc(cur.u || '') + '</span>' +
      (avg.u ? '<small>1w avg ' + esc(avg.v) + ' ' + esc(avg.u) + '</small>' : '');

    var pm = $('pMem');
    if (pm) {
      pm.innerHTML = S.mem && num(S.mem.vsize)
        ? esc((S.mem.vsize / 1e6).toFixed(1)) + '<span class="u">MB</span><small>' + fmtInt(S.mem.count) + ' TX · ' + (num(S.mem.totalFee) ? S.mem.totalFee.toFixed(4) : '—') + ' BTC fee</small>'
        : '—';
    }
    var pf = $('pFee');
    if (pf) {
      pf.innerHTML = S.fees && num(S.fees.fastestFee)
        ? esc(fmtFee(S.fees.fastestFee)) + '<span class="u">sat/vB</span><small>30m ' + esc(fmtFee(S.fees.halfHourFee)) + ' · 1h ' + esc(fmtFee(S.fees.hourFee)) + '</small>'
        : '—';
    }
    var pd = $('pDiff');
    if (pd) {
      if (S.diff && num(S.diff.difficultyChange)) {
        var sign = S.diff.difficultyChange >= 0 ? '+' : '';
        pd.innerHTML = esc(sign + S.diff.difficultyChange.toFixed(2)) + '<span class="u">%</span><small>' +
          fmtInt(S.diff.remainingBlocks) + ' blocks left · ' + dateOf(S.diff.estimatedRetargetDate).slice(0, 10) + '</small>';
      } else pd.textContent = '—';
    }

    /* L1 block */
    var l1 = S.l1;
    var pl1 = $('pL1');
    if (pl1) {
      pl1.innerHTML = l1 && num(l1.total)
        ? fmtInt(l1.total) + '<small>' + (l1.src === 'live' ? L('live') : l1.src === 'cache' ? L('cache') : (l1.daily ? L('snapDaily') : L('snap'))) +
          (l1.reachable && l1.reachable !== l1.total ? ' · metadata ' + fmtInt(l1.reachable) : '') + '</small>'
        : '—';
    }
    var pp = $('pPlat');
    if (pp) {
      var pf2 = l1 ? l1Platforms(l1) : null;
      pp.innerHTML = pf2
        ? fmtInt(pf2.clearnet) + '<small>TOR ' + fmtInt(pf2.tor) + ' · I2P ' + fmtInt(pf2.i2p) + '</small>'
        : '—';
    }
    txt('pL1H', l1 && num(l1.height) ? fmtInt(l1.height) : '—');
    txt('pL1At', l1 && l1.at ? dateOf(l1.at) : '—');
    var fresh = l1Freshness(l1);
    var pfr = $('pL1Fresh');
    if (pfr) {
      pfr.innerHTML = fresh
        ? esc(fresh.text) + (fresh.note ? '<small>' + esc(fresh.note) + '</small>' : '')
        : '—';
    }
    txt('l1Tag', fresh ? fresh.tag : 'BITNODES');

    /* Lightning block */
    var pl = $('pLN');
    if (pl) {
      pl.innerHTML = S.ln && num(S.ln.node_count)
        ? fmtInt(S.ln.node_count) + '<small>as of ' + dateOf(S.ln.added).slice(0, 10) + ' · mempool.space</small>'
        : '—';
    }
    var pl2 = $('pLNCap');
    if (pl2) {
      pl2.innerHTML = S.ln && num(S.ln.channel_count)
        ? fmtInt(S.ln.channel_count) + '<span class="u">ch</span><small>' + fmtBtcCap(S.ln.total_capacity) + ' BTC</small>'
        : '—';
    }

    paintDist();
    paintVersions();
    paintNext();
    paintWatch();
    if (noteDirty) { paintNote(); noteDirty = false; }
    paintBlocks();
    paintTxs();
  }

  function paintDist() {
    var box = $('dist');
    if (!box) return;
    var agg = S.layer === 'l1' ? aggregateL1Countries() : S.conts;
    if (!agg) {
      setHTML('dist', '<div class="dist"><div class="dist-top"><span class="k">' + esc(L('loading')) + '</span></div></div>');
      txt('distTotal', '');
      return;
    }
    var arr = CONT_ORDER.map(function (k) { return { k: k, n: agg.count[k] || 0 }; })
      .filter(function (d) { return d.n > 0 || d.k !== 'OT'; });
    var max = 0, total = agg.total;
    arr.forEach(function (d) { if (d.n > max) max = d.n; });
    var out = '';
    arr.forEach(function (d) {
      var pct = total ? (d.n / total * 100) : 0;
      var w = max ? (d.n / max * 100) : 0;
      out += '<div class="dist"><div class="dist-top"><span class="k">' + esc(contName(d.k)) + '</span>' +
        '<span class="v"><b>' + fmtInt(d.n) + '</b><span>' + pct.toFixed(1) + '%</span></span></div>' +
        '<div class="bar"><i class="' + barClass(Math.max(1.5, w)) + '"></i></div></div>';
    });
    setHTML('dist', out);
    if (S.layer === 'l1') {
      var s = l1Snap();
      txt('distTotal', fmtInt(total) + ' · ' + (agg.countries || 0) + ' countries' +
        (s && s.capturedAt ? ' · ' + L('snapBasis') + ' ' + dateOf(s.capturedAt * 1000).slice(0, 10) : ''));
    } else {
      txt('distTotal', fmtInt(total) + ' · ' + S.countries.length + ' countries');
    }
  }

  function paintVersions() {
    var box = $('verList');
    if (!box) return;
    var vers = (S.l1 && S.l1.vers) ? S.l1.vers : [];
    if (!vers.length) { setHTML('verList', '<div class="ver"><div class="ver-top"><span class="p">' + esc(L('loading')) + '</span></div></div>'); return; }
    var max = 0;
    vers.forEach(function (v) { if (num(v.pct) && v.pct > max) max = v.pct; });
    var out = '';
    vers.slice(0, 5).forEach(function (v) {
      var pct = num(v.pct) ? v.pct : 0;
      var name = v.name.length > 30 ? v.name.slice(0, 29) + '…' : v.name;
      out += '<div class="ver"><div class="ver-top"><span class="n">' + esc(name) + '</span>' +
        '<span class="p">' + pct.toFixed(2) + '%</span></div>' +
        '<div class="bar"><i class="' + barClass(Math.max(1, max ? pct / max * 100 : 0)) + '"></i></div></div>';
    });
    setHTML('verList', out);
    txt('verSrc', S.l1 && S.l1.src === 'live' ? 'LIVE' : S.l1 && S.l1.src === 'cache' ? 'CACHE' : 'SNAPSHOT');
  }

  function paintNext() {
    var box = $('nextBlocks');
    if (!box) return;
    if (!S.mblocks.length) {
      setHTML('nextBlocks', '<div class="nb"><div class="empty">' + esc(L('nextNone')) + '</div></div>');
      txt('nextTotal', '');
      return;
    }
    var out = '<div class="nb">';
    S.mblocks.slice(0, 3).forEach(function (b, i) {
      out += '<div class="b"><div class="h"><span>#' + (i + 1) + '</span><span>' + fmtFixed((b.vsize || 0) / 1e6, 2) + 'M</span></div>' +
        '<div class="f">' + fmtFixed(b.median, b.median != null && b.median < 10 ? 1 : 0) + '<span class="u">sat/vB</span></div>' +
        '<div class="s">' + fmtFixed(b.lo, 1) + '–' + fmtFixed(b.hi, b.hi != null && b.hi >= 100 ? 0 : 1) + '</div>' +
        '<div class="s">' + fmtInt(b.nTx) + ' tx</div></div>';
    });
    out += '</div>';
    setHTML('nextBlocks', out);
    txt('nextTotal', S.mblocks.length + ' blocks queued' +
      (S.mblocksAt ? ' · ' + ago(S.mblocksAt) : ''));
  }

  function paintWatch() {
    var box = $('watch');
    if (!box) return;
    var list = S.wd ? S.wd.list : [];
    if (!list.length) { setHTML('watch', '<div class="wd-list"><div class="wd-item">' + esc(L('wNoData')) + '</div></div>'); return; }
    var out = '<div class="wd-list">';
    list.forEach(function (w) {
      out += '<div class="wd-item ' + (w.alert ? 'alert' : 'ok') + '"><span class="tag">' + esc(w.tag) + '</span><span class="m">' + esc(w.text) + '</span></div>';
    });
    out += '</div>';
    setHTML('watch', out);
    txt('watchSrc', S.poolsAt ? ago(S.poolsAt) : '');
  }

  function noteSrcText() {
    if (!S.l1) return L('none');
    return S.l1.src === 'live' ? L('live') : S.l1.src === 'cache' ? L('cache') : L('snap');
  }

  /* The DATA footnote names where the L1 figures come from right now: a live Bitnodes
     read, a cached Bitnodes answer (localStorage, served when the live request failed),
     or the bundled snapshot. The old two-state wording printed "the built-in snapshot"
     for the cache case too — true of neither the numbers nor the timestamp shown. */
  function l1NowClause(l1, snapAt) {
    if (l1 && l1.src === 'live') return ' (live now)';
    if (l1 && l1.src === 'cache') {
      var at = num(l1.at) ? dateOf(l1.at) : '—';
      return ' — currently the cached Bitnodes answer of ' + at + ', because the live request did not answer';
    }
    if (l1 && l1.daily) return ' — currently the published daily snapshot ' + snapAt + ', read from corejbh.github.io';
    return ' — currently the built-in snapshot ' + snapAt + ', because the live request did not answer';
  }

  function l1PointsClause(l1) {
    if (l1 && l1.src === 'live') return 'live';
    if (l1 && l1.src === 'cache') return 'cached answer';
    if (l1 && l1.daily) return 'daily snapshot';
    return 'snapshot';
  }

  function paintNote() {
    var e = $('note');
    if (!e) return;
    var s = l1Snap();
    var l1 = S.l1;
    var snapAt = s && s.capturedAt ? dateOf(s.capturedAt * 1000).slice(0, 16) : '—';
    e.innerHTML =
      '<b>DATA</b> Bitcoin mainnet values are mempool.space REST + WebSocket responses; L1 full-node values are the Bitnodes crawler export (bitnodes.io/api/v1).<br>' +
      '· <b>Bitnodes is the primary L1 source</b>: the reachable node count, the clear-net/Tor/I2P split, the client versions and the unique coordinates on the globe are read from <code>snapshots/latest/?field=coordinates</code> and <code>?field=top</code>' +
      l1NowClause(l1, snapAt) + '.<br>' +
      '· The country split (' + (s ? s.countries.length : 0) + ' countries) is the Bitnodes snapshot captured ' + snapAt + ' with ' + fmtInt(s ? s.totalNodes : null) +
      ' nodes; Bitnodes exposes per-node country only through its paginated node list, which is too heavy to pull on a phone, so this panel names that snapshot instead of hiding it.<br>' +
      '· Globe points: ' + (l1 ? fmtInt(l1.coords.length) : '0') + ' unique coordinates Bitnodes geolocated (' + l1PointsClause(l1) + '). Tor and I2P nodes carry no coordinates, so they are not placed, and no link is drawn between nodes: Bitnodes publishes no peer graph.<br>' +
      '· Values the crawler cannot know (per-node latency, uptime, disk size, per-node height) are never shown or guessed.<br>' +
      '· Next blocks are mempool.space\'s own projection of the transactions that would fill each of the coming blocks, with the reported fee range and tx count.<br>' +
      '· Watchdog thresholds: no block for ' + (WD_BLOCK_SEC / 60) + ' min, fastest fee ≥ ' + WD_FEE_SPIKE + ' sat/vB or 3× the 10-minute minimum, one pool above ' + Math.round(WD_POOL_SHARE * 100) + '% of the week\'s blocks, or a block hash change at an already-seen height.<br>' +
      '· Lightning layer: the node sample is picked from the <code>lightning/channels-geo</code> graph (' + fmtInt(S.chanRows) + ' real open channels) completed with <code>nodes/{pubkey}</code>, and every arc is one of those rows; no proximity link exists.';
  }

  function paintBlocks() {
    var box = $('listBlocks');
    if (!box || !S.blocks.length) { if (box) box.innerHTML = '<div class="item"><div class="l2">' + esc(L('loading')) + '</div></div>'; return; }
    var out = '';
    S.blocks.forEach(function (b) {
      var elapsed = num(b.time) ? durSec(Math.max(0, Date.now() / 1000 - b.time)) : '—';
      out += '<div class="item"><div class="l1"><span>#' + fmtInt(b.height) + '</span><span class="r">' + fmtInt(b.txs) + '</span></div>' +
        '<div class="l2"><span>' + fmtFixed(b.size / 1e6, 2) + 'M · ' + esc(elapsed) + '</span>' +
        '<span>' + (b.medianFee != null ? fmtFixed(b.medianFee, 1) : '') + '</span></div>' +
        '<div class="hash">' + esc(shortHash(b.id, 18, 6)) + (b.pool ? ' · ' + esc(b.pool) : '') + '</div></div>';
    });
    setHTML('listBlocks', out);
  }

  function paintTxs() {
    var box = $('listTxs');
    if (!box || !S.recent.length) { if (box) box.innerHTML = '<div class="item"><div class="l2">' + esc(L('loading')) + '</div></div>'; return; }
    var out = '';
    S.recent.slice(0, 8).forEach(function (t) {
      var rate = num(t.rate) ? t.rate : (t.vsize ? t.fee / t.vsize : null);
      out += '<div class="item"><div class="l1"><span>' + fmtBtc(t.value) + '</span>' +
        '<span class="r">' + (rate != null ? fmtFixed(rate, rate < 10 ? 1 : 0) : '—') + '</span></div>' +
        '<div class="l2"><span>' + fmtFixed(t.vsize, 0) + ' vB</span><span class="sat">sat/vB</span></div>' +
        '<div class="hash">' + esc(shortHash(t.txid, 8, 4)) + ' · ' + fmtInt(t.fee) + ' sat</div></div>';
    });
    setHTML('listTxs', out);
  }

  /* --------------------------------------------------------------- events */
  var toastTimer = null;
  function toast(msg, ms) {
    var el = $('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('on');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('on'); }, ms || 3600);
  }

  function blockEvent(height, block) {
    Globe.pulse();
    var bump = $('mHeight');
    if (bump) { bump.classList.remove('bump'); void bump.offsetWidth; bump.classList.add('bump'); }
    toast(L('tNewBlock') + ' · ' + fmtInt(height) + (block && num(block.txs) ? ' · ' + fmtInt(block.txs) + ' tx' : ''));
  }

  function reorgEvent(prevHeight, newHeight, block) {
    S.reorgAt = Date.now();
    S.reorgAtHeight = num(newHeight) ? newHeight : (num(block && block.height) ? block.height : prevHeight);
    toast('⚠ ' + L('tReorg') + ' · #' + fmtInt(S.reorgAtHeight), 6000);
    schedulePaint();
  }

