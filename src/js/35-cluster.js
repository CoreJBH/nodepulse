/* Entities: the on-demand clustering engine behind the ENTITIES / Whale Watch tab.

   It answers one question about a set of public addresses: which of them — and which
   addresses found next to them on chain — belong to the same owner?

     Common-input ownership  addresses spent together as the inputs of one transaction
                             (outside a coinjoin) are one owner's, because a spender
                             must hold every key that signs that transaction.
     Change estimation       in a simple payment the output nobody would have typed as
                             a price — one whose script type the inputs share, whose
                             address has not been seen in this scan, and whose amount
                             is not a round number while the other one is — is very
                             likely the owner's change.
     CoinJoin exclusion      a transaction with repeated equal outputs or a wide
                             fan-in/fan-out deliberately mixes strangers; merging
                             there would join unrelated owners for good, so it is
                             counted and skipped instead.

   Every address in a cluster carries the label that put it there: Verified (a seed the
   entity table attests to), Common-Input (spent together with one) or Change Est. (an
   inferred change output, listed apart from the cluster and never used to merge it).
   No address enters a cluster without one of those three, and the estimates are never
   presented as the verified figure.

   The engine is on demand: nothing runs at boot, one run at a time, at most 20
   transactions per address, a hard ceiling on API calls, spacing between requests, a
   7-minute localStorage cache, the same three mempool mirrors the rest of the app
   walks, and cancelCluster() that aborts the socket instead of only abandoning the
   wait. Every request goes to a host the Content-Security-Policy already names.

   Public API (docs/cluster-api.md):
     Cluster.analyzeEntity(addresses, options) -> Promise<result>
     Cluster.fetchAddressSummary(address, options) -> Promise<summary>
     Cluster.cancelCluster() -> boolean
     Cluster.analyzeTxs(seeds, lists) -> result core   (pure, no network)
     Cluster.detectCoinJoin(tx), Cluster.estimateChange(tx, ctx), Cluster.lastResult()
*/

  var Cluster = (function () {

    /* ------------------------------------------------------------- limits */
    var LS_KEY = 'nodepulse.cluster.v1';
    var TTL_MS = 7 * 60 * 1000;          // saved answers are good for seven minutes
    var TTL_MIN = 60 * 1000, TTL_MAX = 15 * 60 * 1000;
    var TXS_MAX = 20;                    // transactions read per address
    var TXS_LIMIT = 25;                  // the most a caller may ask for
    var CALLS_MAX = 18;                  // GETs one run may spend
    var CALLS_LIMIT = 40;
    var ADD_MAX = 40;                    // seed addresses one run may analyze
    var CACHE_MAX = 24;                  // saved addresses kept
    var CACHE_BYTES = 1500000;           // saved-bytes ceiling before the oldest go
    var GET_MS = 12000;                  // one GET, headers and body
    var GAP_MS = 120;                    // spacing between two live GETs
    var RUN_MS = 60000;                  // wall-clock ceiling for one whole run
    var CJ_EQUAL = 3;                    // equal-value outputs that read as a coinjoin
    var CJ_WIDE_IN = 10, CJ_WIDE_OUT = 10;
    var CHANGE_LEAD = 1;                 // the winning output must lead by this much
    var CHANGE_FLOOR = 3;                // and must collect at least this many points
    var PART_MAX = 500;                  // inputs/outputs kept per transaction

    /* Every address is one of these; the order is the order of certainty. */
    var LABEL_VERIFIED = 'Verified';
    var LABEL_COMMON = 'Common-Input';
    var LABEL_CHANGE = 'Change Est.';

    /* ------------------------------------------------------------ helpers */
    /* Base58 is case-sensitive, so an address is never lower-cased: only its shape is
       checked before it may reach a URL path. */
    var ADDR_RE = /^[A-Za-z0-9]{25,90}$/;
    function validAddress(a) { return typeof a === 'string' && ADDR_RE.test(a); }

    function clamp(v, lo, hi, def) {
      return num(v) ? Math.max(lo, Math.min(hi, Math.floor(v))) : def;
    }

    function uniq(list) {
      var seen = Object.create(null), out = [];
      for (var i = 0; i < list.length; i++) {
        var v = list[i];
        if (!v || seen[v]) continue;
        seen[v] = true;
        out.push(v);
      }
      return out;
    }

    /* An output type that can carry an owner's coins. OP_RETURN and the other data
       carriers cannot be spent, so they are never change and never an input. */
    function payable(t) {
      return t !== 'op_return' && t !== 'nulldata' && t !== 'anchor' && t !== 'provably_unspendable';
    }

    /* A hand-typed amount: whole 0.001 or 0.0001 BTC. A payment is often one; change is
       almost never one, because it is whatever the inputs left over. */
    function isRound(v) {
      return num(v) && v > 0 && (v % 100000 === 0 || v % 10000 === 0);
    }

    function abortError() {
      var e = new Error('aborted');
      e.aborted = true;
      return e;
    }
    function isAbort(e) { return !!(e && e.aborted); }

    /* --------------------------------------------------------- transaction */
    /* One API transaction reduced to what the heuristics read: for every input the
       address, value and script type it spends, for every output its index, address,
       value and type, plus the fee and when it was mined. Scripts, witnesses and
       signatures are dropped — they answer no question here and would multiply the
       cached size. */
    function compressTx(tx) {
      if (!isObj(tx) || typeof tx.txid !== 'string' || !tx.txid) return null;
      if (!isArr(tx.vin) || !isArr(tx.vout)) return null;
      var vin = [], vout = [], i;
      /* A dust or batch transaction can carry thousands of outputs, and twenty of them
         would be a phone-sized heap on their own. The first PART_MAX of each side are
         kept — enough for any ordinary transaction and for the merge a consolidation
         makes — and `part` marks a transaction that was cut, which no heuristic is then
         allowed to read as a whole. */
      var part = false;
      for (i = 0; i < tx.vin.length; i++) {
        if (vin.length >= PART_MAX) { part = true; break; }
        var v = tx.vin[i];
        if (!isObj(v)) continue;
        var p = isObj(v.prevout) ? v.prevout : null;
        vin.push({
          a: p && typeof p.scriptpubkey_address === 'string' ? p.scriptpubkey_address : '',
          v: p && num(p.value) && p.value >= 0 ? p.value : null,
          t: p && typeof p.scriptpubkey_type === 'string' ? p.scriptpubkey_type : '',
          cb: v.is_coinbase === true
        });
      }
      for (i = 0; i < tx.vout.length; i++) {
        if (vout.length >= PART_MAX) { part = true; break; }
        var o = tx.vout[i];
        if (!isObj(o)) continue;
        vout.push({
          a: typeof o.scriptpubkey_address === 'string' ? o.scriptpubkey_address : '',
          v: num(o.value) && o.value >= 0 ? o.value : null,
          t: typeof o.scriptpubkey_type === 'string' ? o.scriptpubkey_type : '',
          n: i
        });
      }
      var st = isObj(tx.status) ? tx.status : {};
      var at = num(st.block_time) && st.block_time > 0 ? st.block_time * 1000 : 0;
      if (!at && st.confirmed !== true) at = Date.now();   // still in the mempool: newest
      return {
        txid: tx.txid, at: at, conf: st.confirmed === true,
        fee: num(tx.fee) && tx.fee >= 0 ? tx.fee : null,
        vin: vin, vout: vout,
        ni: tx.vin.length, no: tx.vout.length, part: part
      };
    }

    /* The same shape read back out of localStorage, field by field: storage is writable
       by anything that ever ran on this origin, and a cluster built from a poisoned
       cache must not be able to crash the paint path or invent an address. */
    function txFromCache(v) {
      if (!isObj(v) || typeof v.txid !== 'string' || !v.txid) return null;
      if (!isArr(v.vin) || !isArr(v.vout)) return null;
      var vin = [], vout = [], i;
      for (i = 0; i < v.vin.length; i++) {
        var a = v.vin[i];
        if (!isObj(a)) return null;
        vin.push({
          a: typeof a.a === 'string' ? a.a : '',
          v: num(a.v) && a.v >= 0 ? a.v : null,
          t: typeof a.t === 'string' ? a.t : '',
          cb: a.cb === true
        });
      }
      for (i = 0; i < v.vout.length; i++) {
        var b = v.vout[i];
        if (!isObj(b)) return null;
        vout.push({
          a: typeof b.a === 'string' ? b.a : '',
          v: num(b.v) && b.v >= 0 ? b.v : null,
          t: typeof b.t === 'string' ? b.t : '',
          n: num(b.n) && b.n >= 0 ? b.n : i
        });
      }
      return {
        txid: v.txid,
        at: num(v.at) && v.at > 0 ? v.at : 0,
        conf: v.conf === true,
        fee: num(v.fee) && v.fee >= 0 ? v.fee : null,
        vin: vin, vout: vout,
        ni: num(v.ni) ? v.ni : vin.length,
        no: num(v.no) ? v.no : vout.length,
        part: v.part === true
      };
    }

    /* --------------------------------------------------------------- change */
    /* Change estimation for one transaction. It answers only when the reading is
       unambiguous — two payable outputs, one script type, a lead of at least one point
       and a floor of three — because a wrong change output is a wrong owner, and this
       label is shown to the user as an estimate, never as a verified fact. */
    function estimateChange(tx, ctx) {
      if (!isObj(tx) || !isArr(tx.vin) || !isArr(tx.vout) || !tx.vin.length) return null;
      if (tx.part === true) return null;                     // not read whole: no opinion
      if (tx.vin[0] && tx.vin[0].cb) return null;            // a coinbase pays no change
      var outs = [], i;
      for (i = 0; i < tx.vout.length; i++) {
        var o = tx.vout[i];
        if (!isObj(o) || !o.a || !payable(o.t)) continue;
        if (!num(o.v) || o.v <= 0) continue;
        outs.push(o);
      }
      if (outs.length !== 2) return null;                    // one output or a batch: no reading
      var a = outs[0], b = outs[1];
      /* Mixed script types mean the wallet may not control the second type at all; the
         two outputs cannot be compared, so the transaction is left unestimated. */
      if (a.t !== b.t) return null;

      var typed = Object.create(null), dom = '', domN = 0;
      var used = Object.create(null);
      for (i = 0; i < tx.vin.length; i++) {
        var v = tx.vin[i];
        if (!isObj(v) || v.cb) continue;
        if (v.a) used[v.a] = true;
        if (!v.t || !payable(v.t)) continue;
        typed[v.t] = (typed[v.t] || 0) + 1;
        if (typed[v.t] > domN) { domN = typed[v.t]; dom = v.t; }
      }
      var seen = (ctx && ctx.seen) || Object.create(null);
      function score(cand, other) {
        var s = 0, why = [];
        if (dom && cand.t === dom) { s += 2; why.push('script type matches the inputs'); }
        if (used[cand.a]) { s -= 3; why.push('already an input of this transaction'); }
        if (seen[cand.a]) { s -= 1; why.push('output address already seen'); }
        else { s += 1; why.push('output address unseen before this transaction'); }
        if (isRound(other.v) && !isRound(cand.v)) { s += 2; why.push('the other output is a round amount'); }
        if (isRound(cand.v) && !isRound(other.v)) { s -= 2; why.push('this output is the round amount'); }
        return { s: s, why: why };
      }
      var sa = score(a, b), sb = score(b, a), pick = null, best = null, peer = null;
      if (sa.s >= sb.s + CHANGE_LEAD) { pick = a; best = sa; peer = sb; }
      else if (sb.s >= sa.s + CHANGE_LEAD) { pick = b; best = sb; peer = sa; }
      if (!pick || best.s < CHANGE_FLOOR) return null;
      return { n: pick.n, address: pick.a, value: pick.v, score: best.s, peer: peer.s, why: best.why };
    }

    /* ------------------------------------------------------------- coinjoin */
    /* A coinjoin from the outside: several equal-value outputs that cannot be told
       apart, or a fan of many input owners into many outputs. Both are exclusive: the
       first is the point of the transaction, the second is what a mixing service looks
       like. A plain two-output payment never matches either. */
    function detectCoinJoin(tx) {
      if (!isObj(tx) || !isArr(tx.vin) || !isArr(tx.vout)) {
        return { coinjoin: false, why: [], inputs: 0, outputs: 0, equal: 0 };
      }
      var ins = [], outs = [], i;
      for (i = 0; i < tx.vin.length; i++) {
        var v = tx.vin[i];
        if (!isObj(v) || v.cb || !v.a || !payable(v.t)) continue;
        ins.push(v.a);
      }
      var outSet = Object.create(null);
      for (i = 0; i < tx.vout.length; i++) {
        var o = tx.vout[i];
        if (!isObj(o) || !o.a || !payable(o.t)) continue;
        outs.push(o);
        outSet[o.a] = true;
      }
      var inN = uniq(ins).length, outN = Object.keys(outSet).length;
      /* A transaction that was cut at PART_MAX is judged by the counts the API declared:
         a fan of thousands of outputs is a mixing or dusting shape whatever the kept
         rows look like. */
      var dIn = num(tx.ni) ? Math.max(inN, tx.ni) : inN;
      var dOut = num(tx.no) ? Math.max(outN, tx.no) : outN;
      var counts = Object.create(null), best = 0, bestV = null;
      for (i = 0; i < outs.length; i++) {
        if (!num(outs[i].v) || outs[i].v <= 0) continue;
        var k = String(outs[i].v);
        counts[k] = (counts[k] || 0) + 1;
        if (counts[k] > best) { best = counts[k]; bestV = outs[i].v; }
      }
      var why = [];
      if (best >= CJ_EQUAL) why.push(best + ' outputs of ' + fmtInt(bestV) + ' sats');
      if (dIn >= CJ_WIDE_IN && dOut >= CJ_WIDE_OUT) why.push('wide fan-in/fan-out ' + dIn + ' in / ' + dOut + ' out');
      if (inN >= 5 && best >= 2 && outN >= 5) why.push('repeated amounts across ' + outN + ' outputs');
      if (tx.part === true) why.push('too wide to read: ' + dIn + ' in / ' + dOut + ' out');
      return { coinjoin: why.length > 0, why: why, inputs: dIn, outputs: dOut, equal: best };
    }

    /* ---------------------------------------------------------- union-find */
    /* Path-halving union-find over addresses. Plain objects would read an inherited
       value for a key such as "constructor", so the map has no prototype. */
    function UF() { this.p = Object.create(null); }
    UF.prototype.find = function (a) {
      var p = this.p;
      if (!(a in p)) { p[a] = a; return a; }
      var root = a;
      while (p[root] !== root) root = p[root];
      while (p[a] !== root) { var next = p[a]; p[a] = root; a = next; }
      return root;
    };
    UF.prototype.union = function (a, b) {
      var ra = this.find(a), rb = this.find(b);
      if (ra !== rb) this.p[rb] = ra;
    };

    /* -------------------------------------------------------------- seeds */
    /* A seed is a string or an object {address, verified, label, source}. Duplicates
       and addresses that cannot be one are dropped here, so no other path has to ask
       whether an address is safe to put in a URL. */
    function normSeeds(input) {
      var out = [], seen = Object.create(null);
      (isArr(input) ? input : (typeof input === 'string' ? [input] : [])).forEach(function (s) {
        var o = typeof s === 'string' ? { address: s } : (isObj(s) ? s : null);
        if (!o) return;
        var addr = typeof o.address === 'string' ? o.address : '';
        if (!validAddress(addr) || seen[addr]) return;
        seen[addr] = true;
        out.push({
          address: addr,
          verified: o.verified === true,
          label: typeof o.label === 'string' ? o.label : '',
          source: typeof o.source === 'string' ? o.source : ''
        });
      });
      return out;
    }

    /* ------------------------------------------------------------ analysis */
    /* The pure core: no network, no storage, no DOM. `lists` is what the fetch side
       collected — one {address, txs} per address, each tx in compressTx() shape — and
       everything below is a deterministic function of it, which is what the unit tests
       drive. */
    function analyzeTxs(seedInput, lists) {
      var seeds = normSeeds(seedInput);
      var uf = new UF(), own = Object.create(null), byTx = Object.create(null), order = [];
      var seedBy = Object.create(null);
      seeds.forEach(function (s) { seedBy[s.address] = s; own[s.address] = true; uf.find(s.address); });

      (isArr(lists) ? lists : []).forEach(function (l) {
        if (!isObj(l) || !isArr(l.txs)) return;
        l.txs.forEach(function (tx) {
          if (!isObj(tx) || typeof tx.txid !== 'string' || !tx.txid || byTx[tx.txid]) return;
          if (!isArr(tx.vin) || !isArr(tx.vout)) return;
          byTx[tx.txid] = tx;
          order.push(tx);
        });
      });
      /* Oldest first: change estimation asks what the scan had already seen, and a
         response lists transactions newest first. */
      order.sort(function (a, b) {
        return ((a.at || 0) - (b.at || 0)) || (a.txid < b.txid ? -1 : a.txid > b.txid ? 1 : 0);
      });

      var seen = Object.create(null);
      seeds.forEach(function (s) { seen[s.address] = true; });
      var change = [], shared = [], cj = [], cjCount = 0, scanned = 0, maxAt = 0;

      order.forEach(function (tx) {
        var c = detectCoinJoin(tx);
        if (c.coinjoin) {
          cjCount++;
          if (cj.length < 40) cj.push({ txid: tx.txid, why: c.why, inputs: c.inputs, outputs: c.outputs });
          return;
        }
        var ins = [], i;
        for (i = 0; i < tx.vin.length; i++) {
          var v = tx.vin[i];
          if (!isObj(v) || v.cb || !v.a || !validAddress(v.a) || !payable(v.t)) continue;
          ins.push(v.a);
        }
        var uniqIns = uniq(ins);
        /* Direction matters: a transaction where the entity only appears among the
           outputs is somebody paying it, and its inputs belong to the payer. Merging
           those would hand the entity a stranger's coins, so a transaction is read only
           when at least one input address is already the entity's — the test that the
           entity signed it. */
        var signed = false;
        for (i = 0; i < uniqIns.length; i++) if (own[uniqIns[i]]) { signed = true; break; }
        if (signed) {
          for (i = 1; i < uniqIns.length; i++) {
            uf.union(uniqIns[0], uniqIns[i]);
            own[uniqIns[i]] = true;
          }
          uf.find(uniqIns[0]);
          own[uniqIns[0]] = true;
          if (uniqIns.length > 1 && shared.length < 200) shared.push({ txid: tx.txid, addresses: uniqIns });

          var ch = estimateChange(tx, { seen: seen });
          if (ch) {
            change.push({
              txid: tx.txid, address: ch.address, value: ch.value, score: ch.score,
              peer: ch.peer, why: ch.why, at: tx.at || 0, clusterId: null, first: uniqIns[0] || ''
            });
          }
        }
        for (i = 0; i < tx.vin.length; i++) {
          if (isObj(tx.vin[i]) && tx.vin[i].a && validAddress(tx.vin[i].a)) seen[tx.vin[i].a] = true;
        }
        for (i = 0; i < tx.vout.length; i++) {
          if (isObj(tx.vout[i]) && tx.vout[i].a && validAddress(tx.vout[i].a)) seen[tx.vout[i].a] = true;
        }
        if (tx.at > maxAt) maxAt = tx.at;
        scanned++;
      });

      /* One cluster per owner found. A cluster that holds a verified seed is Verified;
         one built only from shared inputs is Common-Input. */
      var roots = Object.create(null), members = Object.create(null), ids = [];
      Object.keys(own).forEach(function (a) {
        var r = uf.find(a);
        if (roots[r] === undefined) { roots[r] = ids.length; ids.push(r); }
        (members[r] || (members[r] = [])).push(a);
      });
      var flat = [];
      var clusters = ids.map(function (r, id) {
        var list = members[r].slice().sort(function (x, y) {
          var vx = seedBy[x] && seedBy[x].verified ? 0 : 1;
          var vy = seedBy[y] && seedBy[y].verified ? 0 : 1;
          return vx - vy || (x < y ? -1 : x > y ? 1 : 0);
        });
        var verified = 0;
        var rows = list.map(function (address) {
          var seed = seedBy[address];
          var isV = !!(seed && seed.verified);
          if (isV) verified++;
          var row = {
            address: address,
            verified: isV,
            label: isV ? LABEL_VERIFIED : LABEL_COMMON,
            clusterId: id,
            balance: null, txCount: null, source: '', at: 0
          };
          if (seed && seed.label) row.entityLabel = seed.label;
          if (seed && seed.source) row.entitySource = seed.source;
          flat.push(row);
          return row;
        });
        return {
          id: id,
          label: verified ? LABEL_VERIFIED : LABEL_COMMON,
          size: rows.length,
          verified: verified,
          heuristic: rows.length - verified,
          addresses: rows,
          balance: null,
          balanceKnown: 0
        };
      });
      /* A change estimate belongs to the cluster of the inputs that produced it, but it
         never joined it: a wrong estimate must not be able to pull a merchant's coins
         into the entity through a later merge. */
      change.forEach(function (c) {
        if (!c.first) return;
        var r = uf.find(c.first);
        c.clusterId = roots[r] === undefined ? null : roots[r];
        delete c.first;
      });

      return {
        ok: true,
        clusters: clusters,
        addresses: flat,
        change: change,
        shared: shared,
        coinjoin: cj,
        coinjoinExcluded: cjCount,
        stats: { txs: order.length, scanned: scanned, newest: maxAt },
        at: Date.now()
      };
    }

    /* --------------------------------------------------------------- cache */
    /* One entry per address holding two independently dated parts: the summary and the
       transactions read for it ('st' and 'xt'). A fresh part costs no API call; a part
       older than the TTL is fetched again while the other may still be served — a
       summary that failed once must not make the transaction list it never touched look
       stale, and a transaction list must not keep a balance alive past its TTL. */
    function cacheLoad() {
      var c = recall(LS_KEY);
      return isObj(c) && isObj(c.e) ? c.e : Object.create(null);
    }
    function cacheAt(map, addr) {
      var e = map[addr];
      return isObj(e) ? e : null;
    }
    function fresh(e, part, ttl) {
      if (!isObj(e)) return 0;
      var t = num(e[part + 't']) ? e[part + 't'] : 0;
      if (!t || Date.now() - t > ttl) return 0;
      return t;
    }
    function cachePut(map, addr, patch) {
      var e = isObj(map[addr]) ? map[addr] : {};
      var now = Date.now();
      if (patch.s !== undefined) { e.s = patch.s; e.st = now; }
      if (patch.x !== undefined) { e.x = patch.x; e.xt = now; }
      map[addr] = e;
    }
    /* Count first, bytes second: an entry is worth keeping only while the whole map
       still fits what localStorage will take, and the oldest go first. */
    function entryAge(e) {
      var a = num(e && e.st) ? e.st : 0, b = num(e && e.xt) ? e.xt : 0;
      return Math.max(a, b);
    }
    function cacheSave(map) {
      var keys = Object.keys(map);
      if (keys.length > CACHE_MAX) {
        keys.sort(function (a, b) { return entryAge(map[a]) - entryAge(map[b]); });
        while (keys.length > CACHE_MAX) delete map[keys.shift()];
      }
      var text = JSON.stringify({ v: 1, e: map });
      if (text.length > CACHE_BYTES) {
        keys = Object.keys(map).sort(function (a, b) { return entryAge(map[a]) - entryAge(map[b]); });
        while (text.length > CACHE_BYTES && keys.length) {
          delete map[keys.shift()];
          text = JSON.stringify({ v: 1, e: map });
        }
      }
      store(LS_KEY, { v: 1, e: map });
    }
    function clearCache() {
      try { localStorage.removeItem(LS_KEY); } catch (e) { }
      return true;
    }

    /* ------------------------------------------------------------ network */
    /* One GET of a mempool.space path. The same three mirrors 10-net.js walks, with one
       difference this caller needs: it is bounded by the run's own signal, so cancel()
       closes the socket instead of leaving a fetch in flight behind an abandoned wait.
       A 4xx (except 429) is this address's fault, not the mirror's, so the rotation
       stops there; 429 and 5xx move to the next mirror. The native bridge is the last
       attempt, exactly as in request(): a mirror that is down for fetch is down for it
       too, and only a browser that cannot read the host at all needs it. */
    function net(path, signal) {
      var i = 0, bridged = false, lastStatus = 0;
      if (typeof fetch !== 'function') return Promise.reject(new Error('no fetch'));
      if (typeof offline === 'function' && offline()) return Promise.reject(new Error('offline'));
      function gone() { return !!(signal && signal.aborted); }
      function go() {
        if (gone()) return Promise.reject(abortError());
        if (i >= API_HOSTS.length) return viaBridge();
        var host = API_HOSTS[i++];
        var opt = { cache: 'no-store', credentials: 'omit', mode: 'cors' };
        var ctrl = null, timer = null, onAbort = null;
        if (typeof AbortController !== 'undefined') {
          ctrl = new AbortController();
          opt.signal = ctrl.signal;
          timer = setTimeout(function () { try { ctrl.abort(); } catch (e) { } }, GET_MS);
          if (signal && signal.addEventListener) {
            onAbort = function () { try { ctrl.abort(); } catch (e) { } };
            signal.addEventListener('abort', onAbort);
          }
        }
        function settle() {
          if (timer) { clearTimeout(timer); timer = null; }
          if (onAbort && signal && signal.removeEventListener) signal.removeEventListener('abort', onAbort);
          onAbort = null;
        }
        var req = fetch(host + path, opt);
        /* A WebView without AbortController (older than Chrome 66) would otherwise wait
           on a stalled mirror with nothing to stop it: the answer is abandoned after
           GET_MS and the next mirror gets the request. The socket may still finish on
           its own; the run no longer waits for it. */
        if (!ctrl) {
          var lateTimer = null;
          req = Promise.race([req, new Promise(function (_, rej) {
            lateTimer = setTimeout(function () { rej(new Error('timeout')); }, GET_MS);
          })]);
          req.then(function () { if (lateTimer) clearTimeout(lateTimer); },
            function () { if (lateTimer) clearTimeout(lateTimer); });
        }
        return req.then(function (r) {
          if (!r.ok) {
            settle();
            var e = new Error('HTTP ' + r.status);
            e.status = r.status;
            throw e;
          }
          return r.json().then(function (body) { settle(); return body; },
            function (e) { settle(); throw e; });
        }).catch(function (e) {
          settle();
          if (gone()) throw abortError();
          if (e && e.status) {
            lastStatus = e.status;
            /* A 4xx that is not 429 is this address's fault, not the mirror's: the
               rotation stops there instead of asking three hosts the same question. */
            if (e.status >= 400 && e.status < 500 && e.status !== 429) throw e;
          }
          return go();
        });
      }
      /* The bridge cannot be cancelled, so its wait is only raced against the signal:
         the request may finish on the native side, but this run stops waiting for it. */
      function viaBridge() {
        if (gone()) return Promise.reject(abortError());
        if (bridged || typeof BR === 'undefined' || !BR || !BR.on || typeof BR.get !== 'function') {
          var e = new Error('no host answered');
          /* The last mirror's status survives the rotation, so a run can say it was
             rate-limited (429) rather than merely unanswered. */
          if (lastStatus) e.status = lastStatus;
          return Promise.reject(e);
        }
        bridged = true;
        var p = BR.get(API_HOSTS[0] + path).then(function (t) {
          try { return JSON.parse(t); } catch (e) { throw new Error('bad json'); }
        });
        if (!signal || !signal.addEventListener) return p;
        return Promise.race([p, new Promise(function (_, rej) {
          signal.addEventListener('abort', function () { rej(abortError()); });
        })]);
      }
      return go();
    }

    /* One GET with a pause in front of it, so ten addresses are ten spaced requests
       instead of a burst the endpoint may answer with 429. */
    function pause(ms, signal) {
      if (!ms) return Promise.resolve();
      return new Promise(function (res, rej) {
        if (signal && signal.aborted) return rej(abortError());
        var t = setTimeout(function () { cleanup(); res(); }, ms);
        function cleanup() {
          if (signal && signal.removeEventListener) signal.removeEventListener('abort', onAbort);
        }
        function onAbort() { clearTimeout(t); cleanup(); rej(abortError()); }
        if (signal && signal.addEventListener) signal.addEventListener('abort', onAbort);
      });
    }

    function summaryFrom(d, address) {
      if (!isObj(d) || !isObj(d.chain_stats)) return null;
      var c = d.chain_stats, m = isObj(d.mempool_stats) ? d.mempool_stats : {};
      /* The two sums are the balance: an answer that does not carry both numbers is not
         a balance, and printing 0 for it would claim the address is empty. */
      if (!num(c.funded_txo_sum) || !num(c.spent_txo_sum)) return null;
      function n(v) { return num(v) && v >= 0 ? v : 0; }
      var funded = n(c.funded_txo_sum), spent = n(c.spent_txo_sum);
      var mf = n(m.funded_txo_sum), ms = n(m.spent_txo_sum);
      return {
        address: address,
        balance: funded - spent + mf - ms,
        received: funded + mf,
        spent: spent + ms,
        txCount: n(c.tx_count) + n(m.tx_count),
        mempoolCount: n(m.tx_count),
        source: 'live',
        at: Date.now()
      };
    }
    /* A saved summary read back: every figure is re-typed, because localStorage is
       writable by anything that ever ran on this origin, and the card prints these. A
       saved row without a numeric balance is not a summary and becomes a miss. */
    function summaryFromCache(s, at) {
      if (!isObj(s) || !num(s.balance)) return null;
      return {
        address: typeof s.address === 'string' ? s.address : '',
        balance: s.balance,
        received: num(s.received) ? s.received : 0,
        spent: num(s.spent) ? s.spent : 0,
        txCount: num(s.txCount) ? s.txCount : 0,
        mempoolCount: num(s.mempoolCount) ? s.mempoolCount : 0,
        source: 'cache',
        at: num(s.at) ? s.at : at
      };
    }

    /* -------------------------------------------------------------- state */
    var state = { run: null, last: null, lastId: 0, seq: 0 };

    function cancelCluster() {
      var run = state.run;
      if (!run) return false;
      run.cancelled = true;
      if (run.ctrl) { try { run.ctrl.abort(); } catch (e) { } }
      return true;
    }
    function isCancelled(run) {
      return !!(run.cancelled || (run.signal && run.signal.aborted));
    }

    function emit(run, phase, address) {
      var cb = run.onProgress;
      if (typeof cb !== 'function') return;
      try {
        cb({
          phase: phase, done: run.done, total: run.seeds.length,
          address: address || '', calls: run.calls, cacheHits: run.cacheHits
        });
      } catch (e) { }
    }

    /* ---------------------------------------------------- one address's data */
    function fetchSummary(run, seed) {
      if (isCancelled(run)) return Promise.reject(abortError());
      var e = cacheAt(run.cache, seed.address);
      var st = fresh(e, 's', run.ttl);
      if (st && isObj(e.s)) {
        var saved = summaryFromCache(e.s, st);
        if (saved) {
          run.cacheHits++;
          run.summaries[seed.address] = saved;
          return Promise.resolve(saved);
        }
      }
      if (run.dead[seed.address]) return Promise.resolve(null);
      if (run.calls >= run.maxCalls || run.rateLimited || Date.now() - run.t0 > RUN_MS) {
        run.truncated = true;
        return Promise.resolve(null);
      }
      run.calls++;
      return pause(GAP_MS, run.signal).then(function () {
        return net('/api/address/' + encodeURIComponent(seed.address), run.signal);
      }).then(function (d) {
        var s = summaryFrom(d, seed.address);
        if (s) {
          cachePut(run.cache, seed.address, { s: s });
          run.dirty = true;
          run.summaries[seed.address] = s;
        } else {
          run.failed++;
        }
        return s;
      }).catch(function (err) {
        if (isAbort(err)) throw err;
        run.failed++;
        if (err && err.status === 429) run.rateLimited = true;
        /* A 4xx that is not 429 is the address, not the network: it cannot become a
           valid address mid-run, so its transaction list is not asked for either. */
        if (err && err.status >= 400 && err.status < 500 && err.status !== 429) run.dead[seed.address] = true;
        return null;
      });
    }

    function fetchTxs(run, seed) {
      if (isCancelled(run)) return Promise.reject(abortError());
      if (run.dead[seed.address]) return Promise.resolve(null);
      var e = cacheAt(run.cache, seed.address);
      var xt = fresh(e, 'x', run.ttl);
      if (xt && isArr(e.x)) {
        run.cacheHits++;
        var cached = e.x.map(txFromCache).filter(Boolean).slice(0, run.maxTxs);
        return Promise.resolve({ address: seed.address, txs: cached, source: 'cache', at: xt });
      }
      if (run.calls >= run.maxCalls || run.rateLimited || Date.now() - run.t0 > RUN_MS) {
        run.truncated = true;
        return Promise.resolve(null);
      }
      run.calls++;
      return pause(GAP_MS, run.signal).then(function () {
        return net('/api/address/' + encodeURIComponent(seed.address) + '/txs', run.signal);
      }).then(function (rows) {
        if (!isArr(rows)) { run.failed++; return null; }
        var txs = [], valid = 0;
        for (var i = 0; i < rows.length; i++) {
          var t = compressTx(rows[i]);
          if (!t) continue;
          valid++;
          if (txs.length < run.maxTxs) txs.push(t);
        }
        /* More readable transactions than the cap: the run kept the newest, and the
           result says the history was cut instead of implying it was complete. */
        if (valid > txs.length) run.capped = true;
        /* A dust or batch transaction (thousands of outputs) would fill the whole cache
           on its own, so such a list is analyzed but not saved: an address is cached
           whole or not at all, and a re-run must not read a shortened list where the
           live run saw every row. */
        var lean = true;
        for (var j = 0; j < txs.length; j++) {
          if (txs[j].vin.length + txs[j].vout.length > 300) { lean = false; break; }
        }
        if (lean) { cachePut(run.cache, seed.address, { x: txs }); run.dirty = true; }
        return { address: seed.address, txs: txs, source: 'live', at: Date.now() };
      }).catch(function (err) {
        if (isAbort(err)) throw err;
        run.failed++;
        if (err && err.status === 429) run.rateLimited = true;
        return null;
      });
    }

    /* --------------------------------------------------------- analyzeEntity */
    /* The on-demand entry point. It does not reject because a mirror was down, a rate
       limit was hit or the caller cancelled: those are states the tab has to display,
       so they come back inside the result with whatever was read before them. The only
       refusal is an input with no usable address at all, and even that resolves with
       ok: false instead of throwing. */
    function analyzeEntity(addresses, options) {
      var opt = isObj(options) ? options : {};
      cancelCluster();                       // one run at a time
      var seeds = normSeeds(addresses);
      if (!seeds.length) {
        return Promise.resolve({
          ok: false, error: 'no valid address', aborted: false, truncated: false,
          rateLimited: false, clusters: [], addresses: [], change: [], shared: [],
          coinjoin: [], coinjoinExcluded: 0, entity: { verified: 0, total: 0, balance: null },
          api: { calls: 0, cacheHits: 0, failed: 0, elapsedMs: 0, source: 'none' },
          at: Date.now()
        });
      }
      var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      var onOuterAbort = null;
      if (ctrl && opt.signal && opt.signal.addEventListener) {
        if (opt.signal.aborted) { try { ctrl.abort(); } catch (e) { } }
        else {
          onOuterAbort = function () { try { ctrl.abort(); } catch (e) { } };
          opt.signal.addEventListener('abort', onOuterAbort);
        }
      }
      var cap = clamp(opt.maxAddresses, 1, ADD_MAX, ADD_MAX);
      var run = {
        id: ++state.seq,
        ctrl: ctrl,
        outer: opt.signal || null,
        onOuterAbort: onOuterAbort,
        signal: ctrl ? ctrl.signal : (opt.signal || null),
        cancelled: false,
        t0: Date.now(),
        /* Every seed is reported, but only the first `cap` are fetched: an entity's
           address the run did not reach shows up with no balance, which is a fact the
           tab can print, rather than disappearing from the table. */
        all: seeds.slice(0, 200),
        seeds: seeds.slice(0, cap),
        maxTxs: clamp(opt.maxTxsPerAddress, 1, TXS_LIMIT, TXS_MAX),
        maxCalls: clamp(opt.maxApiCalls, 4, CALLS_LIMIT, CALLS_MAX),
        ttl: clamp(opt.ttlMs, TTL_MIN, TTL_MAX, TTL_MS),
        cache: cacheLoad(),
        summaries: Object.create(null),
        dead: Object.create(null),
        lists: [],
        calls: 0, cacheHits: 0, failed: 0, done: 0,
        truncated: false, rateLimited: false, capped: false, dirty: false,
        onProgress: typeof opt.onProgress === 'function' ? opt.onProgress : null
      };
      if (run.seeds.length < run.all.length) run.truncated = true;
      state.run = run;
      emit(run, 'start');

      var at = 0;
      function next() {
        if (isCancelled(run)) return Promise.resolve();
        if (at >= run.seeds.length) return Promise.resolve();
        if (Date.now() - run.t0 > RUN_MS) { run.truncated = true; return Promise.resolve(); }
        var seed = run.seeds[at++];
        emit(run, 'summary', seed.address);
        return fetchSummary(run, seed).then(function () {
          if (isCancelled(run)) return null;
          emit(run, 'txs', seed.address);
          return fetchTxs(run, seed);
        }).then(function (list) {
          if (list) {
            /* The same transaction can be the first page of two seeds; the core dedupes
               by txid, so appending is enough. */
            run.lists.push(list);
          }
          run.done++;
          return next();
        });
      }

      return next().catch(function (e) {
        if (!isAbort(e)) run.error = String((e && e.message) || e);
        return null;
      }).then(function () { return finish(run); });
    }

    function finish(run) {
      /* The cache is written once per run: every save serialises the whole map, and one
         write per address would do that work a few dozen times for nothing. A finished
         or cancelled run is the right moment — both end here. */
      if (run.dirty) cacheSave(run.cache);
      if (run.outer && run.onOuterAbort && run.outer.removeEventListener) {
        run.outer.removeEventListener('abort', run.onOuterAbort);
        run.onOuterAbort = null;
      }
      var core = analyzeTxs(run.all, run.lists);
      var sums = run.summaries;
      var entityBalance = 0, entityKnown = 0, entityVerified = 0;
      run.all.forEach(function (s) {
        if (!s.verified) return;
        entityVerified++;
        var sum = sums[s.address];
        if (sum) { entityBalance += sum.balance; entityKnown++; }
      });
      core.clusters.forEach(function (c) {
        var total = 0, known = 0;
        c.addresses.forEach(function (a) {
          var s = sums[a.address];
          if (!s) return;
          a.balance = s.balance;
          a.txCount = s.txCount;
          a.source = s.source;
          a.at = s.at;
          total += s.balance;
          known++;
        });
        c.balance = known ? total : null;
        c.balanceKnown = known;
      });
      var aborted = isCancelled(run);
      var res = {
        ok: true,
        aborted: aborted,
        truncated: !!(run.truncated || run.capped),
        rateLimited: !!run.rateLimited,
        error: run.error || '',
        clusters: core.clusters,
        addresses: core.addresses,
        change: core.change,
        shared: core.shared,
        coinjoin: core.coinjoin,
        coinjoinExcluded: core.coinjoinExcluded,
        entity: {
          total: run.all.length,
          verified: entityVerified,
          balance: entityKnown ? entityBalance : null,
          balanceKnown: entityKnown
        },
        stats: {
          addresses: run.all.length,
          read: run.seeds.length,
          txs: core.stats.txs,
          scanned: core.stats.scanned,
          newest: core.stats.newest,
          maxTxsPerAddress: run.maxTxs,
          maxApiCalls: run.maxCalls
        },
        api: {
          calls: run.calls, cacheHits: run.cacheHits, failed: run.failed,
          elapsedMs: Date.now() - run.t0,
          source: run.calls && run.cacheHits ? 'mixed' : run.calls ? 'live' : run.cacheHits ? 'cache' : 'none'
        },
        at: Date.now()
      };
      if (state.run === run) state.run = null;
      if (run.id >= (state.lastId || 0)) { state.last = res; state.lastId = run.id; }
      emit(run, aborted ? 'aborted' : 'done');
      return res;
    }

    /* ------------------------------------------------- fetchAddressSummary */
    /* The one-address read the UI can call on its own (a card opening): cached for the
       same TTL, no cap of its own, and a fresh read on request. */
    function fetchAddressSummary(address, options) {
      var opt = isObj(options) ? options : {};
      if (!validAddress(address)) return Promise.reject(new Error('invalid address'));
      var ttl = clamp(opt.ttlMs, TTL_MIN, TTL_MAX, TTL_MS);
      var cache = cacheLoad();
      var e = opt.fresh === true ? null : cacheAt(cache, address);
      var st = opt.fresh === true ? 0 : fresh(e, 's', ttl);
      if (st && isObj(e.s)) {
        var saved = summaryFromCache(e.s, st);
        if (saved) return Promise.resolve(saved);
      }
      var signal = opt.signal || null;
      return net('/api/address/' + encodeURIComponent(address), signal).then(function (d) {
        var s = summaryFrom(d, address);
        if (!s) throw new Error('bad summary');
        cachePut(cache, address, { s: s });
        cacheSave(cache);
        return s;
      });
    }

    return {
      analyzeEntity: analyzeEntity,
      analyzeTxs: analyzeTxs,
      fetchAddressSummary: fetchAddressSummary,
      cancelCluster: cancelCluster,
      detectCoinJoin: detectCoinJoin,
      estimateChange: estimateChange,
      compressTx: compressTx,
      txFromCache: txFromCache,
      lastResult: function () { return state.last; },
      running: function () { return !!state.run; },
      clearCache: clearCache,
      limits: function () {
        return {
          ttlMs: TTL_MS, maxTxsPerAddress: TXS_MAX, maxApiCalls: CALLS_MAX,
          maxAddresses: ADD_MAX, cacheAddresses: CACHE_MAX, runMs: RUN_MS,
          labels: [LABEL_VERIFIED, LABEL_COMMON, LABEL_CHANGE]
        };
      },
      labels: { verified: LABEL_VERIFIED, common: LABEL_COMMON, change: LABEL_CHANGE }
    };
  })();
