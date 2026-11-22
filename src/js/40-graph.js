/* Lightning graph: channels-geo parsing, the topology-driven node pick, the real-channel
   cap and the saved node snapshot with its element-by-element validation. */

  /* ------------------------------------------------------------- nodes ---- */
  function toNum(v) {
    var x = typeof v === 'string' ? parseFloat(v) : v;
    return num(x) ? x : null;
  }

  function mergeRankings(conn, liq) {
    var by = Object.create(null);
    function put(n) {
      if (!n || !validPk(n.publicKey)) return;
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
    (isArr(conn) ? conn : []).forEach(put);
    (isArr(liq) ? liq : []).forEach(put);
    return Object.keys(by).map(function (k) { return by[k]; });
  }

  /* ---- real channel graph: mempool.space /api/v1/lightning/channels-geo ------- */
  /* A 33-byte compressed key as its 66 hex characters, checked by code point rather than
     by a regular expression: every row of channels-geo carries two of them and the payload
     holds thousands of rows, so the key test is the hottest check in the parse. Case is
     not significant here (mempool.space answers lower-case), as it was not for PK_RE. */
  function isPk(s) {
    if (typeof s !== 'string' || s.length !== 66) return false;
    for (var i = 0; i < 66; i++) {
      var c = s.charCodeAt(i);
      if (!((c >= 48 && c <= 57) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70))) return false;
    }
    return true;
  }

  /* One node of the graph. Its grid cell, region and cluster key depend only on its
     coordinates, so they are computed once here instead of for every candidate of every
     pick round (the pick used to build three strings per node per round). */
  function graphNode(pk, alias, lat, lon) {
    return {
      pk: pk,
      alias: (typeof alias === 'string' && alias) ? alias : pk.slice(0, 10),
      lat: lat, lon: lon, peers: Object.create(null), deg: 0,
      cell: cellOf(lat, lon), reg: regionOf(lat, lon), dot: clusterKeyOf(lat, lon)
    };
  }

  function graphFrom(rows) {
    var by = Object.create(null), keys = [], links = [], list = isArr(rows) ? rows : [];
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      if (!r || typeof r.length !== 'number' || r.length < 8) continue;
      var a = r[0], b = r[4];
      if (!isPk(a) || !isPk(b) || a === b) continue;
      var loa = toNum(r[2]), la = toNum(r[3]), lob = toNum(r[6]), lb = toNum(r[7]);
      if (la === null || loa === null || lb === null || lob === null) continue;
      if (la > 90 || la < -90 || lb > 90 || lb < -90 || loa > 180 || loa < -180 || lob > 180 || lob < -180) continue;
      var A = by[a], B = by[b];
      if (!A) { A = by[a] = graphNode(a, r[1], la, loa); keys.push(a); }
      if (!B) { B = by[b] = graphNode(b, r[5], lb, lob); keys.push(b); }
      if (A.peers[b]) continue;
      A.peers[b] = 1; B.peers[a] = 1; A.deg++; B.deg++;
      links.push([a, b]);
    }
    return { by: by, keys: keys, links: links };
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
    /* neig[k] is the number of already-picked nodes k really shares a channel with. Every
       pick touches only that node's own peers, so the count is kept incrementally: the old
       loop recounted it for every candidate of every round by walking that candidate's
       whole peer map (22 rounds × ~1 200 candidates × their degree). The picks and their
       order are exactly the same — a candidate is chosen by that count, then by degree,
       scanning the same order as before. */
    var neig = Object.create(null);
    var sel = [], inset = Object.create(null), cells = Object.create(null), regs = Object.create(null), dots = Object.create(null), relax = 0;
    function fits(n) {
      return !dots[n.dot] && (cells[n.cell] || 0) < CELL_CAP + relax && (regs[n.reg] || 0) < REGION_CAP + relax;
    }
    while (sel.length < MAX_NODES) {
      var best = null, bestV = -1, bestD = -1;
      for (var i = 0; i < order.length; i++) {
        var n = g.by[order[i]];
        if (inset[n.pk] || !fits(n)) continue;
        var v = neig[n.pk] || 0;
        if (v > bestV || (v === bestV && n.deg > bestD)) { best = n; bestV = v; bestD = n.deg; }
      }
      if (!best) { if (relax < 3) { relax++; continue; } break; }
      sel.push(best); inset[best.pk] = 1;
      for (var p in best.peers) { if (!inset[p]) neig[p] = (neig[p] || 0) + 1; }
      cells[best.cell] = (cells[best.cell] || 0) + 1;
      regs[best.reg] = (regs[best.reg] || 0) + 1;
      dots[best.dot] = 1;
    }
    return sel;
  }

  function linksAmong(g, picked) {
    var inset = Object.create(null), out = [];
    picked.forEach(function (n) { inset[n.pk] = 1; });
    for (var i = 0; i < picked.length; i++) {
      var n = picked[i];
      for (var p in n.peers) if (inset[p] && n.pk < p) out.push([n.pk, p]);
    }
    return out;
  }

  var LINK_PER_NODE = 5;

  function countKeys(o) { var c = 0; for (var k in o) c++; return c; }

  function capLinks(pairs, g) {
    var peers = Object.create(null), cnt = Object.create(null), used = Object.create(null), out = [], i, k, q;
    function add(x, y) {
      if (!g.by[x] || !g.by[y] || x === y) return;
      (peers[x] || (peers[x] = Object.create(null)))[y] = 1;
      (peers[y] || (peers[y] = Object.create(null)))[x] = 1;
    }
    for (i = 0; i < pairs.length; i++) add(pairs[i][0], pairs[i][1]);
    /* Each node's pair count is measured once. It used to be counted inside the sort
       comparator, which walked the peer map on every comparison. */
    var order = [], size = Object.create(null);
    for (k in peers) { order.push(k); size[k] = countKeys(peers[k]); }
    order.sort(function (x, y) {
      var d = size[x] - size[y];
      if (d) return d;
      return x < y ? -1 : 1;
    });
    function deg(k2) { return g.by[k2].deg || 0; }
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

  /* The saved node snapshot is rebuilt field by field, not merely accepted when its key
     and coordinate happen to be right. localStorage is writable by anything that ever ran
     on this origin and JSON.parse hands back whatever the string held, so a bare number in
     the nodes array, a string where the channel count belongs, an object in the alias, a
     boolean in the capacity or a two-character string in the links array all used to reach
     Globe.build(), the channel lookup and the detail card untouched — and the card printed
     "[object Object]" or "NaN". Nothing below is copied without being the type the paint
     path expects: a finite number where a figure is formatted, a string where a name is
     printed, a list of strings where peers are listed, a real boolean for Tor. */
  function textField(v, max) {
    return typeof v === 'string' ? v.slice(0, max || 120) : '';
  }
  /* A count or a timestamp: finite, not negative, and not larger than the field can mean.
     The default ceiling is above any millisecond timestamp (1.8e12 today); a capacity in
     satoshis is the one field that needs a wider one (2.1e15 is every bitcoin that exists). */
  function countField(v, max) {
    return num(v) && v >= 0 && v <= (max || 1e15) ? v : null;
  }
  function nodeFromCache(n) {
    if (!isObj(n) || !validPk(n.pk) || !num(n.lat) || !num(n.lon)) return null;
    if (!(n.lat >= -90 && n.lat <= 90 && n.lon >= -180 && n.lon <= 180)) return null;
    var peers = [];
    if (isArr(n.peers)) {
      for (var i = 0; i < n.peers.length && peers.length < 6; i++) {
        var p = n.peers[i];
        if (typeof p === 'string' && p) peers.push(p.slice(0, 64));
      }
    }
    return {
      pk: n.pk,
      alias: textField(n.alias) || n.pk.slice(0, 10),
      lat: n.lat, lon: n.lon,
      iso: textField(n.iso, 2).toUpperCase(),
      city: textField(n.city), country: textField(n.country), asOrg: textField(n.asOrg, 64),
      firstSeen: countField(n.firstSeen) || 0,
      updatedAt: countField(n.updatedAt) || 0,
      sockets: countField(n.sockets, 1e4) || 0,
      tor: n.tor === true,
      channels: countField(n.channels),
      channelsSrc: n.channelsSrc === 'ranking' || n.channelsSrc === 'node' ? n.channelsSrc : '',
      capacity: countField(n.capacity, 1e16),
      deg: countField(n.deg, 1e6) || 0,
      peers: peers,
      tag: n.tag === 'seed' || n.tag === 'live' || n.tag === 'cache' ? n.tag : 'cache'
    };
  }
  /* A link is a pair of real node keys, not merely two strings. */
  function linkFromCache(l) {
    return isArr(l) && l.length === 2 && validPk(l[0]) && validPk(l[1]) && l[0] !== l[1] ? l : null;
  }
  /* A cached node-detail entry is read for exactly the fields a live answer fills. An
     entry without usable coordinates is dropped: every one of those fields is merged into
     a plotted node, so half an entry is worse than none. */
  function geoFromCache(v) {
    if (!isObj(v) || !num(v.lat) || !num(v.lon)) return null;
    if (!(v.lat >= -90 && v.lat <= 90 && v.lon >= -180 && v.lon <= 180)) return null;
    return {
      alias: textField(v.alias), lat: v.lat, lon: v.lon,
      city: textField(v.city), country: textField(v.country), iso: textField(v.iso, 2).toUpperCase(),
      asOrg: textField(v.asOrg, 64),
      firstSeen: countField(v.firstSeen) || 0, updatedAt: countField(v.updatedAt) || 0,
      sockets: countField(v.sockets, 1e4) || 0, tor: v.tor === true,
      ch: countField(v.ch, 1e6), cap: countField(v.cap, 1e16), t: countField(v.t) || 0
    };
  }
  function cachedNodeGraph(stored) {
    var c = isObj(stored) ? stored : {};
    var geo = null;
    if (isObj(c.geo)) {
      geo = Object.create(null);
      Object.keys(c.geo).forEach(function (k) {
        if (!validPk(k)) return;
        var v = geoFromCache(c.geo[k]);
        /* a real detail object only: nothing here is ever written as null, and a null
           left by an older build carries nothing */
        if (v) geo[k] = v;
      });
    }
    return {
      nodes: isArr(c.nodes) ? c.nodes.map(nodeFromCache).filter(Boolean) : [],
      links: isArr(c.links) ? c.links.map(linkFromCache).filter(Boolean) : [],
      rows: countField(c.rows, 1e8) || 0,
      at: countField(c.t) || 0,
      chanAt: countField(c.chanAt) || (countField(c.t) || 0),
      geo: geo
    };
  }

  function refreshNodes(force) {
    /* localStorage is writable by anything that ever ran on this origin and JSON.parse
       returns whatever the string held, so the snapshot is only used after each field is
       checked for the shape this code walks. */
    var stored = recall(LS_NODES);
    var cache = cachedNodeGraph(stored);
    var now = Date.now();
    var cacheAt = cache.at;
    var cacheChanAt = cache.chanAt;
    if (!force && cache.nodes.length && cache.links.length &&
      (now - cacheAt) < NODE_TTL) {
      /* A fresh snapshot is the whole answer: it is drawn, and the channel graph behind
         it is less than six hours old. The old code drew it and then fetched
         channels-geo, both rankings and every node detail again on every boot, so a
         restart re-downloaded a 1.5 MB payload it already had. */
      applyNodes(cache.nodes, cache.links, 'live', cacheAt, { rows: cache.rows, at: cacheChanAt });
      return Promise.resolve();
    }
    /* cachedNodeGraph() has already re-typed every entry it kept. */
    var geoCache = cache.geo || Object.create(null);

    return Promise.all([
      request(CH_PATH),
      request('/api/v1/lightning/nodes/rankings/connectivity').catch(noop),
      request('/api/v1/lightning/nodes/rankings/liquidity').catch(noop)
    ]).then(function (res) {
      var rows = res[0];
      if (!isArr(rows) || !rows.length) throw new Error('empty channels-geo');
      var g = graphFrom(rows);
      var picked = pickChannelNodes(g);
      if (!picked.length) throw new Error('no node with channels');

      var inset = Object.create(null);
      picked.forEach(function (n) { inset[n.pk] = 1; });
      var links = linksAmong(g, picked);
      var rank = Object.create(null);
      mergeRankings(res[1] || [], res[2] || []).forEach(function (r) { rank[r.pk] = r; });

      var jobs = picked.map(function (n) {
        var path = pkPath(n.pk);
        if (!path) return function () { return Promise.resolve(); };
        var hit = geoCache[n.pk];
        if (hit && num(hit.lat) && (now - (hit.t || 0)) < NODE_TTL) return function () { return Promise.resolve(); };
        return function () {
          return request('/api/v1/lightning/nodes/' + path).then(function (d) {
            if (!isObj(d)) throw new Error('bad node');
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
          }).catch(function () {
            /* A failed detail fetch keeps whatever the snapshot already held for this
               node. Storing null here — as this line used to — erased an alias, city,
               country and AS the map had just shown, and wrote that null back into the
               saved snapshot. The kept entry is stale (old t), so the next refresh
               fetches it again. */
          });
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

        var seenDot = Object.create(null), kept = [];
        nodes.forEach(function (nd) {
          var k = clusterKeyOf(nd.lat, nd.lon);
          var prev = seenDot[k];
          if (prev === undefined) { seenDot[k] = kept.length; kept.push(nd); return; }
          if ((nd.deg || 0) > (kept[prev].deg || 0)) kept[prev] = nd;
        });
        nodes = kept;
        if (!nodes.length) throw new Error('no node');

        inset = Object.create(null);
        var keptGraph = nodes.map(function (nd) { inset[nd.pk] = 1; return g.by[nd.pk]; });
        links = capLinks(linksAmong(g, keptGraph), g);
        nodes.forEach(function (nd) {
          nd.peers = peersOf(g, g.by[nd.pk], inset);
        });

        applyNodes(nodes, links, 'live', now, { rows: rows.length, at: now });
        store(LS_NODES, { t: now, geo: geoCache, nodes: nodes, links: links, rows: rows.length, chanAt: now });
      });
    }).catch(function () {
      var cached = cachedNodeGraph(recall(LS_NODES));
      if (cached.nodes.length) {
        applyNodes(cached.nodes, cached.links, 'cache', cached.at,
          { rows: cached.rows, at: cached.chanAt });
      } else if (!S.nodes.length) {
        applySeed();
      }
    });
  }

