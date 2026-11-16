/* ============================================================================
   NODEPULSE — Bitcoin mainnet network monitor
   ----------------------------------------------------------------------------
   Data: mempool.space (REST + WebSocket). Everything shown as a network value
   comes from an API field; nothing is generated, randomised or estimated for
   display. See the panel footnote ("DATA") for the exact sources and for the
   two things that are deliberately NOT shown because the API does not carry
   them (per-node latency, uptime, disk size, per-node chain height).

   Globe links: every arc is one real open Lightning channel taken from
   /api/v1/lightning/channels-geo, drawn only between the nodes that are on the
   globe and cut to LINK_PER_NODE arcs per dot. There is no nearest-neighbour or
   proximity fallback. Only the near hemisphere is stroked: a channel or coastline
   behind the globe is never drawn through it.
   ========================================================================== */
(function () {
  'use strict';

  var DEG = Math.PI / 180, TAU = Math.PI * 2;
  var API_HOSTS = ['https://mempool.space', 'https://mempool.emzy.de', 'https://mempool.ninja'];
  var WS_URL = 'wss://mempool.space/api/v1/ws';
  var CH_PATH = '/api/v1/lightning/channels-geo';
  var LS_CACHE = 'nodepulse.cache.v1';
  var LS_NODES = 'nodepulse.nodes.v2';   // node sample + the real channels between them
  var NODE_TTL = 6 * 3600 * 1000;     // node geo re-fetch window
  var MAX_NODES = 22;
  var STALE_MS = 90000;
  var CELL_DEG = 20;                  // lat/lon bucket that keeps two picks off one dot
  var CELL_CAP = 2;
  var REGION_CAP = 5;

  /* ------------------------------------------------------------------ dom */
  function $(id) { return document.getElementById(id); }
  function txt(id, s) { var e = $(id); if (e && e.textContent !== s) e.textContent = s; }
  function setHTML(id, s) { var e = $(id); if (e && e.innerHTML !== s) e.innerHTML = s; }
  function mark(el, name, on) { if (!el) return; if (on) { el.classList.add(name); } else { el.classList.remove(name); } }
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
    var s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 60) return Math.floor(s) + '초 전';
    if (s < 3600) return Math.floor(s / 60) + '분 전';
    if (s < 86400) return Math.floor(s / 3600) + '시간 전';
    return Math.floor(s / 86400) + '일 전';
  }
  function durSec(sec) {
    if (!num(sec) || sec < 0) return '—';
    if (sec < 60) return Math.floor(sec) + '초';
    if (sec < 3600) return Math.floor(sec / 60) + '분';
    if (sec < 86400) return Math.floor(sec / 3600) + '시간 ' + Math.floor((sec % 3600) / 60) + '분';
    return Math.floor(sec / 86400) + '일 ' + Math.floor((sec % 86400) / 3600) + '시간';
  }
  function dateOf(v) {
    var d;
    if (typeof v === 'string') d = new Date(v);                       // ISO strings (e.g. lightning stats "added")
    else if (num(v) && v > 0) d = new Date(v < 1e12 ? v * 1000 : v);  // epoch seconds or milliseconds
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
    lastOk: 0, ws: 'idle', wsTries: 0, fail: 0, panelOpen: false, tab: 'blocks'
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

  function loadBlocks() {
    return request('/api/v1/blocks').then(function (arr) {
      if (!arr || !arr.length) throw new Error('no blocks');
      S.blocks = arr.slice(0, 8).map(mapBlock);
      if (S.tip === null) { S.tip = S.blocks[0].height; S.tipSeenAt = Date.now(); }
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
      S.recent = arr.slice(0, 8).map(function (t) {
        return { txid: t.txid, fee: t.fee, vsize: t.vsize, value: t.value, rate: t.vsize ? t.fee / t.vsize : null };
      });
      ok(); schedulePaint();
    });
  }

  function loadFees() {
    return request('/api/v1/fees/recommended').then(function (f) {
      S.fees = f; ok(); schedulePaint();
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

  /* -------------------------------------------------------- continents ---- */
  var CONT_ORDER = ['NA', 'EU', 'AS', 'SA', 'OC', 'AF', 'OT'];
  var CONT_KO = { NA: '북미', EU: '유럽', AS: '아시아', SA: '남미', OC: '오세아니아', AF: '아프리카', OT: '기타' };

  function contOf(iso) {
    var meta = (typeof COUNTRY_META !== 'undefined' && COUNTRY_META.cont) ? COUNTRY_META.cont : {};
    return meta[String(iso || '').toUpperCase()] || 'OT';
  }
  function countryKo(iso, fallback) {
    var ko = (typeof COUNTRY_META !== 'undefined' && COUNTRY_META.ko) ? COUNTRY_META.ko : {};
    return ko[String(iso || '').toUpperCase()] || fallback || '';
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

  /* ---- real channel graph: mempool.space /api/v1/lightning/channels-geo -------
     One row is [pubkeyA, aliasA, lonA, latA, pubkeyB, aliasB, lonB, latB]. A row
     can be drawn only when both endpoints carry coordinates, and a drawn arc is
     always exactly one of these rows — the globe has no other source of links. */
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
      if (A.peers[b]) return;                       // one row per pair; guard anyway
      A.peers[b] = 1; B.peers[a] = 1; A.deg++; B.deg++;
      g.links.push([a, b]);
    });
    return g;
  }

  /* Coarse globe buckets. They only spread the sample over the map (the card
     shows the API's real country/coordinate, never these labels). */
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

  /* Choose the nodes to draw: greedy on the real channel graph — the node that
     brings the most new real channels into the drawn set wins, while no 20° cell
     and no region gets crowded. Deterministic for a given channels-geo payload,
     which is what lets the offline snapshot reproduce the same globe. */
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
      if (dots[clusterKeyOf(n.lat, n.lon)]) return false;   // one dot per place on the globe
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

  /* How many channel arcs one dot may carry. Twenty dense nodes joined to each
     other make a spiderweb, so the globe keeps, per dot, only its strongest real
     channels — a cap, never an invented edge. */
  var LINK_PER_NODE = 5;

  /* Trim the real channels to LINK_PER_NODE arcs per dot. The dots with the fewest
     partners choose first, so a small node keeps its one or two real channels
     instead of being pushed out by a hub; inside a dot the strongest peer (highest
     real channels-geo degree) wins. Deterministic for a payload: pubkeys compare
     as plain strings, so the live path and the offline snapshot cut the same set. */
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

  /* Up to four real peers for the node card: the ones drawn on the globe first,
     then the node's other channels-geo peers by degree. Aliases as the API has them. */
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
    Globe.build();
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

        /* the sample was spread using the channels-geo coordinates; once the node
           detail arrives, two nodes can land in one 4° dot. Keep the stronger one,
           so every dot on the globe is exactly one node. */
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
      fees: S.fees, hr: S.hr, diff: S.diff, ln: S.ln, lnAt: S.lnAt, countries: S.countries
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
    return !!(c.tip || c.mem || c.ln);
  }

  /* ------------------------------------------------------------ websocket */
  var ws = null, wsTimer = null;

  function connectWS() {
    if (!('WebSocket' in window)) { S.ws = 'off'; paintStatus(); return; }
    try { ws = new WebSocket(WS_URL); } catch (e) { S.ws = 'off'; scheduleWS(); return; }
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

  function handleWS(m) {
    var touched = false;
    if (m.mempoolInfo) {
      S.mem = { count: m.mempoolInfo.size, vsize: m.mempoolInfo.bytes, totalFee: m.mempoolInfo.total_fee };
      touched = true;
    }
    if (m.fees) { S.fees = m.fees; touched = true; }
    if (m.da) { S.diff = m.da; touched = true; }
    if (m.blocks && m.blocks.length) {
      var list = m.blocks.slice(0, 8).map(mapBlock);
      var top = list[0].height;
      if (S.tip !== null && top > S.tip) blockEvent(top, list[0]);
      S.tip = Math.max(S.tip || 0, top);
      S.tipSeenAt = Date.now();
      S.blocks = list;
      touched = true;
    }
    if (m.transactions && m.transactions.length) {
      var add = m.transactions.map(function (t) {
        return { txid: t.txid, fee: t.fee, vsize: t.vsize, value: t.value, rate: num(t.rate) ? t.rate : (t.vsize ? t.fee / t.vsize : null) };
      });
      var seen = {};
      add.forEach(function (t) { seen[t.txid] = 1; });
      S.recent = add.concat(S.recent.filter(function (t) { return !seen[t.txid]; })).slice(0, 8);
      touched = true;
    }
    if (touched) { ok(); schedulePaint(); }
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
      sync.textContent = bad ? '연결 재시도 중' : (S.ws === 'open' ? '실시간 동기화' : '폴링 갱신');
      mark($('syncWrap'), 'warn', bad);
    }
  }

  function paintMetrics() {
    var nodes = S.ln && num(S.ln.node_count) ? S.ln.node_count : null;
    var h = hashParts(S.hr && S.hr.currentHashrate);

    txt('vNodes', nodes === null ? '—' : fmtInt(nodes));
    txt('vHeight', S.tip === null ? '—' : fmtInt(S.tip));
    var hEl = $('vHash');
    if (hEl) {
      var want = h.u ? h.v : '—';
      if (hEl.getAttribute('data-v') !== want + h.u) {
        hEl.setAttribute('data-v', want + h.u);
        hEl.innerHTML = esc(want) + (h.u ? '<span class="u">' + esc(h.u) + '</span>' : '');
      }
    }
    [['mNodes', nodes], ['mHeight', S.tip], ['mHash', h.u ? 1 : null]].forEach(function (p) {
      var el = $(p[0]);
      if (!el) return;
      mark(el, 'pending', p[1] === null);
      mark(el, 'stale', p[1] !== null && stale());
    });

    // mempool strip
    var sMem = $('sMem'), sFee = $('sFee');
    var memTxt = '—';
    if (S.mem && num(S.mem.vsize)) {
      memTxt = (S.mem.vsize / 1e6).toFixed(1) + ' MB · ' + fmtInt(S.mem.count) + ' TX';
    }
    if (sMem) sMem.textContent = memTxt;
    if (sFee) sFee.textContent = S.fees && num(S.fees.fastestFee) ? (Math.round(S.fees.fastestFee * 10) / 10) + ' sat/vB' : '—';
  }

  function paintPanel() {
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
      (avg.u ? '<small>1주 평균 ' + esc(avg.v) + ' ' + esc(avg.u) + '</small>' : '');

    var pm = $('pMem');
    if (pm) {
      pm.innerHTML = S.mem && num(S.mem.vsize)
        ? esc((S.mem.vsize / 1e6).toFixed(1)) + '<span class="u">MB</span><small>' + fmtInt(S.mem.count) + ' TX · ' + (num(S.mem.totalFee) ? S.mem.totalFee.toFixed(4) : '—') + ' BTC fee</small>'
        : '—';
    }
    var pf = $('pFee');
    if (pf) {
      pf.innerHTML = S.fees && num(S.fees.fastestFee)
        ? esc(String(Math.round(S.fees.fastestFee * 10) / 10)) + '<span class="u">sat/vB</span><small>30분 ' + esc(String(Math.round(S.fees.halfHourFee * 10) / 10)) + ' · 1시간 ' + esc(String(Math.round(S.fees.hourFee * 10) / 10)) + '</small>'
        : '—';
    }
    var pd = $('pDiff');
    if (pd) {
      if (S.diff && num(S.diff.difficultyChange)) {
        var sign = S.diff.difficultyChange >= 0 ? '+' : '';
        pd.innerHTML = esc(sign + S.diff.difficultyChange.toFixed(2)) + '<span class="u">%</span><small>' +
          fmtInt(S.diff.remainingBlocks) + ' 블록 남음 · ' + dateOf(S.diff.estimatedRetargetDate).slice(0, 10) + '</small>';
      } else pd.textContent = '—';
    }
    var pl = $('pLN');
    if (pl) {
      pl.innerHTML = S.ln && num(S.ln.node_count)
        ? fmtInt(S.ln.node_count) + '<small>기준 ' + dateOf(S.ln.added).slice(0, 10) + ' · mempool.space</small>'
        : '—';
    }
    var pl2 = $('pLNCap');
    if (pl2) {
      pl2.innerHTML = S.ln && num(S.ln.channel_count)
        ? fmtInt(S.ln.channel_count) + '<span class="u">ch</span><small>' + fmtBtcCap(S.ln.total_capacity) + ' BTC</small>'
        : '—';
    }

    paintDist();
    if (noteDirty) { paintNote(); noteDirty = false; }
    if (S.tab === 'blocks') paintBlocks(); else paintTxs();
  }

  function paintDist() {
    var box = $('dist');
    if (!box) return;
    if (!S.conts) { setHTML('dist', '<div class="dist"><div class="dist-top"><span class="k">집계 중…</span></div></div>'); txt('distTotal', ''); return; }
    var arr = CONT_ORDER.map(function (k) { return { k: k, n: S.conts.count[k] || 0, cap: S.conts.capacity[k] || 0 }; })
      .filter(function (d) { return d.n > 0 || d.k !== 'OT'; });
    var max = 0, total = S.conts.total;
    arr.forEach(function (d) { if (d.n > max) max = d.n; });
    var out = '';
    arr.forEach(function (d) {
      var pct = total ? (d.n / total * 100) : 0;
      var w = max ? (d.n / max * 100) : 0;
      out += '<div class="dist"><div class="dist-top"><span class="k">' + esc(CONT_KO[d.k]) + '</span>' +
        '<span class="v"><b>' + fmtInt(d.n) + '</b><span>' + pct.toFixed(1) + '%</span></span></div>' +
        '<div class="bar"><i style="width:' + Math.max(1.5, w).toFixed(1) + '%"></i></div></div>';
    });
    setHTML('dist', out);
    txt('distTotal', fmtInt(total) + ' · ' + S.countries.length + '개국');
  }

  function fmtBtcCap(sats) {
    if (!num(sats)) return '—';
    var b = sats / 1e8;
    var s = (b >= 100 ? b.toFixed(1) : b >= 1 ? b.toFixed(2) : b.toFixed(4));
    var parts = s.split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return parts.join('.');
  }

  function paintNote() {
    var src = S.nodeSrc === 'live' ? '실시간 조회' : S.nodeSrc === 'cache' ? '저장된 목록' : S.nodeSrc === 'seed' ? '내장 스냅샷(오프라인)' : '—';
    var arcs = Globe.state.links.length;
    var e = $('note');
    if (!e) return;
    e.innerHTML =
      '<b>DATA</b> 블록·멤풀·수수료·해시레이트·난이도·라이트닝 통계는 mempool.space REST + WebSocket 응답값입니다.<br>' +
      '· 지구본 노드 ' + (S.nodes.length || 0) + '개 · ' + esc(src) + ' — <code>lightning/channels-geo</code>의 실제 채널 그래프에서 연결이 많은 순으로, 같은 좌표 격자와 권역이 겹치지 않게 고른 표본입니다. 좌표·국가·별칭은 각 노드의 <code>nodes/{pubkey}</code> 응답값입니다.<br>' +
      '· 노드 사이의 호 ' + arcs + '개는 <b>모두 실제 공개 라이트닝 채널</b>입니다 — <code>lightning/channels-geo</code>(' + fmtInt(S.chanRows) + '개 채널' + (S.chanAt ? ' · ' + dateOf(S.chanAt).slice(0, 16) + ' 조회' : '') + ')에 실린 채널 중 두 끝점이 모두 지구본에 있는 것만 그렸고, 근접·임의로 이은 선은 없습니다.' +
      (S.nodeSrc === 'seed' ? ' 지금은 내장 스냅샷(2026-11-16 캡처)의 실제 채널 ' + arcs + '개를 쓰는 오프라인 상태입니다.' : '') + '<br>' +
      '· channels-geo는 두 끝점의 위치를 아는 채널만 담으므로, 노드 카드의 전체 채널 수보다 지구본에 그려지는 호가 적습니다.<br>' +
      '· 대륙 분포는 <code>lightning/nodes/countries</code>의 국가별 실측값을 대륙으로 묶은 값입니다.<br>' +
      '· <b>Bitnodes</b>(bitnodes.io → btcnodes.io) 스냅샷은 2026-11-16 확인 결과 <code>Access-Control-Allow-Origin</code> 헤더가 없어 브라우저에서 직접 호출할 수 없었습니다(CORS 미허용). 따라서 풀노드 수·대륙 분포는 Bitnodes 값이 아니라 Mempool.space 라이트닝 데이터이며, Bitnodes를 출처로 표기하지 않습니다.<br>' +
      '· API가 주지 않는 지연시간·가동시간·디스크 용량·개별 노드 체인 높이는 표시하지 않습니다.';
  }

  function paintBlocks() {
    var box = $('listBlocks');
    if (!box || !S.blocks.length) { if (box) box.innerHTML = '<div class="item"><div class="l2">불러오는 중…</div></div>'; return; }
    var out = '';
    S.blocks.forEach(function (b) {
      var elapsed = b.time ? durSec(Date.now() / 1000 - b.time) : '—';
      out += '<div class="item"><div class="l1"><span>#' + fmtInt(b.height) + '</span><span class="r">' + fmtInt(b.txs) + ' tx</span></div>' +
        '<div class="l2"><span>' + fmtFixed(b.size / 1e6, 2) + ' MB · ' + esc(elapsed) + ' 전' + (b.pool ? ' · ' + esc(b.pool) : '') + '</span>' +
        '<span>' + (b.medianFee != null ? fmtFixed(b.medianFee, 2) + ' sat/vB' : '') + '</span></div>' +
        '<div class="hash">' + esc(shortHash(b.id, 22, 6)) + '</div></div>';
    });
    setHTML('listBlocks', out);
  }

  function paintTxs() {
    var box = $('listTxs');
    if (!box || !S.recent.length) { if (box) box.innerHTML = '<div class="item"><div class="l2">불러오는 중…</div></div>'; return; }
    var out = '';
    S.recent.forEach(function (t) {
      var rate = num(t.rate) ? t.rate : (t.vsize ? t.fee / t.vsize : null);
      out += '<div class="item"><div class="l1"><span>' + fmtBtc(t.value) + ' <span style="color:#5d84bd">BTC</span></span>' +
        '<span class="r">' + (rate != null ? fmtFixed(rate, rate < 10 ? 2 : 1) : '—') + ' sat/vB</span></div>' +
        '<div class="l2"><span>' + fmtFixed(t.vsize, 0) + ' vB · ' + fmtInt(t.fee) + ' sats</span><span>' + esc(shortHash(t.txid, 8, 4)) + '</span></div></div>';
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
    var m = 'NEW BLOCK · ' + fmtInt(height) + (block && num(block.txs) ? ' · ' + fmtInt(block.txs) + ' tx' : '');
    toast(m);
  }

  /* ---------------------------------------------------------------- globe */
  var Globe = (function () {
    var G = {
      cv: null, ctx: null, w: 0, h: 0, dpr: 1, cx: 0, cy: 0, R: 0,
      yaw: -0.35, pitch: 0.36, zoom: 1, zoomT: 1, vYaw: 0,
      spin: 0.045, spinEase: 1, hold: false,
      dragging: false, lastTouch: 0, clusters: [], links: [], arcs: [], flash: 0, ripples: [],
      rings: [], grats: [], raf: 0, lastTs: 0, hit: null,
      /* caches: static layers are drawn once per resize, never per frame */
      bg: null, ball: null, ballSize: 0, glow: null,
      slow: false, ft: 0.016, miss: 0, age: 0, goodMs: 0, stepAt: 0, prevScale: 1, lockScale: 0,
      hide: {}, adaptive: true, resScale: 1, forceFull: false,
      /* per-frame scratch, reused so a frame allocates nothing */
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
      G.dpr = Math.min(2, window.devicePixelRatio || 1);   // cap at 2x: 3x phones were the bottleneck
      G.w = w; G.h = h;
      if (!G.cv) G.cv = $('globe');
      if (!G.cv) return;
      applyRes();
      layout();
      buildBackground();
      buildBall();
    }

    /* Backing-store size = css size x dpr x resScale. Lowering resScale is the
       cheapest way to buy frames on a weak device: same drawing code, fewer pixels. */
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
      var sub = document.querySelector('.subrow');
      var hud = document.querySelector('.hud');
      var topH = (head ? head.offsetHeight : 56) + (sub ? sub.offsetHeight : 18) + 16;
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

    /* Stars and the space wash never move: paint them once per resize into an
       offscreen canvas and blit it each frame (one drawImage instead of ~200 fills). */
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
        c.fillStyle = i % 11 === 0 ? '#9fd0ff' : '#cfe4ff';
        if (big) { c.beginPath(); c.arc(x, y, r * 0.7, 0, TAU); c.fill(); }
        else c.fillRect(x, y, r, r);
      }
      c.globalAlpha = 1;
      G.bg = cv;
      buildGlow();
    }

    /* A single soft dot, reused for every node halo and every channel packet. */
    function buildGlow() {
      var size = 64;
      var cv = document.createElement('canvas');
      cv.width = cv.height = size;
      var c = cv.getContext('2d');
      var grd = c.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      grd.addColorStop(0, 'rgba(226,246,255,0.95)');
      grd.addColorStop(0.16, 'rgba(140,215,255,0.60)');
      grd.addColorStop(0.42, 'rgba(56,165,255,0.20)');
      grd.addColorStop(0.70, 'rgba(56,150,255,0.055)');
      grd.addColorStop(1, 'rgba(56,150,255,0)');
      c.fillStyle = grd;
      c.fillRect(0, 0, size, size);
      G.glow = cv;
    }

    /* The globe body, its shading, fresnel rim and atmosphere are static apart
       from the radius, so they are baked once and blitted (scaled) each frame. */
    function buildBall() {
      var R = Math.max(40, G.R);
      var pad = 1.30, s = Math.ceil(R * 2 * pad);
      var cv = document.createElement('canvas');
      cv.width = Math.ceil(s * G.dpr);
      cv.height = Math.ceil(s * G.dpr);
      var c = cv.getContext('2d');
      c.setTransform(G.dpr, 0, 0, G.dpr, 0, 0);
      var cx = s / 2, cy = s / 2;

      var body = c.createRadialGradient(cx - R * 0.40, cy - R * 0.46, R * 0.04, cx, cy, R * 1.04);
      body.addColorStop(0, 'rgba(20,46,96,0.52)');
      body.addColorStop(0.30, 'rgba(10,26,58,0.66)');
      body.addColorStop(0.66, 'rgba(6,16,38,0.82)');
      body.addColorStop(0.90, 'rgba(3,9,22,0.92)');
      body.addColorStop(1, 'rgba(2,6,16,0.96)');
      c.beginPath(); c.arc(cx, cy, R, 0, TAU); c.fillStyle = body; c.fill();

      var rim = c.createRadialGradient(cx, cy, R * 0.52, cx, cy, R);
      rim.addColorStop(0, 'rgba(4,10,22,0)');
      rim.addColorStop(0.70, 'rgba(3,9,22,0.14)');
      rim.addColorStop(0.92, 'rgba(6,22,48,0.30)');
      rim.addColorStop(0.978, 'rgba(38,140,225,0.20)');
      rim.addColorStop(1, 'rgba(125,211,252,0.12)');
      c.beginPath(); c.arc(cx, cy, R, 0, TAU); c.fillStyle = rim; c.fill();

      /* The atmosphere is a ring, not a disc: a radial gradient filled over a whole
         circle repeats its inner stop across the globe and washes the sphere out. */
      c.globalCompositeOperation = 'lighter';
      var at1 = c.createRadialGradient(cx, cy, R * 0.99, cx, cy, R * 1.075);
      at1.addColorStop(0, 'rgba(150,215,255,0.40)');
      at1.addColorStop(0.35, 'rgba(56,170,255,0.13)');
      at1.addColorStop(1, 'rgba(56,150,255,0)');
      c.beginPath();
      c.arc(cx, cy, R * 1.075, 0, TAU);
      c.arc(cx, cy, R * 0.99, 0, TAU, true);
      c.fillStyle = at1; c.fill();

      var at2 = c.createRadialGradient(cx, cy, R, cx, cy, R * 1.28);
      at2.addColorStop(0, 'rgba(56,145,255,0.10)');
      at2.addColorStop(0.45, 'rgba(40,110,220,0.04)');
      at2.addColorStop(1, 'rgba(40,110,220,0)');
      c.beginPath();
      c.arc(cx, cy, R * 1.28, 0, TAU);
      c.arc(cx, cy, R, 0, TAU, true);
      c.fillStyle = at2; c.fill();

      var hi = c.createRadialGradient(cx - R * 0.42, cy - R * 0.48, 0, cx - R * 0.42, cy - R * 0.48, R * 0.58);
      hi.addColorStop(0, 'rgba(150,210,255,0.055)');
      hi.addColorStop(1, 'rgba(160,220,255,0)');
      c.beginPath(); c.arc(cx, cy, R, 0, TAU); c.fillStyle = hi; c.fill();
      c.globalCompositeOperation = 'source-over';

      c.beginPath(); c.arc(cx, cy, R, 0, TAU);
      c.strokeStyle = 'rgba(140,214,255,0.44)'; c.lineWidth = 1.05; c.stroke();
      c.beginPath(); c.arc(cx, cy, R - 1.2, 0, TAU);
      c.strokeStyle = 'rgba(56,189,248,0.12)'; c.lineWidth = 2.4; c.stroke();

      G.ball = cv;
      G.ballSize = s;
    }

    function project(lat, lon, o) {
      /* G.yaw is radians, lon is degrees: rotate in radians, once. This is the
         same rotation projectRing/projectArc apply (x = cl·sin(lo−yaw)), so a
         node, its continent and its arc endpoints land on one another. */
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

    /* ---- land / graticule ----------------------------------------------------
       Each ring's trigonometry is baked once (cos/sin of lat and lon), so a frame
       only multiplies — no trig per point. Every ring is projected exactly once
       per frame into its own cached arrays, then the layer's subpaths are batched
       into ONE path, so a whole layer costs a handful of draw calls. */
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
        /* camera-space offsets are kept so the fill can clip the ring in true 3D */
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

    /* add one side's runs of a projected ring to the current path */
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
    /* Fill a ring clipped by the limb. Every run of front vertices becomes its own
       closed shape: the coastline itself, closed back along the limb between the two
       z = 0 crossings that bound the run. So the land inside the limb is filled and
       nothing else — a hidden stretch can never be closed by a chord across the disc
       (which would flood the ocean), and no vertex is ever pulled to the limb (which
       would let the winding flip). Each piece keeps the ring's own direction. */
    function fillRing(r, ctx) {
      var n = r.n, zs = r.zs, ox = r.ox, oy = r.oy, cam = G.cam;
      var cx = cam.cx, cy = cam.cy, k, front = 0, start = -1;
      for (k = 0; k < n; k++) {
        if (zs[k] >= 0) {
          front++;
          if (start < 0 && zs[(k + n - 1) % n] < 0) start = k;   /* a run begins exactly here */
        }
      }
      if (!front) return false;                                  /* whole ring behind the globe */
      if (start < 0) {                                           /* nothing hidden: the ring as it is */
        ctx.moveTo(cx + ox[0], cy + oy[0]);
        for (k = 1; k < n; k++) ctx.lineTo(cx + ox[k], cy + oy[k]);
        ctx.closePath();
        return true;
      }
      var t = 0, sx, sy;
      while (t < n) {
        while (t < n && zs[(start + t) % n] < 0) t++;            /* skip the hidden stretch */
        if (t >= n) break;
        sx = 0; sy = 0;
        var i0 = (start + t) % n;
        while (t < n && zs[(start + t) % n] >= 0) {              /* one visible run */
          var ii = (start + t) % n;
          sx += ox[ii]; sy += oy[ii];
          t++;
        }
        fillRun(r, ctx, i0, (start + t - 1) % n, sx, sy);
      }
      return true;
    }

    /* one visible run: its coastline, then the limb between its exit and its entry
       crossing, on the side the run's own vertices sit on */
    function fillRun(r, ctx, i0, i1, sx, sy) {
      var n = r.n, ox = r.ox, oy = r.oy, zs = r.zs, cam = G.cam;
      var cx = cam.cx, cy = cam.cy, R = cam.R, i;
      var b = (i0 + n - 1) % n, a = (i1 + 1) % n;
      var e = crossing(ox[b], oy[b], zs[b], ox[i0], oy[i0], zs[i0]);     /* entry, on the limb */
      var x = crossing(ox[i1], oy[i1], zs[i1], ox[a], oy[a], zs[a]);     /* exit, on the limb */
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

    /* where an edge between two projected vertices passes z = 0 */
    function crossing(x0, y0, z0, x1, y1, z1) {
      var t = z0 / (z0 - z1);
      if (!(t >= 0)) t = 0; else if (t > 1) t = 1;
      return [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t];
    }

    /* smallest angle between two directions */
    function angTo(p, q) { return Math.abs((((p - q) % TAU) + TAU + Math.PI) % TAU - Math.PI); }

    function emit(a, b, ctx, xs, ys, close) {
      ctx.moveTo(xs[a], ys[a]);
      for (var j = a + 1; j <= b; j++) ctx.lineTo(xs[j], ys[j]);
      if (close) ctx.closePath();
    }

    function drawGraticule() {
      var cam = G.cam, ctx = G.ctx, i, r, list = G.gratsP, anyFront = false, anyBack = false;
      for (i = 0; i < list.length; i++) projectRing(list[i], cam);

      if (!G.slow) {
        ctx.beginPath();
        for (i = 0; i < list.length; i++) {
          r = list[i];
          if (r.max <= 0) continue;
          if (runPath(r, ctx, false, false)) anyBack = true;
        }
        if (anyBack) { ctx.strokeStyle = 'rgba(56,110,190,0.032)'; ctx.lineWidth = 0.6; ctx.stroke(); }
      }

      ctx.beginPath();
      for (i = 0; i < list.length; i++) {
        r = list[i];
        if (r.max <= 0) continue;
        if (runPath(r, ctx, true, false)) anyFront = true;
      }
      if (anyFront) { ctx.strokeStyle = 'rgba(76,140,225,0.09)'; ctx.lineWidth = 0.6; ctx.stroke(); }

      /* the equator reads a touch brighter than the rest of the grid */
      var eq = list[list.length - 3];
      if (eq && eq.max > 0) {
        ctx.beginPath();
        if (runPath(eq, ctx, true, false)) {
          ctx.strokeStyle = 'rgba(90,164,244,0.15)'; ctx.lineWidth = 0.8; ctx.stroke();
        }
      }
    }

    function drawLand() {
      var cam = G.cam, ctx = G.ctx, i, r, list = G.ringsP, anyFill = false, anyLine = false;
      for (i = 0; i < list.length; i++) projectRing(list[i], cam);

      /* No far-side coastline pass: a coast on the hidden hemisphere stays hidden,
         exactly like the channels behind it, so the globe reads as a solid body. */

      /* near side body: all continents in one fill (dropped first when frames run long) */
      if (!G.slow && !G.hide.landFill) {
        ctx.beginPath();
        for (i = 0; i < list.length; i++) {
          r = list[i];
          if (r.max <= 0) continue;
          if (fillRing(r, ctx)) anyFill = true;
        }
        if (anyFill) { ctx.fillStyle = 'rgba(37,99,235,0.14)'; ctx.fill(); }
      }

      /* near side coastline: wide dim stroke + thin bright stroke, same path */
      ctx.beginPath();
      for (i = 0; i < list.length; i++) {
        r = list[i];
        if (r.max <= 0) continue;
        if (runPath(r, ctx, true, false)) anyLine = true;
      }
      if (anyLine && !G.hide.landStroke) {
        if (!G.slow && !G.hide.landGlow) {
          ctx.strokeStyle = 'rgba(56,160,250,0.18)'; ctx.lineWidth = 2.2; ctx.stroke();
        }
        ctx.strokeStyle = 'rgba(150,214,255,0.5)'; ctx.lineWidth = 0.8; ctx.stroke();
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

    /* Each channel arc is one real channels-geo row, so its great-circle path is
       fixed at build time (trig baked in) and only re-projected each frame. */
    function buildArcs() {
      var cs = G.clusters, out = [], i;
      for (i = 0; i < G.links.length; i++) {
        var a = cs[G.links[i][0]], b = cs[G.links[i][1]];
        if (!a || !b) continue;
        /* segments scale with the arc's length: short hub-to-hub links need far
           fewer samples than a transatlantic one, and stay just as smooth */
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
      var ctx = G.ctx, cam = G.cam, boost = G.flash, arcs = G.arcs, glow = G.glow;
      var frontA = 0.33 + 0.30 * boost;
      var bands = G.slow ? 2 : 3;
      var i, arc, k, n;

      /* project every channel once per frame; nothing is projected twice */
      for (i = 0; i < arcs.length; i++) projectArc(arcs[i], cam);

      /* The far hemisphere is never drawn: a channel behind the globe stays behind
         it, so the body reads as one solid ball instead of a wire cage. Only
         segments whose midpoint has z > 0 reach the canvas. */

      /* near side: depth bands batched across every arc — a handful of strokes
         for the whole network instead of one per channel */
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
        ctx.strokeStyle = 'rgba(110,190,255,' + (frontA * a).toFixed(3) + ')';
        ctx.lineWidth = 0.75;
        ctx.stroke();
      }

      /* soft bloom, only on the brightest band, still one stroke for all arcs */
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
        ctx.strokeStyle = 'rgba(80,165,255,' + (0.035 + 0.05 * boost).toFixed(3) + ')';
        ctx.lineWidth = 2.4;
        ctx.stroke();
      }

      /* light packets: sprite blits, positions from the frame timestamp */
      if (!glow || G.hide.packets) return;
      eachPacket(t, function (x, y, size, alpha) {
        ctx.globalAlpha = alpha;
        ctx.drawImage(glow, x - size / 2, y - size / 2, size, size);
      });
      ctx.globalAlpha = 1;
    }

    /* Every light packet on the globe at time t: the head and its two tail dots.
       Each position is interpolated between the two neighbouring arc vertices, so the
       packet glides at frame rate instead of snapping from vertex to vertex. */
    function eachPacket(t, fn) {
      var arcs = G.arcs, phase = t * 0.085, boost = G.flash, i, q;
      var skip = G.slow ? 2 : 1;   /* every arc carries a packet; long frames take every other */
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
      var ctx = G.ctx, glow = G.glow;
      for (var i = 0; i < G.clusters.length; i++) {
        var c = G.clusters[i];
        project(c.lat, c.lon, P);
        c.sx = P.x; c.sy = P.y; c.on = P.z > 0.02;
        if (!c.on) continue;
        var edge = Math.min(1, P.z * 4);
        var r = 1.15 + Math.min(0.95, Math.log(1 + c.channels) / 8) + (c.count > 1 ? 0.3 : 0);
        var pulse = 0.70 + 0.30 * Math.sin(t * 1.5 + i);

        if (glow) {
          var gs = r * 7.5;
          ctx.globalAlpha = Math.min(1, (0.42 + 0.26 * pulse) * edge + 0.35 * G.flash);
          ctx.drawImage(glow, P.x - gs / 2, P.y - gs / 2, gs, gs);
          ctx.globalAlpha = 1;
        }

        ctx.beginPath(); ctx.arc(P.x, P.y, r, 0, TAU);
        ctx.fillStyle = 'rgba(226,246,255,' + (0.95 * edge).toFixed(2) + ')';
        ctx.fill();

        var br = r * (1.9 + 0.30 * Math.sin(t * 1.9 + i));
        ctx.beginPath(); ctx.arc(P.x, P.y, br, 0, TAU);
        ctx.strokeStyle = 'rgba(120,205,255,' + (0.18 * edge * pulse).toFixed(2) + ')';
        ctx.lineWidth = 0.6; ctx.stroke();

        if (c.count > 1) {
          ctx.beginPath(); ctx.arc(P.x, P.y, r + 2.4, 0, TAU);
          ctx.strokeStyle = 'rgba(120,200,255,' + (0.24 * edge).toFixed(2) + ')';
          ctx.lineWidth = 0.5; ctx.stroke();
        }
      }
    }

    function drawRipples(dt) {
      /* Expanding wave over the sphere surface: a small circle of growing angular
         radius around the point the camera looks at. */
      var ctx = G.ctx;
      var cLat = G.pitch * 180 / Math.PI, cLon = G.yaw * 180 / Math.PI;
      var la1 = cLat * DEG, cos1 = Math.cos(la1), sin1 = Math.sin(la1);
      for (var i = G.ripples.length - 1; i >= 0; i--) {
        var r = G.ripples[i];
        r.t += dt;
        if (r.t > 1.9) { G.ripples.splice(i, 1); continue; }
        var k = r.t / 1.9;
        var ang = 0.05 + k * 2.5;                       // angular radius in radians
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
        ctx.strokeStyle = 'rgba(130,210,255,' + alpha.toFixed(3) + ')';
        ctx.lineWidth = 1.5 * (1 - k) + 0.35;
        ctx.stroke();
        ctx.strokeStyle = 'rgba(80,160,255,' + (alpha * 0.35).toFixed(3) + ')';
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

      /* Adaptive quality. A missed vsync is exactly what makes the rotation and the
         light packets look like they jump, so the share of late frames is measured
         and work is shed in stages — cheaper passes first, then a lower backing-store
         resolution — until frames are steady again. */
      var r = Math.abs(raw);
      G.age += r;
      if (G.age > 1.2) {                                      // ignore the first moments of boot
        G.miss = G.miss * 0.94 + (r > 0.024 ? 1 : 0) * 0.06;  // share of frames missing vsync
        G.slow = G.forceFull ? false : G.miss > 0.30;         // drop the optional passes
      }
      if (G.adaptive) {
        if (G.lockScale) {
          if (G.resScale !== G.lockScale) setRes(G.lockScale);
        } else {
          if (G.miss > 0.55 && G.resScale > 0.5) setRes(0.5);
          else if (G.miss > 0.28 && G.resScale > 0.62) setRes(0.62);
          else if (G.miss > 0.10 && G.resScale > 0.75) setRes(0.75);
          if (G.miss < 0.02 && G.resScale < 1) {
            /* comfortably fast for a while: try giving the sharpness back */
            G.goodMs += r;
            if (G.goodMs > 6) {
              G.goodMs = 0;
              G.prevScale = G.resScale;
              G.stepAt = G.age;
              setRes(G.resScale < 0.62 ? 0.62 : G.resScale < 0.75 ? 0.75 : 1);
            }
          } else if (G.miss > 0.04) G.goodMs = 0;
          if (G.stepAt && G.age - G.stepAt < 3 && G.miss > 0.12) {
            /* that step did not hold: settle on the scale that did */
            G.lockScale = G.prevScale;
            G.stepAt = 0;
            setRes(G.prevScale);
          }
        }
      }

      /* slow continuous autorotation: drag or an open node card eases it to a
         stop, and letting go eases it back in — never a jump */
      var want = (!G.dragging && !pinch && !G.hold) ? 1 : 0;
      G.spinEase += (want - G.spinEase) * Math.min(1, dt * 2.0);
      if (!G.dragging && !pinch) {
        G.yaw += G.vYaw * (raw / 0.0167);      // inertia in real time, not in frames
        G.vYaw *= Math.pow(0.90, raw / 0.0167);
        G.yaw += G.spin * G.spinEase * Math.min(0.25, Math.abs(raw));
      }
      G.zoom += (G.zoomT - G.zoom) * 0.16;
      if (G.flash > 0) G.flash = Math.max(0, G.flash - dt * 0.9);

      /* one camera for the frame; every projection below reuses it */
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

    function build() {
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

      /* One drawn arc per real channel whose two endpoints are both on the globe.
         Nothing else is ever added here: no neighbour join, no filler edge. */
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

    function pulse() { G.flash = 1; G.ripples.push({ t: 0 }); }

    /* Verification-only: at a given camera angle, compare project() (used for
       nodes/ripples/cards) against the ring and arc projection used for the
       continents and channels. Any drift here means nodes float off their land. */
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

      /* 1. every sampled land/graticule vertex: project() vs projectRing() */
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

      /* 2. each drawn arc's two ends vs the two node dots it connects */
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

    /* ------- input ------- */
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
      relayout: function () { layout(); buildBall(); },
      setRes: setRes,
      hold: function (on) { G.hold = !!on; G.lastTouch = Date.now(); },
      state: G
    };
  })();

  /* ------------------------------------------------------------ node card */
  function showNodeCard(cluster) {
    var n = cluster.nodes[0];
    var many = cluster.nodes.length > 1;
    var continent = CONT_KO[contOf(n.iso)] || '기타';
    var place = [n.city, countryKo(n.iso, n.country)].filter(Boolean).join(' · ');
    var chainTipHash = null, chainTipHeight = S.tip;
    if (S.blocks && S.blocks.length) chainTipHash = S.blocks[0].id;

    var card = $('card');
    if (!card) return;
    var rows = [
      ['좌표', num(n.lat) && num(n.lon) ? n.lat.toFixed(4) + '°, ' + n.lon.toFixed(4) + '°' : '—'],
      ['국가', (countryKo(n.iso, n.country) || '—') + (n.iso ? ' (' + n.iso + ')' : '')],
      ['채널', num(n.channels) ? fmtInt(n.channels) + ' 개' + (n.channelsSrc === 'node' ? ' · 활성' : '') : '—'],
      ['용량', num(n.capacity) ? fmtBtcCap(n.capacity) + ' BTC' : '—'],
      ['지도 채널', num(n.deg) ? fmtInt(n.deg) + ' 개' : '—'],
      ['AS 조직', n.asOrg || '—'],
      ['소켓', n.sockets ? n.sockets + '개' + (n.tor ? ' · Tor 포함' : ' · 클리어넷') : '—'],
      ['최초 관측', dateOf(n.firstSeen)],
      ['최근 갱신', n.updatedAt ? dateOf(n.updatedAt) : '—']
    ];
    if (many) rows.push(['클러스터', cluster.count + '개 노드 · 채널 합계 ' + fmtInt(cluster.channels) + ' 개', true]);

    var htmlRows = rows.map(function (r) {
      return '<div class="cell' + (r[2] ? ' full' : '') + '"><dt>' + esc(r[0]) + '</dt><dd class="' + (r[1] === '—' ? 'na' : '') + '">' + esc(r[1]) + '</dd></div>';
    }).join('');

    var aliasList = many ? cluster.nodes.map(function (x) { return esc(x.alias); }).slice(0, 6).join(', ') : '';
    var peers = n.peers || [];
    var peerHTML = peers.length
      ? '<div class="peers"><div class="t">REAL CHANNELS · 실제 채널 상대</div><div class="p">' +
        peers.map(function (a) { return '<span class="peer">' + esc(a) + '</span>'; }).join('') +
        '</div><div class="v">이 지점의 실제 채널 ' + fmtInt(cluster.deg) + '개 중 ' + cluster.arcs + '개가 지구본에 그려졌습니다 · channels-geo</div></div>'
      : '';

    card.innerHTML =
      '<div class="card-head"><div>' +
      '<div class="kicker">NODE · ' + esc(continent) + '</div>' +
      '<h2>' + esc(n.alias) + '</h2>' +
      '<p class="place">' + esc(place || '위치 정보 없음') + '</p>' +
      '</div><button class="close" id="cardClose" aria-label="닫기">×</button></div>' +
      '<dl class="grid">' + htmlRows + '</dl>' +
      peerHTML +
      (aliasList ? '<div class="disc" style="margin-top:12px">같은 좌표 격자에 묶인 노드: ' + aliasList + (cluster.nodes.length > 6 ? ' 외 ' + (cluster.nodes.length - 6) + '개' : '') + '</div>' : '') +
      '<div class="tip"><div class="t">CHAIN TIP · 네트워크 공통 (mempool.space)</div>' +
      '<div class="h">' + esc(chainTipHash || '—') + '</div>' +
      '<div class="v">높이 ' + (chainTipHeight === null ? '—' : fmtInt(chainTipHeight)) + ' · ' + esc(S.nodeSrc === 'seed' ? '내장 스냅샷 노드' : ago(S.nodeAt)) + ' 기준 노드 목록</div></div>' +
      '<p class="disc"><b>표시 값은 mempool.space Lightning API 응답 그대로</b>입니다(별칭·국가·도시·좌표·채널·용량·AS·관측 시각). ' +
      '지연시간, 가동시간, 디스크 용량, 개별 노드의 동기화 높이처럼 API가 제공하지 않는 항목은 표시하지 않습니다. ' +
      'CHAIN TIP은 이 노드가 보고한 값이 아니라 네트워크 공통 현재 tip입니다. ' +
      '노드 사이의 호는 <code>lightning/channels-geo</code>에 실린 <b>실제 공개 채널</b>이며, 근접 추정으로 이은 선은 없습니다.</p>';

    $('modal').classList.add('on');
    Globe.hold(true);
    var cb = $('cardClose');
    if (cb) cb.addEventListener('click', closeNodeCard);
  }

  function closeNodeCard() {
    var m = $('modal');
    if (m) m.classList.remove('on');
    Globe.hold(false);          // autorotation eases back in
  }

  /* ------------------------------------------------------------------ boot */
  function refreshCore() {
    Promise.all([
      loadTip().catch(noop), loadBlocks().catch(noop), loadMem().catch(noop),
      loadRecentTxs().catch(noop), loadFees().catch(noop), loadHashrate().catch(noop),
      loadDiff().catch(noop)
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
        btn.setAttribute('aria-label', open ? '실시간 네트워크 패널 닫기' : '실시간 네트워크 패널 열기');
      }
      if (open) paintPanel();
    }
    if (btn) btn.addEventListener('click', function () { setPanel(!S.panelOpen); });
    var strip = $('strip');
    if (strip) strip.addEventListener('click', function () { setPanel(true); if (panel) panel.scrollTop = 0; });
    ['mNodes', 'mHeight', 'mHash'].forEach(function (id) {
      var el = $(id);
      if (el) el.addEventListener('click', function () { setPanel(true); });
    });
    var tabB = $('tabBlocks'), tabT = $('tabTxs');
    if (tabB) tabB.addEventListener('click', function () { setTab('blocks'); });
    if (tabT) tabT.addEventListener('click', function () { setTab('txs'); });
    var modal = $('modal');
    if (modal) modal.addEventListener('click', function (e) { if (e.target === modal) closeNodeCard(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeNodeCard(); });
  }

  function setTab(t) {
    S.tab = t;
    var on = t === 'blocks';
    mark($('tabBlocks'), 'on', on);
    mark($('tabTxs'), 'on', !on);
    mark($('listBlocks'), 'on', on);
    mark($('listTxs'), 'on', !on);
    if (on) paintBlocks(); else paintTxs();
  }

  function tickClock() {
    var d = new Date();
    txt('clock', pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ':' + pad2(d.getUTCSeconds()));
    var kst = new Date(d.getTime() + 9 * 3600 * 1000);
    txt('clockKst', 'KST ' + pad2(kst.getUTCHours()) + ':' + pad2(kst.getUTCMinutes()));
  }

  function boot() {
    var hadCache = restoreCache();
    Globe.init();
    bindUI();
    applySeed();                 // immediate, clearly-labelled fallback; replaced by live data
    tickClock();
    setInterval(tickClock, 1000);
    paint();
    if (hadCache) toast('저장된 마지막 데이터 표시 중 · 갱신 중');

    refreshCore();
    refreshSlow();
    refreshNodes(false);
    connectWS();

    // polling (always on; faster when the socket is not open)
    setInterval(function () { if (S.ws !== 'open') refreshCore(); }, 20000);
    setInterval(function () { if (S.ws === 'open') { loadTip().catch(noop); loadMem().catch(noop); } }, 90000);
    setInterval(function () { loadBlocks().catch(noop); loadRecentTxs().catch(noop); }, 60000);
    setInterval(function () { loadHashrate().catch(noop); loadDiff().catch(noop); }, 300000);
    setInterval(refreshSlow, 1800000);
    setInterval(function () { refreshNodes(false); }, 6 * 3600 * 1000);
    setInterval(function () { if (stale()) { refreshCore(); if (S.ws !== 'open') connectWS(); } }, 45000);
    setInterval(function () { paintStatus(); if (S.panelOpen) { paintBlocks(); paintTxs(); } }, 15000);

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
      conts: aggregateContinents
    };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
