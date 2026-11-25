/* Bitcoin L1: the Bitnodes answer, what it may claim about itself (live, cache or
   snapshot, and why), the transport split, client versions, and the build-time country
   table the crawler only publishes page by page. */

  /* --------------------------------------------------------------- L1 data */
  /* Bitnodes carries two light endpoints with everything the app shows live:
       ?field=coordinates  total_nodes, latest_height, unique lat/lon pairs
       ?field=top          top ASNs (TOR/I2P are listed here too) and client versions
     The per-node country counts come from the bundled fetch_l1.py snapshot; the
     panel says so and stamps it with the capture date. */
  /* A transport split is drawn only when all three figures are finite, non-negative
     counts: the panel prints them as integers, and a string from a proxy or a rewritten
     answer would print TOR NaN and a clear-net figure of concatenated digits. */
  function validSplit(p) {
    return isObj(p) && num(p.clearnet) && num(p.tor) && num(p.i2p) &&
      p.clearnet >= 0 && p.tor >= 0 && p.i2p >= 0;
  }

  /* What the L1 block says about how fresh it is. The three states are kept apart on
     purpose: a live Bitnodes read, a saved answer served after a failed request, and the
     bundled build-time snapshot — and the snapshot says why it is one, so a browser that
     can never read bitnodes.io (no CORS header; one attempt, then the poll stops) is not
     drawn as a live network that is merely slow. */
  function l1Freshness(l1) {
    if (!l1) return null;
    if (l1.src === 'live') return { tag: 'LIVE', text: L('fLive'), note: L('fLiveNote') };
    /* The measurement time has its own row above this one, so it is not repeated here. */
    if (l1.src === 'cache') return { tag: 'CACHE', text: L('fCache'), note: L('fCacheNote') };
    if (l1.why === 'cors') return { tag: 'SNAPSHOT', text: L('fCors'), note: L('fCorsNote') };
    return { tag: 'SNAPSHOT', text: L('fSnap'), note: L('fSnapNote') };
  }

  /* The short form for the row under the title, which is visible without opening the
     panel: the L1 layer says at a glance whether these dots are live or a snapshot. */
  function l1Badge() {
    var l1 = S.l1;
    if (!l1) return '';
    if (l1.src === 'live') return ' · ' + L('subLive');
    if (l1.src === 'cache') return ' · ' + L('subCache');
    return ' · ' + L('subSnap') + (l1.why === 'cors' ? ' · CORS' : '');
  }

  function applyL1(d) {
    var prev = S.l1;
    S.l1 = {
      total: num(d.total) ? d.total : null,
      reachable: num(d.reachable) ? d.reachable : null,
      height: num(d.height) ? d.height : null,
      at: num(d.at) ? d.at : 0,
      coords: isArr(d.coords) ? d.coords : [],
      platforms: validSplit(d.platforms) ? d.platforms : null,
      asns: isArr(d.asns) ? d.asns : null,
      vers: (isArr(d.vers) && d.vers.length) ? d.vers : l1Versions(d),
      /* Only a caller that says so is live. A payload re-served from localStorage or from
         the bundled snapshot must never inherit the LIVE label from a default: what the
         panel and the footnote print about the source hangs off this one field. `why`
         keeps the reason when the answer is not live, so the panel can say whether this
         browser is refused by the host (CORS) or the request simply failed. */
      src: d.src === 'live' ? 'live' : d.src === 'cache' ? 'cache' : 'snapshot',
      why: (d.src === 'live' || d.src === 'cache') ? d.src
        : (d.why === 'cors' || d.why === 'boot') ? d.why : 'fail',
      loadAt: Date.now()
    };
    if (S.layer === 'l1') Globe.build();
    noteDirty = true;
    schedulePaint();
    if (prev && prev.src !== 'live' && S.l1.src === 'live') toast(L('live') + ' · Bitnodes');
  }

  /* The clear-net / Tor / I2P split: the crawler's own figures when it reported all three,
     otherwise derived from the TOR and I2P rows of the ASN list. Every number is checked
     before it is used — an ASN row is an arbitrary array from the network, and a string in
     the count column would have been printed as the split and carried into the clear-net
     subtraction. */
  function l1Platforms(d) {
    if (validSplit(d.platforms)) return d.platforms;
    var tor = 0, i2p = 0, bad = false, asns = isArr(d.asns) ? d.asns : [];
    asns.forEach(function (a) {
      if (!isArr(a) || !a.length) return;
      if (a[0] !== 'TOR' && a[0] !== 'I2P') return;
      /* A row that names TOR or I2P without a finite count is a split this app cannot
         state: drawing the other figures and leaving this one at 0 would claim the
         transport has no nodes at all. */
      if (!num(a[1]) || a[1] < 0) { bad = true; return; }
      if (a[0] === 'TOR') tor = a[1]; else i2p = a[1];
    });
    if (bad || !num(d.total) || (!tor && !i2p)) return null;
    if (tor + i2p > d.total) return null;
    return { tor: tor, i2p: i2p, clearnet: d.total - tor - i2p };
  }

  /* Client versions, from the top payload's [user agent, count] rows or from a
     [version, count] list. Only string names and finite counts survive: the panel prints
     each name and computes a percentage of the total, so a row that is not a pair of that
     shape used to produce “undefined” or NaN %. */
  function l1Versions(d) {
    var pair = function (row) { return isArr(row) && row.length > 1 && typeof row[0] === 'string' && row[0]; };
    if (isArr(d.ua) && d.ua.length) {
      return d.ua.slice(0, 6).filter(pair).map(function (r) {
        return { name: r[0], pct: num(r[1]) ? r[1] : null };
      });
    }
    if (isArr(d.versions) && d.versions.length) {
      var all = 0;
      d.versions.forEach(function (v) { if (isArr(v) && num(v[1]) && v[1] >= 0) all += v[1]; });
      return d.versions.slice(0, 6).filter(pair).map(function (v) {
        return { name: v[0], pct: (all && num(v[1])) ? (v[1] / all * 100) : null };
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

  /* Bitnodes answers the coordinate grid and the ASN/client-version breakdown as two
     separate snapshots. The grid is what most of the view needs, so a failure of the
     top query alone must not blank the parts that are already known: the counts, the
     clearnet/Tor/I2P split and the client versions stay as they were until a later load
     works. What is reused is this session's own answer — never the copy in localStorage.
     The object this feeds is stamped live, and a payload read back from storage must not
     be shown under that stamp; when the grid arrives and the top query does not, the
     version/split rows keep the last session answer and the footnote still dates the
     snapshot they may have come from. */
  function l1TopFallback() {
    var prev = isObj(S.l1) ? S.l1 : null;
    if (prev && (isArr(prev.asns) || isObj(prev.platforms) || (isArr(prev.vers) && prev.vers.length))) return prev;
    return null;
  }

  function loadL1() {
    S.l1Tried = Date.now();
    /* A plain browser (no native bridge) can never read bitnodes.io: the host sends no
       Access-Control-Allow-Origin, so the same-origin policy refuses the answer before
       this code sees it. That is the host's policy, not a passing network fault, so a
       retry cannot end differently from the attempt before it — yet the 5-minute timer
       used to fire two doomed requests forever. One attempt per page load is allowed
       (a page that can reach the host, such as one with the bridge, still gets its read);
       after it fails the network poll is switched off for the session and the bundled
       snapshot, or the last cache, stays on screen. */
    if (!BR.on && S.l1Off) return Promise.resolve();
    var coords = getJSON(BIT_COORDS, 22000).catch(function () { return null; });
    var top = getJSON(BIT_TOP, 16000).catch(function () { return null; });
    return Promise.all([coords, top]).then(function (res) {
      var c = res[0], t = res[1];
      if (!isObj(c) || !isArr(c.coordinates) || !num(c.total_nodes)) throw new Error('bitnodes unavailable');
      var tops = (isObj(t) && isObj(t.top)) ? t.top : null;
      var prev = l1TopFallback() || {};
      var d = {
        total: c.total_nodes,
        reachable: (c.metadata && c.metadata.reachable_nodes) || null,
        height: c.latest_height,
        at: (c.timestamp || 0) * 1000,
        coords: c.coordinates,
        asns: (tops && isArr(tops.top_asns)) ? tops.top_asns : (isArr(prev.asns) ? prev.asns : null),
        ua: (tops && isArr(tops.top_user_agents)) ? tops.top_user_agents : (isArr(prev.ua) ? prev.ua : null),
        src: 'live'
      };
      d.platforms = l1Platforms(d) || (isObj(prev.platforms) ? prev.platforms : null);
      d.vers = l1Versions(d);
      if (!d.vers.length && isArr(prev.vers) && prev.vers.length) d.vers = prev.vers.slice(0, 6);
      /* A real Bitnodes answer is a healthy read like any other: without this, a working
         L1 layer left lastOk untouched, so the pill said STALE (or WAIT) while fresh L1
         data was on screen. The cache and snapshot paths below deliberately do not. */
      ok();
      applyL1(d);
      store(LS_CACHE + '.l1', { t: Date.now(), d: { total: d.total, reachable: d.reachable, height: d.height, at: d.at, coords: d.coords, asns: d.asns, ua: d.ua, platforms: d.platforms } });
    }).catch(function () {
      /* In the browser the refusal is final for this page load, so the timer above will
         find the poll off rather than repeat it; the Android shell keeps retrying, where
         a failure is an ordinary network fault that can clear. The reason is kept so the
         panel can name it instead of saying only that the request did not answer. */
      var why = BR.on ? 'fail' : 'cors';
      if (!BR.on) S.l1Off = true;
      var cached = recall(LS_CACHE + '.l1');
      if (isObj(cached) && isObj(cached.d) && isArr(cached.d.coords) && cached.d.coords.length) {
        var d = cached.d;
        d.src = 'cache'; d.vers = l1Versions(d);
        if (!d.platforms) d.platforms = l1Platforms(d);
        applyL1(d);
      } else if (!S.l1 || S.l1.src !== 'live') {
        applySnapshotL1(why);
      }
    });
  }

  /* -------------------------------------------------------- continents ---- */
  var CONT_ORDER = ['NA', 'EU', 'AS', 'SA', 'OC', 'AF', 'OT'];
  var CONT_EN = { NA: 'North America', EU: 'Europe', AS: 'Asia', SA: 'South America', OC: 'Oceania', AF: 'Africa', OT: 'Other' };
  function contName(k) { return CONT_EN[k] || k; }

  function contOf(iso) {
    var meta = (typeof COUNTRY_META !== 'undefined' && COUNTRY_META.cont) ? COUNTRY_META.cont : {};
    return meta[String(iso || '').toUpperCase()] || 'OT';
  }
  function countryName(iso, fallback) {
    var names = (typeof L1_SNAPSHOT !== 'undefined' && L1_SNAPSHOT.countryNames) ? L1_SNAPSHOT.countryNames : {};
    return names[String(iso || '').toUpperCase()] || fallback || iso || '';
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

