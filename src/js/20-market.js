/* Market: the mempool.space REST loaders — chain tip, blocks, mempool, recent
   transactions, fees, hashrate, difficulty, pools, Lightning statistics, countries.
   Every one of them types what it keeps and rejects a payload it cannot draw. */

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

  /* newest first, whatever order the mirror served */
  function orderBlocks(list) {
    return list.slice().sort(function (a, b) { return (b && b.height) - (a && a.height); });
  }

  function loadBlocks() {
    return request('/api/v1/blocks').then(function (arr) {
      if (!isArr(arr)) throw new Error('bad blocks');
      var list = arr.filter(function (b) { return isObj(b) && num(b.height); });
      if (!list.length) throw new Error('no blocks');
      S.blocks = orderBlocks(list.map(mapBlock)).slice(0, 8);
      /* /api/v1/blocks is the other half of the same fact /api/blocks/tip/height reports,
         and it is the tip endpoint that upstream caches: the blocks answer regularly
         carried a height the tip endpoint had not published yet. Only the tip endpoint
         could move S.tip, so the HUD sat one block behind while the newer block was
         already in the list below it. A height above the known tip is a new block from
         either source, so both of them raise the row and both ring the block event. */
      if (S.tip === null) { S.tip = S.blocks[0].height; S.tipSeenAt = Date.now(); }
      else if (S.blocks[0].height > S.tip) {
        var top = S.blocks[0];
        S.tip = top.height;
        S.tipSeenAt = Date.now();
        blockEvent(top.height, top);
      }
      trackChain(S.blocks);
      ok(); schedulePaint();
    });
  }

  /* The two mempool feeds do not use the same unit for the same figure: REST
     /api/mempool answers total_fee in satoshis, while the websocket push carries
     mempoolInfo.total_fee in BTC. The HUD reads this field as BTC, so the REST value
     is scaled once here; without it the fee line showed millions of BTC until the
     first push replaced it. */
  var SATS_PER_BTC = 1e8;
  function toBtc(v) {
    return num(v) && v >= 0 ? btcAmount(v / SATS_PER_BTC) : null;
  }
  function loadMem() {
    return request('/api/mempool').then(function (m) {
      if (!isObj(m) || !num(m.count) || !num(m.vsize)) throw new Error('bad mempool');
      S.mem = { count: m.count, vsize: m.vsize, totalFee: toBtc(m.total_fee) };
      ok(); schedulePaint();
    });
  }

  function loadRecentTxs() {
    return request('/api/mempool/recent').then(function (arr) {
      if (!isArr(arr)) throw new Error('bad mempool recent');
      S.recent = arr.filter(function (t) { return isObj(t) && typeof t.txid === 'string'; })
        .slice(0, 10).map(function (t) {
        return { txid: t.txid, fee: t.fee, vsize: t.vsize, value: t.value, rate: t.vsize ? t.fee / t.vsize : null };
      });
      ok(); schedulePaint();
    });
  }

  /* Fees: fastestFee drives the HUD and the watchdog, and the 30 m / 1 h figures sit
     beside it in the panel, so an answer is kept only when fastestFee is a finite number
     and only its numeric fields are copied — a string halfHourFee used to reach the
     panel and print NaN. */
  var FEE_FIELDS = ['fastestFee', 'halfHourFee', 'hourFee', 'economyFee', 'minimumFee'];
  function feesFromAnswer(f) {
    if (!isObj(f) || !num(f.fastestFee)) return null;
    var out = {};
    FEE_FIELDS.forEach(function (k) { if (num(f[k])) out[k] = f[k]; });
    return out;
  }
  /* The next-retarget row needs a finite difficultyChange; the other two only label it. */
  function diffFromAnswer(d) {
    if (!isObj(d) || !num(d.difficultyChange)) return null;
    return {
      difficultyChange: d.difficultyChange,
      remainingBlocks: num(d.remainingBlocks) ? d.remainingBlocks : null,
      estimatedRetargetDate: (typeof d.estimatedRetargetDate === 'string' || num(d.estimatedRetargetDate))
        ? d.estimatedRetargetDate : null
    };
  }

  function loadFees() {
    return request('/api/v1/fees/recommended').then(function (f) {
      var fees = feesFromAnswer(f);
      if (!fees) throw new Error('bad fees');
      S.fees = fees; noteFee(fees); ok(); schedulePaint();
    });
  }

  /* The hashrate answer is walked twice: paintPanel averages every entry of hashrates
     and formats currentHashrate. A proxy or a captive portal can answer with a string,
     a number or an object where that list belongs, and an isObj() check alone let it
     through — forEach() then threw on the next paint and a string figure printed NaN.
     Only the fields the app draws survive, each a finite number, and an answer without
     a single usable row is rejected so the previous series stays on screen. */
  function hrFromAnswer(h) {
    if (!isObj(h) || !isArr(h.hashrates)) return null;
    var rows = h.hashrates.filter(function (r) { return isObj(r) && num(r.avgHashrate); })
      .map(function (r) { return { avgHashrate: r.avgHashrate }; });
    if (!rows.length) return null;
    return { hashrates: rows, currentHashrate: num(h.currentHashrate) ? h.currentHashrate : null };
  }

  function loadHashrate() {
    return request('/api/v1/mining/hashrate/1w').then(function (h) {
      var hr = hrFromAnswer(h);
      if (!hr) throw new Error('bad hashrate');
      S.hr = hr; ok(); schedulePaint();
    });
  }

  function loadDiff() {
    return request('/api/v1/difficulty-adjustment').then(function (d) {
      var diff = diffFromAnswer(d);
      if (!diff) throw new Error('bad difficulty');
      S.diff = diff; ok(); schedulePaint();
    });
  }

  function loadPools() {
    return request('/api/v1/mining/pools/1w').then(function (p) {
      if (!isObj(p) || !isArr(p.pools) || !p.pools.length) throw new Error('no pools');
      S.pools = p; S.poolsAt = Date.now(); schedulePaint();
    });
  }

  /* Every figure the Lightning block prints is re-typed here: a string where a number
     belongs printed NaN straight into the HUD and the panel, and a non-string `added`
     reached dateOf() with a shape it was never meant to read. Only the finite numbers
     and the string `added` are kept; an answer left with nothing usable is rejected by
     the caller, which keeps the previous stats on screen. */
  var LN_NUMS = ['id', 'channel_count', 'node_count', 'total_capacity', 'tor_nodes',
    'clearnet_nodes', 'unannounced_nodes', 'avg_capacity', 'avg_fee_rate',
    'avg_base_fee_mtokens', 'med_capacity', 'med_fee_rate', 'med_base_fee_mtokens',
    'clearnet_tor_nodes'];
  function lnFromAnswer(d) {
    if (!isObj(d)) return null;
    var out = {};
    LN_NUMS.forEach(function (k) { if (num(d[k])) out[k] = d[k]; });
    out.added = typeof d.added === 'string' ? d.added : '';
    return out;
  }

  function loadLightning() {
    return request('/api/v1/lightning/statistics/latest').then(function (d) {
      var ln = lnFromAnswer(d && d.latest);
      if (!ln || !num(ln.node_count) || !num(ln.channel_count)) throw new Error('no ln stats');
      S.ln = ln; S.lnAt = Date.now(); ok(); schedulePaint();
    });
  }

  function loadCountries() {
    return request('/api/v1/lightning/nodes/countries').then(function (arr) {
      if (!isArr(arr)) throw new Error('bad countries');
      /* The rows are summed per continent and counted, so a row without a finite count
         would turn a sum into a string (“12” + 5 = “125”): the live answer is held to the
         same shape as a cached one, which has been checked element by element since
         1.1.7. */
      var rows = arr.map(countryRow).filter(Boolean);
      if (!rows.length) throw new Error('no countries');
      S.countries = rows;
      S.conts = aggregateContinents(S.countries);
      ok(); schedulePaint();
    });
  }

