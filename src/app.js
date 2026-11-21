/* ============================================================================
   NodePulse — Bitcoin L1 mainnet monitor
   ----------------------------------------------------------------------------
   Two layers, one rule: every value on screen is a value an API reported.

     Bitcoin L1 (default)  Bitnodes crawler export — reachable full-node count,
                           clear-net/Tor/I2P split, country + continent counts,
                           client versions (/Satoshi:x.y.z/), and the unique
                           coordinates the crawler geolocated.
     Lightning             mempool.space — the real public channel graph.

   Nothing is generated, interpolated or estimated for display. Bitnodes does not
   publish a per-node peer graph, so the L1 globe draws no links at all rather
   than invent one; Tor/I2P nodes carry no coordinates, so they are not placed.

   On Android the Bitnodes requests go through the native HTTP bridge
   (window.NPBridge, MainActivity.java) because bitnodes.io sends no CORS header;
   in a plain browser they are attempted with fetch and fall back to the bundled
   build-time Bitnodes snapshot (fetch_l1.py), which the panel labels by date.
   ========================================================================== */
(function () {
  'use strict';

  var DEG = Math.PI / 180, TAU = Math.PI * 2;
  var API_HOSTS = ['https://mempool.space', 'https://mempool.emzy.de', 'https://mempool.ninja'];
  var WS_HOSTS = ['mempool.space', 'mempool.emzy.de', 'mempool.ninja'];
  var WS_PATH = '/api/v1/ws';
  var BIT = 'https://bitnodes.io';
  var BIT_COORDS = BIT + '/api/v1/snapshots/latest/?field=coordinates';
  var BIT_TOP = BIT + '/api/v1/snapshots/latest/?field=top';
  var CH_PATH = '/api/v1/lightning/channels-geo';
  var LS_CACHE = 'nodepulse.cache.v2';
  var LS_NODES = 'nodepulse.nodes.v2';   // lightning node sample + real channels between them
  var LS_PREF = 'nodepulse.pref.v1';     // layer + language
  var NODE_TTL = 6 * 3600 * 1000;
  var L1_TTL = 5 * 60 * 1000;
  var POOL_TTL = 30 * 60 * 1000;
  var MAX_NODES = 22;
  var STALE_MS = 90000;
  var CELL_DEG = 20;
  var CELL_CAP = 2;
  var REGION_CAP = 5;
  var L1_CELL_DEG = 3;                   // globe bucket for Bitnodes coordinates
  /* watchdog thresholds — documented in the panel footnote */
  var WD_BLOCK_SEC = 30 * 60;
  var WD_FEE_SPIKE = 80;                 // sat/vB
  var WD_POOL_SHARE = 0.35;              // one pool's share of a week's blocks
  var WD_REORG_MS = 30 * 60 * 1000;      // how long a reorg stays on the badge

  /* ------------------------------------------------------------------ i18n */
  var STR = {
    ko: {
      utc: '현재 시각 (UTC)', state: '상태',
      secNet: 'BITCOIN MAINNET · 실시간', secL1: 'BITCOIN L1 · 풀노드', secLN: 'LIGHTNING · MEMPOOL.SPACE',
      kHeight: '블록 높이', kMem: '멤풀', kFee: '최속 수수료', kHash: '해시레이트', kDiff: '다음 난이도 조정',
      kL1: '도달 가능 풀노드', kPlat: '접속망', kL1H: '크롤러 기준 높이', kL1At: '측정 시각',
      kLN: '라이트닝 노드', kLNCap: '채널 · 용량',
      secDistL1: '대륙별 L1 노드 분포', secDistLN: '대륙별 라이트닝 노드 분포',
      secVer: '클라이언트 버전', secNext: '다음 블록 · NEXT BLOCKS', secWatch: '네트워크 감시 · WATCHDOG',
      secLedger: '최근 블록 · 최근 트랜잭션', hBlocks: '최근 블록', hTxs: '최근 트랜잭션',
      loading: '불러오는 중…', syncing: '실시간 동기화', polling: '폴링 갱신', retry: '연결 재시도 중',
      live: '실시간', snap: '내장 스냅샷', cache: '저장본', none: '—',
      subL1: 'FULL NODE NETWORK · BITNODES', subLN: 'LIGHTNING CHANNEL GRAPH · MEMPOOL.SPACE',
      legL1dot: 'L1 풀노드 위치 (Bitnodes)', legL1note: 'Tor·I2P 노드는 좌표 없음', legLNdot: 'LIGHTNING NODE',
      legLNline: 'LIGHTNING CHANNEL (실측)',
      hint: 'DRAG TO ROTATE · SCROLL / PINCH TO ZOOM',
      pOpen: '실시간 네트워크 패널 열기', pClose: '실시간 네트워크 패널 닫기',
      nextWaiting: '블록 분량 대기', nextNone: 'mempool-blocks 대기 중 — WebSocket 연결되면 표시됩니다',
      nextBlock: '다음', nextFee: 'sat/vB',
      wOkChain: '체인 정상', wOkGap: '마지막 블록', wOkFee: '수수료 정상', wOkPool: '채굴 풀 집중도',
      wGap: '블록 지연', wFee: '수수료 급등', wPool: '채굴 풀 집중', wReorg: '리오그 감지',
      wNoData: '감시 데이터 대기 중',
      tNewBlock: 'NEW BLOCK', tReorg: 'REORG 감지', tSnap: '비트노즈 스냅샷 표시 중 · 갱신 중',
      tCached: '저장된 마지막 데이터 표시 중 · 갱신 중',
      cCoord: '좌표', cCell: '격자 내 위치', cCountry: '국가', cPlace: '지역', cSrc: '출처', cSnapAt: '기준 시각',
      cChainTip: 'CHAIN TIP · 네트워크 공통', cHeight: '높이', cWhere: '위치',
      cL1Note: '이 지점은 Bitnodes가 좌표를 보고한 실제 노드 위치입니다. Bitnodes는 노드별 P2P 연결 그래프를 공개하지 않으므로 지구본에 연결선은 그리지 않습니다. 지연시간·가동시간·디스크 용량처럼 크롤러가 알 수 없는 값도 표시하지 않습니다.',
      cLNNote: '표시 값은 mempool.space Lightning API 응답 그대로입니다(별칭·국가·도시·좌표·채널·용량·AS·관측 시각). 지연시간, 가동시간, 디스크 용량, 개별 노드의 동기화 높이처럼 API가 제공하지 않는 항목은 표시하지 않습니다. CHAIN TIP은 이 노드가 보고한 값이 아니라 네트워크 공통 현재 tip입니다. 노드 사이의 호는 lightning/channels-geo에 실린 실제 공개 채널이며, 근접 추정으로 이은 선은 없습니다.',
      cPeers: 'REAL CHANNELS · 실제 채널 상대', cMapCh: '지도 채널', cCh: '채널', cCap: '용량', cAS: 'AS 조직',
      cSock: '소켓', cFirst: '최초 관측', cUpd: '최근 갱신', cCluster: '클러스터', cCells: '곳',
      noteL1a: 'BITNODES · L1 풀노드', noteL1b: '국가 분포 · 내장 스냅샷', noteL1c: '지구본 지점',
      apl: '접속망', ua: '클라이언트'
    },
    en: {
      utc: 'CURRENT TIME (UTC)', state: 'STATUS',
      secNet: 'BITCOIN MAINNET · LIVE', secL1: 'BITCOIN L1 · FULL NODES', secLN: 'LIGHTNING · MEMPOOL.SPACE',
      kHeight: 'Block height', kMem: 'Mempool', kFee: 'Fastest fee', kHash: 'Hashrate', kDiff: 'Next difficulty',
      kL1: 'Reachable full nodes', kPlat: 'Transport', kL1H: 'Crawler height', kL1At: 'Measured at',
      kLN: 'Lightning nodes', kLNCap: 'Channels · capacity',
      secDistL1: 'L1 nodes by continent', secDistLN: 'Lightning nodes by continent',
      secVer: 'Client versions', secNext: 'Next blocks', secWatch: 'Network watchdog',
      secLedger: 'Recent blocks · recent transactions', hBlocks: 'Recent blocks', hTxs: 'Recent txs',
      loading: 'loading…', syncing: 'live sync', polling: 'polling', retry: 'reconnecting',
      live: 'live', snap: 'built-in snapshot', cache: 'cached', none: '—',
      subL1: 'FULL NODE NETWORK · BITNODES', subLN: 'LIGHTNING CHANNEL GRAPH · MEMPOOL.SPACE',
      legL1dot: 'L1 FULL NODE LOCATION (Bitnodes)', legL1note: 'Tor/I2P nodes have no coordinates', legLNdot: 'LIGHTNING NODE',
      legLNline: 'LIGHTNING CHANNEL (measured)',
      hint: 'DRAG TO ROTATE · SCROLL / PINCH TO ZOOM',
      pOpen: 'Open the network panel', pClose: 'Close the network panel',
      nextWaiting: 'blocks queued', nextNone: 'waiting for mempool-blocks over WebSocket',
      nextBlock: 'next', nextFee: 'sat/vB',
      wOkChain: 'chain normal', wOkGap: 'last block', wOkFee: 'fees normal', wOkPool: 'mining pool concentration',
      wGap: 'block delay', wFee: 'fee spike', wPool: 'pool concentration', wReorg: 'reorg detected',
      wNoData: 'waiting for data',
      tNewBlock: 'NEW BLOCK', tReorg: 'REORG DETECTED', tSnap: 'showing the Bitnodes snapshot · refreshing',
      tCached: 'showing cached data · refreshing',
      cCoord: 'Coordinate', cCell: 'Locations in cell', cCountry: 'Country', cPlace: 'Place', cSrc: 'Source', cSnapAt: 'Captured',
      cChainTip: 'CHAIN TIP · network-wide', cHeight: 'height', cWhere: 'location',
      cL1Note: 'This is a real node location Bitnodes geolocated. Bitnodes publishes no per-node peer graph, so no link is drawn on the globe, and values the crawler cannot know (latency, uptime, disk size) are not shown.',
      cLNNote: 'Every value shown is the mempool.space Lightning API response as-is (alias, country, city, coordinates, channels, capacity, AS, observation time). Latency, uptime, disk size and per-node sync height are not shown because the API does not carry them. CHAIN TIP is the network-wide tip, not a value reported by this node. Arcs are real public channels from lightning/channels-geo — never a proximity guess.',
      cPeers: 'REAL CHANNELS', cMapCh: 'Mapped channels', cCh: 'Channels', cCap: 'Capacity', cAS: 'AS org',
      cSock: 'Sockets', cFirst: 'First seen', cUpd: 'Updated', cCluster: 'Cluster', cCells: 'locations',
      noteL1a: 'BITNODES · L1 FULL NODES', noteL1b: 'Country split · built-in snapshot', noteL1c: 'Globe points',
      apl: 'transport', ua: 'clients'
    }
  };
  function L(k) { var t = STR[S.lang] || STR.ko; return t[k] !== undefined ? t[k] : (STR.ko[k] !== undefined ? STR.ko[k] : k); }

  /* ------------------------------------------------------------------ dom */
  function $(id) { return document.getElementById(id); }
  function txt(id, s) { var e = $(id); if (e && e.textContent !== s) e.textContent = s; }
  function setHTML(id, s) { var e = $(id); if (e && e.innerHTML !== s) e.innerHTML = s; }
  function mark(el, name, on) { if (!el) return; if (on) { el.classList.add(name); } else { el.classList.remove(name); } }
  function show(id, on) { var e = $(id); if (e) e.style.display = on ? '' : 'none'; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;';
    });
  }

  /* ------------------------------------------------------------- formatting */
  function num(v) { return typeof v === 'number' && isFinite(v); }
  function fmtInt(v) {
    if (!num(v)) return '—';
    var s = String(Math.round(v));
    return s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  function fmtFixed(v, d) { return num(v) ? v.toFixed(d) : '—'; }
  function fmtBtc(sats) {
    if (!num(sats)) return '—';
    var b = sats / 1e8;
    var s = b >= 1 ? b.toFixed(4) : b.toFixed(8);
    s = s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
    var parts = s.split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return parts.join('.');
  }
  function fmtBtcCap(sats) {
    if (!num(sats)) return '—';
    var b = sats / 1e8;
    var s = (b >= 100 ? b.toFixed(1) : b >= 1 ? b.toFixed(2) : b.toFixed(4));
    var parts = s.split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return parts.join('.');
  }
  var UNITS = [[1e21, 'ZH/s'], [1e18, 'EH/s'], [1e15, 'PH/s'], [1e12, 'TH/s'], [1e9, 'GH/s']];
  function hashParts(hs) {
    if (!num(hs) || hs <= 0) return { v: '—', u: '' };
    for (var i = 0; i < UNITS.length; i++) {
      if (hs >= UNITS[i][0]) {
        var v = hs / UNITS[i][0];
        return { v: (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)), u: UNITS[i][1] };
      }
    }
    return { v: (hs / 1e6).toFixed(2), u: 'MH/s' };
  }
  function ago(ms) {
    if (!num(ms) || ms <= 0) return '—';
    var s = Math.max(0, (Date.now() - ms) / 1000), en = S.lang === 'en';
    if (s < 60) return Math.floor(s) + (en ? 's ago' : '초 전');
    if (s < 3600) return Math.floor(s / 60) + (en ? 'm ago' : '분 전');
    if (s < 86400) return Math.floor(s / 3600) + (en ? 'h ago' : '시간 전');
    return Math.floor(s / 86400) + (en ? 'd ago' : '일 전');
  }
  function durSec(sec) {
    if (!num(sec) || sec < 0) return '—';
    var en = S.lang === 'en';
    if (sec < 60) return Math.floor(sec) + (en ? 's' : '초');
    if (sec < 3600) return Math.floor(sec / 60) + (en ? 'm' : '분');
    if (sec < 86400) return Math.floor(sec / 3600) + (en ? 'h ' : '시간 ') + Math.floor((sec % 3600) / 60) + (en ? 'm' : '분');
    return Math.floor(sec / 86400) + (en ? 'd ' : '일 ') + Math.floor((sec % 86400) / 3600) + (en ? 'h' : '시간');
  }
  function dateOf(v) {
    var d;
    if (typeof v === 'string') d = new Date(v);
    else if (num(v) && v > 0) d = new Date(v < 1e12 ? v * 1000 : v);
    else return '—';
    if (!d || isNaN(d.getTime())) return '—';
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function shortHash(h, head, tail) {
    if (!h) return '';
    head = head || 10; tail = tail || 6;
    return h.length <= head + tail ? h : h.slice(0, head) + '…' + h.slice(-tail);
  }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /* --------------------------------------------------------------- storage */
  function store(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) { } }
  function recall(key) { try { var s = localStorage.getItem(key); return s ? JSON.parse(s) : null; } catch (e) { return null; } }

  /* ----------------------------------------------------------------- state */
  var S = {
    tip: null, tipSeenAt: 0, blocks: [], mem: null, recent: [], fees: null,
    hr: null, diff: null, ln: null, lnAt: 0, countries: [], conts: null,
    nodes: [], links: [], nodeSrc: 'none', nodeAt: 0,
    chanRows: 0, chanAt: 0,
    lastOk: 0, ws: 'idle', wsTries: 0, wsHost: 0, fail: 0, panelOpen: false,
    layer: 'l1', lang: 'ko',
    l1: null, l1Tried: 0,
    mblocks: [], mblocksAt: 0,
    pools: null, poolsAt: 0,
    wd: null, alertSig: '', feeHist: [], chain: {}, reorgAt: 0, reorgAtHeight: 0
  };

  /* --------------------------------------------------------- native bridge */
  /* MainActivity exposes NPBridge.fetch(id, url) and calls back
     window.NPBridgeOnData(id, ok, text). It exists because bitnodes.io sends no
     Access-Control-Allow-Origin, and because the app should not depend on the
     WebView's own network stack for the primary dataset. */
  var BR = {
    on: false, seq: 0, wait: {},
    init: function () {
      if (!window.NPBridge || typeof window.NPBridge.fetch !== 'function') return false;
      window.NPBridgeOnData = function (id, ok, text) {
        var p = BR.wait[id];
        if (!p) return;
        delete BR.wait[id];
        if (p.timer) clearTimeout(p.timer);
        if (ok) p.res(String(text || '')); else p.rej(new Error('bridge ' + id));
      };
      BR.on = true;
      return true;
    },
    get: function (url, ms) {
      var id = ++BR.seq;
      return new Promise(function (res, rej) {
        var timer = setTimeout(function () {
          if (BR.wait[id]) { delete BR.wait[id]; rej(new Error('bridge timeout')); }
        }, ms || 20000);
        BR.wait[id] = { res: res, rej: rej, timer: timer };
        try { window.NPBridge.fetch(String(id), String(url)); }
        catch (e) { delete BR.wait[id]; clearTimeout(timer); rej(e); }
      });
    }
  };

  /* ------------------------------------------------------------------- api */
  function request(path, kind) {
    var i = 0;
    function go() {
      if (i >= API_HOSTS.length) return Promise.reject(new Error('no host answered ' + path));
      var host = API_HOSTS[i++];
      var opt = { cache: 'no-store', credentials: 'omit', mode: 'cors' };
      var ctrl = null, timer = null;
      if (typeof AbortController !== 'undefined') {
        ctrl = new AbortController();
        opt.signal = ctrl.signal;
        timer = setTimeout(function () { try { ctrl.abort(); } catch (e) { } }, 9000);
      }
      return fetch(host + path, opt).then(function (r) {
        if (timer) clearTimeout(timer);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return kind === 'text' ? r.text() : r.json();
      }).catch(function () {
        if (timer) clearTimeout(timer);
        return go();
      });
    }
    return go();
  }

  /* one absolute GET, through the native bridge when it exists */
  function getJSON(url, ms, asText) {
    if (BR.on) {
      return BR.get(url, ms).then(function (t) { if (asText) return t; try { return JSON.parse(t); } catch (e) { throw new Error('bad json'); } });
    }
    var opt = { cache: 'no-store', credentials: 'omit', mode: 'cors' };
    var ctrl = null, timer = null;
    if (typeof AbortController !== 'undefined') {
      ctrl = new AbortController();
      opt.signal = ctrl.signal;
      timer = setTimeout(function () { try { ctrl.abort(); } catch (e) { } }, ms || 15000);
    }
    return fetch(url, opt).then(function (r) {
      if (timer) clearTimeout(timer);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return asText ? r.text() : r.json();
    }, function (e) { if (timer) clearTimeout(timer); throw e; });
  }

  function ok() { S.lastOk = Date.now(); if (S.fail > 0) S.fail = 0; }

  function loadTip() {
    return request('/api/blocks/tip/height', 'text').then(function (t) {
      var h = parseInt(String(t).trim(), 10);
      if (!isFinite(h) || h <= 0) throw new Error('bad tip');
      if (S.tip !== null && h > S.tip) blockEvent(h, null);
      S.tip = h; S.tipSeenAt = Date.now();
      ok(); schedulePaint();
    });
  }

  function mapBlock(b) {
    return {
      height: b.height, id: b.id, time: b.timestamp,
      txs: b.tx_count, size: b.size,
      medianFee: (b.extras && b.extras.medianFee) || null,
      pool: (b.extras && b.extras.pool && (b.extras.pool.name || b.extras.pool.slug)) || null
    };
  }

  /* Keep the last heights' hashes so a second block at an already-seen height
     with a different hash is a reorg rather than a new block. */
  function trackChain(list) {
    if (!list || !list.length) return;
    var found = 0;
    list.forEach(function (b) {
      if (!b || !num(b.height) || !b.id) return;
      var prev = S.chain[b.height];
      if (prev && prev !== b.id) { reorgEvent(b.height + 1, b.height, b); found++; }
      S.chain[b.height] = b.id;
    });
    var ks = Object.keys(S.chain).map(Number).sort(function (a, b) { return b - a; });
    ks.slice(14).forEach(function (k) { delete S.chain[k]; });
    return found;
  }

  function loadBlocks() {
    return request('/api/v1/blocks').then(function (arr) {
      if (!arr || !arr.length) throw new Error('no blocks');
      S.blocks = arr.slice(0, 8).map(mapBlock);
      if (S.tip === null) { S.tip = S.blocks[0].height; S.tipSeenAt = Date.now(); }
      trackChain(S.blocks);
      ok(); schedulePaint();
    });
  }

  function loadMem() {
    return request('/api/mempool').then(function (m) {
      S.mem = { count: m.count, vsize: m.vsize, totalFee: m.total_fee };
      ok(); schedulePaint();
    });
  }

  function loadRecentTxs() {
    return request('/api/mempool/recent').then(function (arr) {
      S.recent = arr.slice(0, 10).map(function (t) {
        return { txid: t.txid, fee: t.fee, vsize: t.vsize, value: t.value, rate: t.vsize ? t.fee / t.vsize : null };
      });
      ok(); schedulePaint();
    });
  }

  function loadFees() {
    return request('/api/v1/fees/recommended').then(function (f) {
      S.fees = f; noteFee(f); ok(); schedulePaint();
    });
  }

  function loadHashrate() {
    return request('/api/v1/mining/hashrate/1w').then(function (h) {
      S.hr = h; ok(); schedulePaint();
    });
  }

  function loadDiff() {
    return request('/api/v1/difficulty-adjustment').then(function (d) {
      S.diff = d; ok(); schedulePaint();
    });
  }

  function loadPools() {
    return request('/api/v1/mining/pools/1w').then(function (p) {
      if (!p || !p.pools || !p.pools.length) throw new Error('no pools');
      S.pools = p; S.poolsAt = Date.now(); schedulePaint();
    });
  }

  function loadLightning() {
    return request('/api/v1/lightning/statistics/latest').then(function (d) {
      if (!d || !d.latest) throw new Error('no ln stats');
      S.ln = d.latest; S.lnAt = Date.now(); ok(); schedulePaint();
    });
  }

  function loadCountries() {
    return request('/api/v1/lightning/nodes/countries').then(function (arr) {
      S.countries = arr || [];
      S.conts = aggregateContinents(S.countries);
      ok(); schedulePaint();
    });
  }

  /* --------------------------------------------------------------- L1 data */
  /* Bitnodes carries two light endpoints with everything the app shows live:
       ?field=coordinates  total_nodes, latest_height, unique lat/lon pairs
       ?field=top          top ASNs (TOR/I2P are listed here too) and client versions
     The per-node country counts come from the bundled fetch_l1.py snapshot; the
     panel says so and stamps it with the capture date. */
  function applyL1(d) {
    var prev = S.l1;
    S.l1 = {
      total: num(d.total) ? d.total : null,
      reachable: num(d.reachable) ? d.reachable : null,
      height: num(d.height) ? d.height : null,
      at: num(d.at) ? d.at : 0,
      coords: d.coords || [],
      platforms: d.platforms || null,
      asns: d.asns || null,
      vers: (d.vers && d.vers.length) ? d.vers : l1Versions(d),
      src: d.src || 'live',
      loadAt: Date.now()
    };
    if (S.layer === 'l1') Globe.build();
    noteDirty = true;
    schedulePaint();
    if (prev && prev.src !== 'live' && S.l1.src === 'live') toast(L('live') + ' · Bitnodes');
  }

  function l1Platforms(d) {
    if (d.platforms && num(d.platforms.clearnet)) return d.platforms;
    var tor = 0, i2p = 0, asns = d.asns || [];
    asns.forEach(function (a) {
      if (!a) return;
      if (a[0] === 'TOR') tor = a[1];
      else if (a[0] === 'I2P') i2p = a[1];
    });
    if (!num(d.total) || (!tor && !i2p)) return null;
    return { tor: tor, i2p: i2p, clearnet: d.total - tor - i2p };
  }

  function l1Versions(d) {
    var total = num(d.total) ? d.total : 0;
    if (d.ua && d.ua.length) {
      return d.ua.slice(0, 6).map(function (r) {
        return { name: String(r[0]), pct: num(r[1]) ? r[1] : null };
      });
    }
    if (d.versions && d.versions.length) {
      var all = 0;
      d.versions.forEach(function (v) { all += v[1] || 0; });
      return d.versions.slice(0, 6).map(function (v) {
        return { name: String(v[0]), pct: all ? (v[1] / all * 100) : null };
      });
    }
    return [];
  }

  function applySnapshotL1(why) {
    var s = (typeof L1_SNAPSHOT !== 'undefined') ? L1_SNAPSHOT : null;
    if (!s) return false;
    applyL1({
      total: s.totalNodes, reachable: s.reachableNodes, height: s.height,
      at: (s.capturedAt || 0) * 1000, coords: s.coords || [],
      platforms: s.platforms || null, asns: s.topAsns || null,
      versions: s.versions || null, ua: s.userAgents || null,
      src: 'snapshot', why: why
    });
    return true;
  }

  function loadL1() {
    S.l1Tried = Date.now();
    var coords = getJSON(BIT_COORDS, 22000).catch(function () { return null; });
    var top = getJSON(BIT_TOP, 16000).catch(function () { return null; });
    return Promise.all([coords, top]).then(function (res) {
      var c = res[0], t = res[1];
      if (!c || !c.coordinates || !num(c.total_nodes)) throw new Error('bitnodes unavailable');
      var tops = (t && t.top) || {};
      var d = {
        total: c.total_nodes,
        reachable: (c.metadata && c.metadata.reachable_nodes) || null,
        height: c.latest_height,
        at: (c.timestamp || 0) * 1000,
        coords: c.coordinates,
        asns: tops.top_asns || null,
        ua: tops.top_user_agents || null,
        src: 'live'
      };
      d.platforms = l1Platforms(d);
      d.vers = l1Versions(d);
      applyL1(d);
      store(LS_CACHE + '.l1', { t: Date.now(), d: { total: d.total, reachable: d.reachable, height: d.height, at: d.at, coords: d.coords, asns: d.asns, ua: d.ua, platforms: d.platforms } });
    }).catch(function () {
      var cached = recall(LS_CACHE + '.l1');
      if (cached && cached.d && cached.d.coords && cached.d.coords.length) {
        var d = cached.d;
        d.src = 'cache'; d.vers = l1Versions(d);
        if (!d.platforms) d.platforms = l1Platforms(d);
        applyL1(d);
      } else if (!S.l1 || S.l1.src !== 'live') {
        applySnapshotL1('fallback');
      }
    });
  }

  /* -------------------------------------------------------- continents ---- */
  var CONT_ORDER = ['NA', 'EU', 'AS', 'SA', 'OC', 'AF', 'OT'];
  var CONT_KO = { NA: '북미', EU: '유럽', AS: '아시아', SA: '남미', OC: '오세아니아', AF: '아프리카', OT: '기타' };
  var CONT_EN = { NA: 'North America', EU: 'Europe', AS: 'Asia', SA: 'South America', OC: 'Oceania', AF: 'Africa', OT: 'Other' };
  function contName(k) { return S.lang === 'en' ? (CONT_EN[k] || k) : (CONT_KO[k] || k); }

  function contOf(iso) {
    var meta = (typeof COUNTRY_META !== 'undefined' && COUNTRY_META.cont) ? COUNTRY_META.cont : {};
    return meta[String(iso || '').toUpperCase()] || 'OT';
  }
  function countryKo(iso, fallback) {
    var ko = (typeof COUNTRY_META !== 'undefined' && COUNTRY_META.ko) ? COUNTRY_META.ko : {};
    return ko[String(iso || '').toUpperCase()] || fallback || '';
  }
  function countryName(iso, fallback) {
    var names = (typeof L1_SNAPSHOT !== 'undefined' && L1_SNAPSHOT.countryNames) ? L1_SNAPSHOT.countryNames : {};
    var en = names[String(iso || '').toUpperCase()] || fallback || iso || '';
    return S.lang === 'en' ? en : (countryKo(iso, en) || en);
  }
  function aggregateContinents(list) {
    var acc = {}, total = 0, cap = {};
    (list || []).forEach(function (c) {
      var k = contOf(c.iso);
      acc[k] = (acc[k] || 0) + (c.count || 0);
      cap[k] = (cap[k] || 0) + (parseInt(c.capacity, 10) || 0);
      total += c.count || 0;
    });
    return { count: acc, capacity: cap, total: total };
  }
  /* L1 country rows are [iso, count] pairs from the Bitnodes snapshot */
  function aggregateL1Countries() {
    var s = (typeof L1_SNAPSHOT !== 'undefined') ? L1_SNAPSHOT : null;
    if (!s || !s.countries) return null;
    var acc = {}, total = 0;
    s.countries.forEach(function (r) {
      var k = contOf(r[0]);
      acc[k] = (acc[k] || 0) + (r[1] || 0);
      total += r[1] || 0;
    });
    return { count: acc, total: total, countries: s.countries.length };
  }

  /* ------------------------------------------------------------- nodes ---- */
  function toNum(v) {
    var x = typeof v === 'string' ? parseFloat(v) : v;
    return num(x) ? x : null;
  }

  function mergeRankings(conn, liq) {
    var by = {};
    function put(n) {
      var e = by[n.publicKey];
      if (!e) {
        e = by[n.publicKey] = {
          pk: n.publicKey, alias: n.alias || n.publicKey.slice(0, 10),
          iso: n.iso_code || '', city: (n.city && n.city.en) || '',
          country: (n.country && n.country.en) || '',
          channels: n.channels || 0, capacity: n.capacity || 0,
          updatedAt: n.updatedAt || 0
        };
      }
      if (n.channels) e.channels = Math.max(e.channels, n.channels);
      if (n.capacity) e.capacity = Math.max(e.capacity, n.capacity);
      if (!e.city && n.city && n.city.en) e.city = n.city.en;
      if (!e.country && n.country && n.country.en) e.country = n.country.en;
      if (!e.iso && n.iso_code) e.iso = n.iso_code;
    }
    (conn || []).forEach(put);
    (liq || []).forEach(put);
    return Object.keys(by).map(function (k) { return by[k]; });
  }

  /* ---- real channel graph: mempool.space /api/v1/lightning/channels-geo ------- */
  function graphFrom(rows) {
    var g = { by: {}, keys: [], links: [] };
    function touch(pk, alias, lat, lon) {
      var n = g.by[pk];
      if (!n) {
        n = g.by[pk] = { pk: pk, alias: alias || pk.slice(0, 10), lat: lat, lon: lon, peers: {}, deg: 0 };
        g.keys.push(pk);
      }
      return n;
    }
    (rows || []).forEach(function (r) {
      if (!r || typeof r.length !== 'number' || r.length < 8) return;
      var a = String(r[0]), b = String(r[4]);
      if (!a || !b || a === b) return;
      var la = toNum(r[3]), loa = toNum(r[2]), lb = toNum(r[7]), lob = toNum(r[6]);
      if (la === null || loa === null || lb === null || lob === null) return;
      if (Math.abs(la) > 90 || Math.abs(lb) > 90 || Math.abs(loa) > 180 || Math.abs(lob) > 180) return;
      var A = touch(a, r[1], la, loa), B = touch(b, r[5], lb, lob);
      if (A.peers[b]) return;
      A.peers[b] = 1; B.peers[a] = 1; A.deg++; B.deg++;
      g.links.push([a, b]);
    });
    return g;
  }

  function regionOf(lat, lon) {
    if (lat < -10 && (lon > 110 || lon < -170)) return 'OC';
    if (lat >= 12 && lon > -170 && lon < -30) return 'NA';
    if (lat < 12 && lon > -95 && lon < -30) return 'SA';
    if (lat < 12 && lon >= -20 && lon < 52) return 'AF';
    if (lat >= 12 && lat < 40 && lon >= 52 && lon < 100) return 'AS';
    if (lat >= 35 && lon >= -25 && lon < 45) return 'EU';
    if (lat >= 40 && lon >= 45) return 'AS';
    if (lon >= 100) return 'AS';
    if (lon >= -30 && lon < 52) return 'AF';
    return 'OT';
  }
  function cellOf(lat, lon) {
    return Math.floor((lat + 90) / CELL_DEG) + ':' + Math.floor((lon + 180) / CELL_DEG);
  }
  function clusterKeyOf(lat, lon) {
    return Math.round(lat / 4) + ':' + Math.round(lon / 4);
  }

  function pickChannelNodes(g) {
    var order = g.keys.slice().sort(function (a, b) {
      var A = g.by[a], B = g.by[b];
      if (B.deg !== A.deg) return B.deg - A.deg;
      if (A.alias !== B.alias) return A.alias < B.alias ? -1 : 1;
      return a < b ? -1 : 1;
    });
    var sel = [], inset = {}, cells = {}, regs = {}, dots = {}, relax = 0;
    function fits(n) {
      var c = cellOf(n.lat, n.lon), k = regionOf(n.lat, n.lon);
      if (dots[clusterKeyOf(n.lat, n.lon)]) return false;
      return (cells[c] || 0) < CELL_CAP + relax && (regs[k] || 0) < REGION_CAP + relax;
    }
    while (sel.length < MAX_NODES) {
      var best = null, bestV = -1, bestD = -1;
      for (var i = 0; i < order.length; i++) {
        var n = g.by[order[i]];
        if (inset[n.pk] || !fits(n)) continue;
        var v = 0;
        for (var p in n.peers) if (inset[p]) v++;
        if (v > bestV || (v === bestV && n.deg > bestD)) { best = n; bestV = v; bestD = n.deg; }
      }
      if (!best) { if (relax < 3) { relax++; continue; } break; }
      sel.push(best); inset[best.pk] = 1;
      var c2 = cellOf(best.lat, best.lon), k2 = regionOf(best.lat, best.lon);
      cells[c2] = (cells[c2] || 0) + 1;
      regs[k2] = (regs[k2] || 0) + 1;
      dots[clusterKeyOf(best.lat, best.lon)] = 1;
    }
    return sel;
  }

  function linksAmong(g, picked) {
    var inset = {}, out = [];
    picked.forEach(function (n) { inset[n.pk] = 1; });
    for (var i = 0; i < picked.length; i++) {
      var n = picked[i];
      for (var p in n.peers) if (inset[p] && n.pk < p) out.push([n.pk, p]);
    }
    return out;
  }

  var LINK_PER_NODE = 5;

  function capLinks(pairs, g) {
    var peers = {}, order = [], cnt = {}, used = {}, out = [], i, k, q;
    function add(x, y) {
      if (!g.by[x] || !g.by[y] || x === y) return;
      (peers[x] || (peers[x] = {}))[y] = 1;
      (peers[y] || (peers[y] = {}))[x] = 1;
    }
    for (i = 0; i < pairs.length; i++) add(pairs[i][0], pairs[i][1]);
    function size(o) { var c = 0; for (var p in o) c++; return c; }
    for (k in peers) order.push(k);
    order.sort(function (x, y) {
      var d = size(peers[x]) - size(peers[y]);
      if (d) return d;
      return x < y ? -1 : 1;
    });
    function deg(k) { return g.by[k].deg || 0; }
    for (i = 0; i < order.length; i++) {
      var p = order[i], mine = peers[p];
      while ((cnt[p] || 0) < LINK_PER_NODE) {
        var best = null;
        for (q in mine) {
          if ((cnt[q] || 0) >= LINK_PER_NODE) continue;
          if (used[p < q ? p + '|' + q : q + '|' + p]) continue;
          if (best === null || deg(q) > deg(best) || (deg(q) === deg(best) && q < best)) best = q;
        }
        if (best === null) break;
        used[p < best ? p + '|' + best : best + '|' + p] = 1;
        cnt[p] = (cnt[p] || 0) + 1;
        cnt[best] = (cnt[best] || 0) + 1;
        out.push([p, best]);
      }
    }
    return out;
  }

  function peersOf(g, n, inset) {
    var inside = [], outside = [], p;
    for (p in n.peers) { if (inset[p]) inside.push(p); else outside.push(p); }
    function byDeg(x, y) {
      var dx = g.by[y].deg - g.by[x].deg;
      if (dx) return dx;
      return g.by[x].alias < g.by[y].alias ? -1 : 1;
    }
    inside.sort(byDeg); outside.sort(byDeg);
    return inside.concat(outside).slice(0, 4).map(function (k) { return g.by[k].alias; });
  }

  function runLimited(tasks, limit) {
    var idx = 0;
    function next() {
      if (idx >= tasks.length) return Promise.resolve();
      var p = tasks[idx++];
      return p().then(next, next);
    }
    var arr = [];
    for (var i = 0; i < Math.min(limit, tasks.length); i++) arr.push(next());
    return Promise.all(arr);
  }

  function applyNodes(nodes, links, src, at, meta) {
    meta = meta || {};
    S.nodes = nodes; S.nodeSrc = src; S.nodeAt = at || 0;
    S.links = links || [];
    S.chanRows = meta.rows || 0;
    S.chanAt = meta.at || 0;
    if (S.layer === 'ln') Globe.build();
    noteDirty = true;
    schedulePaint();
  }

  function applySeed() {
    var seed = (typeof NODE_SEED !== 'undefined' && NODE_SEED && NODE_SEED.nodes) ? NODE_SEED.nodes : [];
    if (!seed.length) return;
    var chan = (typeof CHANNEL_SEED !== 'undefined' && CHANNEL_SEED) ? CHANNEL_SEED : null;
    var at = (NODE_SEED.fetchedAt || 0) * 1000;
    applyNodes(seed.map(function (n) {
      return {
        pk: n.pk, alias: n.alias, lat: n.lat, lon: n.lon, iso: n.iso, city: n.city,
        country: n.country, asOrg: n.asOrg, firstSeen: n.firstSeen, updatedAt: n.updatedAt,
        sockets: n.sockets, tor: !!n.tor,
        channels: toNum(n.channels), channelsSrc: n.channelsSrc || '',
        capacity: toNum(n.capacity),
        deg: n.deg || 0, peers: n.peers || [], tag: 'seed'
      };
    }), (chan && chan.links) || [], 'seed', at, {
      rows: (chan && chan.rows) || NODE_SEED.channelRows || 0,
      at: (chan && chan.capturedAt) ? chan.capturedAt * 1000 : at
    });
  }

  function refreshNodes(force) {
    var cache = recall(LS_NODES) || {};
    var now = Date.now();
    if (!force && cache.nodes && cache.nodes.length && cache.links && cache.links.length &&
      (now - (cache.t || 0)) < NODE_TTL) {
      applyNodes(cache.nodes, cache.links, 'live', cache.t, { rows: cache.rows || 0, at: cache.chanAt || cache.t });
    }
    var geoCache = cache.geo || {};

    return Promise.all([
      request(CH_PATH),
      request('/api/v1/lightning/nodes/rankings/connectivity').catch(noop),
      request('/api/v1/lightning/nodes/rankings/liquidity').catch(noop)
    ]).then(function (res) {
      var rows = res[0];
      if (!rows || !rows.length) throw new Error('empty channels-geo');
      var g = graphFrom(rows);
      var picked = pickChannelNodes(g);
      if (!picked.length) throw new Error('no node with channels');

      var inset = {};
      picked.forEach(function (n) { inset[n.pk] = 1; });
      var links = linksAmong(g, picked);
      var rank = {};
      mergeRankings(res[1] || [], res[2] || []).forEach(function (r) { rank[r.pk] = r; });

      var jobs = picked.map(function (n) {
        var hit = geoCache[n.pk];
        if (hit && num(hit.lat) && (now - (hit.t || 0)) < NODE_TTL) return function () { return Promise.resolve(); };
        return function () {
          return request('/api/v1/lightning/nodes/' + n.pk).then(function (d) {
            geoCache[n.pk] = {
              alias: d.alias || '',
              lat: d.latitude, lon: d.longitude,
              city: (d.city && d.city.en) || '', country: (d.country && d.country.en) || '',
              iso: d.iso_code || '', asOrg: d.as_organization || '',
              firstSeen: d.first_seen || 0, updatedAt: d.updated_at || 0,
              sockets: (d.sockets || '').split(',').filter(Boolean).length,
              tor: (d.sockets || '').indexOf('.onion') >= 0,
              ch: toNum(d.active_channel_count), cap: toNum(d.capacity),
              t: now
            };
          }).catch(function () { geoCache[n.pk] = null; });
        };
      });

      return runLimited(jobs, 5).then(function () {
        var nodes = picked.map(function (n) {
          var d = geoCache[n.pk] || {}, r = rank[n.pk] || {};
          var ch = num(r.channels) ? r.channels : toNum(d.ch);
          var cap = num(r.capacity) ? r.capacity : toNum(d.cap);
          return {
            pk: n.pk,
            alias: d.alias || n.alias,
            lat: num(d.lat) ? d.lat : n.lat,
            lon: num(d.lon) ? d.lon : n.lon,
            iso: d.iso || r.iso || '',
            city: d.city || '',
            country: d.country || '',
            asOrg: d.asOrg || '',
            firstSeen: d.firstSeen || 0,
            updatedAt: d.updatedAt || 0,
            channels: ch,
            channelsSrc: num(r.channels) ? 'ranking' : (toNum(d.ch) !== null ? 'node' : ''),
            capacity: cap,
            sockets: d.sockets || 0,
            tor: !!d.tor,
            deg: n.deg,
            peers: [],
            tag: 'live'
          };
        });

        var seenDot = {}, kept = [];
        nodes.forEach(function (nd) {
          var k = clusterKeyOf(nd.lat, nd.lon);
          var prev = seenDot[k];
          if (prev === undefined) { seenDot[k] = kept.length; kept.push(nd); return; }
          if ((nd.deg || 0) > (kept[prev].deg || 0)) kept[prev] = nd;
        });
        nodes = kept;
        if (!nodes.length) throw new Error('no node');

        inset = {};
        var keptGraph = nodes.map(function (nd) { inset[nd.pk] = 1; return g.by[nd.pk]; });
        links = capLinks(linksAmong(g, keptGraph), g);
        nodes.forEach(function (nd) {
          nd.peers = peersOf(g, g.by[nd.pk], inset);
        });

        applyNodes(nodes, links, 'live', now, { rows: rows.length, at: now });
        store(LS_NODES, { t: now, geo: geoCache, nodes: nodes, links: links, rows: rows.length, chanAt: now });
      });
    }).catch(function () {
      var cached = recall(LS_NODES);
      if (cached && cached.nodes && cached.nodes.length) {
        applyNodes(cached.nodes, cached.links || [], 'cache', cached.t, { rows: cached.rows || 0, at: cached.chanAt || cached.t });
      } else if (!S.nodes.length) {
        applySeed();
      }
    });
  }

  /* ---------------------------------------------------------------- cache */
  function saveCache() {
    store(LS_CACHE, {
      t: Date.now(), tip: S.tip, blocks: S.blocks, mem: S.mem, recent: S.recent,
      fees: S.fees, hr: S.hr, diff: S.diff, ln: S.ln, lnAt: S.lnAt, countries: S.countries,
      mblocks: S.mblocks, mblocksAt: S.mblocksAt, pools: S.pools, poolsAt: S.poolsAt
    });
  }
  function restoreCache() {
    var c = recall(LS_CACHE);
    if (!c) return false;
    if (num(c.tip)) S.tip = c.tip;
    if (c.blocks) S.blocks = c.blocks;
    if (c.mem) S.mem = c.mem;
    if (c.recent) S.recent = c.recent;
    if (c.fees) S.fees = c.fees;
    if (c.hr) S.hr = c.hr;
    if (c.diff) S.diff = c.diff;
    if (c.ln) { S.ln = c.ln; S.lnAt = c.lnAt || 0; }
    if (c.countries) { S.countries = c.countries; S.conts = aggregateContinents(S.countries); }
    if (c.mblocks) { S.mblocks = c.mblocks; S.mblocksAt = c.mblocksAt || 0; }
    if (c.pools) { S.pools = c.pools; S.poolsAt = c.poolsAt || 0; }
    if (c.blocks) trackChain(S.blocks);
    return !!(c.tip || c.mem || c.ln);
  }

  /* ------------------------------------------------------------ websocket */
  var ws = null, wsTimer = null;

  function wsUrl() { return 'wss://' + WS_HOSTS[S.wsHost % WS_HOSTS.length] + WS_PATH; }

  function connectWS() {
    if (!('WebSocket' in window)) { S.ws = 'off'; paintStatus(); return; }
    try { ws = new WebSocket(wsUrl()); } catch (e) { S.ws = 'off'; scheduleWS(); return; }
    S.ws = 'connecting';
    paintStatus();
    ws.onopen = function () {
      S.ws = 'open'; S.wsTries = 0; ok();
      try { ws.send(JSON.stringify({ action: 'want', data: ['blocks', 'stats', 'mempool-blocks'] })); } catch (e) { }
      paintStatus();
    };
    ws.onmessage = function (ev) {
      var m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      handleWS(m);
    };
    ws.onerror = function () { /* close follows */ };
    ws.onclose = function () {
      S.ws = 'closed';
      S.wsHost = (S.wsHost + 1) % WS_HOSTS.length;   // next mirror answers the retry
      paintStatus();
      scheduleWS();
    };
  }
  function scheduleWS() {
    if (wsTimer) return;
    S.wsTries++;
    var wait = Math.min(30000, 1200 * Math.pow(1.7, Math.min(6, S.wsTries)));
    wsTimer = setTimeout(function () { wsTimer = null; connectWS(); }, wait);
  }

  function noteFee(f) {
    if (!f || !num(f.fastestFee)) return;
    var now = Date.now();
    S.feeHist.push({ v: f.fastestFee, t: now });
    if (S.feeHist.length > 60) S.feeHist.splice(0, S.feeHist.length - 60);
  }

  function handleWS(m) {
    var touched = false;
    if (m.mempoolInfo) {
      S.mem = { count: m.mempoolInfo.size, vsize: m.mempoolInfo.bytes, totalFee: m.mempoolInfo.total_fee };
      touched = true;
    }
    if (m.fees) { S.fees = m.fees; noteFee(m.fees); touched = true; }
    if (m.da) { S.diff = m.da; touched = true; }
    if (m.blocks && m.blocks.length) {
      var list = m.blocks.slice(0, 8).map(mapBlock);
      var top = list[0].height;
      if (S.tip !== null && top > S.tip) blockEvent(top, list[0]);
      S.tip = Math.max(S.tip || 0, top);
      S.tipSeenAt = Date.now();
      S.blocks = list;
      trackChain(list);
      touched = true;
    }
    if (m.transactions && m.transactions.length) {
      var add = m.transactions.map(function (t) {
        return { txid: t.txid, fee: t.fee, vsize: t.vsize, value: t.value, rate: num(t.rate) ? t.rate : (t.vsize ? t.fee / t.vsize : null) };
      });
      var seen = {};
      add.forEach(function (t) { seen[t.txid] = 1; });
      S.recent = add.concat(S.recent.filter(function (t) { return !seen[t.txid]; })).slice(0, 10);
      touched = true;
    }
    /* mempool.space's own projection of the next blocks: each entry is the set of
       transactions that would fill one block, with its fee range and tx count. */
    if (m['mempool-blocks'] && m['mempool-blocks'].length) {
      S.mblocks = m['mempool-blocks'].map(function (b) {
        var fr = b.feeRange || [];
        return {
          nTx: b.nTx, vsize: b.blockVSize, size: b.blockSize, fees: b.totalFees,
          median: b.medianFee, lo: fr.length ? fr[0] : null, hi: fr.length ? fr[fr.length - 1] : null
        };
      });
      S.mblocksAt = Date.now();
      touched = true;
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
    var gap = b && num(b.time) ? now / 1000 - b.time : null;

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

    var p = S.pools;
    if (p && p.pools && p.pools.length && num(p.blockCount) && p.blockCount > 0) {
      var top1 = p.pools[0];
      var share = top1.blockCount / p.blockCount;
      var txtPool = (top1.name || '—') + ' ' + (share * 100).toFixed(1) + '%';
      if (share > WD_POOL_SHARE) {
        list.push({ tag: 'POOL', alert: true, text: L('wPool') + ' · ' + txtPool + ' (1주 ' + fmtInt(p.blockCount) + ' 블록)' });
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

  /* ------------------------------------------------------------- painting */
  var paintQueued = false, lastPaint = 0, noteDirty = true;

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
    saveCache();
  }

  function paintStatus() {
    var live = $('livePill'), liveTxt = $('liveTxt'), wsPill = $('wsPill'), wsTxt = $('wsTxt');
    var bad = stale();
    mark(live, 'warn', bad);
    mark(live, 'pulse', !bad);
    if (liveTxt) liveTxt.textContent = bad ? (S.lastOk ? 'STALE' : 'WAIT') : 'LIVE';
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
        ? esc(String(Math.round(S.fees.fastestFee * 10) / 10)) + '<span class="u">sat/vB</span><small>30m ' + esc(String(Math.round(S.fees.halfHourFee * 10) / 10)) + ' · 1h ' + esc(String(Math.round(S.fees.hourFee * 10) / 10)) + '</small>'
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
    txt('l1Tag', l1 ? (l1.src === 'live' ? 'LIVE' : l1.src === 'cache' ? 'CACHE' : 'SNAPSHOT') : 'BITNODES');

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
        '<div class="bar"><i style="width:' + Math.max(1.5, w).toFixed(1) + '%"></i></div></div>';
    });
    setHTML('dist', out);
    if (S.layer === 'l1') {
      var s = (typeof L1_SNAPSHOT !== 'undefined') ? L1_SNAPSHOT : null;
      txt('distTotal', fmtInt(total) + ' · ' + (agg.countries || 0) + (S.lang === 'en' ? ' countries' : '개국') +
        (s && s.capturedAt ? ' · ' + dateOf(s.capturedAt * 1000).slice(0, 10) : ''));
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
        '<div class="bar"><i style="width:' + Math.max(1, max ? pct / max * 100 : 0).toFixed(1) + '%"></i></div></div>';
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
    txt('nextTotal', S.mblocks.length + ' ' + (S.lang === 'en' ? 'blocks queued' : '블록 대기'));
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
        (l1 && l1.src === 'live' ? ' (live now)' : ' — currently the built-in snapshot ' + snapAt + ', because the live request did not answer') + '.<br>' +
        '· The country split (' + (s ? s.countries.length : 0) + ' countries) is the Bitnodes snapshot captured ' + snapAt + ' with ' + fmtInt(s ? s.totalNodes : null) +
        ' nodes; Bitnodes exposes per-node country only through its paginated node list, which is too heavy to pull on a phone, so this panel names that snapshot instead of hiding it.<br>' +
        '· Globe points: ' + (l1 ? fmtInt(l1.coords.length) : '0') + ' unique coordinates Bitnodes geolocated (' + (l1 && l1.src === 'live' ? 'live' : 'snapshot') + '). Tor and I2P nodes carry no coordinates, so they are not placed, and no link is drawn between nodes: Bitnodes publishes no peer graph.<br>' +
        '· Values the crawler cannot know (per-node latency, uptime, disk size, per-node height) are never shown or guessed.<br>' +
        '· Next blocks are mempool.space\'s own projection of the transactions that would fill each of the coming blocks, with the reported fee range and tx count.<br>' +
        '· Watchdog thresholds: no block for ' + (WD_BLOCK_SEC / 60) + ' min, fastest fee ≥ ' + WD_FEE_SPIKE + ' sat/vB or 3× the 10-minute minimum, one pool above ' + Math.round(WD_POOL_SHARE * 100) + '% of the week\'s blocks, or a block hash change at an already-seen height.<br>' +
        '· Lightning layer: the node sample is picked from the <code>lightning/channels-geo</code> graph (' + fmtInt(S.chanRows) + ' real open channels) completed with <code>nodes/{pubkey}</code>, and every arc is one of those rows; no proximity link exists.';
      return;
    }
    e.innerHTML =
      '<b>DATA</b> 비트코인 메인넷 값은 mempool.space REST + WebSocket 응답값이고, L1 풀노드 값은 Bitnodes 크롤러 export(bitnodes.io/api/v1)입니다.<br>' +
      '· <b>L1의 1차 출처는 Bitnodes</b>입니다: 도달 가능 노드 수, 클리어넷/Tor/I2P 비중, 클라이언트 버전, 지구본 좌표는 <code>snapshots/latest/?field=coordinates</code>와 <code>?field=top</code>' +
      (l1 && l1.src === 'live' ? '에서 지금 실시간으로 읽었습니다' : '에서 읽으며, 지금은 실시간 요청이 답하지 않아 내장 스냅샷(' + snapAt + ')을 표시 중입니다') + '.<br>' +
      '· 국가 분포(' + (s ? s.countries.length : 0) + '개국)는 ' + snapAt + ' Bitnodes 스냅샷(' + fmtInt(s ? s.totalNodes : null) + ' 노드) 값입니다. Bitnodes는 노드별 국가를 페이지 목록으로만 공개해 휴대폰에서 전부 받아오기엔 무겁기 때문에, 이 항목만 스냅샷 기준임을 숨기지 않고 적습니다.<br>' +
      '· 지구본 지점 ' + (l1 ? fmtInt(l1.coords.length) : '0') + '곳은 Bitnodes가 좌표를 확인한 서로 다른 위치입니다(' + (l1 && l1.src === 'live' ? '실시간' : '스냅샷') + '). Tor·I2P 노드는 좌표가 없어 배치하지 않고, 노드 사이에 선은 그리지 않습니다 — Bitnodes는 노드별 연결 그래프를 공개하지 않습니다.<br>' +
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
      var elapsed = b.time ? durSec(Date.now() / 1000 - b.time) : '—';
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

  /* ---------------------------------------------------------------- globe */
  /* Two palettes, one renderer. The L1 identity is Bitcoin orange; Lightning
     keeps the cyan it had. Every colour the globe draws comes from here. */
  var THEME = {
    ln: {
      body: [[0, 'rgba(20,46,96,0.52)'], [0.30, 'rgba(10,26,58,0.66)'], [0.66, 'rgba(6,16,38,0.82)'], [0.90, 'rgba(3,9,22,0.92)'], [1, 'rgba(2,6,16,0.96)']],
      rim: [[0, 'rgba(4,10,22,0)'], [0.70, 'rgba(3,9,22,0.14)'], [0.92, 'rgba(6,22,48,0.30)'], [0.978, 'rgba(38,140,225,0.20)'], [1, 'rgba(125,211,252,0.12)']],
      at1: [[0, 'rgba(150,215,255,0.40)'], [0.35, 'rgba(56,170,255,0.13)'], [1, 'rgba(56,150,255,0)']],
      at2: [[0, 'rgba(56,145,255,0.10)'], [0.45, 'rgba(40,110,220,0.04)'], [1, 'rgba(40,110,220,0)']],
      hi: 'rgba(150,210,255,0.055)',
      rimLine: 'rgba(140,214,255,0.44)', rimLine2: 'rgba(56,189,248,0.12)',
      land: 'rgba(37,99,235,0.14)', coast: 'rgba(150,214,255,0.5)', coastGlow: 'rgba(56,160,250,0.18)',
      grid: 'rgba(76,140,225,0.09)', gridBack: 'rgba(56,110,190,0.032)', equator: 'rgba(90,164,244,0.15)',
      dot: '226,246,255', halo: '120,205,255', arc: '110,190,255', packet: '80,165,255',
      glow: ['rgba(226,246,255,0.95)', 'rgba(140,215,255,0.60)', 'rgba(56,165,255,0.20)', 'rgba(56,150,255,0.055)', 'rgba(56,150,255,0)']
    },
    l1: {
      body: [[0, 'rgba(74,40,12,0.50)'], [0.30, 'rgba(44,25,9,0.68)'], [0.66, 'rgba(26,16,8,0.84)'], [0.90, 'rgba(15,10,6,0.93)'], [1, 'rgba(8,6,5,0.97)']],
      rim: [[0, 'rgba(4,6,12,0)'], [0.70, 'rgba(14,9,5,0.14)'], [0.92, 'rgba(58,32,10,0.30)'], [0.978, 'rgba(247,147,26,0.22)'], [1, 'rgba(255,196,120,0.14)']],
      at1: [[0, 'rgba(255,196,110,0.34)'], [0.35, 'rgba(247,147,26,0.13)'], [1, 'rgba(247,147,26,0)']],
      at2: [[0, 'rgba(247,147,26,0.10)'], [0.45, 'rgba(200,110,20,0.04)'], [1, 'rgba(200,110,20,0)']],
      hi: 'rgba(255,205,150,0.05)',
      rimLine: 'rgba(255,190,130,0.44)', rimLine2: 'rgba(247,147,26,0.14)',
      land: 'rgba(247,147,26,0.12)', coast: 'rgba(255,208,160,0.46)', coastGlow: 'rgba(247,147,26,0.16)',
      grid: 'rgba(200,140,70,0.085)', gridBack: 'rgba(150,100,50,0.030)', equator: 'rgba(230,160,80,0.14)',
      dot: '255,222,180', halo: '247,147,26', arc: '247,147,26', packet: '247,147,26',
      glow: ['rgba(255,238,220,0.95)', 'rgba(255,190,110,0.60)', 'rgba(247,147,26,0.22)', 'rgba(247,147,26,0.06)', 'rgba(247,147,26,0)']
    }
  };
  function TH() { return THEME[S.layer] || THEME.l1; }

  var Globe = (function () {
    var G = {
      cv: null, ctx: null, w: 0, h: 0, dpr: 1, cx: 0, cy: 0, R: 0,
      yaw: -0.35, pitch: 0.36, zoom: 1, zoomT: 1, vYaw: 0,
      spin: 0.045, spinEase: 1, hold: false,
      dragging: false, lastTouch: 0, clusters: [], links: [], arcs: [], flash: 0, ripples: [],
      rings: [], grats: [], raf: 0, lastTs: 0, hit: null,
      bg: null, ball: null, ballSize: 0, glow: null,
      slow: false, ft: 0.016, miss: 0, age: 0, goodMs: 0, stepAt: 0, prevScale: 1, lockScale: 0,
      hide: {}, adaptive: true, resScale: 1, forceFull: false,
      xs: [], ys: [], zs: []
    };
    var P = { x: 0, y: 0, z: 0 };
    var pointers = {}, pinch = null, dragMoved = 0, dragStart = null;

    function normLon(l) { while (l > 180) l -= 360; while (l < -180) l += 360; return l; }

    function decodeRings(str) {
      if (!str) return [];
      var rings = [];
      str.split('|').forEach(function (r) {
        var pts = [], parts = r.split(' ');
        for (var i = 0; i < parts.length; i++) {
          var ab = parts[i].split(',');
          if (ab.length !== 2) continue;
          var lon = parseInt(ab[0], 36) / 10, lat = parseInt(ab[1], 36) / 10;
          if (isFinite(lon) && isFinite(lat)) pts.push([lon, lat]);
        }
        if (pts.length > 2) rings.push(pts);
      });
      return rings;
    }

    function buildGraticule() {
      var g = [];
      for (var lon = -180; lon < 180; lon += 30) {
        var m = [];
        for (var lat = -88; lat <= 88; lat += 4) m.push([lon, lat]);
        g.push(m);
      }
      for (var la = -60; la <= 60; la += 30) {
        var p = [];
        for (var lo = -180; lo <= 180; lo += 4) p.push([lo, la]);
        g.push(p);
      }
      return g;
    }

    function resize() {
      var w = window.innerWidth, h = window.innerHeight;
      G.dpr = Math.min(2, window.devicePixelRatio || 1);
      G.w = w; G.h = h;
      if (!G.cv) G.cv = $('globe');
      if (!G.cv) return;
      applyRes();
      layout();
      buildBackground();
      buildBall();
    }

    function applyRes() {
      var s = G.dpr * G.resScale;
      var cv = G.cv;
      cv.width = Math.round(G.w * s);
      cv.height = Math.round(G.h * s);
      G.ctx = cv.getContext('2d');
      G.ctx.setTransform(s, 0, 0, s, 0, 0);
      G.ctx.lineCap = 'round';
      G.ctx.lineJoin = 'round';
    }

    function setRes(scale) {
      if (scale === G.resScale || !G.cv) return;
      G.resScale = scale;
      applyRes();
    }

    function layout() {
      var w = G.w, h = G.h;
      var head = document.querySelector('.topbar .head');
      var layers = document.querySelector('.layers');
      var sub = document.querySelector('.subrow');
      var hud = document.querySelector('.hud');
      var topH = (head ? head.offsetHeight : 56) + (layers ? layers.offsetHeight : 28) + (sub ? sub.offsetHeight : 18) + 16;
      var hudH = (hud ? hud.offsetHeight : 150) - 16;
      var avail = Math.max(200, h - hudH - topH);
      G.cx = w / 2;
      G.cy = topH + avail * 0.50;
      G.R = Math.min(w * 0.40, avail * 0.44);
      if (h > w * 1.6) G.cy = topH + avail * 0.52;
      var hint = document.getElementById('hint');
      if (hint) {
        var below = h - (G.cy + G.R);
        hint.style.bottom = Math.max(150, Math.round(below - 30)) + 'px';
      }
    }

    function buildBackground() {
      var cv = document.createElement('canvas');
      cv.width = Math.round(G.w * G.dpr);
      cv.height = Math.round(G.h * G.dpr);
      var c = cv.getContext('2d');
      c.setTransform(G.dpr, 0, 0, G.dpr, 0, 0);
      var n = Math.round(Math.min(220, Math.max(110, G.w * G.h / 4800)));
      for (var i = 0; i < n; i++) {
        var x = Math.random() * G.w, y = Math.random() * G.h;
        var big = Math.random() > 0.88;
        var r = big ? 1.2 + Math.random() * 0.8 : 0.45 + Math.random() * 0.6;
        c.globalAlpha = 0.18 + Math.random() * 0.5;
        c.fillStyle = i % 11 === 0 ? '#9fd0ff' : (S.layer === 'l1' ? '#ffe3c4' : '#cfe4ff');
        if (big) { c.beginPath(); c.arc(x, y, r * 0.7, 0, TAU); c.fill(); }
        else c.fillRect(x, y, r, r);
      }
      c.globalAlpha = 1;
      G.bg = cv;
      buildGlow();
    }

    function buildGlow() {
      var th = TH(), g = th.glow, size = 64;
      var cv = document.createElement('canvas');
      cv.width = cv.height = size;
      var c = cv.getContext('2d');
      var grd = c.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      grd.addColorStop(0, g[0]);
      grd.addColorStop(0.16, g[1]);
      grd.addColorStop(0.42, g[2]);
      grd.addColorStop(0.70, g[3]);
      grd.addColorStop(1, g[4]);
      c.fillStyle = grd;
      c.fillRect(0, 0, size, size);
      G.glow = cv;
    }

    function buildBall() {
      var th = TH();
      var R = Math.max(40, G.R);
      var pad = 1.30, s = Math.ceil(R * 2 * pad);
      var cv = document.createElement('canvas');
      cv.width = Math.ceil(s * G.dpr);
      cv.height = Math.ceil(s * G.dpr);
      var c = cv.getContext('2d');
      c.setTransform(G.dpr, 0, 0, G.dpr, 0, 0);
      var cx = s / 2, cy = s / 2;

      var body = c.createRadialGradient(cx - R * 0.40, cy - R * 0.46, R * 0.04, cx, cy, R * 1.04);
      th.body.forEach(function (st) { body.addColorStop(st[0], st[1]); });
      c.beginPath(); c.arc(cx, cy, R, 0, TAU); c.fillStyle = body; c.fill();

      var rim = c.createRadialGradient(cx, cy, R * 0.52, cx, cy, R);
      th.rim.forEach(function (st) { rim.addColorStop(st[0], st[1]); });
      c.beginPath(); c.arc(cx, cy, R, 0, TAU); c.fillStyle = rim; c.fill();

      c.globalCompositeOperation = 'lighter';
      var at1 = c.createRadialGradient(cx, cy, R * 0.99, cx, cy, R * 1.075);
      th.at1.forEach(function (st) { at1.addColorStop(st[0], st[1]); });
      c.beginPath();
      c.arc(cx, cy, R * 1.075, 0, TAU);
      c.arc(cx, cy, R * 0.99, 0, TAU, true);
      c.fillStyle = at1; c.fill();

      var at2 = c.createRadialGradient(cx, cy, R, cx, cy, R * 1.28);
      th.at2.forEach(function (st) { at2.addColorStop(st[0], st[1]); });
      c.beginPath();
      c.arc(cx, cy, R * 1.28, 0, TAU);
      c.arc(cx, cy, R, 0, TAU, true);
      c.fillStyle = at2; c.fill();

      var hi = c.createRadialGradient(cx - R * 0.42, cy - R * 0.48, 0, cx - R * 0.42, cy - R * 0.48, R * 0.58);
      hi.addColorStop(0, th.hi);
      hi.addColorStop(1, 'rgba(255,255,255,0)');
      c.beginPath(); c.arc(cx, cy, R, 0, TAU); c.fillStyle = hi; c.fill();
      c.globalCompositeOperation = 'source-over';

      c.beginPath(); c.arc(cx, cy, R, 0, TAU);
      c.strokeStyle = th.rimLine; c.lineWidth = 1.05; c.stroke();
      c.beginPath(); c.arc(cx, cy, R - 1.2, 0, TAU);
      c.strokeStyle = th.rimLine2; c.lineWidth = 2.4; c.stroke();

      G.ball = cv;
      G.ballSize = s;
    }

    function project(lat, lon, o) {
      var la = lat * DEG, lo = lon * DEG - G.yaw;
      var cl = Math.cos(la), sl = Math.sin(la);
      var x = cl * Math.sin(lo), y = sl, z = cl * Math.cos(lo);
      var cp = Math.cos(G.pitch), sp = Math.sin(G.pitch);
      var y1 = y * cp - z * sp, z1 = y * sp + z * cp;
      var R = G.R * G.zoom;
      o.x = G.cx + x * R; o.y = G.cy - y1 * R; o.z = z1;
      return o;
    }

    function drawStars() {
      if (G.bg) G.ctx.drawImage(G.bg, 0, 0, G.w, G.h);
    }

    function drawSphere() {
      if (!G.ball) return;
      var size = G.ballSize * G.zoom;
      G.ctx.drawImage(G.ball, G.cx - size / 2, G.cy - size / 2, size, size);
    }

    function prepRing(ring) {
      var pts = [], brk = [], prev = null;
      for (var i = 0; i < ring.length; i++) {
        var lon = ring[i][0], lat = ring[i][1];
        var la = lat * DEG, lo = lon * DEG;
        pts.push(Math.cos(la), Math.sin(la), Math.sin(lo), Math.cos(lo));
        brk.push(prev !== null && Math.abs(lon - prev) > 180 ? 1 : 0);
        prev = lon;
      }
      return { p: pts, b: brk, n: ring.length, xs: new Array(ring.length), ys: new Array(ring.length),
        zs: new Array(ring.length), ox: new Array(ring.length), oy: new Array(ring.length), max: 0, min: 0 };
    }

    function projectRing(r, cam) {
      var p = r.p, n = r.n, xs = r.xs, ys = r.ys, zs = r.zs, ox = r.ox, oy = r.oy;
      var syw = cam.syw, cyw = cam.cyw, cp = cam.cp, sp = cam.sp;
      var R = cam.R, cx = cam.cx, cy = cam.cy, max = -2, min = 2;
      for (var i = 0, k = 0; k < n; i += 4, k++) {
        var cl = p[i], sl = p[i + 1], slon = p[i + 2], clon = p[i + 3];
        var x = cl * (slon * cyw - clon * syw);
        var z0 = cl * (clon * cyw + slon * syw);
        var z1 = sl * sp + z0 * cp;
        ox[k] = x * R;
        oy[k] = -(sl * cp - z0 * sp) * R;
        xs[k] = cx + ox[k];
        ys[k] = cy + oy[k];
        zs[k] = z1;
        if (z1 > max) max = z1;
        if (z1 < min) min = z1;
      }
      r.max = max; r.min = min;
    }

    function runPath(r, ctx, wantFront, close) {
      var n = r.n, xs = r.xs, ys = r.ys, zs = r.zs, brk = r.b;
      var startIdx = -1, any = false, k;
      for (k = 0; k < n; k++) {
        var vis = wantFront ? (zs[k] > 0) : (zs[k] <= 0);
        if (vis && !brk[k]) {
          if (startIdx < 0) startIdx = k;
        } else {
          if (startIdx >= 0 && k - 1 > startIdx) { emit(startIdx, k - 1, ctx, xs, ys, close); any = true; }
          startIdx = (vis && brk[k]) ? k : -1;
        }
      }
      if (startIdx >= 0 && n - 1 > startIdx) { emit(startIdx, n - 1, ctx, xs, ys, close); any = true; }
      return any;
    }

    function fillRing(r, ctx) {
      var n = r.n, zs = r.zs, ox = r.ox, oy = r.oy, cam = G.cam;
      var cx = cam.cx, cy = cam.cy, k, front = 0, start = -1;
      for (k = 0; k < n; k++) {
        if (zs[k] >= 0) {
          front++;
          if (start < 0 && zs[(k + n - 1) % n] < 0) start = k;
        }
      }
      if (!front) return false;
      if (start < 0) {
        ctx.moveTo(cx + ox[0], cy + oy[0]);
        for (k = 1; k < n; k++) ctx.lineTo(cx + ox[k], cy + oy[k]);
        ctx.closePath();
        return true;
      }
      var t = 0, sx, sy;
      while (t < n) {
        while (t < n && zs[(start + t) % n] < 0) t++;
        if (t >= n) break;
        sx = 0; sy = 0;
        var i0 = (start + t) % n;
        while (t < n && zs[(start + t) % n] >= 0) {
          var ii = (start + t) % n;
          sx += ox[ii]; sy += oy[ii];
          t++;
        }
        fillRun(r, ctx, i0, (start + t - 1) % n, sx, sy);
      }
      return true;
    }

    function fillRun(r, ctx, i0, i1, sx, sy) {
      var n = r.n, ox = r.ox, oy = r.oy, zs = r.zs, cam = G.cam;
      var cx = cam.cx, cy = cam.cy, R = cam.R, i;
      var b = (i0 + n - 1) % n, a = (i1 + 1) % n;
      var e = crossing(ox[b], oy[b], zs[b], ox[i0], oy[i0], zs[i0]);
      var x = crossing(ox[i1], oy[i1], zs[i1], ox[a], oy[a], zs[a]);
      var aE = Math.atan2(x[1], x[0]), aI = Math.atan2(e[1], e[0]);
      var mean = Math.atan2(sy, sx);
      ctx.moveTo(cx + e[0], cy + e[1]);
      for (i = i0; ; i = (i + 1) % n) {
        ctx.lineTo(cx + ox[i], cy + oy[i]);
        if (i === i1) break;
      }
      var ccw = (aI - aE + TAU) % TAU;
      var span = angTo(aE + ccw / 2, mean) <= angTo(aE + (ccw + TAU) / 2, mean) ? ccw : TAU - ccw;
      var dir = span === ccw ? 1 : -1;
      var steps = Math.max(2, Math.ceil(span / 0.12));
      for (i = 1; i <= steps; i++) {
        var ang = aE + dir * span * (i / steps);
        ctx.lineTo(cx + Math.cos(ang) * R, cy + Math.sin(ang) * R);
      }
      ctx.closePath();
    }

    function crossing(x0, y0, z0, x1, y1, z1) {
      var t = z0 / (z0 - z1);
      if (!(t >= 0)) t = 0; else if (t > 1) t = 1;
      return [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t];
    }

    function angTo(p, q) { return Math.abs((((p - q) % TAU) + TAU + Math.PI) % TAU - Math.PI); }

    function emit(a, b, ctx, xs, ys, close) {
      ctx.moveTo(xs[a], ys[a]);
      for (var j = a + 1; j <= b; j++) ctx.lineTo(xs[j], ys[j]);
      if (close) ctx.closePath();
    }

    function drawGraticule() {
      var th = TH(), cam = G.cam, ctx = G.ctx, i, r, list = G.gratsP, anyFront = false, anyBack = false;
      for (i = 0; i < list.length; i++) projectRing(list[i], cam);

      if (!G.slow) {
        ctx.beginPath();
        for (i = 0; i < list.length; i++) {
          r = list[i];
          if (r.max <= 0) continue;
          if (runPath(r, ctx, false, false)) anyBack = true;
        }
        if (anyBack) { ctx.strokeStyle = th.gridBack; ctx.lineWidth = 0.6; ctx.stroke(); }
      }

      ctx.beginPath();
      for (i = 0; i < list.length; i++) {
        r = list[i];
        if (r.max <= 0) continue;
        if (runPath(r, ctx, true, false)) anyFront = true;
      }
      if (anyFront) { ctx.strokeStyle = th.grid; ctx.lineWidth = 0.6; ctx.stroke(); }

      var eq = list[list.length - 3];
      if (eq && eq.max > 0) {
        ctx.beginPath();
        if (runPath(eq, ctx, true, false)) {
          ctx.strokeStyle = th.equator; ctx.lineWidth = 0.8; ctx.stroke();
        }
      }
    }

    function drawLand() {
      var th = TH(), cam = G.cam, ctx = G.ctx, i, r, list = G.ringsP, anyFill = false, anyLine = false;
      for (i = 0; i < list.length; i++) projectRing(list[i], cam);

      if (!G.slow && !G.hide.landFill) {
        ctx.beginPath();
        for (i = 0; i < list.length; i++) {
          r = list[i];
          if (r.max <= 0) continue;
          if (fillRing(r, ctx)) anyFill = true;
        }
        if (anyFill) { ctx.fillStyle = th.land; ctx.fill(); }
      }

      ctx.beginPath();
      for (i = 0; i < list.length; i++) {
        r = list[i];
        if (r.max <= 0) continue;
        if (runPath(r, ctx, true, false)) anyLine = true;
      }
      if (anyLine && !G.hide.landStroke) {
        if (!G.slow && !G.hide.landGlow) {
          ctx.strokeStyle = th.coastGlow; ctx.lineWidth = 2.2; ctx.stroke();
        }
        ctx.strokeStyle = th.coast; ctx.lineWidth = 0.8; ctx.stroke();
      }
    }

    function vec(lat, lon) {
      var la = lat * DEG, lo = lon * DEG;
      return [Math.cos(la) * Math.sin(lo), Math.sin(la), Math.cos(la) * Math.cos(lo)];
    }
    function slerpPoint(a, b, t) {
      var A = vec(a.lat, a.lon), B = vec(b.lat, b.lon);
      var dot = Math.max(-1, Math.min(1, A[0] * B[0] + A[1] * B[1] + A[2] * B[2]));
      var om = Math.acos(dot);
      if (om < 1e-6) return { lat: a.lat, lon: a.lon };
      var so = Math.sin(om);
      var w1 = Math.sin((1 - t) * om) / so, w2 = Math.sin(t * om) / so;
      var x = w1 * A[0] + w2 * B[0], y = w1 * A[1] + w2 * B[1], z = w1 * A[2] + w2 * B[2];
      var lat = Math.asin(Math.max(-1, Math.min(1, y))) / DEG;
      var lon = Math.atan2(x, z) / DEG;
      return { lat: lat, lon: lon };
    }

    function buildArcs() {
      var cs = G.clusters, out = [], i;
      for (i = 0; i < G.links.length; i++) {
        var a = cs[G.links[i][0]], b = cs[G.links[i][1]];
        if (!a || !b) continue;
        var dist = Math.abs(a.lat - b.lat) + Math.abs(((b.lon - a.lon + 540) % 360) - 180);
        var N = Math.max(12, Math.min(32, Math.round(dist / 2.2)));
        var path = [];
        for (var s = 0; s <= N; s++) {
          var p = slerpPoint(a, b, s / N);
          var la = p.lat * DEG, lo = p.lon * DEG;
          path.push(Math.cos(la), Math.sin(la), Math.sin(lo), Math.cos(lo));
        }
        out.push({
          p: path, n: N + 1, seed: (i * 0.137) % 1,
          xs: new Array(N + 1), ys: new Array(N + 1), zs: new Array(N + 1), max: 0
        });
      }
      G.arcs = out;
    }

    function projectArc(arc, cam) {
      var p = arc.p, n = arc.n, xs = arc.xs, ys = arc.ys, zs = arc.zs;
      var syw = cam.syw, cyw = cam.cyw, cp = cam.cp, sp = cam.sp;
      var R = cam.R, cx = cam.cx, cy = cam.cy, max = -2;
      for (var i = 0, k = 0; k < n; i += 4, k++) {
        var cl = p[i], sl = p[i + 1], slon = p[i + 2], clon = p[i + 3];
        var x = cl * (slon * cyw - clon * syw);
        var z0 = cl * (clon * cyw + slon * syw);
        var z1 = sl * sp + z0 * cp;
        xs[k] = cx + x * R;
        ys[k] = cy - (sl * cp - z0 * sp) * R;
        zs[k] = z1;
        if (z1 > max) max = z1;
      }
      arc.max = max;
    }

    function smooth(t) { return t * t * (3 - 2 * t); }

    function drawArcs(t) {
      var th = TH(), ctx = G.ctx, cam = G.cam, boost = G.flash, arcs = G.arcs, glow = G.glow;
      if (!arcs.length) return;
      var frontA = 0.33 + 0.30 * boost;
      var bands = G.slow ? 2 : 3;
      var i, arc, k, n;

      for (i = 0; i < arcs.length; i++) projectArc(arcs[i], cam);

      for (var b = 0; b < bands; b++) {
        var lo = b / bands, hi = (b + 1) / bands, a = smooth((lo + hi) / 2);
        ctx.beginPath();
        var any = false;
        for (i = 0; i < arcs.length; i++) {
          arc = arcs[i];
          if (arc.max <= 0) continue;
          var xs = arc.xs, ys = arc.ys, zs = arc.zs;
          n = arc.n;
          var started = false;
          for (k = 1; k < n; k++) {
            var zm = (zs[k - 1] + zs[k]) * 0.5;
            if (zm <= 0 || zm < lo || zm >= hi) { started = false; continue; }
            if (!started) { ctx.moveTo(xs[k - 1], ys[k - 1]); started = true; }
            ctx.lineTo(xs[k], ys[k]);
            any = true;
          }
        }
        if (!any) continue;
        ctx.strokeStyle = 'rgba(' + th.arc + ',' + (frontA * a).toFixed(3) + ')';
        ctx.lineWidth = 0.75;
        ctx.stroke();
      }

      var topLo = (bands - 1) / bands;
      ctx.beginPath();
      var anyTop = false;
      for (i = 0; i < arcs.length; i++) {
        arc = arcs[i];
        if (arc.max <= 0) continue;
        var tx = arc.xs, ty = arc.ys, tz = arc.zs;
        n = arc.n;
        var on = false;
        for (k = 1; k < n; k++) {
          var tm = (tz[k - 1] + tz[k]) * 0.5;
          if (tm <= topLo) { on = false; continue; }
          if (!on) { ctx.moveTo(tx[k - 1], ty[k - 1]); on = true; }
          ctx.lineTo(tx[k], ty[k]);
          anyTop = true;
        }
      }
      if (anyTop && !G.slow && !G.hide.bloom) {
        ctx.strokeStyle = 'rgba(' + th.packet + ',' + (0.035 + 0.05 * boost).toFixed(3) + ')';
        ctx.lineWidth = 2.4;
        ctx.stroke();
      }

      if (!glow || G.hide.packets) return;
      eachPacket(t, function (x, y, size, alpha) {
        ctx.globalAlpha = alpha;
        ctx.drawImage(glow, x - size / 2, y - size / 2, size, size);
      });
      ctx.globalAlpha = 1;
    }

    function eachPacket(t, fn) {
      var arcs = G.arcs, phase = t * 0.085, boost = G.flash, i, q;
      var skip = G.slow ? 2 : 1;
      for (i = 0; i < arcs.length; i++) {
        var arc = arcs[i];
        if ((i % skip) !== 0 || arc.max <= 0) continue;
        var px = arc.xs, py = arc.ys, pz = arc.zs, n = arc.n;
        var tt = (phase + arc.seed) % 1;
        for (q = 0; q <= 2; q++) {
          var at = tt - 0.03 * q;
          if (at < 0) break;
          var u = at * (n - 1), i0 = u | 0, f = u - i0, i1 = i0 + 1 < n ? i0 + 1 : i0;
          var hz = pz[i0] + (pz[i1] - pz[i0]) * f;
          if (hz <= 0.12) break;
          fn(px[i0] + (px[i1] - px[i0]) * f, py[i0] + (py[i1] - py[i0]) * f,
            q === 0 ? 7.5 : 4.6 / q,
            q === 0 ? Math.min(1, 0.55 + 0.45 * boost) : 0.42 / q, i, tt);
        }
      }
    }

    function drawNodes(t) {
      var th = TH(), ctx = G.ctx, glow = G.glow;
      for (var i = 0; i < G.clusters.length; i++) {
        var c = G.clusters[i];
        project(c.lat, c.lon, P);
        c.sx = P.x; c.sy = P.y; c.on = P.z > 0.02;
        if (!c.on) continue;
        var edge = Math.min(1, P.z * 4);
        /* Lightning dot size follows its real channel degree; an L1 dot follows how
           many distinct geolocated nodes Bitnodes put in this cell. */
        var r = c.l1
          ? 0.85 + Math.min(1.15, Math.log(1 + (c.count || 1)) / 2.6)
          : 1.15 + Math.min(0.95, Math.log(1 + c.channels) / 8) + (c.count > 1 ? 0.3 : 0);
        var pulse = 0.70 + 0.30 * Math.sin(t * 1.5 + i);

        if (glow) {
          var gs = r * 7.5;
          ctx.globalAlpha = Math.min(1, (0.42 + 0.26 * pulse) * edge + 0.35 * G.flash);
          ctx.drawImage(glow, P.x - gs / 2, P.y - gs / 2, gs, gs);
          ctx.globalAlpha = 1;
        }

        ctx.beginPath(); ctx.arc(P.x, P.y, r, 0, TAU);
        ctx.fillStyle = 'rgba(' + th.dot + ',' + (0.95 * edge).toFixed(2) + ')';
        ctx.fill();

        var br = r * (1.9 + 0.30 * Math.sin(t * 1.9 + i));
        ctx.beginPath(); ctx.arc(P.x, P.y, br, 0, TAU);
        ctx.strokeStyle = 'rgba(' + th.halo + ',' + (0.18 * edge * pulse).toFixed(2) + ')';
        ctx.lineWidth = 0.6; ctx.stroke();

        if (!c.l1 && c.count > 1) {
          ctx.beginPath(); ctx.arc(P.x, P.y, r + 2.4, 0, TAU);
          ctx.strokeStyle = 'rgba(' + th.halo + ',' + (0.24 * edge).toFixed(2) + ')';
          ctx.lineWidth = 0.5; ctx.stroke();
        }
      }
    }

    function drawRipples(dt) {
      var th = TH();
      var ctx = G.ctx;
      var cLat = G.pitch * 180 / Math.PI, cLon = G.yaw * 180 / Math.PI;
      var la1 = cLat * DEG, cos1 = Math.cos(la1), sin1 = Math.sin(la1);
      for (var i = G.ripples.length - 1; i >= 0; i--) {
        var r = G.ripples[i];
        r.t += dt;
        if (r.t > 1.9) { G.ripples.splice(i, 1); continue; }
        var k = r.t / 1.9;
        var ang = 0.05 + k * 2.5;
        var alpha = (1 - k) * 0.55;
        ctx.beginPath();
        var started = false;
        for (var b = 0; b <= 360; b += 4) {
          var br = b * DEG;
          var la2 = Math.asin(Math.max(-1, Math.min(1, sin1 * Math.cos(ang) + cos1 * Math.sin(ang) * Math.cos(br))));
          var lo2 = Math.atan2(Math.sin(br) * Math.sin(ang) * cos1, Math.cos(ang) - sin1 * Math.sin(la2));
          var lon2 = cLon + lo2 / DEG;
          project(la2 * 180 / Math.PI, lon2, P);
          if (P.z > 0.01) {
            if (!started) { ctx.moveTo(P.x, P.y); started = true; }
            else ctx.lineTo(P.x, P.y);
          } else started = false;
        }
        ctx.strokeStyle = 'rgba(' + th.halo + ',' + alpha.toFixed(3) + ')';
        ctx.lineWidth = 1.5 * (1 - k) + 0.35;
        ctx.stroke();
        ctx.strokeStyle = 'rgba(' + th.arc + ',' + (alpha * 0.35).toFixed(3) + ')';
        ctx.lineWidth = 5 * (1 - k) + 0.8;
        ctx.stroke();
      }
    }

    function frame(ts) {
      if (!G.lastTs) G.lastTs = ts;
      var raw = (ts - G.lastTs) / 1000;
      var dt = Math.min(0.05, raw);
      G.lastTs = ts;
      var t = ts / 1000;

      var r = Math.abs(raw);
      G.age += r;
      if (G.age > 1.2) {
        G.miss = G.miss * 0.94 + (r > 0.024 ? 1 : 0) * 0.06;
        G.slow = G.forceFull ? false : G.miss > 0.30;
      }
      if (G.adaptive) {
        if (G.lockScale) {
          if (G.resScale !== G.lockScale) setRes(G.lockScale);
        } else {
          if (G.miss > 0.55 && G.resScale > 0.5) setRes(0.5);
          else if (G.miss > 0.28 && G.resScale > 0.62) setRes(0.62);
          else if (G.miss > 0.10 && G.resScale > 0.75) setRes(0.75);
          if (G.miss < 0.02 && G.resScale < 1) {
            G.goodMs += r;
            if (G.goodMs > 6) {
              G.goodMs = 0;
              G.prevScale = G.resScale;
              G.stepAt = G.age;
              setRes(G.resScale < 0.62 ? 0.62 : G.resScale < 0.75 ? 0.75 : 1);
            }
          } else if (G.miss > 0.04) G.goodMs = 0;
          if (G.stepAt && G.age - G.stepAt < 3 && G.miss > 0.12) {
            G.lockScale = G.prevScale;
            G.stepAt = 0;
            setRes(G.prevScale);
          }
        }
      }

      var want = (!G.dragging && !pinch && !G.hold) ? 1 : 0;
      G.spinEase += (want - G.spinEase) * Math.min(1, dt * 2.0);
      if (!G.dragging && !pinch) {
        G.yaw += G.vYaw * (raw / 0.0167);
        G.vYaw *= Math.pow(0.90, raw / 0.0167);
        G.yaw += G.spin * G.spinEase * Math.min(0.25, Math.abs(raw));
      }
      G.zoom += (G.zoomT - G.zoom) * 0.16;
      if (G.flash > 0) G.flash = Math.max(0, G.flash - dt * 0.9);

      G.cam = {
        syw: Math.sin(G.yaw), cyw: Math.cos(G.yaw),
        cp: Math.cos(G.pitch), sp: Math.sin(G.pitch),
        R: G.R * G.zoom, cx: G.cx, cy: G.cy
      };

      var ctx = G.ctx, H = G.hide;
      ctx.clearRect(0, 0, G.w, G.h);
      if (!H.stars) drawStars();
      if (!H.sphere) drawSphere();
      if (!H.grid) drawGraticule();
      if (!H.land) drawLand();
      if (!H.arcs) drawArcs(t);
      if (!H.nodes) drawNodes(t);
      if (!H.ripples) drawRipples(dt);

      G.raf = requestAnimationFrame(frame);
    }

    function start() {
      if (!G.raf) { G.lastTs = 0; G.raf = requestAnimationFrame(frame); }
    }
    function stop() {
      if (G.raf) { cancelAnimationFrame(G.raf); G.raf = 0; }
    }

    /* Lightning layer: one dot per sampled node, one arc per real channel between
       two dots. Nothing else is ever added here. */
    function buildLN() {
      var buckets = {}, order = [], byPk = {};
      S.nodes.forEach(function (n) {
        if (!num(n.lat) || !num(n.lon)) return;
        var key = Math.round(n.lat / 4) + ':' + Math.round(n.lon / 4);
        var b = buckets[key];
        if (!b) { b = buckets[key] = { lat: 0, lon: 0, n: 0, nodes: [] }; order.push(key); }
        b.lat += n.lat; b.lon += n.lon; b.n++; b.nodes.push(n);
      });
      G.clusters = order.map(function (k) {
        var b = buckets[k], ch = 0, cap = 0, deg = 0;
        b.nodes.forEach(function (n) { ch += n.channels || 0; cap += n.capacity || 0; deg += n.deg || 0; });
        return {
          lat: b.lat / b.n, lon: normLon(b.lon / b.n), count: b.n,
          channels: ch, capacity: cap, deg: deg, nodes: b.nodes, sx: 0, sy: 0, on: false, arcs: 0
        };
      });
      G.clusters.forEach(function (c, i) {
        c.nodes.forEach(function (n) { byPk[n.pk] = i; });
      });

      var links = [], used = {}, key, a, b;
      for (var i = 0; i < (S.links || []).length; i++) {
        a = byPk[S.links[i][0]];
        b = byPk[S.links[i][1]];
        if (a === undefined || b === undefined || a === b) continue;
        key = Math.min(a, b) + '-' + Math.max(a, b);
        if (used[key]) continue;
        used[key] = 1;
        links.push([a, b]);
        G.clusters[a].arcs++;
        G.clusters[b].arcs++;
      }
      G.links = links;
      buildArcs();
    }

    /* L1 layer: one dot per bucket of Bitnodes coordinates. A coordinate is a real
       node location the crawler geolocated; the cell only stops the dots from
       piling up on top of each other at phone size. No arcs — Bitnodes publishes
       no peer graph, so there is nothing real to draw between them. */
    function buildL1() {
      var coords = (S.l1 && S.l1.coords) ? S.l1.coords : [];
      var buckets = {}, order = [];
      for (var i = 0; i < coords.length; i++) {
        var p = coords[i];
        if (!p || !num(p[0]) || !num(p[1])) continue;
        var lat = p[0], lon = p[1];
        if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
        var key = Math.floor((lat + 90) / L1_CELL_DEG) + ':' + Math.floor((lon + 180) / L1_CELL_DEG);
        var b = buckets[key];
        if (!b) { b = buckets[key] = { lat: 0, lon: 0, n: 0, pts: [] }; order.push(key); }
        b.lat += lat; b.lon += lon; b.n++; b.pts.push([lat, lon]);
      }
      G.clusters = order.map(function (k) {
        var b = buckets[k];
        return {
          lat: b.lat / b.n, lon: normLon(b.lon / b.n), count: b.n,
          channels: 0, capacity: 0, deg: 0, nodes: [], pts: b.pts,
          l1: true, sx: 0, sy: 0, on: false, arcs: 0,
          iso: l1CellCountry(b.pts)
        };
      });
      G.links = [];
      buildArcs();
    }

    function build() {
      if (S.layer === 'l1') buildL1(); else buildLN();
    }

    function pulse() { G.flash = 1; G.ripples.push({ t: 0 }); }

    function geoProbe(yaw, pitch) {
      var sYaw = G.yaw, sPitch = G.pitch, sCam = G.cam;
      G.yaw = yaw; G.pitch = pitch;
      G.cam = {
        syw: Math.sin(yaw), cyw: Math.cos(yaw),
        cp: Math.cos(pitch), sp: Math.sin(pitch),
        R: G.R * G.zoom, cx: G.cx, cy: G.cy
      };
      var cam = G.cam, o = { x: 0, y: 0, z: 0 }, i, k, e;
      var out = { yaw: yaw, pitch: pitch, ringErr: 0, arcErr: 0, samples: 0, worst: null };

      var all = [G.ringsP, G.gratsP];
      for (var g = 0; g < all.length; g++) {
        var list = all[g];
        for (i = 0; i < list.length; i++) {
          var r = list[i];
          projectRing(r, cam);
          var src = g === 0 ? G.rings[i] : G.grats[i];
          for (k = 0; k < src.length; k += 3) {
            project(src[k][1], src[k][0], o);
            e = Math.max(Math.abs(o.x - r.xs[k]), Math.abs(o.y - r.ys[k]), Math.abs(o.z - r.zs[k]));
            if (e > out.ringErr) { out.ringErr = e; out.worst = { lat: src[k][1], lon: src[k][0] }; }
            out.samples++;
          }
        }
      }

      for (i = 0; i < G.arcs.length; i++) {
        var arc = G.arcs[i], lk = G.links[i];
        if (!lk) continue;
        projectArc(arc, cam);
        for (var side = 0; side < 2; side++) {
          var c = G.clusters[lk[side]], idx = side === 0 ? 0 : arc.n - 1;
          if (!c) continue;
          project(c.lat, c.lon, o);
          e = Math.max(Math.abs(o.x - arc.xs[idx]), Math.abs(o.y - arc.ys[idx]), Math.abs(o.z - arc.zs[idx]));
          if (e > out.arcErr) out.arcErr = e;
          out.samples++;
        }
      }

      G.yaw = sYaw; G.pitch = sPitch; G.cam = sCam;
      return out;
    }

    function hitTest(x, y) {
      var best = null, bestD = 26;
      for (var i = 0; i < G.clusters.length; i++) {
        var c = G.clusters[i];
        if (!c.on) continue;
        var d = Math.sqrt((c.sx - x) * (c.sx - x) + (c.sy - y) * (c.sy - y));
        if (d < bestD) { bestD = d; best = c; }
      }
      return best;
    }

    function bind() {
      var cv = G.cv;
      if (!cv) return;
      cv.addEventListener('pointerdown', function (e) {
        pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
        var keys = Object.keys(pointers);
        if (keys.length === 2) {
          var a = pointers[keys[0]], b = pointers[keys[1]];
          pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, z: G.zoomT };
          G.dragging = false;
        } else {
          G.dragging = true; G.vYaw = 0;
          dragStart = { x: e.clientX, y: e.clientY, yaw: G.yaw, pitch: G.pitch };
          dragMoved = 0;
        }
        G.lastTouch = Date.now();
        try { cv.setPointerCapture(e.pointerId); } catch (err) { }
      });
      cv.addEventListener('pointermove', function (e) {
        if (!pointers[e.pointerId]) return;
        pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
        G.lastTouch = Date.now();
        var keys = Object.keys(pointers);
        if (pinch && keys.length === 2) {
          var a = pointers[keys[0]], b = pointers[keys[1]];
          var d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
          G.zoomT = clamp(pinch.z * (d / pinch.d), 0.8, 2.2);
          e.preventDefault();
          return;
        }
        if (!G.dragging || !dragStart) return;
        var dx = e.clientX - dragStart.x, dy = e.clientY - dragStart.y;
        dragMoved = Math.max(dragMoved, Math.abs(dx) + Math.abs(dy));
        G.yaw = dragStart.yaw - dx * 0.0072;
        G.pitch = clamp(dragStart.pitch + dy * 0.0045, -1.05, 1.05);
        G.vYaw = -dx * 0.00025;
        e.preventDefault();
      });
      function release(e) {
        var wasDrag = dragMoved;
        if (pointers[e.pointerId]) delete pointers[e.pointerId];
        var keys = Object.keys(pointers);
        if (keys.length < 2) pinch = null;
        if (keys.length === 0) {
          G.dragging = false;
          if (wasDrag < 6) {
            var c = hitTest(e.clientX, e.clientY);
            if (c) showNodeCard(c);
          }
          G.lastTouch = Date.now();
        }
      }
      cv.addEventListener('pointerup', release);
      cv.addEventListener('pointercancel', release);
      cv.addEventListener('wheel', function (e) {
        e.preventDefault();
        G.zoomT = clamp(G.zoomT * Math.exp(-e.deltaY * 0.0014), 0.8, 2.2);
        G.lastTouch = Date.now();
      }, { passive: false });
      cv.addEventListener('gesturestart', function (e) { e.preventDefault(); });
    }

    function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

    return {
      init: function () {
        G.rings = decodeRings(typeof WORLD_LAND !== 'undefined' ? WORLD_LAND : '');
        G.grats = buildGraticule();
        G.ringsP = G.rings.map(prepRing);
        G.gratsP = G.grats.map(prepRing);
        resize(); bind(); start();
        window.addEventListener('resize', function () { resize(); });
        window.addEventListener('orientationchange', function () { setTimeout(resize, 250); });
        document.addEventListener('visibilitychange', function () {
          if (document.hidden) stop(); else start();
        });
      },
      build: build,
      pulse: pulse,
      geoProbe: geoProbe,
      packets: function (t) {
        var out = [];
        eachPacket(t, function (x, y, size, alpha, arc, tt) { out.push([x, y, size, arc, tt]); });
        return out;
      },
      projectPoint: function (lat, lon) {
        var o = { x: 0, y: 0, z: 0 };
        project(lat, lon, o);
        return { x: o.x, y: o.y, z: o.z };
      },
      resize: resize,
      /* a layer switch changes the palette and the node set: rebuild both caches */
      relayout: function () { layout(); buildBall(); buildGlow(); },
      retheme: function () { buildBackground(); buildBall(); buildGlow(); },
      setRes: setRes,
      hold: function (on) { G.hold = !!on; G.lastTouch = Date.now(); },
      state: G
    };
  })();

  /* country of an L1 cell: every coordinate in it that the Bitnodes snapshot
     geolocated, and only if they agree */
  function l1CellCountry(pts) {
    var s = (typeof L1_SNAPSHOT !== 'undefined') ? L1_SNAPSHOT : null;
    if (!s || !s.coordCountry) return '';
    var seen = {}, any = '';
    for (var i = 0; i < pts.length; i++) {
      var iso = s.coordCountry[(pts[i][0]).toFixed(4) + ',' + (pts[i][1]).toFixed(4)];
      if (iso) { seen[iso] = 1; any = iso; }
    }
    var keys = Object.keys(seen);
    return keys.length === 1 ? any : '';
  }

  /* ------------------------------------------------------------ node card */
  function showNodeCard(cluster) {
    if (S.layer === 'l1') showL1Card(cluster);
    else showLNCard(cluster);
    $('modal').classList.add('on');
    Globe.hold(true);
    var cb = $('cardClose');
    if (cb) cb.addEventListener('click', closeNodeCard);
  }

  function closeNodeCard() {
    var m = $('modal');
    if (m) m.classList.remove('on');
    Globe.hold(false);
  }

  function cardRows(rows) {
    return rows.map(function (r) {
      return '<div class="cell' + (r[2] ? ' full' : '') + '"><dt>' + esc(r[0]) + '</dt><dd class="' + (r[1] === '—' ? 'na' : '') + '">' + esc(r[1]) + '</dd></div>';
    }).join('');
  }

  function showL1Card(cluster) {
    var s = (typeof L1_SNAPSHOT !== 'undefined') ? L1_SNAPSHOT : null;
    var l1 = S.l1 || {};
    var pt = cluster.pts && cluster.pts.length ? cluster.pts[0] : [cluster.lat, cluster.lon];
    var iso = cluster.iso || '';
    var place = iso ? countryName(iso, '') + (iso ? ' (' + iso + ')' : '') : '—';
    var card = $('card');
    if (!card) return;
    var rows = [
      [L('cCoord'), pt[0].toFixed(4) + '°, ' + pt[1].toFixed(4) + '°'],
      [L('cCell'), fmtInt(cluster.count) + ' ' + L('cCells')],
      [L('cCountry'), place],
      [L('cSrc'), l1.src === 'live' ? 'Bitnodes ' + L('live') : l1.src === 'cache' ? 'Bitnodes ' + L('cache') : 'Bitnodes ' + L('snap')],
      [L('cSnapAt'), l1.at ? dateOf(l1.at) : '—'],
      [L('cHeight'), S.tip === null ? '—' : fmtInt(S.tip)]
    ];
    card.innerHTML =
      '<div class="card-head"><div>' +
      '<div class="kicker">BITCOIN L1 · FULL NODE</div>' +
      '<h2>' + esc(pt[0].toFixed(2) + '°, ' + pt[1].toFixed(2) + '°') + '</h2>' +
      '<p class="place">' + esc(place === '—' ? L('cWhere') + ' ' + (iso || '—') : place) + '</p>' +
      '</div><button class="close" id="cardClose" aria-label="close">×</button></div>' +
      '<dl class="grid">' + cardRows(rows) + '</dl>' +
      (s && s.capturedAt ? '<div class="disc">' + L('cCountry') + ': Bitnodes ' + dateOf(s.capturedAt * 1000).slice(0, 10) + ' · ' + fmtInt(s.totalNodes) + ' nodes</div>' : '') +
      '<p class="disc"><b>Bitnodes</b> · ' + esc(L('cL1Note')) + '</p>';
  }

  function showLNCard(cluster) {
    var n = cluster.nodes[0];
    var many = cluster.nodes.length > 1;
    var continent = contName(contOf(n.iso));
    var place = [n.city, S.lang === 'en' ? n.country : countryName(n.iso, n.country)].filter(Boolean).join(' · ');
    var chainTipHash = null, chainTipHeight = S.tip;
    if (S.blocks && S.blocks.length) chainTipHash = S.blocks[0].id;

    var card = $('card');
    if (!card) return;
    var rows = [
      [L('cCoord'), num(n.lat) && num(n.lon) ? n.lat.toFixed(4) + '°, ' + n.lon.toFixed(4) + '°' : '—'],
      [L('cCountry'), (countryName(n.iso, n.country) || '—') + (n.iso ? ' (' + n.iso + ')' : '')],
      [L('cCh'), num(n.channels) ? fmtInt(n.channels) : '—'],
      [L('cCap'), num(n.capacity) ? fmtBtcCap(n.capacity) + ' BTC' : '—'],
      [L('cMapCh'), num(n.deg) ? fmtInt(n.deg) : '—'],
      [L('cAS'), n.asOrg || '—'],
      [L('cSock'), n.sockets ? n.sockets + '개' + (n.tor ? ' · Tor' : ' · clearnet') : '—'],
      [L('cFirst'), dateOf(n.firstSeen)],
      [L('cUpd'), n.updatedAt ? dateOf(n.updatedAt) : '—']
    ];
    if (many) rows.push([L('cCluster'), cluster.count + ' nodes · ' + fmtInt(cluster.channels) + ' ch', true]);

    var aliasList = many ? cluster.nodes.map(function (x) { return esc(x.alias); }).slice(0, 6).join(', ') : '';
    var peers = n.peers || [];
    var peerHTML = peers.length
      ? '<div class="peers"><div class="t">' + L('cPeers') + '</div><div class="p">' +
        peers.map(function (a) { return '<span class="peer">' + esc(a) + '</span>'; }).join('') +
        '</div><div class="v">' + fmtInt(cluster.deg) + ' / ' + cluster.arcs + ' · channels-geo</div></div>'
      : '';

    card.innerHTML =
      '<div class="card-head"><div>' +
      '<div class="kicker">NODE · ' + esc(continent) + '</div>' +
      '<h2>' + esc(n.alias) + '</h2>' +
      '<p class="place">' + esc(place || '—') + '</p>' +
      '</div><button class="close" id="cardClose" aria-label="close">×</button></div>' +
      '<dl class="grid">' + cardRows(rows) + '</dl>' +
      peerHTML +
      (aliasList ? '<div class="disc" style="margin-top:12px">' + aliasList + (cluster.nodes.length > 6 ? ' +' + (cluster.nodes.length - 6) : '') + '</div>' : '') +
      '<div class="tip"><div class="t">' + L('cChainTip') + '</div>' +
      '<div class="h">' + esc(chainTipHash || '—') + '</div>' +
      '<div class="v">' + L('cHeight') + ' ' + (chainTipHeight === null ? '—' : fmtInt(chainTipHeight)) + ' · ' + esc(S.nodeSrc === 'seed' ? L('snap') : ago(S.nodeAt)) + '</div></div>' +
      '<p class="disc">' + esc(L('cLNNote')) + '</p>';
  }

  /* ------------------------------------------------------------- layer/i18n */
  function setLayer(layer) {
    if (layer !== 'l1' && layer !== 'ln') return;
    S.layer = layer;
    document.body.classList.toggle('l1', layer === 'l1');
    document.body.classList.toggle('ln', layer === 'ln');
    mark($('layerL1'), 'on', layer === 'l1');
    mark($('layerLN'), 'on', layer === 'ln');
    var b1 = $('layerL1'), b2 = $('layerLN');
    if (b1) b1.setAttribute('aria-selected', layer === 'l1' ? 'true' : 'false');
    if (b2) b2.setAttribute('aria-selected', layer === 'ln' ? 'true' : 'false');
    var cv = $('globe');
    if (cv) cv.setAttribute('aria-label', layer === 'l1' ? '비트코인 L1 풀노드 지구본' : '라이트닝 채널 지구본');
    show('secL1Wrap', layer === 'l1');
    show('secVerWrap', layer === 'l1');
    show('secLNWrap', layer === 'ln');
    txt('subrow', layer === 'l1' ? L('subL1') : L('subLN'));
    txt('distTitle', layer === 'l1' ? L('secDistL1') : L('secDistLN'));
    $('legend').innerHTML = layer === 'l1'
      ? '<span class="l"><span class="dot"></span>' + esc(L('legL1dot')) + '</span><span class="l">' + esc(L('legL1note')) + '</span>'
      : '<span class="l"><span class="dot"></span>' + esc(L('legLNdot')) + '</span><span class="l"><span class="line"></span>' + esc(L('legLNline')) + '</span>';
    Globe.build();
    Globe.retheme();
    noteDirty = true;
    storePref();
    schedulePaint();
  }

  function applyLang() {
    document.body.classList.toggle('en', S.lang === 'en');
    if (document.documentElement && document.documentElement.setAttribute) {
      document.documentElement.setAttribute('lang', S.lang === 'en' ? 'en' : 'ko');
    }
    var nodes = document.querySelectorAll ? document.querySelectorAll('[data-i18n]') : [];
    for (var i = 0; i < nodes.length; i++) {
      var k = nodes[i].getAttribute('data-i18n');
      if (k) nodes[i].textContent = L(k);
    }
    txt('langBtn', S.lang === 'en' ? 'KO' : 'EN');
    txt('subrow', S.layer === 'l1' ? L('subL1') : L('subLN'));
    txt('distTitle', S.layer === 'l1' ? L('secDistL1') : L('secDistLN'));
    txt('hint', L('hint'));
    $('legend').innerHTML = S.layer === 'l1'
      ? '<span class="l"><span class="dot"></span>' + esc(L('legL1dot')) + '</span><span class="l">' + esc(L('legL1note')) + '</span>'
      : '<span class="l"><span class="dot"></span>' + esc(L('legLNdot')) + '</span><span class="l"><span class="line"></span>' + esc(L('legLNline')) + '</span>';
    var tg = $('toggle');
    if (tg) tg.setAttribute('aria-label', S.panelOpen ? L('pClose') : L('pOpen'));
    noteDirty = true;
    storePref();
    schedulePaint();
  }

  function storePref() { store(LS_PREF, { layer: S.layer, lang: S.lang }); }
  function loadPref() {
    var p = recall(LS_PREF);
    if (!p) return;
    if (p.lang === 'en' || p.lang === 'ko') S.lang = p.lang;
    if (p.layer === 'l1' || p.layer === 'ln') S.layer = p.layer;
  }

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
    var top = $('topbar'), btn = $('toggle'), panel = $('panel');
    function setPanel(open) {
      S.panelOpen = open;
      if (top) top.classList.toggle('open', open);
      if (btn) {
        btn.textContent = open ? '−' : '+';
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        btn.setAttribute('aria-label', open ? L('pClose') : L('pOpen'));
      }
      if (open) paintPanel();
    }
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
    var lb = $('langBtn');
    if (lb) lb.addEventListener('click', function () { S.lang = S.lang === 'en' ? 'ko' : 'en'; applyLang(); });
    var wp = $('watchPill');
    if (wp) wp.addEventListener('click', function () { setPanel(true); var w = $('watch'); if (w && w.scrollIntoView) w.scrollIntoView({ block: 'center' }); });
    var modal = $('modal');
    if (modal) modal.addEventListener('click', function (e) { if (e.target === modal) closeNodeCard(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeNodeCard(); });
  }

  function tickClock() {
    var d = new Date();
    txt('clock', pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ':' + pad2(d.getUTCSeconds()));
    var kst = new Date(d.getTime() + 9 * 3600 * 1000);
    txt('clockKst', 'KST ' + pad2(kst.getUTCHours()) + ':' + pad2(kst.getUTCMinutes()));
  }

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
    applyLang();
    setLayer(S.layer);
    tickClock();
    setInterval(tickClock, 1000);
    paint();
    if (hadCache) toast(L('tCached'));

    refreshCore();
    refreshSlow();
    loadL1();
    refreshNodes(false);
    connectWS();

    setInterval(function () {
      if (S.ws !== 'open') refreshCore();
    }, 20000);
    setInterval(function () { if (S.ws === 'open') { loadTip().catch(noop); loadMem().catch(noop); } }, 90000);
    setInterval(function () { loadBlocks().catch(noop); loadRecentTxs().catch(noop); }, 60000);
    setInterval(function () { loadHashrate().catch(noop); loadDiff().catch(noop); }, 300000);
    setInterval(function () { loadPools().catch(noop); }, POOL_TTL);
    setInterval(function () { if (Date.now() - S.l1Tried > L1_TTL) loadL1(); }, 60000);
    setInterval(refreshSlow, 1800000);
    setInterval(function () { refreshNodes(false); }, 6 * 3600 * 1000);
    setInterval(function () { if (stale()) { refreshCore(); if (S.ws !== 'open') connectWS(); } }, 45000);
    setInterval(function () { paintStatus(); if (S.panelOpen) paintPanel(); }, 15000);

    var hint = $('hint');
    if (hint) {
      setTimeout(function () { hint.classList.add('on'); }, 900);
      setTimeout(function () { hint.classList.remove('on'); }, 7600);
    }

    // test hook (headless verification only)
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
      lang: function (l) { if (l) { S.lang = l; applyLang(); } return S.lang; },
      loadL1: loadL1,
      bridge: function () { return BR.on; },
      wsUrl: wsUrl,
      mblocks: function () { return S.mblocks; },
      watch: function () { evalWatch(); return { list: S.wd ? S.wd.list : [], alerts: (S.wd ? S.wd.alerts : []) || [], sig: S.alertSig }; },
      reorg: reorgEvent
    };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
