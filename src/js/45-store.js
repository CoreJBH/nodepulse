/* Saved answers: localStorage is writable by anything that ever ran on this origin, so
   every field read back is re-typed here before it reaches a paint path. */

  /* ---------------------------------------------------------------- cache */
  function saveCache() {
    store(LS_CACHE, {
      t: Date.now(), tip: S.tip, blocks: S.blocks, mem: S.mem, recent: S.recent,
      fees: S.fees, hr: S.hr, diff: S.diff, ln: S.ln, lnAt: S.lnAt, countries: S.countries,
      mblocks: S.mblocks, mblocksAt: S.mblocksAt, pools: S.pools, poolsAt: S.poolsAt
    });
  }
  /* A ceiling for a mempool fee total in BTC. Every transaction waiting at once cannot
     sum to more than a few hundred BTC even in a fee spike, while the same figure in
     satoshis starts around 10^6, so this separates the two units with room on both sides.
     1.1.4 and earlier cached whatever the REST feed sent (satoshis), and such a value is
     dropped here rather than printed as BTC; the row is refilled by the next answer. */
  var MAX_MEMPOOL_FEE_BTC = 1e5;
  function btcAmount(v) {
    return (num(v) && v >= 0 && v <= MAX_MEMPOOL_FEE_BTC) ? v : null;
  }
  function memFromCache(m) {
    if (!isObj(m)) return null;
    return {
      count: num(m.count) ? m.count : null,
      vsize: num(m.vsize) ? m.vsize : null,
      totalFee: btcAmount(m.totalFee)
    };
  }

  /* One corrupt element must not take the boot down: localStorage is writable by
     anything that ever ran on this origin and JSON.parse returns whatever the string
     held — including a bare number where a block object belongs, which used to crash
     shortHash() on the first paint. Every cached array is rebuilt element by element,
     from the entries that still carry the shape this code walks. */
  function blockFromCache(b) {
    if (!isObj(b) || !num(b.height) || b.height <= 0 || Math.floor(b.height) !== b.height) return null;
    if (typeof b.id !== 'string' || !b.id) return null;
    return {
      height: b.height, id: b.id,
      time: num(b.time) ? b.time : null,
      txs: num(b.txs) ? b.txs : 0,
      size: num(b.size) ? b.size : 0,
      medianFee: num(b.medianFee) ? b.medianFee : null,
      pool: typeof b.pool === 'string' ? b.pool : null
    };
  }
  function txFromCache(t) {
    if (!isObj(t) || typeof t.txid !== 'string' || !t.txid) return null;
    return {
      txid: t.txid,
      value: num(t.value) ? t.value : 0,
      fee: num(t.fee) ? t.fee : 0,
      vsize: num(t.vsize) ? t.vsize : 0,
      rate: num(t.rate) ? t.rate : null
    };
  }
  function feesFromCache(f) {
    if (!isObj(f)) return null;
    var out = {}, any = false;
    ['fastestFee', 'halfHourFee', 'hourFee', 'economyFee', 'minimumFee'].forEach(function (k) {
      if (num(f[k])) { out[k] = f[k]; any = true; }
    });
    return any ? out : null;
  }
  function hrFromCache(h) {
    /* hashrates must be an array: paintPanel walks it with forEach, and a string
       has a .length, so an array-level check alone let a cached string through. */
    if (!isObj(h) || !isArr(h.hashrates)) return null;
    return {
      hashrates: h.hashrates.filter(function (r) { return isObj(r) && num(r.avgHashrate); }),
      currentHashrate: num(h.currentHashrate) ? h.currentHashrate : null
    };
  }
  /* The retarget row prints a percentage, a block count and a date, so each of the three
     is re-typed on the way out of storage: a string block count used to reach fmtInt(),
     and an object or array in estimatedRetargetDate reached dateOf(), which answered an
     em dash only because new Date(object) happens to be invalid. */
  function diffFromCache(d) {
    if (!isObj(d)) return null;
    var ch = num(d.difficultyChange) ? d.difficultyChange : null;
    var rem = num(d.remainingBlocks) && d.remainingBlocks >= 0 ? d.remainingBlocks : null;
    var at = null;
    if (typeof d.estimatedRetargetDate === 'string' && d.estimatedRetargetDate) at = d.estimatedRetargetDate;
    else if (num(d.estimatedRetargetDate) && d.estimatedRetargetDate > 0) at = d.estimatedRetargetDate;
    if (ch === null && rem === null && at === null) return null;
    return { difficultyChange: ch, remainingBlocks: rem, estimatedRetargetDate: at };
  }
  /* One country row, whether it arrived live or was read back from storage: an ISO code
     to name it and a finite count to sum. capacity is a string of satoshis in the API and
     is only ever parsed, so it is kept as it came (or 0). */
  function countryRow(c) {
    if (!isObj(c) || typeof c.iso !== 'string' || !c.iso || !num(c.count)) return null;
    var cap = typeof c.capacity === 'string' || num(c.capacity) ? c.capacity : 0;
    return { iso: c.iso.slice(0, 2).toUpperCase(), count: c.count, capacity: cap };
  }

  function mblockFromCache(b) {
    if (!isObj(b)) return null;
    /* at least one real figure: a garbage object with nothing numeric is dropped */
    if (!num(b.median) && !num(b.vsize) && !num(b.nTx)) return null;
    return {
      vsize: num(b.vsize) ? b.vsize : 0,
      median: num(b.median) ? b.median : null,
      lo: num(b.lo) ? b.lo : null,
      hi: num(b.hi) ? b.hi : null,
      nTx: num(b.nTx) ? b.nTx : 0
    };
  }
  function poolFromCache(p) {
    /* evalWatch divides by blockCount and reads pool rows by name: a string where the
       row list belongs passed the length check and printed NaN as a share. */
    if (!isArr(p.pools) || !p.pools.length || !num(p.blockCount) || p.blockCount <= 0) return null;
    var rows = p.pools.filter(function (r) { return isObj(r) && typeof r.name === 'string' && num(r.blockCount); });
    if (!rows.length) return null;
    return { blockCount: p.blockCount, pools: rows.map(function (r) { return { name: r.name, blockCount: r.blockCount }; }) };
  }

  function restoreCache() {
    var c = recall(LS_CACHE);
    if (!isObj(c)) return false;
    /* A block height is a positive whole number; anything else in that field is not a
       height this build ever wrote and must not become the HUD's tip. */
    if (num(c.tip) && c.tip > 0 && c.tip < 1e9 && Math.floor(c.tip) === c.tip) S.tip = c.tip;
    if (isArr(c.blocks)) {
      S.blocks = c.blocks.map(blockFromCache).filter(Boolean).slice(0, 8);
      trackChain(S.blocks);
    }
    if (isObj(c.mem)) S.mem = memFromCache(c.mem);
    if (isArr(c.recent)) S.recent = c.recent.map(txFromCache).filter(Boolean).slice(0, 10);
    if (isObj(c.fees)) S.fees = feesFromCache(c.fees);
    if (isObj(c.hr)) S.hr = hrFromCache(c.hr);
    if (isObj(c.diff)) S.diff = diffFromCache(c.diff);
    if (isObj(c.ln)) {
      var ln = lnFromAnswer(c.ln);
      /* A snapshot whose only figures are junk is dropped, not adopted: it would print
         '—' everywhere anyway, and it used to make boot report a cache it does not have. */
      if (num(ln.node_count) || num(ln.channel_count)) {
        S.ln = ln; S.lnAt = num(c.lnAt) ? c.lnAt : 0;
      }
    }
    if (isArr(c.countries)) {
      S.countries = c.countries.map(countryRow).filter(Boolean);
      S.conts = aggregateContinents(S.countries);
    }
    if (isArr(c.mblocks)) {
      S.mblocks = c.mblocks.map(mblockFromCache).filter(Boolean).slice(0, 8);
      S.mblocksAt = num(c.mblocksAt) ? c.mblocksAt : 0;
    }
    if (isObj(c.pools)) { S.pools = poolFromCache(c.pools); S.poolsAt = num(c.poolsAt) ? c.poolsAt : 0; }
    return !!(num(c.tip) || isObj(c.mem) || isObj(S.ln));
  }

