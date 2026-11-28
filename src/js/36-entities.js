/* Entities / Whale Watch: the seed table of public entity addresses, the optional
   refresh from the published JSON, the balance and transaction reads, the watchlist and
   the panel that draws all of it.

   The rule of the rest of the app applies here without exception: every figure on screen
   is a figure an API returned, and every address is one a public source names. The seed
   (src/data/entities-data.js) is the verified table — 20 entities, 42 addresses, each
   confirmed against mempool.space — and this module never invents an address, a balance
   or a rank beyond it.

   What it does:
     · adopts the seed at boot, then quietly tries https://corejbh.github.io/nodepulse/
       entities.json; a newer payload replaces it in localStorage, a failure changes
       nothing and says nothing (the seed is already the verified table).
     · ranks entities by the BTC actually tracked for them, highest first. The Patoshi
       estimate is a badge and a sentence, never part of a total.
     · reads balances on demand, one address at a time, through Cluster.fetchAddressSummary
       (same 7-minute cache as the clustering engine) with a 429 treated as "rate limited"
       rather than as a zero.
     · reads the recent transactions of one address when its row is opened, and marks a
       counterparty that is another known entity.
     · keeps a watchlist of any address the user adds, in localStorage.
     · runs Cluster.analyzeEntity() for the entity on screen and shows its result by the
       display rules of docs/cluster-api.md §8: Verified / Common-Input / Change Est. are
       separate badges, the coinjoin count is its own number, and a truncated, rate-limited
       or empty run says so instead of showing a stale figure as live.

   The panel is light DOM strings, like the rest of the app: no inline handlers (the CSP
   forbids them), one delegated click listener, and the same esc() on every value that came
   from outside. */

  var Ent = (function () {

    var LS_REMOTE = 'nodepulse.entities.v1';
    var LS_WATCH = 'nodepulse.watchlist.v1';
    var REMOTE_URL = 'https://corejbh.github.io/nodepulse/entities.json';
    var REMOTE_MS = 8000;
    var PRICE_TTL = 5 * 60 * 1000;
    var LIVE_TTL = 7 * 60 * 1000;      // the clustering engine's own cache window
    var WATCH_MAX = 20;
    var TX_ROWS = 6;
    var CATS = ['ALL', 'PERSON', 'CORP', 'GOV', 'OTHER'];
    var CAT_LABEL = { ALL: 'All', PERSON: 'Person', CORP: 'Corp', GOV: 'Gov', OTHER: 'Other' };
    /* What a category means, printed under the chips so the grouping is not a guess. */
    var CAT_NOTE = {
      ALL: 'every tracked entity', PERSON: 'individual holders', CORP: 'companies, exchanges and ETFs',
      GOV: 'states and their seizures', OTHER: 'estates, funds, hackers and ransom wallets'
    };
    var EVIDENCE = { official: 'self-published', chain: 'chain record', attributed: 'analytics attribution' };

    var ES = {
      data: null, v: 0, at: 0, src: 'seed',
      filter: 'ALL', open: '', txAddr: '', txOpen: '',
      watch: [], watchLive: Object.create(null),
      live: Object.create(null),
      tx: Object.create(null),
      price: null, priceAt: 0, priceSrc: '',
      run: null, remote: 'idle', err: '',
      index: null, ranked: null
    };

    /* ------------------------------------------------------------- helpers */
    var ADDR_RE = /^[A-Za-z0-9]{25,90}$/;
    function validAddr(a) { return typeof a === 'string' && ADDR_RE.test(a); }
    function isCat(c) { return CATS.indexOf(c) > 0; }

    /* A balance is a whole number of satoshis or it is not a balance: a float, a string
       or a negative from a cached or remote payload is dropped, not rounded. */
    function sats(v) {
      return (num(v) && v >= 0 && Math.floor(v) === v) ? v : null;
    }

    /* ---------------------------------------------------------------- model */
    /* Read one entity out of the seed or a remote payload. Everything is re-typed: the
       remote file is written by a script on another host, and a field it does not carry
       (or carries as a string) must not reach a total or a card. */
    function normEntity(raw) {
      if (!isObj(raw)) return null;
      var id = typeof raw.id === 'string' ? raw.id.slice(0, 60) : '';
      var name = typeof raw.name === 'string' ? raw.name.slice(0, 120) : '';
      if (!id || !name) return null;
      if (CATS.indexOf(raw.category) < 0) return null;
      var list = isArr(raw.addresses) ? raw.addresses : [];
      var addrs = [], total = 0, liveAny = false;
      for (var i = 0; i < list.length && addrs.length < 60; i++) {
        var a = list[i];
        if (!isObj(a) || !validAddr(a.address)) continue;
        var bal = sats(a.sats);
        if (bal === null) continue;
        var live = a.live === true;
        addrs.push({
          address: a.address,
          label: typeof a.label === 'string' ? a.label.slice(0, 160) : '',
          sats: bal,
          source: typeof a.source === 'string' ? a.source : '',
          note: typeof a.note === 'string' ? a.note.slice(0, 400) : '',
          live: live
        });
        total += bal;
        if (live) liveAny = true;
      }
      if (!addrs.length) return null;
      return {
        id: id, name: name, category: raw.category,
        icon: ['person', 'corp', 'gov', 'group', 'hacker'].indexOf(raw.icon) >= 0 ? raw.icon : 'group',
        badge: typeof raw.badge === 'string' ? raw.badge.slice(0, 40) : '',
        evidence: EVIDENCE[raw.evidence] ? raw.evidence : 'attributed',
        live: liveAny,
        description: typeof raw.description === 'string' ? raw.description.slice(0, 600) : '',
        extra: typeof raw.extra === 'string' ? raw.extra.slice(0, 900) : '',
        addresses: addrs,
        total: total
      };
    }

    function normPayload(raw) {
      if (!isObj(raw) || !isArr(raw.list)) return null;
      var list = [], seen = Object.create(null), tracked = 0;
      for (var i = 0; i < raw.list.length && list.length < 200; i++) {
        var e = normEntity(raw.list[i]);
        if (!e || seen[e.id]) continue;
        seen[e.id] = true;
        list.push(e);
        tracked += e.total;
      }
      if (!list.length) return null;
      return {
        v: num(raw.v) && raw.v > 0 ? Math.floor(raw.v) : 1,
        at: typeof raw.at === 'string' ? raw.at : '',
        block: num(raw.block) ? raw.block : null,
        list: list, tracked: tracked
      };
    }

    function adopt(payload, src) {
      var m = normPayload(payload);
      if (!m) return false;
      m.atMs = m.at ? Date.parse(m.at) : 0;
      if (isNaN(m.atMs)) m.atMs = 0;
      ES.data = m; ES.v = m.v; ES.at = m.atMs; ES.src = src;
      ES.index = null; ES.ranked = null;
      return true;
    }

    function list() { return ES.data ? ES.data.list : []; }

    function byId(id) {
      var l = list();
      for (var i = 0; i < l.length; i++) if (l[i].id === id) return l[i];
      return null;
    }

    /* address -> { id, name, label } for the counterparty badges */
    function index() {
      if (ES.index) return ES.index;
      var map = Object.create(null), l = list();
      for (var i = 0; i < l.length; i++) {
        for (var j = 0; j < l[i].addresses.length; j++) {
          var a = l[i].addresses[j];
          if (!map[a.address]) map[a.address] = { id: l[i].id, name: l[i].name, label: a.label };
        }
      }
      ES.index = map;
      return map;
    }
    function entityOfAddress(addr) {
      var m = index();
      return m[addr] || null;
    }

    /* ---------------------------------------------------------------- live */
    function liveState(id) {
      var st = ES.live[id];
      if (!st) {
        st = ES.live[id] = { state: 'idle', at: 0, addrs: Object.create(null), done: 0, total: 0, rate: false, failed: 0, err: '' };
      }
      return st;
    }

    /* The balances a card shows: the live read where one exists, the verified seed value
       where it does not, and a count of how many of the addresses each covers. Nothing is
       ever extrapolated from one address to another. */
    function balanceOf(e) {
      var st = ES.live[e.id], out = { sats: 0, known: 0, total: e.addresses.length, live: 0, cached: 0, seed: 0 };
      for (var i = 0; i < e.addresses.length; i++) {
        var a = e.addresses[i], row = st && st.addrs[a.address];
        if (row && sats(row.sats) !== null) {
          out.sats += row.sats; out.known++;
          if (row.src === 'live') out.live++; else out.cached++;
        } else {
          out.sats += a.sats; out.known++;
          out.seed++;
        }
      }
      return out;
    }

    function trackedSats() {
      var sum = 0, l = list();
      for (var i = 0; i < l.length; i++) {
        var st = ES.live[l[i].id];
        if (!st) { sum += l[i].total; continue; }
        sum += balanceOf(l[i]).sats;
      }
      return sum;
    }

    function addrCount() {
      var n = 0, l = list();
      for (var i = 0; i < l.length; i++) n += l[i].addresses.length;
      return n;
    }

    /* One address at a time, on purpose: a sweep of 42 addresses in parallel is a burst
       the mirrors answer with 429, and a 429 on the first card would look like the entity
       has no balance. Each read goes through the clustering engine's own cache, so opening
       the same card twice in seven minutes costs nothing. */
    function sweep(id, force) {
      var e = byId(id);
      if (!e) return Promise.resolve(null);
      var st = liveState(id);
      if (st.state === 'loading') return st.p;
      var targets = [];
      for (var i = 0; i < e.addresses.length; i++) if (e.addresses[i].live) targets.push(e.addresses[i].address);
      st.total = targets.length; st.done = 0; st.rate = false; st.failed = 0; st.err = '';
      if (!targets.length) { st.state = 'static'; st.at = Date.now(); paintEntities(); return Promise.resolve(st); }
      st.state = 'loading';
      st.p = targets.reduce(function (p, addr) {
        return p.then(function () {
          if (st.state !== 'loading') return null;      // cancelled or re-run
          return Cluster.fetchAddressSummary(addr, { ttlMs: LIVE_TTL }).then(function (sum) {
            st.addrs[addr] = { sats: sum.balance, tx: sum.txCount, src: sum.source, at: sum.at };
          }, function (err) {
            st.failed++;
            if (err && err.status === 429) { st.rate = true; st.err = 'rate limited'; }
            else if (!st.err) st.err = (err && err.message) ? String(err.message) : 'unverified';
          }).then(function () {
            st.done++;
            paintRunLine();
          });
        });
      }, Promise.resolve()).then(function () {
        if (st.state !== 'loading') return null;
        st.state = st.rate ? 'rate-limited' : (st.failed && st.failed >= st.total ? 'unverified' : (st.failed ? 'partial' : 'live'));
        st.at = Date.now();
        paintEntities();
        return st;
      });
      paintEntities();
      return st.p;
    }

    /* ------------------------------------------------------------ transactions */
    function netTo(tx, addr) {
      var out = 0, inn = 0, i, v;
      if (isArr(tx.vout)) for (i = 0; i < tx.vout.length; i++) {
        v = tx.vout[i];
        if (isObj(v) && v.scriptpubkey_address === addr && num(v.value)) out += v.value;
      }
      if (isArr(tx.vin)) for (i = 0; i < tx.vin.length; i++) {
        v = tx.vin[i] && isObj(tx.vin[i].prevout) ? tx.vin[i].prevout : null;
        if (v && v.scriptpubkey_address === addr && num(v.value)) inn += v.value;
      }
      return out - inn;
    }
    /* The other side of the transaction: every address that is not this one, with the
       known entity it belongs to when there is one. That is what turns a hash into a
       sentence ("to Binance PoR wallet"). */
    function peersOf(tx, addr, limit) {
      var seen = Object.create(null), out = [], i, v;
      function push(a) {
        if (!validAddr(a) || a === addr || seen[a] || out.length >= limit) return;
        seen[a] = true;
        var ent = entityOfAddress(a);
        out.push({ address: a, entity: ent ? ent.name : '', label: ent ? ent.label : '' });
      }
      if (isArr(tx.vout)) for (i = 0; i < tx.vout.length; i++) {
        v = tx.vout[i];
        if (isObj(v) && typeof v.scriptpubkey_address === 'string') push(v.scriptpubkey_address);
      }
      if (isArr(tx.vin)) for (i = 0; i < tx.vin.length; i++) {
        v = tx.vin[i] && isObj(tx.vin[i].prevout) ? tx.vin[i].prevout : null;
        if (v && typeof v.scriptpubkey_address === 'string') push(v.scriptpubkey_address);
      }
      return out;
    }

    function txState(addr) {
      var st = ES.tx[addr];
      if (!st) st = ES.tx[addr] = { state: 'idle', at: 0, rows: [], err: '' };
      return st;
    }

    function readTxs(addr, force) {
      if (!validAddr(addr)) return Promise.resolve(null);
      var st = txState(addr);
      if (st.state === 'loading') return st.p;
      if (!force && st.state === 'done' && Date.now() - st.at < LIVE_TTL) return Promise.resolve(st);
      st.state = 'loading'; st.err = '';
      st.p = request('/api/address/' + encodeURIComponent(addr) + '/txs').then(function (rows) {
        if (!isArr(rows)) throw new Error('bad tx list');
        var out = [];
        for (var i = 0; i < rows.length && out.length < TX_ROWS; i++) {
          var t = rows[i];
          if (!isObj(t) || typeof t.txid !== 'string' || !t.txid) continue;
          var conf = isObj(t.status) ? t.status : {};
          out.push({
            txid: t.txid,
            at: num(conf.block_time) ? conf.block_time * 1000 : 0,
            confirmed: conf.confirmed === true,
            sats: netTo(t, addr),
            peers: peersOf(t, addr, 3)
          });
        }
        st.rows = out; st.state = 'done'; st.at = Date.now();
        return st;
      }, function (err) {
        st.state = 'error';
        st.err = err && err.status === 429 ? 'rate limited' : 'unverified';
        return st;
      }).then(function (r) {
        paintEntities();
        return r;
      });
      paintEntities();
      return st.p;
    }

    /* ------------------------------------------------------------- watchlist */
    function watchFrom(raw) {
      if (!isArr(raw)) return [];
      var out = [], seen = Object.create(null);
      for (var i = 0; i < raw.length && out.length < WATCH_MAX; i++) {
        var w = raw[i];
        var addr = typeof w === 'string' ? w : (isObj(w) && typeof w.address === 'string' ? w.address : '');
        if (!validAddr(addr) || seen[addr]) continue;
        seen[addr] = true;
        out.push({
          address: addr,
          label: isObj(w) && typeof w.label === 'string' ? w.label.slice(0, 60) : '',
          at: isObj(w) && num(w.at) ? w.at : 0
        });
      }
      return out;
    }
    function watchSave() { store(LS_WATCH, ES.watch); }
    function watchAdd(addr, label) {
      addr = String(addr || '').trim();
      if (!validAddr(addr)) return { ok: false, err: 'not a bitcoin address' };
      for (var i = 0; i < ES.watch.length; i++) if (ES.watch[i].address === addr) return { ok: false, err: 'already on the watchlist' };
      if (ES.watch.length >= WATCH_MAX) return { ok: false, err: 'watchlist is full (' + WATCH_MAX + ')' };
      ES.watch.unshift({ address: addr, label: String(label || '').slice(0, 60), at: Date.now() });
      watchSave();
      readTxs(addr);
      Cluster.fetchAddressSummary(addr, { ttlMs: LIVE_TTL }).then(function (sum) {
        ES.watchLive[addr] = { sats: sum.balance, tx: sum.txCount, src: sum.source, at: sum.at };
        paintEntities();
      }, function (err) {
        ES.watchLive[addr] = { err: err && err.status === 429 ? 'rate limited' : 'unverified' };
        paintEntities();
      });
      flush();
      return { ok: true };
    }
    function watchDel(addr) {
      for (var i = 0; i < ES.watch.length; i++) {
        if (ES.watch[i].address === addr) { ES.watch.splice(i, 1); watchSave(); paintEntities(); return true; }
      }
      return false;
    }

    /* ---------------------------------------------------------------- price */
    /* USD only, and only with its source: the card prints the pair and the minute it was
       read, because a dollar figure without its rate is a number, not a fact. */
    function loadPrice() {
      if (ES.price && Date.now() - ES.priceAt < PRICE_TTL) return Promise.resolve(ES.price);
      return request('/api/v1/prices').then(function (p) {
        if (isObj(p) && num(p.USD) && p.USD > 0) {
          ES.price = p.USD; ES.priceAt = Date.now(); ES.priceSrc = 'mempool.space';
          paintEntities();
        }
        return ES.price;
      }, function () { return ES.price; });
    }
    function usd(s) {
      if (!num(ES.price) || !num(s)) return null;
      return (s / 1e8) * ES.price;
    }
    function fmtUsd(v) {
      if (!num(v)) return '—';
      var a = Math.abs(v), sign = v < 0 ? '−' : '';
      if (a >= 1e9) return sign + '$' + (a / 1e9).toFixed(a >= 1e11 ? 0 : 2) + 'B';
      if (a >= 1e6) return sign + '$' + (a / 1e6).toFixed(a >= 1e8 ? 1 : 2) + 'M';
      if (a >= 1e3) return sign + '$' + (a / 1e3).toFixed(a >= 1e6 ? 0 : 1) + 'K';
      return sign + '$' + a.toFixed(2);
    }
    function priceNote() {
      if (!num(ES.price)) return 'USD rate not read yet';
      return 'USD at $' + fmtInt(ES.price) + ' · ' + ES.priceSrc + (ES.priceAt ? ' · ' + ago(ES.priceAt) : '');
    }

    /* ----------------------------------------------------------------- rank */
    /* Ranked by the BTC actually tracked for each entity, highest first. The Patoshi
       estimate is not in this number and the card says so, which is why Satoshi sits
       below the exchanges rather than at #1 on an estimate. */
    function ranked() {
      if (ES.ranked) return ES.ranked;
      var l = list().slice();
      l.sort(function (a, b) { return balanceOf(b).sats - balanceOf(a).sats || (a.name < b.name ? -1 : 1); });
      var out = l.map(function (e, i) { return { e: e, rank: i + 1 }; });
      ES.ranked = out;
      return out;
    }
    function rankOf(id) {
      var r = ranked();
      for (var i = 0; i < r.length; i++) if (r[i].e.id === id) return r[i].rank;
      return 0;
    }
    function filtered() {
      var r = ranked();
      if (ES.filter === 'ALL') return r;
      return r.filter(function (x) { return x.e.category === ES.filter; });
    }

    /* ---------------------------------------------------------------- icons */
    /* Minimal line icons, 24x24, stroke only, in the two entity accents (#00E5FF and
       #3B82F6 from app.css --ec / --ec2). A hacker card keeps its mask even though the
       category chip above it reads OTHER. */
    function icon(kind, cls) {
      var d;
      if (kind === 'person') {
        d = '<circle cx="12" cy="8" r="3.4"/><path d="M4.8 20c0-3.6 3.2-6 7.2-6s7.2 2.4 7.2 6"/>';
      } else if (kind === 'corp') {
        d = '<path d="M3.4 20.2V9.4h8.2v10.8M11.6 20.2V4.6h9V20.2"/><path d="M6 12.2h2.2M6 15.4h2.2M14.4 8h3M14.4 11.4h3M14.4 14.8h3"/>';
      } else if (kind === 'gov') {
        d = '<path d="M3 20.4h18M4.6 20.4V10M19.4 20.4V10M12 3.4 3 9.6h18L12 3.4Z"/><path d="M8.4 20.4v-7M12 20.4v-7M15.6 20.4v-7"/>';
      } else if (kind === 'hacker') {
        d = '<path d="M12 3.2c-4.9 0-8.2 3.5-8.2 8.1 0 3.4 1.4 5.4 2.6 6.5l.5 2.9h10.2l.5-2.9c1.2-1.1 2.6-3.1 2.6-6.5 0-4.6-3.3-8.1-8.2-8.1Z"/>' +
            '<path d="M7.6 11.6h3.2M13.2 11.6h3.2"/><path d="M9.4 16.4c1.6.9 3.6.9 5.2 0"/>';
      } else {
        d = '<circle cx="8.6" cy="8.4" r="2.9"/><path d="M2.8 19c0-3.1 2.6-5.2 5.8-5.2s5.8 2.1 5.8 5.2"/>' +
            '<circle cx="16.6" cy="9.6" r="2.4"/><path d="M14.6 13.6c2.9-.4 6.4 1.3 6.4 4.6"/>';
      }
      return '<svg class="ico' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
        'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + '</svg>';
    }

    /* ---------------------------------------------------------------- paint */
    var SHEET = 'entSheet';
    var paintQueued = false;

    function entPaintNow(force) {
      /* A background tick only rebuilds the sheet's DOM while it is on screen; the HUD and
         the row under the title are always current, because they are what the tab shows
         when the sheet is closed. A user action (`force`) always repaints, so a click and
         the screen can never disagree. */
      if (force || isOpen()) paintSheet();
      paintEntHud();
      txt('subrow', subrowText());
    }
    function paintEntities() {
      if (paintQueued) return;
      paintQueued = true;
      setTimeout(function () { paintQueued = false; entPaintNow(); }, 30);
    }
    /* A user action (a chip, a row, ADD, CANCEL) paints at once: the click and the screen
       must not disagree for 30 ms. Background arrivals — a balance, a price, a progress
       tick — keep the throttled path so a sweep of 42 addresses is not 42 full re-renders. */
    function flush() {
      paintQueued = false;
      entPaintNow(true);
    }

    function chipsHTML() {
      return CATS.map(function (c) {
        var on = ES.filter === c;
        var n = c === 'ALL' ? list().length : list().filter(function (e) { return e.category === c; }).length;
        return '<button class="chip' + (on ? ' on' : '') + '" role="tab" aria-selected="' + (on ? 'true' : 'false') +
          '" data-act="filter" data-id="' + c + '">' + esc(CAT_LABEL[c]) + '<b>' + n + '</b></button>';
      }).join('');
    }

    function badgesHTML(e) {
      var out = '';
      if (e.badge) out += '<span class="tag">' + esc(e.badge) + '</span>';
      out += '<span class="ev ' + esc(e.evidence) + '">' + esc(EVIDENCE[e.evidence]) + '</span>';
      if (!e.live) out += '<span class="tag dim">static</span>';
      return out;
    }

    function rowHTML(x) {
      var e = x.e, b = balanceOf(e), st = ES.live[e.id];
      var state = st ? st.state : 'idle';
      return '<div class="erow" data-act="open" data-id="' + esc(e.id) + '" role="button" tabindex="0">' +
        '<div class="rk">#' + x.rank + '</div>' +
        '<div class="ic ' + esc(e.icon) + '">' + icon(e.icon) + '</div>' +
        '<div class="main">' +
          '<div class="nm">' + esc(e.name) + '</div>' +
          '<div class="meta"><span class="cat">' + esc(CAT_LABEL[e.category] || e.category) + '</span>' +
            badgesHTML(e) +
            '<span class="st ' + esc(state) + '">' + esc(liveWord(statusOf(st))) + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="val">' + esc(fmtBtc(b.sats)) + '<span class="u">BTC</span>' +
          '<small>' + esc(fmtUsd(usd(b.sats))) + '</small></div>' +
      '</div>';
    }

    function statusOf(st) {
      if (!st || st.state === 'idle') return 'seed';
      if (st.state === 'loading') return 'reading';
      if (st.state === 'static') return 'static';
      if (st.state === 'rate-limited') return 'rate limited';
      if (st.state === 'unverified') return 'unverified';
      if (st.state === 'partial') return 'partial';
      return 'live';
    }
    function liveWord(s) {
      /* "as of" is the honest word for the seed figure: the address table was read then,
         and this session has not re-read it. It is not a live balance. */
      if (s === 'seed') return 'as of ' + shortDate(ES.at);
      return s;
    }
    function plural(n, one, many) { return n === 1 ? one : many; }
    function shortDate(ms) {
      if (!num(ms) || ms <= 0) return '—';
      return dateOf(ms).slice(0, 10);
    }

    function watchHTML() {
      var rows = ES.watch.map(function (w) {
        var st = ES.watchLive[w.address] || null;
        var bal = st && sats(st.sats) !== null ? fmtBtc(st.sats) + ' BTC' : (st && st.err ? st.err : 'reading…');
        var ent = entityOfAddress(w.address);
        var tx = ES.tx[w.address];
        var body = '';
        if (ES.txOpen === w.address) {
          body = '<div class="wtx">' + txHTML(w.address) + '</div>';
        }
        return '<div class="wrow">' +
          '<div class="wtop">' +
            '<button class="waddr" data-act="wtx" data-id="' + esc(w.address) + '">' + esc(shortHash(w.address, 10, 8)) +
              (ent ? '<span class="badge unto">' + esc(ent.name) + '</span>' : '') + '</button>' +
            '<span class="wbal">' + esc(bal) + '</span>' +
            '<button class="wx" data-act="wdel" data-id="' + esc(w.address) + '" aria-label="Remove from watchlist">×</button>' +
          '</div>' +
          (w.label ? '<div class="wlab">' + esc(w.label) + '</div>' : '') +
          (st && st.tx !== undefined && num(st.tx) ? '<div class="wsub">' + fmtInt(st.tx) + ' tx · ' + esc(st.src === 'live' ? 'live now' : 'cached answer') + '</div>' : '') +
          body +
        '</div>';
      }).join('');
      return '<div class="watch">' +
        '<div class="whead"><span>WATCHLIST</span><span>' + ES.watch.length + ' / ' + WATCH_MAX + ' · any BTC address</span></div>' +
        '<div class="wadd">' +
          '<input id="entWatchInput" class="win" type="text" inputmode="text" autocomplete="off" spellcheck="false" ' +
            'placeholder="Add a BTC address to watch" aria-label="Bitcoin address to watch">' +
          '<button class="wbtn" data-act="wadd">ADD</button>' +
        '</div>' +
        (ES.err ? '<div class="werr">' + esc(ES.err) + '</div>' : '') +
        (rows || '<div class="wempty">No addresses yet. Add one above; its balance and latest transactions are read from mempool.space.</div>') +
      '</div>';
    }

    function txHTML(addr) {
      var st = ES.tx[addr];
      if (!st || st.state === 'idle' || st.state === 'loading') return '<div class="tnote">reading transactions…</div>';
      if (st.state === 'error') return '<div class="tnote warn">' + esc(st.err || 'unverified') + ' · no transaction list could be read</div>';
      if (!st.rows.length) return '<div class="tnote">no transaction returned for this address</div>';
      var out = '<div class="tlist">';
      st.rows.forEach(function (r) {
        var dir = r.sats > 0 ? 'in' : r.sats < 0 ? 'out' : 'self';
        out += '<div class="trow ' + dir + '">' +
          '<div class="tl"><span class="txid">' + esc(shortHash(r.txid, 8, 6)) + '</span>' +
          '<span class="amt">' + (r.sats > 0 ? '+' : '') + esc(fmtBtc(r.sats)) + ' BTC</span></div>' +
          '<div class="td">' + esc(r.at ? ago(r.at) : (r.confirmed ? 'mined' : 'in the mempool')) +
          (r.peers.length ? ' · ' + r.peers.map(function (p) {
            return p.entity
              ? '<span class="badge unto">' + esc(p.entity) + '</span>'
              : '<span class="badge">' + esc(shortHash(p.address, 5, 4)) + '</span>';
          }).join('') : '') +
          '</div></div>';
      });
      return out + '</div>';
    }

    function addrRowHTML(a) {
      var st = ES.live[ES.open], row = st && st.addrs[a.address];
      var limit = st && st.rate && !row ? 'rate limited' : '';
      var bal = row && sats(row.sats) !== null ? row.sats : a.sats;
      var src = row ? (row.src === 'live' ? 'live' : 'cached') : (limit || (a.live ? 'verified ' + shortDate(ES.at) : 'static'));
      var cls = row ? (row.src === 'live' ? 'live' : 'cache') : (a.live ? 'seed' : 'static');
      return '<div class="arow">' +
        '<div class="atop"><button class="aaddr" data-act="atx" data-id="' + esc(a.address) + '">' +
          esc(shortHash(a.address, 12, 8)) + '</button>' +
          '<span class="abal">' + esc(fmtBtc(bal)) + '<span class="u">BTC</span></span></div>' +
        '<div class="alab">' + esc(a.label) + '</div>' +
        '<div class="ameta"><span class="badge ' + cls + '">' + esc(src) + '</span>' +
          '<span class="src">' + esc(sourceHost(a.source)) + '</span>' +
          (row && num(row.tx) ? '<span class="src">' + fmtInt(row.tx) + ' tx</span>' : '') + '</div>' +
        (a.note ? '<div class="anote">' + esc(a.note) + '</div>' : '') +
        (ES.txOpen === a.address ? '<div class="wtx">' + txHTML(a.address) + '</div>' : '') +
      '</div>';
    }
    function sourceHost(u) {
      var m = String(u || '').match(/^https?:\/\/([^\/]+)/i);
      return m ? m[1] : (u || '');
    }

    /* docs/cluster-api.md §8, line by line: the three labels stay apart, the coinjoin
       count is its own figure, and a run that was cut, limited or empty says which. */
    function clusterHTML() {
      var run = ES.run;
      if (!run) {
        return '<button class="cta" data-act="analyze">ANALYZE CLUSTER</button>' +
          '<div class="cnote">Common-input ownership and change estimation over the addresses above, ' +
          'one transaction list at a time through the mempool mirrors. Nothing is guessed into a balance.</div>';
      }
      if (run.state === 'running') {
        var pct = run.total ? Math.round(run.done / run.total * 100) : 0;
        return '<div class="crun">' +
          '<div class="cb"><div class="cbar"><i class="' + barClass(pct) + '"></i></div>' +
          '<span id="entRun">' + esc(run.phase) + ' · ' + run.done + ' / ' + run.total + ' addresses · ' + fmtInt(run.calls) + ' calls' +
          (run.cacheHits ? ' · ' + fmtInt(run.cacheHits) + ' cached' : '') + '</span></div>' +
          '<button class="cta ghost" data-act="cancel">CANCEL</button></div>';
      }
      if (run.state === 'cancelling') {
        return '<div class="crun"><div class="cb"><span>cancelling… the request in flight is being closed</span></div></div>';
      }
      var r = run.result;
      if (!r) {
        return '<div class="cnote warn">' + esc(run.err || 'the run did not answer') + '</div>' +
          '<button class="cta" data-act="analyze">TRY AGAIN</button>';
      }
      var verifiedSats = null, estSats = 0, i;
      if (r.entity && sats(r.entity.balance) !== null) verifiedSats = r.entity.balance;
      var est = 0;
      for (i = 0; i < (r.change || []).length; i++) est += num(r.change[i].value) ? r.change[i].value : 0;
      estSats = est;
      var head = '<div class="csrc">' +
        (r.api && r.api.source === 'none'
          ? '<span class="warn">unverified · no figure could be read</span>'
          : '<span>Verified <b>' + (verifiedSats === null ? 'unknown' : fmtBtc(verifiedSats) + ' BTC') + '</b></span>' +
            '<span>· est. <b>' + fmtBtc(estSats) + ' BTC</b> across ' + (r.change || []).length + ' change output(s)</span>') +
        '</div>';
      var flags = '';
      if (r.aborted) flags += '<span class="tag warn">cancelled · partial result</span>';
      if (r.truncated) flags += '<span class="tag warn">truncated · a cap cut the scan</span>';
      if (r.rateLimited) flags += '<span class="tag warn">rate limited · unverified beyond what was read</span>';
      flags += '<span class="tag">' + fmtInt(r.coinjoinExcluded) + ' ' + plural(r.coinjoinExcluded, 'coinjoin', 'coinjoins') + ' skipped</span>';
      if (r.error) flags += '<span class="tag warn">' + esc(String(r.error).slice(0, 60)) + '</span>';
      flags += '<span class="tag">' + fmtInt(r.api ? r.api.calls : 0) + ' calls · ' +
        fmtInt(r.api ? r.api.cacheHits : 0) + ' cached · ' + fmtInt(r.stats ? r.stats.txs : 0) + ' ' +
        plural(r.stats ? r.stats.txs : 0, 'tx', 'txs') + ' read</span>';

      var clusters = '';
      (r.clusters || []).slice(0, 8).forEach(function (c) {
        var rows = c.addresses.slice(0, 12).map(function (a) {
          return '<div class="cm"><span class="badge ' + (a.label === Cluster.labels.verified ? 'v' : 'ci') + '">' + esc(a.label) + '</span>' +
            '<span class="ca" data-act="atx" data-id="' + esc(a.address) + '">' + esc(shortHash(a.address, 10, 6)) + '</span>' +
            (sats(a.balance) === null ? '<span class="cb2">not read</span>' : '<span class="cb2">' + fmtBtc(a.balance) + '</span>') +
            '</div>';
        }).join('');
        clusters += '<div class="cr">' +
          '<div class="crh"><span class="badge ' + (c.label === Cluster.labels.verified ? 'v' : 'ci') + '">' + esc(c.label) + '</span>' +
          '<span>' + c.size + ' ' + plural(c.size, 'address', 'addresses') + ' · ' + c.verified + ' verified · ' + c.heuristic + ' common-input</span>' +
          '<span class="cb2">' + (sats(c.balance) === null ? 'balance not read' : fmtBtc(c.balance) + ' BTC over ' + c.balanceKnown) + '</span></div>' +
          rows + '</div>';
      });
      var change = '';
      if ((r.change || []).length) {
        change = '<div class="cch"><div class="cchh">CHANGE ESTIMATES · never added to a cluster</div>' +
          r.change.slice(0, 6).map(function (c) {
            return '<div class="cm"><span class="badge ce">' + esc(Cluster.labels.change) + '</span>' +
              '<span class="ca">' + esc(shortHash(c.address, 10, 6)) + '</span>' +
              '<span class="cb2">' + fmtBtc(c.value) + ' · ' + esc((c.why || []).slice(0, 2).join(', ')) + '</span></div>';
          }).join('') + '</div>';
      }
      var cj = '';
      if ((r.coinjoin || []).length) {
        cj = '<div class="ccj"><div class="cchh">EXCLUDED TRANSACTIONS</div>' +
          r.coinjoin.slice(0, 4).map(function (x) {
            return '<div class="cm"><span class="ca">' + esc(shortHash(x.txid, 8, 6)) + '</span>' +
              '<span class="cb2">' + esc((x.why || []).join(' · ')) + '</span></div>';
          }).join('') + '</div>';
      }
      return '<div class="cres">' + head + '<div class="cflags">' + flags + '</div>' + clusters + change + cj +
        '<div class="cfoot">' + (r.api ? fmtInt(r.api.elapsedMs) + ' ms · source ' + esc(r.api.source) : '') +
        ' · <button class="link" data-act="analyze">run again</button></div></div>';
    }

    function detailHTML(e) {
      var b = balanceOf(e), st = ES.live[e.id];
      var addrs = e.addresses.map(addrRowHTML).join('');
      return '<div class="det">' +
        '<div class="dhead">' +
          '<div class="dic ' + esc(e.icon) + '">' + icon(e.icon) + '</div>' +
          '<div class="dttl"><div class="dsub">#' + rankOf(e.id) + ' · ' + esc(CAT_LABEL[e.category] || e.category) +
            ' · tracked ' + esc(fmtBtc(b.sats)) + ' BTC</div>' +
            '<h2>' + esc(e.name) + '</h2></div>' +
        '</div>' +
        '<div class="dtags">' + badgesHTML(e) + '<span class="st ' + esc(statusOf(st)) + '">' + esc(liveWord(statusOf(st))) + '</span></div>' +
        '<p class="ddesc">' + esc(e.description) + '</p>' +
        '<div class="dbal">' +
          '<div><span class="k">TRACKED BALANCE</span><b>' + esc(fmtBtc(b.sats)) + '</b><span class="u">BTC</span></div>' +
          '<div><span class="k">USD</span><b>' + esc(fmtUsd(usd(b.sats))) + '</b></div>' +
          '<div><span class="k">ADDRESSES</span><b>' + b.known + ' / ' + b.total + '</b><span class="u">read</span></div>' +
        '</div>' +
        '<div class="dnote">' + esc(priceNote()) + ' · the tracked figure is the sum of the addresses listed below, not the entity\'s whole holding.</div>' +
        (e.extra ? '<div class="dextra"><b>Note</b> ' + esc(e.extra) + '</div>' : '') +
        '<div class="dsec"><span>PUBLIC ADDRESSES</span><span>' + e.addresses.length + ' · ' + esc(EVIDENCE[e.evidence]) + '</span></div>' +
        addrs +
        '<div class="dsec"><span>CLUSTERING</span><span>on demand · docs/cluster-api.md</span></div>' +
        clusterHTML() +
        '<div class="dsec"><span>SOURCE</span><span>' + esc(e.id) + '</span></div>' +
        '<div class="dfoot">Balances: mempool.space address API, 5–10 minute cache, one request at a time. ' +
        'An address whose balance could not be read is marked unverified, never shown as zero.</div>' +
      '</div>';
    }

    function bodyHTML() {
      if (ES.open) {
        var e = byId(ES.open);
        if (e) return detailHTML(e);
        ES.open = '';
      }
      var rows = filtered().map(rowHTML).join('');
      if (ES.filter === 'ALL') rows = watchHTML() + rows;
      if (!rows) rows = '<div class="empty">no entity in this category</div>';
      return '<div class="list">' + rows + '</div>';
    }

    function paintSheet() {
      var sheet = $(SHEET);
      if (!sheet) return;
      setHTML('entChips', chipsHTML());
      setHTML('entBody', bodyHTML());
      txt('entKicker', ES.open ? 'ENTITY · ' + (byId(ES.open) ? byId(ES.open).category : '') : 'ENTITIES · WHALE WATCH');
      txt('entTitle', ES.open ? (byId(ES.open) ? byId(ES.open).name : 'Whale Watch') : 'Whale Watch');
      txt('entSub', list().length + ' entities · ' + addrCount() + ' public addresses · ' +
        esc(fmtBtc(trackedSats())) + ' BTC tracked · ' + CAT_NOTE[ES.filter]);
    }

    /* The progress line is repainted on every onProgress tick, so it is kept to one
       element instead of re-rendering the whole sheet. */
    function paintRunLine() {
      var el = $('entRun');
      if (!el) return;
      var run = ES.run;
      if (!run || run.state !== 'running') return;
      el.textContent = run.phase + ' · ' + run.done + ' / ' + run.total + ' addresses · ' + run.calls + ' calls';
    }

    function paintEntHud() {
      if (!ES.data) return;
      txt('vEBtc', fmtBtcCap(trackedSats()));
      txt('vECount', String(list().length));
      txt('vEAddr', fmtInt(addrCount()));
    }

    /* ---------------------------------------------------------------- sheet */
    function isOpen() {
      var el = $('ent');
      return !!(el && el.classList.contains('on'));
    }
    function open() {
      var el = $('ent');
      if (!el) return;
      ES.open = ''; ES.err = '';
      el.classList.add('on');
      Globe.hold(true);
      paintEntities();
      syncBack();
      loadPrice();
      if (!ES.at) remote();
    }
    function back() {
      if (ES.open) { ES.open = ''; ES.txOpen = ''; paintEntities(); syncBack(); return true; }
      if (ES.txOpen) { ES.txOpen = ''; paintEntities(); return true; }
      return close();
    }
    function close() {
      var el = $('ent');
      if (!el || !el.classList.contains('on')) return false;
      el.classList.remove('on');
      ES.open = ''; ES.txOpen = '';
      Globe.hold(false);
      syncBack();
      return true;
    }
    function depth() {
      if (!isOpen()) return 0;
      return ES.open ? 2 : 1;
    }
    function setFilter(c) {
      if (CATS.indexOf(c) < 0) return;
      ES.filter = c; ES.open = ''; flush();
    }
    function openEntity(id) {
      var e = byId(id);
      if (!e) return false;
      /* open() clears the detail on purpose (a sheet opened from the button is the list),
         so the id is set after it, not before. */
      var el = $('ent');
      if (el && !el.classList.contains('on')) open();
      ES.open = id; ES.txOpen = ''; ES.run = null;
      flush();
      syncBack();
      sweep(id);
      return true;
    }
    function toggleTx(addr) {
      if (!validAddr(addr)) return;
      ES.txOpen = ES.txOpen === addr ? '' : addr;
      if (ES.txOpen) readTxs(addr);
      flush();
    }

    /* --------------------------------------------------------------- cluster */
    function analyze() {
      var e = byId(ES.open);
      if (!e) return Promise.resolve(null);
      var seeds = e.addresses.map(function (a) {
        return { address: a.address, verified: true, label: a.label, source: a.source };
      });
      var id = e.id;
      ES.run = { id: id, state: 'running', phase: 'start', done: 0, total: seeds.length, calls: 0, cacheHits: 0, result: null, err: '' };
      paintEntities();
      return Cluster.analyzeEntity(seeds, {
        maxTxsPerAddress: 20,
        maxApiCalls: 18,
        onProgress: function (p) {
          if (!ES.run || ES.run.id !== id) return;
          ES.run.phase = p.phase; ES.run.done = p.done; ES.run.total = p.total;
          ES.run.calls = p.calls; ES.run.cacheHits = p.cacheHits;
          paintRunLine();
        }
      }).then(function (res) {
        if (!ES.run || ES.run.id !== id) return res;
        ES.run.state = res.aborted ? 'aborted' : (res.ok ? 'done' : 'error');
        ES.run.result = res;
        ES.run.err = res.error || '';
        flush();
        return res;
      }, function (err) {
        if (ES.run && ES.run.id === id) {
          ES.run.state = 'error';
          ES.run.err = String((err && err.message) || err);
          flush();
        }
        return null;
      });
    }
    function cancel() {
      if (!ES.run || ES.run.state !== 'running') return false;
      ES.run.state = 'cancelling';
      var stopped = Cluster.cancelCluster();
      flush();
      return stopped;
    }

    /* ---------------------------------------------------------------- remote */
    /* The published table is optional: it is the same shape as the seed, it is only
       adopted when it parses and is newer, and a failure leaves the seed in place without
       a toast. No bridge: corejbh.github.io is not one of the hosts the native allowlist
       carries, and a page fetch is enough for a static file. */
    function remote() {
      if (typeof fetch !== 'function' || (typeof offline === 'function' && offline())) {
        ES.remote = 'off';
        return Promise.resolve(false);
      }
      ES.remote = 'loading';
      var ctrl = null, timer = null, opt = { cache: 'no-cache', credentials: 'omit', mode: 'cors' };
      if (typeof AbortController !== 'undefined') {
        ctrl = new AbortController();
        opt.signal = ctrl.signal;
        timer = setTimeout(function () { try { ctrl.abort(); } catch (e) { } }, REMOTE_MS);
      }
      return fetch(REMOTE_URL, opt).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      }).then(function (raw) {
        if (timer) clearTimeout(timer);
        var m = normPayload(raw);
        if (!m) { ES.remote = 'bad'; return false; }
        var newer = m.v > ES.v || (m.v === ES.v && m.at && Date.parse(m.at) > (ES.at || 0));
        if (!newer) { ES.remote = 'current'; return false; }
        if (adopt(raw, 'remote')) {
          store(LS_REMOTE, raw);
          ES.remote = 'updated';
          paintEntities();
          return true;
        }
        ES.remote = 'bad';
        return false;
      }).catch(function () {
        if (timer) clearTimeout(timer);
        ES.remote = 'off';
        return false;
      });
    }

    /* ---------------------------------------------------------------- clicks */
    function actOf(el, stop) {
      while (el && el !== stop && el.nodeType !== 9) {
        if (el.getAttribute) {
          var act = el.getAttribute('data-act');
          if (act) return { act: act, id: el.getAttribute('data-id') || '' };
        }
        el = el.parentNode;
      }
      return null;
    }

    function onAct(a) {
      if (!a) return;
      if (a.act === 'filter') return setFilter(a.id);
      if (a.act === 'open') return openEntity(a.id);
      if (a.act === 'back') return back();
      if (a.act === 'close') return close();
      if (a.act === 'analyze') return analyze();
      if (a.act === 'cancel') return cancel();
      if (a.act === 'atx' || a.act === 'wtx') return toggleTx(a.id);
      if (a.act === 'wdel') return watchDel(a.id);
      if (a.act === 'wadd') {
        var input = $('entWatchInput');
        var res = watchAdd(input ? input.value : '', '');
        ES.err = res.ok ? '' : res.err;
        if (res.ok && input) input.value = '';
        paintEntities();
        return res;
      }
      return null;
    }

    function bind() {
      var sheet = $('ent');
      if (sheet && !sheet._entBound) {
        sheet._entBound = true;
        sheet.addEventListener('click', function (e) {
          var a = actOf(e.target, sheet);
          if (!a) return;
          if (e.preventDefault) e.preventDefault();
          onAct(a);
        });
        sheet.addEventListener('keydown', function (e) {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          var a = actOf(e.target, sheet);
          if (a && (a.act === 'open' || a.act === 'filter')) { if (e.preventDefault) e.preventDefault(); onAct(a); }
        });
      }
    }

    /* ------------------------------------------------------------------ boot */
    function init() {
      var cached = recall(LS_REMOTE);
      if (!(cached && adopt(cached, 'cache'))) {
        adopt(typeof ENTITIES !== 'undefined' ? ENTITIES : null, 'seed');
      }
      ES.watch = watchFrom(recall(LS_WATCH));
      bind();
      paintEntities();
      loadPrice();
      /* the published table is asked for once the first paint is on screen */
      setTimeout(function () { remote(); }, 1200);
      /* A watched address comes back with its balance and its latest transactions: three
         reads at most on a launch, one at a time through the clustering engine's cache. */
      for (var i = 0; i < ES.watch.length && i < 3; i++) {
        (function (addr) {
          readTxs(addr);
          Cluster.fetchAddressSummary(addr, { ttlMs: LIVE_TTL }).then(function (sum) {
            ES.watchLive[addr] = { sats: sum.balance, tx: sum.txCount, src: sum.source, at: sum.at };
            paintEntities();
          }, function (err) {
            ES.watchLive[addr] = { err: err && err.status === 429 ? 'rate limited' : 'unverified' };
            paintEntities();
          });
        })(ES.watch[i].address);
      }
      return !!ES.data;
    }

    return {
      init: init, paint: paintEntities, open: open, close: close, back: back, depth: depth,
      isOpen: isOpen, setFilter: setFilter, openEntity: openEntity, analyze: analyze, cancel: cancel,
      sweep: sweep, readTxs: readTxs, loadPrice: loadPrice, remote: remote,
      watchAdd: watchAdd, watchDel: watchDel, toggleTx: toggleTx, act: onAct,
      usd: usd, fmtUsd: fmtUsd, ranked: ranked, filtered: filtered, byId: byId,
      balanceOf: balanceOf, liveState: liveState, trackedSats: trackedSats,
      addrCount: addrCount, entityOfAddress: entityOfAddress,
      state: ES, cats: CATS, remoteUrl: REMOTE_URL
    };
  })();
