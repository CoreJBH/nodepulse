/* Live feeds and the watchdog: one socket at a time, every pushed field shape-checked,
   and the four alerts computed only from values an API reported. */

  /* ------------------------------------------------------------ websocket */
  var ws = null, wsTimer = null, wsHeld = false;

  function wsUrl() { return 'wss://' + WS_HOSTS[S.wsHost % WS_HOSTS.length] + WS_PATH; }

  /* One socket at a time. connectWS() is reachable from the retry timer, from the 45 s
     watchdog tick and from a close that arrives late, and each of those used to open
     another socket: the app then held two or three live feeds, and the loser's close
     advanced the mirror and scheduled yet another connect. A socket that is still
     connecting or already open is left alone, and every handler checks that its own
     socket is still the current one before it touches the state or schedules a retry. */
  function connectWS() {
    if (!('WebSocket' in window)) { S.ws = 'off'; paintStatus(); return; }
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
    if (wsTimer) { clearTimeout(wsTimer); wsTimer = null; }
    var sock;
    try { sock = new WebSocket(wsUrl()); } catch (e) { S.ws = 'off'; scheduleWS(); return; }
    ws = sock;
    S.ws = 'connecting';
    paintStatus();
    /* A socket can stay CONNECTING forever (a captive portal, a dead mirror): the
       browser only gives up on its own after tens of seconds, so the mirrors never
       rotate and the app sits without a feed. If the socket is still CONNECTING when
       this fires, close it, advance the mirror and schedule the retry here. */
    var openTimer = setTimeout(function () {
      if (ws !== sock || sock.readyState !== 0) return;
      try { sock.close(); } catch (e) { }
      if (ws !== sock) return;                       // the close handler already ran
      ws = null;
      S.ws = 'closed';
      S.wsHost = (S.wsHost + 1) % WS_HOSTS.length;
      paintStatus();
      scheduleWS();
    }, WS_CONNECT_MS);
    sock.onopen = function () {
      if (ws !== sock) return;
      clearTimeout(openTimer);
      S.ws = 'open'; S.wsTries = 0; ok();
      try { sock.send(JSON.stringify({ action: 'want', data: ['blocks', 'stats', 'mempool-blocks'] })); } catch (e) { }
      paintStatus();
    };
    sock.onmessage = function (ev) {
      if (ws !== sock) return;
      var m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      handleWS(m);
    };
    sock.onerror = function () { /* close follows */ };
    sock.onclose = function () {
      if (ws !== sock) return;                 // a stale socket closing late changes nothing
      ws = null;
      S.ws = 'closed';
      S.wsHost = (S.wsHost + 1) % WS_HOSTS.length;   // next mirror answers the retry
      paintStatus();
      scheduleWS();
    };
  }
  function scheduleWS() {
    if (wsTimer) return;
    /* A hidden page has nobody watching the feed, and a retry that comes due while it is
       hidden only wakes the radio: the socket is opened once the page is visible again,
       through the visibilitychange handler at the bottom of this file. This matters most
       with the screen off, where every retry was a wake-up with no reader. */
    if (document.hidden) { wsHeld = true; return; }
    S.wsTries++;
    var wait = Math.min(30000, 1200 * Math.pow(1.7, Math.min(6, S.wsTries)));
    wsTimer = setTimeout(function () { wsTimer = null; connectWS(); }, wait);
  }

  function noteFee(f) {
    if (!f || !num(f.fastestFee)) return;
    var now = Date.now();
    S.feeHist.push({ v: f.fastestFee, t: now });
    if (S.feeHist.length > 240) S.feeHist.splice(0, S.feeHist.length - 240);
  }

  /* A push block must carry every figure the ledger row prints: a numeric height, a hash
     string, and finite numbers for time, tx count and size. An entry missing them is
     skipped instead of being drawn as NaN or throwing inside shortHash(). */
  function pushedBlock(b) {
    return isObj(b) && num(b.height) && typeof b.id === 'string' && b.id.length > 0 &&
      num(b.timestamp) && num(b.tx_count) && num(b.size);
  }

  /* A push is not a REST answer: nothing has validated it before it arrives, and every
     branch below feeds a value straight into a paint path that assumes numbers and
     lists. Each field is therefore shape-checked here — a finite number where a figure
     is printed, an array where a list is walked — and a branch that fails is skipped,
     leaving the previous value on screen. */
  function handleWS(m) {
    if (!isObj(m)) return;
    var touched = false;
    if (isObj(m.mempoolInfo) && num(m.mempoolInfo.size) && num(m.mempoolInfo.bytes)) {
      S.mem = { count: m.mempoolInfo.size, vsize: m.mempoolInfo.bytes, totalFee: btcAmount(m.mempoolInfo.total_fee) };
      touched = true;
    }
    if (isObj(m.fees)) {
      var fees = feesFromAnswer(m.fees);
      if (fees) { S.fees = fees; noteFee(fees); touched = true; }
    }
    if (isObj(m.da)) {
      var da = diffFromAnswer(m.da);
      if (da) { S.diff = da; touched = true; }
    }
    if (isArr(m.blocks) && m.blocks.length) {
      var list = orderBlocks(m.blocks.filter(pushedBlock).map(mapBlock)).slice(0, 8);
      if (list.length) {
        var top = list[0].height;
        if (S.tip !== null && top > S.tip) blockEvent(top, list[0]);
        S.tip = Math.max(S.tip || 0, top);
        S.tipSeenAt = Date.now();
        S.blocks = list;
        trackChain(list);
        touched = true;
      }
    }
    if (isArr(m.transactions) && m.transactions.length) {
      var add = m.transactions.filter(function (t) { return isObj(t) && typeof t.txid === 'string' && t.txid; })
        .map(function (t) {
        return {
          txid: t.txid,
          fee: num(t.fee) ? t.fee : null,
          vsize: num(t.vsize) ? t.vsize : null,
          value: num(t.value) ? t.value : null,
          rate: num(t.rate) ? t.rate : (num(t.fee) && num(t.vsize) && t.vsize > 0 ? t.fee / t.vsize : null)
        };
      });
      if (add.length) {
        var seen = Object.create(null);
        add.forEach(function (t) { seen[t.txid] = 1; });
        S.recent = add.concat(S.recent.filter(function (t) { return !seen[t.txid]; })).slice(0, 10);
        touched = true;
      }
    }
    /* mempool.space's own projection of the next blocks: each entry is the set of
       transactions that would fill one block, with its fee range and tx count. */
    if (isArr(m['mempool-blocks']) && m['mempool-blocks'].length) {
      var mbs = [];
      m['mempool-blocks'].forEach(function (b) {
        if (!isObj(b)) return;
        /* at least one real figure, the same rule the cached projection uses */
        if (!num(b.medianFee) && !num(b.blockVSize) && !num(b.nTx)) return;
        var fr = isArr(b.feeRange) ? b.feeRange.filter(function (v) { return num(v); }) : [];
        mbs.push({
          nTx: num(b.nTx) ? b.nTx : 0, vsize: num(b.blockVSize) ? b.blockVSize : 0,
          size: num(b.blockSize) ? b.blockSize : 0, fees: num(b.totalFees) ? b.totalFees : null,
          median: num(b.medianFee) ? b.medianFee : null,
          lo: fr.length ? fr[0] : null, hi: fr.length ? fr[fr.length - 1] : null
        });
      });
      if (mbs.length) {
        S.mblocks = mbs;
        S.mblocksAt = Date.now();
        touched = true;
      }
    }
    if (touched) { ok(); schedulePaint(); }
  }

  /* ------------------------------------------------------------- watchdog */
  /* Every alert below is computed from a value an API reported; nothing is
     inferred about the network beyond the documented thresholds. */
  function evalWatch() {
    var list = [], alerts = [], now = Date.now();
    var fresh = !stale();          // our own feed answered recently
    var b = S.blocks && S.blocks.length ? S.blocks[0] : null;
    /* clamped: a slow phone clock must not turn a fresh block into a negative gap */
    var gap = b && num(b.time) ? Math.max(0, now / 1000 - b.time) : null;

    if (gap === null || !fresh) {
      list.push({ tag: 'BLOCK', alert: false, text: L('wNoData') });
    } else if (gap > WD_BLOCK_SEC) {
      list.push({ tag: 'BLOCK', alert: true, text: L('wGap') + ' · ' + durSec(gap) + ' · #' + fmtInt(b.height) });
      alerts.push({ k: 'gap', text: L('wGap') + ' ' + durSec(gap) });
    } else {
      list.push({ tag: 'BLOCK', alert: false, text: L('wOkGap') + ' ' + durSec(gap) + ' · #' + fmtInt(b.height) });
    }

    var ff = S.fees && num(S.fees.fastestFee) ? S.fees.fastestFee : null;
    if (ff === null || !fresh) {
      list.push({ tag: 'FEE', alert: false, text: L('wNoData') });
    } else {
      var base = null;
      for (var i = 0; i < S.feeHist.length; i++) {
        var h = S.feeHist[i];
        if (now - h.t <= 10 * 60 * 1000 && h.v > 0) base = base === null ? h.v : Math.min(base, h.v);
      }
      var spike = ff >= WD_FEE_SPIKE;
      var jump = base !== null && ff >= base * 3 && ff >= 5;
      if (spike || jump) {
        var why = spike ? '≥ ' + WD_FEE_SPIKE : '×' + (ff / base).toFixed(1);
        list.push({ tag: 'FEE', alert: true, text: L('wFee') + ' · ' + fmtFixed(ff, 1) + ' sat/vB (' + why + ')' });
        alerts.push({ k: 'fee', text: L('wFee') + ' ' + fmtFixed(ff, 1) + ' sat/vB' });
      } else {
        list.push({ tag: 'FEE', alert: false, text: L('wOkFee') + ' · ' + fmtFixed(ff, 1) + ' sat/vB' });
      }
    }

    var p = (S.pools && S.poolsAt && now - S.poolsAt < 24 * 3600 * 1000) ? S.pools : null;
    if (p && p.pools && p.pools.length && num(p.blockCount) && p.blockCount > 0) {
      var top1 = p.pools[0];
      var share = top1.blockCount / p.blockCount;
      var txtPool = (top1.name || '—') + ' ' + (share * 100).toFixed(1) + '%';
      if (share > WD_POOL_SHARE) {
        list.push({ tag: 'POOL', alert: true, text: L('wPool') + ' · ' + txtPool + ' (' + L('poolSpan') + ' ' + fmtInt(p.blockCount) + ' ' + L('poolBlocks') + ')' });
        alerts.push({ k: 'pool', text: L('wPool') + ' ' + (share * 100).toFixed(1) + '%' });
      } else {
        list.push({ tag: 'POOL', alert: false, text: L('wOkPool') + ' · ' + txtPool });
      }
    } else {
      list.push({ tag: 'POOL', alert: false, text: L('wNoData') });
    }

    if (S.reorgAt && now - S.reorgAt < WD_REORG_MS) {
      list.push({ tag: 'CHAIN', alert: true, text: L('wReorg') + ' · #' + fmtInt(S.reorgAtHeight) });
      alerts.push({ k: 'reorg', text: L('wReorg') + ' #' + fmtInt(S.reorgAtHeight) });
    } else {
      list.push({ tag: 'CHAIN', alert: false, text: L('wOkChain') + (b ? ' · #' + fmtInt(b.height) : '') });
    }

    S.wd = { list: list, alerts: alerts, at: now, gapSec: gap };
    var sig = alerts.map(function (a) { return a.k; }).sort().join('|');
    if (sig !== S.alertSig) {
      S.alertSig = sig;
      if (alerts.length) toast('⚠ ' + alerts.map(function (a) { return a.text; }).slice(0, 2).join(' · '), 5200);
    }
    return alerts;
  }

