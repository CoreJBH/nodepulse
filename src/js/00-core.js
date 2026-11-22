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

/* Core: the page-level constants, the two-language string table, the DOM and text
   helpers, the number formatters and the one live state object every other module reads. */

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
  /* A REST answer must be complete, not merely started: the abort timer spans the
     headers AND the body read, so a mirror that stalls mid-body still falls to the next
     one instead of hanging forever (the test build's hook can set it: fetchMs). */
  var FETCH_MS = 9000;
  /* The native bridge is bounded on the Java side by CONNECT_MS 12 s + READ_MS 25 s = 37 s
     per hop (HttpBridge in MainActivity.java). A page timer shorter than that abandons a
     request Android is still completing, so a slow but working network never delivered an
     L1 read: the page gave up at 20–22 s, threw the answer away when it arrived, and the
     call was the only one the layer had. Every bridge wait is therefore floored at this
     value, five seconds above the native ceiling for the chunked hand-over
     (the test build's hook can read it: bridgeMs). */
  var BRIDGE_MS = 42000;
  /* A WebSocket that never finishes connecting is closed after this long and the next
     mirror gets the retry, instead of the app sitting without a feed until the browser
     gives up on its own (window.NP_WS_CONNECT_MS before boot, or the test build's hook:
     wsConnectMs). */
  var WS_CONNECT_MS = 8000;
  if (typeof window !== 'undefined' && window && num(window.NP_WS_CONNECT_MS)) {
    WS_CONNECT_MS = window.NP_WS_CONNECT_MS;
  }

  /* ------------------------------------------------------------------ i18n */
  var STR = {
    ko: {
      utc: '현재 시각 (UTC)', state: '상태',
      secNet: 'BITCOIN MAINNET · 실시간', secL1: 'BITCOIN L1 · 풀노드', secLN: 'LIGHTNING · MEMPOOL.SPACE',
      kHeight: '블록 높이', kMem: '멤풀', kFee: '최속 수수료', kHash: '해시레이트', kDiff: '다음 난이도 조정',
      kL1: '도달 가능 풀노드', kPlat: '접속망', kL1H: '크롤러 기준 높이', kL1At: '측정 시각',
      kL1Fresh: 'L1 실시간성',
      kLN: '라이트닝 노드', kLNCap: '채널 · 용량',
      secDistL1: '대륙별 L1 노드 분포', secDistLN: '대륙별 라이트닝 노드 분포',
      secVer: '클라이언트 버전', secNext: '다음 블록 · NEXT BLOCKS', secWatch: '네트워크 감시 · WATCHDOG',
      secLedger: '최근 블록 · 최근 트랜잭션', hBlocks: '최근 블록', hTxs: '최근 트랜잭션',
      loading: '불러오는 중…', syncing: '실시간 동기화', polling: '폴링 갱신', retry: '연결 재시도 중',
      live: '실시간', snap: '내장 스냅샷', cache: '저장본', none: '—',
      fLive: '실시간 · Bitnodes', fLiveNote: '좌표 · 전송망 · 버전을 지금 읽었습니다',
      fCache: '저장본', fCacheNote: '실시간 요청이 답하지 않아 저장해 둔 답을 표시',
      fCors: '정적 스냅샷 · 브라우저 CORS 차단', fCorsNote: 'bitnodes.io가 CORS 헤더를 보내지 않아 브라우저에서는 읽을 수 없습니다 · Android 앱은 네이티브 브리지로 실시간',
      fSnap: '정적 스냅샷', fSnapNote: '실시간 요청을 기다리는 중이거나 답하지 않았습니다',
      snapBasis: '스냅샷 기준',
      legL1static: '좌표 · 정적 스냅샷', subSnap: '스냅샷', subCache: '저장본', subLive: '실시간',
      subL1: 'FULL NODE NETWORK · BITNODES', subLN: 'LIGHTNING CHANNEL GRAPH · MEMPOOL.SPACE',
      legL1dot: 'L1 풀노드 위치 (Bitnodes)', legL1note: 'Tor·I2P 노드는 좌표 없음', legLNdot: 'LIGHTNING NODE',
      legLNline: 'LIGHTNING CHANNEL (실측)',
      hint: 'DRAG TO ROTATE · SCROLL / PINCH TO ZOOM',
      pOpen: '실시간 네트워크 패널 열기', pClose: '실시간 네트워크 패널 닫기',
      nextWaiting: '블록 분량 대기', nextNone: 'mempool-blocks 대기 중 — WebSocket 연결되면 표시됩니다',
      nextBlock: '다음', nextFee: 'sat/vB',
      wOkChain: '체인 정상', wOkGap: '마지막 블록', wOkFee: '수수료 정상', wOkPool: '채굴 풀 집중도',
      wGap: '블록 지연', wFee: '수수료 급등', wPool: '채굴 풀 집중', wReorg: '리오그 감지',
      wNoData: '감시 데이터 대기 중', poolSpan: '1주', poolBlocks: '블록',
      tNewBlock: 'NEW BLOCK', tReorg: 'REORG 감지', tSnap: '비트노즈 스냅샷 표시 중 · 갱신 중',
      tCached: '저장된 마지막 데이터 표시 중 · 갱신 중',
      cCoord: '좌표', cCell: '격자 내 위치', cCountry: '국가', cPlace: '지역', cSrc: '출처', cSnapAt: '기준 시각',
      cChainTip: 'CHAIN TIP · 네트워크 공통', cHeight: '높이', cWhere: '위치',
      cL1Note: '이 지점은 Bitnodes가 좌표를 보고한 실제 노드 위치입니다. Bitnodes는 노드별 P2P 연결 그래프를 공개하지 않으므로 지구본에 연결선은 그리지 않습니다. 지연시간·가동시간·디스크 용량처럼 크롤러가 알 수 없는 값도 표시하지 않습니다.',
      cLNNote: '표시 값은 mempool.space Lightning API 응답 그대로입니다(별칭·국가·도시·좌표·채널·용량·AS·관측 시각). 지연시간, 가동시간, 디스크 용량, 개별 노드의 동기화 높이처럼 API가 제공하지 않는 항목은 표시하지 않습니다. CHAIN TIP은 이 노드가 보고한 값이 아니라 네트워크 공통 현재 tip입니다. 노드 사이의 호는 lightning/channels-geo에 실린 실제 공개 채널이며, 근접 추정으로 이은 선은 없습니다.',
      cPeers: 'REAL CHANNELS · 실제 채널 상대', cMapCh: '지도 채널', cCh: '채널', cCap: '용량', cAS: 'AS 조직',
      cSock: '소켓', cFirst: '최초 관측', cUpd: '최근 갱신', cCluster: '클러스터', cCells: '곳',
      sockUnit: '개', unitNodes: '개 노드', unitCh: ' 채널', cClose: '닫기', ariaL1: '비트코인 L1 풀노드 지구본', ariaLN: '라이트닝 채널 지구본',
      noteL1a: 'BITNODES · L1 풀노드', noteL1b: '국가 분포 · 내장 스냅샷', noteL1c: '지구본 지점',
      apl: '접속망', ua: '클라이언트'
    },
    en: {
      utc: 'CURRENT TIME (UTC)', state: 'STATUS',
      secNet: 'BITCOIN MAINNET · LIVE', secL1: 'BITCOIN L1 · FULL NODES', secLN: 'LIGHTNING · MEMPOOL.SPACE',
      kHeight: 'Block height', kMem: 'Mempool', kFee: 'Fastest fee', kHash: 'Hashrate', kDiff: 'Next difficulty',
      kL1: 'Reachable full nodes', kPlat: 'Transport', kL1H: 'Crawler height', kL1At: 'Measured at',
      kL1Fresh: 'L1 freshness',
      kLN: 'Lightning nodes', kLNCap: 'Channels · capacity',
      secDistL1: 'L1 nodes by continent', secDistLN: 'Lightning nodes by continent',
      secVer: 'Client versions', secNext: 'Next blocks', secWatch: 'Network watchdog',
      secLedger: 'Recent blocks · recent transactions', hBlocks: 'Recent blocks', hTxs: 'Recent txs',
      loading: 'loading…', syncing: 'live sync', polling: 'polling', retry: 'reconnecting',
      live: 'live', snap: 'built-in snapshot', cache: 'cached', none: '—',
      fLive: 'live · Bitnodes', fLiveNote: 'coordinates, transport and versions read just now',
      fCache: 'cached answer', fCacheNote: 'the live request did not answer, so the last saved answer is shown',
      fCors: 'static snapshot · browser CORS block', fCorsNote: 'bitnodes.io sends no Access-Control-Allow-Origin, so a browser cannot read it · the Android app reads it live through its native bridge',
      fSnap: 'static snapshot', fSnapNote: 'waiting for the live request, or it did not answer',
      snapBasis: 'snapshot',
      legL1static: 'dots · static snapshot', subSnap: 'SNAPSHOT', subCache: 'CACHE', subLive: 'LIVE',
      subL1: 'FULL NODE NETWORK · BITNODES', subLN: 'LIGHTNING CHANNEL GRAPH · MEMPOOL.SPACE',
      legL1dot: 'L1 FULL NODE LOCATION (Bitnodes)', legL1note: 'Tor/I2P nodes have no coordinates', legLNdot: 'LIGHTNING NODE',
      legLNline: 'LIGHTNING CHANNEL (measured)',
      hint: 'DRAG TO ROTATE · SCROLL / PINCH TO ZOOM',
      pOpen: 'Open the network panel', pClose: 'Close the network panel',
      nextWaiting: 'blocks queued', nextNone: 'waiting for mempool-blocks over WebSocket',
      nextBlock: 'next', nextFee: 'sat/vB',
      wOkChain: 'chain normal', wOkGap: 'last block', wOkFee: 'fees normal', wOkPool: 'mining pool concentration',
      wGap: 'block delay', wFee: 'fee spike', wPool: 'pool concentration', wReorg: 'reorg detected',
      wNoData: 'waiting for data', poolSpan: '1w', poolBlocks: 'blocks',
      tNewBlock: 'NEW BLOCK', tReorg: 'REORG DETECTED', tSnap: 'showing the Bitnodes snapshot · refreshing',
      tCached: 'showing cached data · refreshing',
      cCoord: 'Coordinate', cCell: 'Locations in cell', cCountry: 'Country', cPlace: 'Place', cSrc: 'Source', cSnapAt: 'Captured',
      cChainTip: 'CHAIN TIP · network-wide', cHeight: 'height', cWhere: 'location',
      cL1Note: 'This is a real node location Bitnodes geolocated. Bitnodes publishes no per-node peer graph, so no link is drawn on the globe, and values the crawler cannot know (latency, uptime, disk size) are not shown.',
      cLNNote: 'Every value shown is the mempool.space Lightning API response as-is (alias, country, city, coordinates, channels, capacity, AS, observation time). Latency, uptime, disk size and per-node sync height are not shown because the API does not carry them. CHAIN TIP is the network-wide tip, not a value reported by this node. Arcs are real public channels from lightning/channels-geo — never a proximity guess.',
      cPeers: 'REAL CHANNELS', cMapCh: 'Mapped channels', cCh: 'Channels', cCap: 'Capacity', cAS: 'AS org',
      cSock: 'Sockets', cFirst: 'First seen', cUpd: 'Updated', cCluster: 'Cluster', cCells: 'locations',
      sockUnit: '', unitNodes: ' nodes', unitCh: ' ch', cClose: 'Close', ariaL1: 'Bitcoin L1 full-node globe', ariaLN: 'Lightning channel globe',
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
  /* Every answer from a mirror is parsed JSON, which may be any value: a proxy or a
     captive portal can hand back a string, a number or an array where an object was
     expected. These checks keep the paint path from walking into a primitive. */
  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function isArr(v) { return Array.isArray(v); }

  /* esc() covers the five characters that end an attribute or open a tag. Values are
     written into text and into attributes, so the single quote is escaped too. */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;';
    });
  }

  /* The panel bars: an inline style attribute is inline CSS, which the page's policy
     no longer allows, so the fill width is a class from a 1 %-step grid instead
     (.bar i.bw1 … .bw100 in app.css). The value itself stays computed from the API. */
  function barClass(pct) {
    var n = num(pct) ? Math.round(pct) : 0;
    if (n < 1) return '';
    return 'bw' + (n > 100 ? 100 : n);
  }

  /* ------------------------------------------------------------- formatting */
  function num(v) { return typeof v === 'number' && isFinite(v); }
  function fmtInt(v) {
    if (!num(v)) return '—';
    var s = String(Math.round(v));
    return s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  function fmtFixed(v, d) { return num(v) ? v.toFixed(d) : '—'; }
  /* The fee row prints one decimal: a figure the answer did not carry (a push may omit
     halfHourFee or hourFee) is an em dash, never Math.round() of NaN. */
  function fmtFee(v) { return num(v) ? String(Math.round(v * 10) / 10) : '—'; }
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
  /* A device clock that runs a little slow puts an API timestamp (a block, a mempool
     answer) a few seconds in the future, and Date.now() - ms then comes out negative.
     Every elapsed-time figure is clamped at zero here and at its call sites, so the UI
     reads "0초 전" instead of "-3초 전" or the em dash that durSec() returns for a
     negative second count. */
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
    l1: null, l1Tried: 0, l1Off: false,
    mblocks: [], mblocksAt: 0,
    pools: null, poolsAt: 0,
    wd: null, alertSig: '', feeHist: [], chain: Object.create(null), reorgAt: 0, reorgAtHeight: 0
  };
