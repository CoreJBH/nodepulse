/* Entities / Whale Watch: the seed table of public entity addresses, the optional
   refresh from the published JSON, the balance and transaction reads, the watchlist and
   the panel that draws all of it.

   The rule of the rest of the app applies here without exception: every figure on screen
   is a figure an API returned, and every address is one a public source names. The seed
   (src/data/entities-data.js) is the verified table — 235 entities, 1,899 addresses, each
   confirmed against mempool.space — and this module never invents an address, a balance
   or a rank beyond it.

   What it does:
     · adopts the seed at boot, then quietly tries https://corejbh.github.io/nodepulse/
       entities.json; a newer payload replaces it in localStorage, a failure changes
       nothing and says nothing (the seed is already the verified table).
     · ranks entities by the BTC they are held to have, highest first: the addresses read
       (or their verified seed figure) plus any estimate the card can name — the Patoshi
       pattern from the table, and the common-input balances and change outputs a finished
       clustering run read. The verified part is never overwritten; it is printed beside
       the estimate in every total.
     · reads balances on demand, one address at a time, through Cluster.fetchAddressSummary
       (same 7-minute cache as the clustering engine) with a 429 treated as "rate limited"
       rather than as a zero.
     · reads the recent transactions of one address when its row is opened, and marks a
       counterparty that is another known entity.
     · keeps a watchlist of any address the user adds, in localStorage.
     · runs Cluster.analyzeEntity() for the entity on screen and shows its result by the
       display rules of docs/cluster-api.md §8: the total names its seed and Est. parts, the
       labels stay separate badges (a seed the table lists on an attribution is Attributed,
       never Verified), the coinjoin count is its own number, and a truncated, rate-limited
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
    var SWEEP_TOP = 30;                // background balance refresh covers the top N entities
    var ADDR_CAP = 250;                // addresses one entity may carry
    var MAX_SUPPLY = 2099999997690000; // 20,999,999.9769 BTC: the halving subsidy summed to its last satoshi
    var SUBSIDY_EPOCH = 210000;        // blocks per halving epoch
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
      ests: Object.create(null),          // entity id -> what its last clustering run read beyond the seeds
      price: null, priceAt: 0, priceSrc: '',
      run: null, runSeq: 0, remote: 'idle', err: '',
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
      var addrs = [], total = 0, liveAny = false, est = normEst(raw.est);
      for (var i = 0; i < list.length && addrs.length < ADDR_CAP; i++) {
        var a = list[i];
        if (!isObj(a) || !validAddr(a.address)) continue;
        var bal = sats(a.sats);
        if (bal === null) continue;
        var live = a.live === true;
        addrs.push({
          address: a.address,
          label: typeof a.label === 'string' ? a.label.slice(0, 160) : '',
          sats: bal,
          /* Coins the address is known to hold but the address API leaves out of its
             statistics (the block-1 P2PK coinbase). A live read adds it back. */
          p2pkSats: sats(a.p2pkSats) || 0,
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
        est: est,
        addresses: addrs,
        /* A card whose public addresses cover only part of the entity says so; the
           reported figure is the disclosure the coverage note names, never a read value. */
        coverage: raw.coverage === 'partial' ? 'partial' : 'full',
        reportedSats: sats(raw.reportedSats),
        reportedNote: typeof raw.reportedNote === 'string' ? raw.reportedNote.slice(0, 400) : '',
        total: total
      };
    }

    /* The estimate a seed entity carries (the Patoshi pattern), typed like a balance: a
       whole number of satoshis off an unapproved payload is dropped, not rounded. */
    function normEst(raw) {
      if (!isObj(raw)) return null;
      var v = sats(raw.sats);
      if (v === null || v <= 0) return null;
      return {
        label: typeof raw.label === 'string' && raw.label ? raw.label.slice(0, 40) : 'Est.',
        sats: v,
        note: typeof raw.note === 'string' ? raw.note.slice(0, 400) : ''
      };
    }

    function normPayload(raw) {
      if (!isObj(raw) || !isArr(raw.list)) return null;
      var list = [], seen = Object.create(null), tracked = 0;
      for (var i = 0; i < raw.list.length && list.length < 400; i++) {
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
       ever extrapolated from one address to another. `known` counts the addresses whose
       balance was actually read (live or from the engine's cache) — a card that fell back
       to the seed figure says "0 / 3 read", not "3 / 3 read" on an empty wallet that was
       never asked. */
    function balanceOf(e) {
      var st = ES.live[e.id], out = { sats: 0, known: 0, total: e.addresses.length, live: 0, cached: 0, seed: 0 };
      for (var i = 0; i < e.addresses.length; i++) {
        var a = e.addresses[i], row = st && st.addrs[a.address];
        if (row && sats(row.sats) !== null) {
          out.sats += row.sats; out.known++;
          if (row.src === 'live') out.live++; else out.cached++;
        } else {
          out.sats += a.sats; out.seed++;          // the verified seed figure, not a read
        }
      }
      return out;
    }

    /* ------------------------------------------------------------ estimates */
    /* What a finished run read beyond the verified addresses, each address counted once:
       the balance of a Common-Input address the run actually read, and a change output it
       read out of a transaction. A verified seed and any address already counted here is
       skipped, so the two parts cannot double-count the same coins. An address whose
       balance was not read contributes nothing: an estimate is a figure that was read,
       never one that was assumed. */
    function runEstimate(r) {
      var out = { verified: 0, attributed: 0, common: 0, change: 0, commonN: 0, changeN: 0, sats: 0 };
      if (!r) return out;
      if (r.entity && sats(r.entity.balance) !== null) out.verified = r.entity.balance;
      if (r.entity && sats(r.entity.attributedBalance) !== null) out.attributed = r.entity.attributedBalance;
      var seen = Object.create(null), i, j, a, m;
      if (isArr(r.addresses)) for (i = 0; i < r.addresses.length; i++) {
        a = r.addresses[i];
        if (isObj(a) && a.verified === true) seen[a.address] = true;
      }
      var clusters = isArr(r.clusters) ? r.clusters : [];
      for (i = 0; i < clusters.length; i++) {
        var mem = isArr(clusters[i].addresses) ? clusters[i].addresses : [];
        for (j = 0; j < mem.length; j++) {
          m = mem[j];
          if (!isObj(m) || !validAddr(m.address)) continue;
          if (m.verified === true || seen[m.address]) { seen[m.address] = true; continue; }
          seen[m.address] = true;
          if (sats(m.balance) === null) continue;
          out.common += m.balance; out.commonN++;
        }
      }
      var ch = isArr(r.change) ? r.change : [];
      for (i = 0; i < ch.length; i++) {
        a = ch[i];
        if (!isObj(a) || !validAddr(a.address) || seen[a.address]) continue;
        if (sats(a.value) === null) continue;
        seen[a.address] = true;
        out.change += a.value; out.changeN++;
      }
      out.sats = out.common + out.change;
      return out;
    }

    /* The estimated part of an entity: the seed's own estimate where the table names one,
       plus what a finished run on this entity read. Kept per id, so the number survives
       closing the card and the ranking does not fall back when the sheet is reopened. */
    function estOf(e) {
      var seed = e.est ? e.est.sats : 0;
      var run = ES.ests[e.id] || null;
      return {
        seed: seed, run: run ? run.sats : 0,
        common: run ? run.common : 0, change: run ? run.change : 0,
        commonN: run ? run.commonN : 0, changeN: run ? run.changeN : 0,
        verified: run ? run.verified : 0,
        sats: seed + (run ? run.sats : 0)
      };
    }
    /* The one figure the tab ranks on and the HUD adds up: what the addresses hold plus
       the estimates printed beside it. */
    function heldOf(e) { return balanceOf(e).sats + estOf(e).sats; }

    /* --------------------------------------------------------- entity figures */
    /* A number on this tab is written to three decimals at most, and as a whole number once
       it passes 1,000 BTC: an eleven-character figure in a phone's right-hand column used to
       be cut to its first five ("~1,100,109.5185" read as "~1,100"). The exact sats stay in
       the payload; this is only how many of them the card prints. */
    function fmtEnt(v, whole) {
      if (!num(v)) return '—';
      var b = v / 1e8;
      if (b === 0) return '0';
      if (b < 0) return '−' + fmtEnt(-v, whole);
      if (whole && b >= 1000) return fmtInt(Math.round(b));
      if (b < 0.001) return '<0.001';
      var s = (Math.round(b * 1000) / 1000).toFixed(3).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
      var parts = s.split('.');
      parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
      return parts.join('.');
    }

    /* Mined supply from the block height, the way the protocol counts it: 210,000 blocks per
       epoch and a subsidy that halves each epoch, rounded down to whole satoshis, which is
       what makes the last coins stop being mined around block 6,930,000. */
    function minedSats(height) {
      if (!num(height) || height <= 0) return null;
      var h = Math.min(Math.floor(height), 33 * SUBSIDY_EPOCH);
      var total = 0, epoch = 0, left = h;
      while (left > 0) {
        var n = Math.min(left, SUBSIDY_EPOCH);
        var sub = Math.floor(5000000000 / Math.pow(2, epoch));
        total += n * sub;
        left -= n; epoch++;
      }
      return Math.min(total, MAX_SUPPLY);
    }
    function heightNow() {
      return (typeof S !== 'undefined' && S && num(S.tip)) ? S.tip : null;
    }

    /* A large estimate reads in millions (the Patoshi ~1.1M BTC), a small one in the sats
       formatter's own precision; neither is ever rounded into the total it is added to. */
    function fmtBtcShort(v) {
      if (!num(v)) return '—';
      if (v >= 1e14) {
        var m = v / 1e14;
        return (m >= 10 ? m.toFixed(1) : m.toFixed(2)).replace(/\.?0+$/, '') + 'M';
      }
      return fmtBtc(v);
    }
    /* The breakdown printed with every total that carries an estimate. The seed part carries
       the table's own word: an entity listed on an analytics attribution says Attributed. */
    function heldBreakdown(e) {
      var b = balanceOf(e), o = estOf(e);
      var out = (e.evidence === 'attributed' ? 'Attributed ' : 'Verified ') + fmtEnt(b.sats) + ' BTC';
      if (o.seed) out += ' + ' + (e.est.label || 'Est.') + ' ~' + fmtBtcShort(o.seed) + ' BTC';
      if (o.common) out += ' + common-input ' + fmtEnt(o.common) + ' BTC';
      if (o.change) out += ' + change est. ' + fmtEnt(o.change) + ' BTC';
      return out;
    }

    function trackedSats() {
      var sum = 0, l = list();
      for (var i = 0; i < l.length; i++) sum += heldOf(l[i]);
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
      for (var i = 0; i < e.addresses.length; i++) if (e.addresses[i].live) targets.push(e.addresses[i]);
      st.total = targets.length; st.done = 0; st.rate = false; st.failed = 0; st.err = '';
      if (!targets.length) { st.state = 'static'; st.at = Date.now(); paintEntities(); return Promise.resolve(st); }
      st.state = 'loading';
      st.p = targets.reduce(function (p, a) {
        return p.then(function () {
          if (st.state !== 'loading') return null;      // cancelled or re-run
          return Cluster.fetchAddressSummary(a.address, { ttlMs: LIVE_TTL }).then(function (sum) {
            /* The block-1 coinbase: its 50 BTC P2PK output is unspent but is not in the
               address statistics, so a live answer must have it added back or the card
               would lose the one output that makes the address Satoshi's. */
            st.addrs[a.address] = { sats: sum.balance + a.p2pkSats, tx: sum.txCount, src: sum.source, at: sum.at };
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
    /* Ranked by the BTC the entity is held to have — the addresses read plus the estimate
       printed beside them — highest first, and only the entities that hold something: an
       entity whose tracked total is 0 sats (all of its coins were sold, or the seizure was
       liquidated) has no place in a ranking of holders, so it is left out rather than shown
       at #87 with a zero. Each tab ranks its own field in full: every entity that holds
       something is listed, so the list carries the whole table rather than a cut of it. */
    function rankList(cat) {
      var l = list().filter(function (e) {
        return heldOf(e) > 0 && (cat === 'ALL' || e.category === cat);
      });
      l.sort(function (a, b) { return heldOf(b) - heldOf(a) || (a.name < b.name ? -1 : 1); });
      return l.map(function (e, i) { return { e: e, rank: i + 1 }; });
    }
    function ranked() { return rankList('ALL'); }
    function rankOf(id) {
      var e = byId(id);
      if (!e) return 0;
      var r = rankList(e.category);
      for (var i = 0; i < r.length; i++) if (r[i].e.id === id) return r[i].rank;
      return 0;
    }
    function filtered() { return rankList(ES.filter); }
    /* How many entities hold something — the table can be larger than the 100 a tab prints. */
    function heldCount() {
      var l = list(), n = 0;
      for (var i = 0; i < l.length; i++) if (heldOf(l[i]) > 0) n++;
      return n;
    }
    /* How many entities the ranking leaves out because they hold nothing right now. */
    function zeroCount() {
      var l = list(), n = 0;
      for (var i = 0; i < l.length; i++) if (heldOf(l[i]) <= 0) n++;
      return n;
    }

    /* ---------------------------------------------------------------- icons */
    /* Minimal line icons, 24x24, stroke only, in the two entity accents (#00E5FF and
       #3B82F6 from app.css --ec / --ec2). A hacker card keeps its mask even though the
       category chip above it reads OTHER.

       Every child tag is written with an explicit closing tag. A browser serialises SVG
       back as <path …></path>, so a self-closing <path …/> in the string we wrote never
       equals e.innerHTML afterwards: the panel would decide its markup had changed on
       every tick, rebuild itself, and wipe the watchlist input's text and focus once a
       second. The markup here is what the browser hands back, so a repaint with the same
       data writes nothing. */
    function icon(kind, cls) {
      var d;
      if (kind === 'person') {
        d = '<circle cx="12" cy="8" r="3.4"></circle><path d="M4.8 20c0-3.6 3.2-6 7.2-6s7.2 2.4 7.2 6"></path>';
      } else if (kind === 'corp') {
        d = '<path d="M3.4 20.2V9.4h8.2v10.8M11.6 20.2V4.6h9V20.2"></path><path d="M6 12.2h2.2M6 15.4h2.2M14.4 8h3M14.4 11.4h3M14.4 14.8h3"></path>';
      } else if (kind === 'gov') {
        d = '<path d="M3 20.4h18M4.6 20.4V10M19.4 20.4V10M12 3.4 3 9.6h18L12 3.4Z"></path><path d="M8.4 20.4v-7M12 20.4v-7M15.6 20.4v-7"></path>';
      } else if (kind === 'dots') {
        d = '<circle cx="12" cy="12" r="8.6"></circle><circle cx="8.5" cy="12" r=".85"></circle>' +
            '<circle cx="12" cy="12" r=".85"></circle><circle cx="15.5" cy="12" r=".85"></circle>';
      } else if (kind === 'hacker') {
        d = '<path d="M12 3.2c-4.9 0-8.2 3.5-8.2 8.1 0 3.4 1.4 5.4 2.6 6.5l.5 2.9h10.2l.5-2.9c1.2-1.1 2.6-3.1 2.6-6.5 0-4.6-3.3-8.1-8.2-8.1Z"></path>' +
            '<path d="M7.6 11.6h3.2M13.2 11.6h3.2"></path><path d="M9.4 16.4c1.6.9 3.6.9 5.2 0"></path>';
      } else {
        d = '<circle cx="8.6" cy="8.4" r="2.9"></circle><path d="M2.8 19c0-3.1 2.6-5.2 5.8-5.2s5.8 2.1 5.8 5.2"></path>' +
            '<circle cx="16.6" cy="9.6" r="2.4"></circle><path d="M14.6 13.6c2.9-.4 6.4 1.3 6.4 4.6"></path>';
      }
      return '<svg class="ico' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
        'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + '</svg>';
    }

    /* ---------------------------------------------------------------- paint */
    var SHEET = 'entSheet';
    var paintQueued = false;

    function entPaintNow(force) {
      /* A background tick only rebuilds the sheet's DOM while it is on screen; the HUD, the
         dashboard and the row under the title are always current, because they are what the
         tab shows when the sheet is closed. A user action (`force`) always repaints, so a
         click and the screen can never disagree. */
      if (force || isOpen()) paintSheet();
      paintEntHud();
      paintDash();
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
      /* A card built from the public subset of an entity that keeps thousands of addresses
         says so on its face, not only in the small print. */
      if (e.coverage === 'partial') out += '<span class="tag dim">partial coverage</span>';
      if (!e.live) out += '<span class="tag dim">static</span>';
      return out;
    }

    function rowHTML(x) {
      var e = x.e, b = balanceOf(e), st = ES.live[e.id], o = estOf(e);
      var state = st ? st.state : 'idle';
      var held = b.sats + o.sats;
      return '<div class="erow" data-act="open" data-id="' + esc(e.id) + '" role="button" tabindex="0">' +
        '<div class="rk">#' + x.rank + '</div>' +
        '<div class="ic ' + esc(e.icon) + '">' + icon(e.icon) + '</div>' +
        '<div class="main">' +
          '<div class="nm">' + esc(e.name) + '</div>' +
          '<div class="meta"><span class="cat">' + esc(CAT_LABEL[e.category] || e.category) + '</span>' +
            badgesHTML(e) +
            '<span class="st ' + esc(state) + '">' + esc(liveWord(statusOf(st))) + '</span>' +
          '</div>' +
          (o.sats ? '<div class="estb">' + esc(heldBreakdown(e)) + '</div>' : '') +
        '</div>' +
        '<div class="val">' + esc(fmtEnt(held, true)) + '<span class="u">BTC</span>' +
          '<small>' + esc(fmtUsd(usd(held))) + '</small></div>' +
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
        var bal = st && sats(st.sats) !== null ? fmtEnt(st.sats) + ' BTC' : (st && st.err ? st.err : 'reading…');
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
      var bal = addrBal(a);
      var src = row ? (row.src === 'live' ? 'live' : 'cached') : (limit || (a.live ? 'verified ' + shortDate(ES.at) : 'static'));
      var cls = row ? (row.src === 'live' ? 'live' : 'cache') : (a.live ? 'seed' : 'static');
      return '<div class="arow">' +
        '<div class="atop"><button class="aaddr" data-act="atx" data-id="' + esc(a.address) + '">' +
          esc(shortHash(a.address, 12, 8)) + '</button>' +
          '<span class="abal">' + esc(fmtEnt(bal)) + '<span class="u">BTC</span></span></div>' +
        '<div class="alab">' + esc(a.label) + '</div>' +
        '<div class="ameta"><span class="badge ' + cls + '">' + esc(src) + '</span>' +
          '<span class="src">' + esc(sourceHost(a.source)) + '</span>' +
          (row && num(row.tx) ? '<span class="src">' + fmtInt(row.tx) + ' tx</span>' : '') + '</div>' +
        (a.note ? '<div class="anote">' + esc(a.note) + '</div>' : '') +
        (ES.txOpen === a.address ? '<div class="wtx">' + txHTML(a.address) + '</div>' : '') +
      '</div>';
    }
    /* The balance a card prints for one address: the live read if the card has one, or the
       verified seed figure. An address that holds nothing is left off the card's list — a
       zero row is noise, and dozens of entities carry one (Bitfinex alone lists 119 spent
       addresses) — unless the reader put that address on the watchlist, which keeps it. */
    function addrBal(a) {
      var st = ES.live[ES.open], row = st && st.addrs[a.address];
      return (row && sats(row.sats) !== null) ? row.sats : a.sats;
    }
    function isWatched(addr) {
      for (var i = 0; i < ES.watch.length; i++) if (ES.watch[i].address === addr) return true;
      return false;
    }
    function shownAddrs(e) {
      var out = [], empty = 0;
      for (var i = 0; i < e.addresses.length; i++) {
        var a = e.addresses[i];
        if (addrBal(a) > 0 || isWatched(a.address)) out.push(a); else empty++;
      }
      return { list: out, empty: empty };
    }
    function sourceHost(u) {
      var m = String(u || '').match(/^https?:\/\/([^\/]+)/i);
      return m ? m[1] : (u || '');
    }

    /* The badge class for a cluster label: verified green, attributed amber, a change
       estimate yellow, common-input cyan. */
    function labelClass(l) {
      return l === Cluster.labels.verified ? 'v'
        : l === Cluster.labels.attributed ? 'at'
        : l === Cluster.labels.change ? 'ce' : 'ci';
    }

    /* docs/cluster-api.md §8, line by line: the labels stay apart, the coinjoin
       count is its own figure, and a run that was cut, limited or empty says which. */
    function clusterHTML() {
      var run = ES.run;
      if (!run) {
        return '<button class="cta" data-act="analyze">ANALYZE CLUSTER</button>' +
          '<div class="cnote">Common-input ownership and change estimation over the addresses above, ' +
          'one transaction list at a time through the mempool mirrors. The verified balances stay ' +
          'verified; whatever the heuristics find is added to the total as an estimate and named beside it.</div>';
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
      /* The seed part is called what the table calls it: an entity whose addresses rest on
         an analytics attribution prints ``Attributed'', never ``Verified''. An estimate a
         run read is added to both, and the whole line is skipped when nothing was read. */
      var seed = null, o = runEstimate(r);
      if (r.entity && sats(r.entity.balance) !== null) seed = { word: 'Verified', sats: r.entity.balance };
      else if (r.entity && sats(r.entity.attributedBalance) !== null) seed = { word: 'Attributed', sats: r.entity.attributedBalance };
      var totalSats = (seed === null ? 0 : seed.sats) + o.sats;
      var head = '<div class="csrc">' +
        (r.api && r.api.source === 'none'
          ? '<span class="warn">unverified · no figure could be read</span>'
          : '<span>TOTAL <b>' + fmtBtc(totalSats) + ' BTC</b></span>' +
            '<span>· ' + (seed ? esc(seed.word) : 'Seed') + ' <b>' + (seed === null ? 'unknown' : fmtBtc(seed.sats) + ' BTC') + '</b></span>' +
            '<span>· Est. <b>' + fmtBtc(o.sats) + ' BTC</b> · ' + fmtInt(o.commonN) + ' common-input, ' +
            fmtInt(o.changeN) + ' ' + plural(o.changeN, 'change output', 'change outputs') + '</span>') +
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
          return '<div class="cm"><span class="badge ' + labelClass(a.label) + '">' + esc(a.label) + '</span>' +
            '<span class="ca" data-act="atx" data-id="' + esc(a.address) + '">' + esc(shortHash(a.address, 10, 6)) + '</span>' +
            (sats(a.balance) === null ? '<span class="cb2">not read</span>' : '<span class="cb2">' + fmtBtc(a.balance) + '</span>') +
            '</div>';
        }).join('');
        var attributed = num(c.attributed) ? c.attributed : 0;
        clusters += '<div class="cr">' +
          '<div class="crh"><span class="badge ' + labelClass(c.label) + '">' + esc(c.label) + '</span>' +
          '<span>' + c.size + ' ' + plural(c.size, 'address', 'addresses') + ' · ' + c.verified + ' verified' +
            (attributed ? ' · ' + attributed + ' attributed' : '') + ' · ' + c.heuristic + ' common-input</span>' +
          '<span class="cb2">' + (sats(c.balance) === null ? 'balance not read' : fmtBtc(c.balance) + ' BTC over ' + c.balanceKnown) + '</span></div>' +
          rows + '</div>';
      });
      var change = '';
      if ((r.change || []).length) {
        change = '<div class="cch"><div class="cchh">CHANGE ESTIMATES · added to the total, never to a cluster</div>' +
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
      var b = balanceOf(e), st = ES.live[e.id], o = estOf(e);
      var held = b.sats + o.sats;
      var shown = shownAddrs(e);
      var addrs = shown.list.map(addrRowHTML).join('');
      var rank = rankOf(e.id);
      var scope = e.category === 'ALL' ? '' : ' · ' + esc(CAT_LABEL[e.category] || e.category);
      return '<div class="det">' +
        '<div class="dhead">' +
          '<div class="dic ' + esc(e.icon) + '">' + icon(e.icon) + '</div>' +
          '<div class="dttl"><div class="dsub">' + (rank ? '#' + rank + scope : 'not ranked · holds 0 BTC') +
            ' · held ' + esc(fmtEnt(held)) + ' BTC</div>' +
            '<h2>' + esc(e.name) + '</h2></div>' +
        '</div>' +
        '<div class="dtags">' + badgesHTML(e) + '<span class="st ' + esc(statusOf(st)) + '">' + esc(liveWord(statusOf(st))) + '</span></div>' +
        '<p class="ddesc">' + esc(e.description) + '</p>' +
        '<div class="dbal">' +
          '<div><span class="k">HELD BALANCE</span><b>' + esc(fmtEnt(held)) + '</b><span class="u">BTC</span>' +
            (o.sats ? '<span class="bd">' + esc(heldBreakdown(e)) + '</span>' : '') + '</div>' +
          '<div><span class="k">USD</span><b>' + esc(fmtUsd(usd(held))) + '</b></div>' +
          '<div><span class="k">ADDRESSES</span><b>' + b.known + ' / ' + b.total + '</b><span class="u">read</span></div>' +
        '</div>' +
        (e.reportedSats || e.coverage === 'partial'
          ? '<div class="dcov"><b>COVERAGE</b> ' +
            (e.reportedSats ? 'Reported ' + esc(fmtEnt(e.reportedSats)) + ' BTC' : 'Tracked addresses only') +
            (e.reportedNote ? ' · ' + esc(e.reportedNote) : '') +
            (e.coverage === 'partial' && !e.reported ? ' · partial coverage: the entity holds coins at addresses it does not publish.' : '') + '</div>'
          : '') +
        '<div class="dnote">' + esc(priceNote()) + ' · the held figure is the sum of the addresses listed below plus the estimates named beside it, not the entity\'s whole holding.</div>' +
        (e.extra ? '<div class="dextra"><b>Note</b> ' + esc(e.extra) + '</div>' : '') +
        (e.est && e.est.note ? '<div class="dextra"><b>' + esc(e.est.label) + '</b> ' + esc(e.est.note) + '</div>' : '') +
        (st && st.rate
          ? '<div class="anote">rate limited · the mirror refused the reads; every figure below is the verified seed as of ' + esc(shortDate(ES.at)) + '</div>'
          : '') +
        '<div class="dsec"><span>PUBLIC ADDRESSES</span><span>' + shown.list.length + ' of ' + e.addresses.length + ' · ' + esc(EVIDENCE[e.evidence]) + '</span></div>' +
        addrs +
        (shown.empty
          ? '<div class="anote">' + fmtInt(shown.empty) + ' empty ' + plural(shown.empty, 'address', 'addresses') +
            ' omitted · read balance 0 BTC</div>'
          : '') +
        '<div class="dsec"><span>CLUSTERING</span><span>on demand · docs/cluster-api.md</span></div>' +
        clusterHTML() +
        '<div class="dsec"><span>SOURCE</span><span>' + esc(e.id) + '</span></div>' +
        '<div class="dfoot">Balances: mempool.space address API, 5–10 minute cache, one request at a time. ' +
        'An address whose balance could not be read is marked unverified, never shown as zero.</div>' +
      '</div>';
    }

    /* --------------------------------------------- background balance refresh */
    /* The table now carries hundreds of addresses. Asking mempool.space for all of them at
       launch is a burst the mirrors answer with 429, and a 429 on the first cards would look
       like every entity holds nothing. So the app shows the verified seed and the published
       JSON at once — every figure on screen already carries a balance read from that API —
       and then refreshes quietly in the background: the top SWEEP_TOP entities, one address
       each (the largest one the table lists), one request at a time, 400 ms apart. A tapped
       card still reads all of its own addresses, and REFRESH runs the top pass again. */
    var sweepTopState = { state: 'idle', done: 0, total: 0, at: 0, err: '', rate: false };

    function biggestAddr(e) {
      var best = null;
      for (var i = 0; i < e.addresses.length; i++) {
        var a = e.addresses[i];
        if (!best || a.sats > best.sats) best = a;
      }
      return best;
    }

    function sweepTop(force) {
      if (sweepTopState.state === 'loading' && sweepTopState.p) return sweepTopState.p;
      if (!force && sweepTopState.at && Date.now() - sweepTopState.at < LIVE_TTL) return Promise.resolve(sweepTopState);
      var top = ranked().slice(0, SWEEP_TOP), i = 0;
      sweepTopState = { state: 'loading', done: 0, total: top.length, at: 0, err: '', rate: false };
      var settle;
      var p = new Promise(function (res) { settle = res; });
      sweepTopState.p = p;
      function step() {
        if (sweepTopState.state !== 'loading' || i >= top.length) {
          sweepTopState.state = sweepTopState.rate ? 'rate-limited' : 'done';
          sweepTopState.at = Date.now();
          paintEntities();
          settle(sweepTopState);
          return;
        }
        var e = top[i++].e, a = biggestAddr(e);
        if (!a) return step();
        sweepTopState.done++;
        Cluster.fetchAddressSummary(a.address, { ttlMs: LIVE_TTL }).then(function (sum) {
          liveState(e.id).addrs[a.address] = { sats: sum.balance + a.p2pkSats, tx: sum.txCount, src: sum.source, at: sum.at };
          paintEntities();
          setTimeout(step, 400);
        }, function (err) {
          if (err && err.status === 429) { sweepTopState.rate = true; sweepTopState.err = 'rate limited'; }
          /* A limit is a reason to stop asking, not a reason to change a figure: the seed
             balance stays where it was and the card keeps saying when it was read. */
          setTimeout(step, sweepTopState.rate ? 0 : 400);
        });
      }
      step();
      return p;
    }

    /* ---------------------------------------------------------------- supply */
    /* What the dashboard prints above the ranking: the 21M cap, how much of it the chain has
       paid out at the height on screen, how much of that this table can see, and the rest.
       Read from S.tip, so a block arriving moves it by one subsidy. */
    function supplyNow() {
      var h = heightNow();
      var mined = minedSats(h);
      var tracked = trackedSats();
      return {
        height: h, mined: mined,
        unmined: mined === null ? null : Math.max(0, MAX_SUPPLY - mined),
        tracked: tracked,
        private: mined === null ? null : Math.max(0, mined - tracked),
        max: MAX_SUPPLY
      };
    }

    function pct(part, whole) {
      if (!num(part) || !num(whole) || whole <= 0) return '—';
      var p = part / whole * 100;
      return p >= 10 ? p.toFixed(1) : p >= 1 ? p.toFixed(2) : p.toFixed(3);
    }

    function catTotals() {
      var out = {};
      CATS.forEach(function (c) { if (c !== 'ALL') out[c] = { sats: 0, n: 0, ranked: 0 }; });
      var l = list();
      for (var i = 0; i < l.length; i++) {
        var t = out[l[i].category];
        if (!t) continue;
        t.n++;
        var h = heldOf(l[i]);
        t.sats += h;
        if (h > 0) t.ranked++;
      }
      return out;
    }

    /* ------------------------------------------------------------ dashboard */
    /* The ENTITIES layer draws no point on the globe, so the tab lands on the supply split
       and the four category cards, and the ranking sheet is behind the + button. The panel
       is drawn as soon as the layer is active — under the sheet, not after it — because a
       dashboard that starts drawing when the sheet closes is a stutter the eye reads as
       lag, while one that is already there is simply revealed.

       Every figure below comes from the same functions the cards and the HUD use: the cap
       from the protocol's own subsidy maths, the split from S.tip, the entities from the
       table. Nothing here is a constant except the year the last subsidy stops (2140) and
       the colours of the design. */
    /* The category cards carry the icon that reads the category at a glance: a person, a
       building, a state house, and three dots for everything else (the mask an entity's
       own row keeps is a different thing and is not reused here). */
    var CAT_ICON = { PERSON: 'person', CORP: 'corp', GOV: 'gov', OTHER: 'dots' };

    /* The block subsidy in force at a height: 50 BTC halved once per 210,000 blocks, in
       whole satoshis like the protocol counts it. The card's `[ +3.125 / BLK ]` badge is
       this number, so it moves by itself at a halving instead of being written in. */
    function subsidySats(height) {
      if (!num(height) || height < 0) return null;
      var epoch = Math.floor(height / SUBSIDY_EPOCH);
      if (epoch > 33) return 0;
      return Math.floor(5000000000 / Math.pow(2, epoch));
    }

    /* A stacked bar's segments as 5 % width classes (the CSP allows no inline style).
       Rounding each share on its own can leave the row at 95 % or push it past 100 %, which
       shows as a gap at the end or as segments the flex row quietly shrinks; the largest
       segment carries the difference so the bar always spans exactly its track. */
    function stackSteps(shares) {
      var steps = [], sum = 0, i;
      for (i = 0; i < shares.length; i++) {
        var p = num(shares[i]) ? shares[i] : 0;
        var st = Math.round(p / 5) * 5;
        if (st < 5 && p > 0) st = 5;
        st = Math.max(0, Math.min(100, st));
        steps.push(st); sum += st;
      }
      if (!sum) return steps;
      if (sum !== 100) {
        var at = 0;
        for (i = 1; i < steps.length; i++) if (steps[i] > steps[at]) at = i;
        steps[at] = Math.max(0, Math.min(100, steps[at] + (100 - sum)));
      }
      return steps;
    }

    /* The dashboard prints every BTC figure to exactly three decimals, the way the design
       writes them ("20,118,543.750 BTC"): fmtEnt drops a trailing zero because a row in a
       ranking has no column to align to, while these figures sit under each other and are
       read as one table. The sats are whole, so the third decimal is exact. */
    function fmtDash(v) {
      if (!num(v)) return '—';
      var b = v / 1e8;
      var s = Math.abs(b).toFixed(3);
      var parts = s.split('.');
      parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
      return (b < 0 ? '−' : '') + parts.join('.');
    }

    function supplyCardHTML(s, t, est) {
      var mined = s.mined, priv = s.private, unmined = s.unmined;
      var steps = stackSteps([
        s.max ? s.tracked / s.max * 100 : 0,
        s.max && num(priv) ? priv / s.max * 100 : 0,
        s.max && num(unmined) ? unmined / s.max * 100 : 0
      ]);
      var sub = subsidySats(s.height);
      var usdT = usd(t);
      var stack = '<div class="dstack3">' +
        '<i class="tk w' + steps[0] + '"></i>' +
        '<i class="pv w' + steps[1] + '"></i>' +
        '<i class="un w' + steps[2] + '"></i>' +
      '</div>';
      return '<div class="dcard supply">' +
        '<div class="dtitle">' + esc(fmtDash(s.max)) + ' BTC SUPPLY</div>' +
        stack +
        '<div class="dlegend">' +
          '<span><i class="sw tk"></i>Tracked Entities</span>' +
          '<span><i class="sw pv"></i>Private/Untracked</span>' +
          '<span><i class="sw un"></i>Unmined</span>' +
        '</div>' +
        '<div class="drows">' +
          '<span class="dk">MINED<em>' + (num(s.height) ? ' (BLK ' + fmtInt(s.height) + ')' : '') + '</em></span>' +
          '<span class="dv">' + (mined === null ? '—' : esc(fmtDash(mined)) + ' BTC') + '</span>' +
          '<span class="dt"><b class="dbd">' + (sub === null ? '—' : '+' + esc(fmtEnt(sub)) + ' / BLK') + '</b></span>' +
          '<span class="dk">UNMINED<em> (2140)</em></span>' +
          '<span class="dv">' + (unmined === null ? '—' : esc(fmtDash(unmined)) + ' BTC') + '</span>' +
          '<span class="dt pc">' + (unmined === null || mined === null ? '—' : esc(pct(unmined, mined)) + '%') +
            '<i>of mined</i></span>' +
        '</div>' +
        '<div class="dcols">' +
          '<div><span class="dk">TRACKED ENTITIES' + (est > 0 ? ' (+ EST.)' : '') + '</span>' +
            '<b>' + esc(fmtDash(t)) + ' BTC</b>' +
            '<span class="dsm">' + (mined === null ? '—' : esc(pct(t, mined)) + '% of mined') +
              (usdT === null ? '' : ' · ' + esc(fmtUsd(usdT))) + '</span></div>' +
          '<div><span class="dk">PRIVATE / UNTRACKED</span>' +
            '<b>' + (priv === null ? '—' : esc(fmtDash(priv)) + ' BTC') + '</b>' +
            '<span class="dsm">' + (priv === null || mined === null ? '—' : esc(pct(priv, mined)) + '% of mined') + '</span></div>' +
        '</div>' +
      '</div>';
    }

    function categoryCardHTML(t, cat) {
      var cats = ['PERSON', 'CORP', 'GOV', 'OTHER'];
      var shares = cats.map(function (c) { return t > 0 ? cat[c].sats / t * 100 : 0; });
      var steps = stackSteps(shares);
      var stack = '<div class="dstack4">' + cats.map(function (c, i) {
        return '<i class="' + c.toLowerCase() + ' w' + steps[i] + '"></i>';
      }).join('') + '</div>';
      var cards = cats.map(function (c) {
        var x = cat[c];
        return '<div class="dmini ' + c.toLowerCase() + '" data-act="catopen" data-id="' + c + '" role="button" tabindex="0" ' +
            'aria-label="Open the ' + esc(CAT_LABEL[c]) + ' ranking">' +
          '<span class="dmico">' + icon(CAT_ICON[c]) + '</span>' +
          '<span class="dmbody">' +
            '<span class="dmname">' + esc(c) + '</span>' +
            '<span class="dmpct">' + (t > 0 ? esc(pct(x.sats, t)) + '%' : '—') + '</span>' +
            '<span class="dmbtc">' + esc(fmtDash(x.sats)) + ' BTC</span>' +
            '<span class="dmcnt">' + fmtInt(x.n) + ' ' + plural(x.n, 'entity', 'entities') + '</span>' +
          '</span>' +
        '</div>';
      }).join('');
      return '<div class="dcard cats">' +
        '<div class="dtitle">SHARE BY CATEGORY</div>' +
        stack +
        '<div class="dgrid">' + cards + '</div>' +
      '</div>';
    }

    function dashHTML() {
      var s = supplyNow(), t = trackedSats(), cat = catTotals();
      var est = 0, l = list();
      for (var i = 0; i < l.length; i++) est += estOf(l[i]).sats;
      return supplyCardHTML(s, t, est) + categoryCardHTML(t, cat);
    }

    /* The panel is on screen for the whole time the tab is active — the sheet is drawn over
       it, not instead of it — so closing the sheet reveals a figure that is already
       rendered and never a panel that starts drawing at that moment. */
    function paintDash() {
      var el = $('entDash');
      if (!el) return;
      var show = !!(typeof S !== 'undefined' && S && S.layer === 'entities');
      if (el.getAttribute('data-h') !== String(show)) {
        el.setAttribute('data-h', String(show));
        el.style.display = show ? 'block' : 'none';
      }
      if (!show) return;
      /* A balance arriving rebuilds the panel, which replaces the node a keyboard or a
         screen reader was standing on. Whatever had focus inside the panel is put back on
         the card that carries the same act, so a sweep in the background does not pull the
         focus out of the reader's hands. */
      var keep = focusedAct(el);
      setHTML('entDash', dashHTML());
      restoreAct(el, keep);
    }
    function focusedAct(root) {
      var a = null;
      try { a = typeof document !== 'undefined' ? document.activeElement : null; } catch (e) { }
      if (!a || !a.getAttribute || !root.contains || !root.contains(a)) return null;
      if (!a.getAttribute('data-act')) return null;
      return { act: a.getAttribute('data-act'), id: a.getAttribute('data-id') || '' };
    }
    function restoreAct(root, k) {
      if (!k || !root.querySelector) return;
      var q = null;
      try { q = root.querySelector('[data-act="' + k.act + '"][data-id="' + k.id + '"]'); } catch (e) { }
      if (q && q.focus) { try { q.focus(); } catch (e) { } }
    }

    function bodyHTML() {
      if (ES.open) {
        var e = byId(ES.open);
        if (e) return detailHTML(e);
        ES.open = '';
      }
      var list0 = filtered();
      var rows = list0.map(rowHTML).join('');
      var head = '<div class="lhead"><span>' + esc(String(CAT_LABEL[ES.filter] || ES.filter).toUpperCase()) + ' · ' +
        fmtInt(list0.length) + ' ' + plural(list0.length, 'ENTITY', 'ENTITIES') +
        '</span><span>' + (zeroCount() ? zeroCount() + ' at 0 BTC not ranked · ' : '') +
        (sweepTopState.state === 'loading' ? 'reading ' + sweepTopState.done + ' / ' + sweepTopState.total
          : sweepTopState.rate ? 'rate limited' : 'seeded · ' + shortDate(ES.at)) + '</span>' +
        '<button class="wbtn" data-act="refresh">REFRESH</button></div>';
      if (!list0.length) rows = '<div class="empty">no entity in this category holds bitcoin right now</div>';
      rows = (ES.filter === 'ALL' ? watchHTML() : '') + head + rows;
      return '<div class="list">' + rows + '</div>';
    }

    function paintSheet() {
      var sheet = $(SHEET);
      if (!sheet) return;
      setHTML('entChips', chipsHTML());
      /* The watchlist field lives inside the sheet's markup, so a repaint that carries new
         data replaces the element. When the reader is typing in it, the text, the caret and
         the focus are put back on the new field: a balance arriving must not take the
         address out of their hands. */
      var typing = watchTyping();
      setHTML('entBody', bodyHTML());
      if (typing) restoreWatchTyping(typing);
      txt('entKicker', ES.open ? 'ENTITY · ' + (byId(ES.open) ? byId(ES.open).category : '') : 'ENTITIES · WHALE WATCH');
      txt('entTitle', ES.open ? (byId(ES.open) ? byId(ES.open).name : 'Whale Watch') : 'Whale Watch');
      /* Counts and the held total are written the way the cards write them: thousands
         separators on the counts, three decimals at most on the BTC figure. txt() sets
         textContent, so no HTML escape belongs here. */
      txt('entSub', fmtInt(list().length) + ' entities · ' + fmtInt(addrCount()) + ' public addresses · ' +
        fmtEnt(trackedSats()) + ' BTC held (verified + est.) · ' + CAT_NOTE[ES.filter]);
    }

    function watchTyping() {
      var el = $('entWatchInput');
      if (!el || !el.value) return null;
      var focused = false;
      try { focused = typeof document !== 'undefined' && document.activeElement === el; } catch (e) { }
      return { v: el.value, focused: focused, caret: num(el.selectionStart) ? el.selectionStart : null };
    }
    function restoreWatchTyping(t) {
      var el = $('entWatchInput');
      if (!el) return;
      el.value = t.v;
      try {
        if (t.caret !== null && el.setSelectionRange) el.setSelectionRange(t.caret, t.caret);
        if (t.focused && el.focus) el.focus();
      } catch (e) { }
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
      txt('vEBtc', fmtEnt(trackedSats(), true));
      txt('vECount', String(heldCount()));
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
      sweepTop(false);
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
      /* The dashboard is already painted underneath, so nothing has to be drawn here: the
         panel is on screen the same frame the sheet leaves it. */
      paintDash();
      return true;
    }
    /* The tab's landing screen: the dashboard, with the sheet closed. Tab switching calls
       this rather than open(), because a sheet that opens itself on every tab press hides
       the one screen the tab is for. */
    function showDash() {
      var el = $('ent');
      if (el && el.classList.contains('on')) close();
      ES.open = ''; ES.txOpen = '';
      paintQueued = false;
      entPaintNow(true);
      syncBack();
      return true;
    }
    /* A category card opens the ranking already narrowed to that category. Only a press
       does this; entering the tab never does. */
    function openCategory(c) {
      if (!isCat(c)) return null;
      ES.filter = c; ES.open = ''; ES.txOpen = '';
      var el = $('ent');
      if (el && !el.classList.contains('on')) open();
      flush();
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
      /* The table's own evidence decides the word on the addresses: only an official or
         on-chain listing is Verified, an analytics attribution is Attributed, and the
         engine keeps them apart from Common-Input (which it discovered, not the table). */
      var verified = e.evidence !== 'attributed';
      var seeds = e.addresses.map(function (a) {
        return { address: a.address, verified: verified, label: a.label, source: a.source };
      });
      var id = e.id;
      /* A run is identified by its own sequence, not by the entity: a second ANALYZE on the
         same card must not let the first run's result land in the second run's state. */
      var seq = ++ES.runSeq;
      ES.run = { id: id, seq: seq, state: 'running', phase: 'start', done: 0, total: seeds.length, calls: 0, cacheHits: 0, result: null, err: '' };
      paintEntities();
      return Cluster.analyzeEntity(seeds, {
        maxTxsPerAddress: 20,
        maxApiCalls: 18,
        onProgress: function (p) {
          if (!ES.run || ES.run.seq !== seq) return;
          ES.run.phase = p.phase; ES.run.done = p.done; ES.run.total = p.total;
          ES.run.calls = p.calls; ES.run.cacheHits = p.cacheHits;
          paintRunLine();
        }
      }).then(function (res) {
        if (!ES.run || ES.run.seq !== seq) return res;
        ES.run.state = res.aborted ? 'aborted' : (res.ok ? 'done' : 'error');
        ES.run.result = res;
        ES.run.err = res.error || '';
        /* The estimate this run read joins the entity's held total (and so the ranking and
           the HUD), with the verified part printed beside it on every screen that shows it.
           A run that could not read anything keeps the estimate it already had: an empty
           answer is not a reason to forget what was read before. */
        if (res && res.ok && (!res.api || res.api.source !== 'none')) {
          ES.ests[id] = runEstimate(res); ES.ranked = null;
        }
        flush();
        return res;
      }, function (err) {
        if (ES.run && ES.run.seq === seq) {
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
      if (a.act === 'catopen') return openCategory(a.id);
      if (a.act === 'refresh') return sweepTop(true);
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

    /* The sheet and the dashboard are two elements that carry acts, so both get the one
       delegated listener. The cards on the dashboard are `div role="button"` (a real
       button would bring its own font and padding in every engine), so Enter and Space
       open them the way a button would. */
    function bindActs(el) {
      if (!el || el._entBound) return;
      el._entBound = true;
      el.addEventListener('click', function (e) {
        var a = actOf(e.target, el);
        if (!a) return;
        if (e.preventDefault) e.preventDefault();
        onAct(a);
      });
      el.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        var a = actOf(e.target, el);
        if (a && (a.act === 'open' || a.act === 'filter' || a.act === 'catopen')) { if (e.preventDefault) e.preventDefault(); onAct(a); }
      });
    }

    function bind() {
      bindActs($('ent'));
      bindActs($('entDash'));
    }

    /* ------------------------------------------------------------------ boot */
    function init() {
      /* A saved table is used only when it is at least as new as the table this build
         carries — version first, then date, the same guard the L1 snapshot takes at boot.
         An older cached copy (a v1 table from before the estimate, say) must not hide a
         newer seed: it would show a figure the build already knows is out of date. */
      var seed = typeof ENTITIES !== 'undefined' ? ENTITIES : null;
      var seedV = seed && num(seed.v) && seed.v > 0 ? Math.floor(seed.v) : 0;
      var seedAt = seed && typeof seed.at === 'string' ? Date.parse(seed.at) : 0;
      if (isNaN(seedAt)) seedAt = 0;
      var cached = recall(LS_REMOTE), used = false;
      if (cached) {
        var m = normPayload(cached);
        var mAt = m && m.at ? Date.parse(m.at) : 0;
        if (isNaN(mAt)) mAt = 0;
        if (m && (m.v > seedV || (m.v === seedV && mAt >= seedAt))) used = adopt(cached, 'cache');
      }
      if (!used) adopt(seed, 'seed');
      ES.watch = watchFrom(recall(LS_WATCH));
      bind();
      paintEntities();
      loadPrice();
      /* the published table is asked for once the first paint is on screen */
      setTimeout(function () { remote(); }, 1200);
      /* and then the top of the table is re-read quietly, one address at a time, so the
         first screen is instant and no mirror sees a burst */
      setTimeout(function () {
        if (typeof S !== 'undefined' && S && S.layer === 'entities') sweepTop(false);
      }, 2500);
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
      showDash: showDash, openCategory: openCategory,
      sweep: sweep, sweepTop: sweepTop, readTxs: readTxs, loadPrice: loadPrice, remote: remote,
      watchAdd: watchAdd, watchDel: watchDel, toggleTx: toggleTx, act: onAct,
      usd: usd, fmtUsd: fmtUsd, ranked: ranked, filtered: filtered, byId: byId,
      balanceOf: balanceOf, liveState: liveState, trackedSats: trackedSats,
      heldOf: heldOf, estOf: estOf, runEstimate: runEstimate, heldBreakdown: heldBreakdown,
      addrCount: addrCount, entityOfAddress: entityOfAddress,
      rankOf: rankOf, zeroCount: zeroCount, heldCount: heldCount, fmtEnt: fmtEnt, fmtDash: fmtDash, minedSats: minedSats,
      supplyNow: supplyNow, dashHTML: dashHTML, catTotals: catTotals, subsidySats: subsidySats,
      stackSteps: stackSteps, sweepTopState: function () { return sweepTopState; },
      state: ES, cats: CATS, remoteUrl: REMOTE_URL
    };
  })();
