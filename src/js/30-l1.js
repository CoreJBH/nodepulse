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

  /* --------------------------------------------------- the daily snapshot */
  /* The Bitnodes snapshot is rebuilt once a day (fetch_l1.py) and bundled at build time,
     which means the copy inside the page ages from the day it was built. The same table
     is published at https://corejbh.github.io/nodepulse/l1-snapshot.json in this exact
     shape; the app reads it after the first paint, keeps it in localStorage, and uses it
     whenever it is newer than the bundled copy. A failure changes nothing and says
     nothing: the bundled table is already a real Bitnodes export. */
  var LS_L1SNAP = 'nodepulse.l1snap.v1';
  var L1_SNAP_URL = 'https://corejbh.github.io/nodepulse/l1-snapshot.json';
  var L1_SNAP_MS = 9000;
  var L1_SNAP = null;        // the effective snapshot table
  var L1_SNAP_SRC = 'builtin';   // builtin | cache | remote

  /* The table the L1 layer reads. The bundled one until a newer published copy is in
     hand, and always a table — no caller has to ask which. */
  function l1Snap() {
    if (L1_SNAP) return L1_SNAP;
    if (typeof L1_SNAPSHOT !== 'undefined' && L1_SNAPSHOT) {
      L1_SNAP = L1_SNAPSHOT;
      L1_SNAP_SRC = 'builtin';
    }
    return L1_SNAP;
  }
  function l1SnapSrc() { l1Snap(); return L1_SNAP_SRC; }

  /* Read one published table. Everything is re-typed: the file comes from another host
     and a field it does not carry (or carries as a string) must not become a node count
     or a coordinate. `ts` and `capturedAt` are both accepted, because the bundled file
     uses the latter and the published one the former. */
  function normSnap(raw) {
    if (!isObj(raw)) return null;
    var at = num(raw.ts) ? raw.ts : (num(raw.capturedAt) ? raw.capturedAt : 0);
    if (!at || at < 1e9) return null;
    if (!num(raw.totalNodes) || raw.totalNodes <= 0) return null;
    if (!isArr(raw.coords) || !raw.coords.length) return null;
    var coords = [], i;
    for (i = 0; i < raw.coords.length && coords.length < 40000; i++) {
      var p = raw.coords[i];
      if (!isArr(p) || p.length < 2 || !num(p[0]) || !num(p[1])) continue;
      if (Math.abs(p[0]) > 90 || Math.abs(p[1]) > 180) continue;
      coords.push([p[0], p[1]]);
    }
    if (!coords.length) return null;
    function pairs(v) {
      if (!isArr(v)) return null;
      var out = [];
      for (var k = 0; k < v.length && out.length < 400; k++) {
        var r = v[k];
        if (!isArr(r) || r.length < 2 || typeof r[0] !== 'string' || !num(r[1])) continue;
        out.push([r[0].slice(0, 40), r[1]]);
      }
      return out.length ? out : null;
    }
    var countries = pairs(raw.countries), names = isObj(raw.countryNames) ? raw.countryNames : null;
    var cc = isObj(raw.coordCountry) ? raw.coordCountry : null;
    return {
      capturedAt: Math.floor(at),
      source: typeof raw.source === 'string' ? raw.source : '',
      totalNodes: raw.totalNodes,
      reachableNodes: num(raw.reachableNodes) ? raw.reachableNodes : null,
      height: num(raw.height) ? raw.height : null,
      countries: countries,
      countryNames: names,
      coords: coords,
      coordCount: num(raw.coordCount) ? raw.coordCount : coords.length,
      coordCountry: cc,
      userAgents: pairs(raw.userAgents),
      topAsns: pairs(raw.topAsns),
      versions: pairs(raw.versions),
      platforms: validSplit(raw.platforms) ? raw.platforms : null,
      partial: !(countries && names)
    };
  }

  /* Adopt a table only when it is strictly newer than the one in hand: a cached copy
     from an earlier day never rolls back a freshly built table. */
  function adoptSnap(raw, src) {
    var s = normSnap(raw);
    if (!s) return false;
    var cur = l1Snap();
    if (cur && num(cur.capturedAt) && s.capturedAt <= cur.capturedAt) return false;
    L1_SNAP = s; L1_SNAP_SRC = src;
    return true;
  }

  /* Boot path: a saved table newer than the bundled one is used at once, so the very
     first paint is the newest table the page has ever seen. */
  function l1SnapBoot() {
    var saved = recall(LS_L1SNAP);
    if (isObj(saved) && isObj(saved.raw) && adoptSnap(saved.raw, 'cache')) return true;
    return false;
  }

  /* A snapshot that was replaced is re-applied only where a snapshot is what is on
     screen: a live Bitnodes read is never overwritten by a file. */
  function l1SnapApply() {
    if (S.l1 && S.l1.src === 'live') return false;
    return applySnapshotL1((S.l1 && S.l1.why === 'cors') ? 'cors' : 'boot');
  }

  function l1SnapRemote() {
    if (typeof fetch !== 'function' || (typeof offline === 'function' && offline())) return Promise.resolve(false);
    var ctrl = null, timer = null, opt = { cache: 'no-cache', credentials: 'omit', mode: 'cors' };
    if (typeof AbortController !== 'undefined') {
      ctrl = new AbortController();
      opt.signal = ctrl.signal;
      timer = setTimeout(function () { try { ctrl.abort(); } catch (e) { } }, L1_SNAP_MS);
    }
    return fetch(L1_SNAP_URL, opt).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (raw) {
      if (timer) clearTimeout(timer);
      if (!adoptSnap(raw, 'remote')) return false;
      store(LS_L1SNAP, { raw: raw, at: Date.now() });
      l1SnapApply();
      return true;
    }).catch(function () {
      if (timer) clearTimeout(timer);
      return false;
    });
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
    if (l1.daily) return { tag: 'DAILY', text: L('fDaily'), note: L('fDailyNote') };
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
    /* The published daily table is a snapshot too, but a fresher one than the copy built
       into the page, and the row under the title says which it is. */
    if (l1.daily) return ' · ' + L('subDaily');
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
      /* True when the table on screen is the published daily snapshot rather than the copy
         built into this page. The panel and the row under the title say which. */
      daily: d.daily === true,
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
    var s = l1Snap();
    if (!s) return false;
    applyL1({
      total: s.totalNodes, reachable: s.reachableNodes, height: s.height,
      at: (s.capturedAt || 0) * 1000, coords: s.coords || [],
      platforms: s.platforms || null, asns: s.topAsns || null,
      versions: s.versions || null, ua: s.userAgents || null,
      src: 'snapshot', why: why, daily: l1SnapSrc() !== 'builtin'
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
    var s = l1Snap();
    var names = (s && s.countryNames) ? s.countryNames : {};
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
    var s = l1Snap();
    if (!s || !s.countries) return null;
    var acc = {}, total = 0;
    s.countries.forEach(function (r) {
      var k = contOf(r[0]);
      acc[k] = (acc[k] || 0) + (r[1] || 0);
      total += r[1] || 0;
    });
    return { count: acc, total: total, countries: s.countries.length };
  }

