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
    return S.layer === 'l1' ? L('subL1') + l1Badge() : L('subLN');
  }

  var legendSig = '';
  function paintLegend() {
    var html = S.layer === 'l1'
      ? '<span class="l"><span class="dot"></span>' + esc(L('legL1dot')) + '</span><span class="l">' + esc(L('legL1note')) + '</span>' +
        ((!S.l1 || S.l1.src !== 'live') ? '<span class="l">' + esc(L('legL1static')) + '</span>' : '')
      : '<span class="l"><span class="dot"></span>' + esc(L('legLNdot')) + '</span><span class="l"><span class="line"></span>' + esc(L('legLNline')) + '</span>';
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
      (avg.u ? '<small>' + (S.lang === 'en' ? '1w avg ' : '1주 평균 ') + esc(avg.v) + ' ' + esc(avg.u) + '</small>' : '');

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
          fmtInt(S.diff.remainingBlocks) + (S.lang === 'en' ? ' blocks left · ' : ' 블록 남음 · ') + dateOf(S.diff.estimatedRetargetDate).slice(0, 10) + '</small>';
      } else pd.textContent = '—';
    }

    /* L1 block */
    var l1 = S.l1;
    var pl1 = $('pL1');
    if (pl1) {
      pl1.innerHTML = l1 && num(l1.total)
        ? fmtInt(l1.total) + '<small>' + (l1.src === 'live' ? L('live') : l1.src === 'cache' ? L('cache') : L('snap')) +
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
        ? fmtInt(S.ln.node_count) + '<small>' + (S.lang === 'en' ? 'as of ' : '기준 ') + dateOf(S.ln.added).slice(0, 10) + ' · mempool.space</small>'
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
      var s = (typeof L1_SNAPSHOT !== 'undefined') ? L1_SNAPSHOT : null;
      txt('distTotal', fmtInt(total) + ' · ' + (agg.countries || 0) + (S.lang === 'en' ? ' countries' : '개국') +
        (s && s.capturedAt ? ' · ' + L('snapBasis') + ' ' + dateOf(s.capturedAt * 1000).slice(0, 10) : ''));
    } else {
      txt('distTotal', fmtInt(total) + ' · ' + S.countries.length + (S.lang === 'en' ? ' countries' : '개국'));
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
    txt('nextTotal', S.mblocks.length + ' ' + (S.lang === 'en' ? 'blocks queued' : '블록 대기') +
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
  function l1NowClause(l1, snapAt, en) {
    if (l1 && l1.src === 'live') return en ? ' (live now)' : '에서 지금 실시간으로 읽었습니다';
    if (l1 && l1.src === 'cache') {
      var at = num(l1.at) ? dateOf(l1.at) : '—';
      return en
        ? ' — currently the cached Bitnodes answer of ' + at + ', because the live request did not answer'
        : '에서 읽으며, 지금은 저장해 둔 Bitnodes 응답(' + at + ')을 표시 중입니다(실시간 요청이 답하지 않았습니다)';
    }
    return en
      ? ' — currently the built-in snapshot ' + snapAt + ', because the live request did not answer'
      : '에서 읽으며, 지금은 실시간 요청이 답하지 않아 내장 스냅샷(' + snapAt + ')을 표시 중입니다';
  }

  function l1PointsClause(l1, en) {
    if (l1 && l1.src === 'live') return en ? 'live' : '실시간';
    if (l1 && l1.src === 'cache') return en ? 'cached answer' : '저장본';
    return en ? 'snapshot' : '스냅샷';
  }

  function paintNote() {
    var e = $('note');
    if (!e) return;
    var s = (typeof L1_SNAPSHOT !== 'undefined') ? L1_SNAPSHOT : null;
    var l1 = S.l1;
    var snapAt = s && s.capturedAt ? dateOf(s.capturedAt * 1000).slice(0, 16) : '—';
    if (S.lang === 'en') {
      e.innerHTML =
        '<b>DATA</b> Bitcoin mainnet values are mempool.space REST + WebSocket responses; L1 full-node values are the Bitnodes crawler export (bitnodes.io/api/v1).<br>' +
        '· <b>Bitnodes is the primary L1 source</b>: the reachable node count, the clear-net/Tor/I2P split, the client versions and the unique coordinates on the globe are read from <code>snapshots/latest/?field=coordinates</code> and <code>?field=top</code>' +
        l1NowClause(l1, snapAt, true) + '.<br>' +
        '· The country split (' + (s ? s.countries.length : 0) + ' countries) is the Bitnodes snapshot captured ' + snapAt + ' with ' + fmtInt(s ? s.totalNodes : null) +
        ' nodes; Bitnodes exposes per-node country only through its paginated node list, which is too heavy to pull on a phone, so this panel names that snapshot instead of hiding it.<br>' +
        '· Globe points: ' + (l1 ? fmtInt(l1.coords.length) : '0') + ' unique coordinates Bitnodes geolocated (' + l1PointsClause(l1, true) + '). Tor and I2P nodes carry no coordinates, so they are not placed, and no link is drawn between nodes: Bitnodes publishes no peer graph.<br>' +
        '· Values the crawler cannot know (per-node latency, uptime, disk size, per-node height) are never shown or guessed.<br>' +
        '· Next blocks are mempool.space\'s own projection of the transactions that would fill each of the coming blocks, with the reported fee range and tx count.<br>' +
        '· Watchdog thresholds: no block for ' + (WD_BLOCK_SEC / 60) + ' min, fastest fee ≥ ' + WD_FEE_SPIKE + ' sat/vB or 3× the 10-minute minimum, one pool above ' + Math.round(WD_POOL_SHARE * 100) + '% of the week\'s blocks, or a block hash change at an already-seen height.<br>' +
        '· Lightning layer: the node sample is picked from the <code>lightning/channels-geo</code> graph (' + fmtInt(S.chanRows) + ' real open channels) completed with <code>nodes/{pubkey}</code>, and every arc is one of those rows; no proximity link exists.';
      return;
    }
    e.innerHTML =
      '<b>DATA</b> 비트코인 메인넷 값은 mempool.space REST + WebSocket 응답값이고, L1 풀노드 값은 Bitnodes 크롤러 export(bitnodes.io/api/v1)입니다.<br>' +
      '· <b>L1의 1차 출처는 Bitnodes</b>입니다: 도달 가능 노드 수, 클리어넷/Tor/I2P 비중, 클라이언트 버전, 지구본 좌표는 <code>snapshots/latest/?field=coordinates</code>와 <code>?field=top</code>' +
      l1NowClause(l1, snapAt, false) + '.<br>' +
      '· 국가 분포(' + (s ? s.countries.length : 0) + '개국)는 ' + snapAt + ' Bitnodes 스냅샷(' + fmtInt(s ? s.totalNodes : null) + ' 노드) 값입니다. Bitnodes는 노드별 국가를 페이지 목록으로만 공개해 휴대폰에서 전부 받아오기엔 무겁기 때문에, 이 항목만 스냅샷 기준임을 숨기지 않고 적습니다.<br>' +
      '· 지구본 지점 ' + (l1 ? fmtInt(l1.coords.length) : '0') + '곳은 Bitnodes가 좌표를 확인한 서로 다른 위치입니다(' + l1PointsClause(l1, false) + '). Tor·I2P 노드는 좌표가 없어 배치하지 않고, 노드 사이에 선은 그리지 않습니다 — Bitnodes는 노드별 연결 그래프를 공개하지 않습니다.<br>' +
      '· 크롤러가 알 수 없는 값(노드별 지연시간·가동시간·디스크 용량·개별 높이)은 표시하지도 추정하지도 않습니다.<br>' +
      '· 다음 블록은 mempool.space가 계산한 예측으로, 앞으로의 블록을 채울 트랜잭션 묶음의 수수료 범위와 트랜잭션 수입니다.<br>' +
      '· 감시 기준: ' + (WD_BLOCK_SEC / 60) + '분 이상 새 블록 없음, 최속 수수료 ' + WD_FEE_SPIKE + ' sat/vB 이상 또는 10분 최저의 3배, 한 채굴 풀이 주간 블록의 ' + Math.round(WD_POOL_SHARE * 100) + '% 초과, 이미 본 높이의 블록 해시 변경(리오그).<br>' +
      '· 라이트닝 레이어: 노드 표본은 <code>lightning/channels-geo</code>가 보고한 실제 공개 채널 ' + fmtInt(S.chanRows) + '개 그래프에서 뽑고 <code>nodes/{pubkey}</code>로 보완했으며, 모든 호가 그 채널 행 중 하나입니다 — 근접·임의로 이은 선은 없습니다.';
  }

  function paintBlocks() {
    var box = $('listBlocks');
    if (!box || !S.blocks.length) { if (box) box.innerHTML = '<div class="item"><div class="l2">' + esc(L('loading')) + '</div></div>'; return; }
    var out = '';
    S.blocks.forEach(function (b) {
      var elapsed = num(b.time) ? durSec(Math.max(0, Date.now() / 1000 - b.time)) : '—';
      out += '<div class="item"><div class="l1"><span>#' + fmtInt(b.height) + '</span><span class="r">' + fmtInt(b.txs) + '</span></div>' +
        '<div class="l2"><span>' + fmtFixed(b.size / 1e6, 2) + 'M · ' + esc(elapsed) + (S.lang === 'en' ? '' : ' 전') + '</span>' +
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

