/* Unit tests for the on-demand clustering engine (src/js/35-cluster.js).

   No browser, no build, no network. The module is loaded the way build.py loads it —
   inside 00-core.js's own IIFE scope, so it reads num/isObj/isArr/store/recall exactly
   as the app does — with fetch and localStorage replaced by recording stubs. The
   pure half (analyzeTxs) is driven with hand-built transactions; the on-demand half is
   driven through analyzeEntity() against scripted API answers.

   Run: node test/cluster.js
*/
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const CORE = fs.readFileSync(path.join(ROOT, 'src', 'js', '00-core.js'), 'utf8');
const MOD = fs.readFileSync(path.join(ROOT, 'src', 'js', '35-cluster.js'), 'utf8');

const HOSTS = ['https://mempool.space', 'https://mempool.emzy.de', 'https://mempool.ninja'];

/* ---------------------------------------------------------------- fixtures */
let addrSeq = 0;
function addr(tag) {
  const t = tag === undefined ? 'x' + (++addrSeq) : String(tag);
  return ('bc1q' + t.replace(/[^a-z0-9]/gi, '') + '0000000000000000000000000000000000000').slice(0, 42);
}

/* compact transaction, the shape compressTx() produces and analyzeTxs() reads */
function cin(a, v, t) { return { a: a, v: v, t: t || 'v0_p2wpkh', cb: false }; }
function cout(a, v, t, n) { return { a: a, v: v, t: t || 'v0_p2wpkh', n: n || 0 }; }
function mtx(id, at, vin, vout) { return { txid: id, at: at, conf: true, fee: 500, vin: vin, vout: vout }; }

/* raw mempool.space transaction, the shape compressTx() reads */
function rawTx(id, time, vin, vout) {
  return {
    txid: id, version: 2, locktime: 0, fee: 700,
    vin: vin.map(function (x, i) {
      return {
        txid: 'aa'.repeat(31) + String(i).slice(-2), vout: i,
        prevout: { scriptpubkey: '', scriptpubkey_asm: '', scriptpubkey_type: x.t || 'v0_p2wpkh', scriptpubkey_address: x.a, value: x.v },
        scriptsig: '', is_coinbase: false, sequence: 4294967295
      };
    }),
    vout: vout.map(function (x) {
      return { scriptpubkey: '', scriptpubkey_asm: '', scriptpubkey_type: x.t || 'v0_p2wpkh', scriptpubkey_address: x.a, value: x.v };
    }),
    size: 250, weight: 800,
    status: { confirmed: true, block_height: 800000, block_hash: 'bb'.repeat(32), block_time: time }
  };
}

function summaryJson(a, balance, txCount) {
  return {
    address: a,
    chain_stats: {
      funded_txo_count: txCount, funded_txo_sum: balance,
      spent_txo_count: 0, spent_txo_sum: 0, tx_count: txCount
    },
    mempool_stats: { funded_txo_count: 0, funded_txo_sum: 0, spent_txo_count: 0, spent_txo_sum: 0, tx_count: 0 }
  };
}

/* --------------------------------------------------------------- vm harness */
function makeApp(opts) {
  opts = opts || {};
  const ls = new Map();
  const calls = [];
  const route = opts.route || function () { return { status: 404 }; };
  const sandbox = {
    localStorage: {
      getItem: k => (ls.has(k) ? ls.get(k) : null),
      setItem: (k, v) => { ls.set(k, String(v)); },
      removeItem: k => { ls.delete(k); }
    },
    API_HOSTS: HOSTS,
    BR: { on: false },
    console: console,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    AbortController: AbortController,
    fetch: function (url, init) {
      calls.push(url);
      const plan = route(url, calls.length) || { status: 404 };
      const status = plan.status || 200;
      const body = plan.body;
      const delay = typeof plan.delay === 'number' ? plan.delay : (opts.delay || 0);
      const signal = init && init.signal;
      return new Promise(function (res, rej) {
        let live = true;
        function cleanup() { if (signal && signal.removeEventListener) signal.removeEventListener('abort', onAbort); }
        function onAbort() { if (!live) return; live = false; cleanup(); const e = new Error('aborted'); e.name = 'AbortError'; rej(e); }
        if (signal) {
          if (signal.aborted) return onAbort();
          signal.addEventListener('abort', onAbort);
        }
        const fire = () => {
          if (!live) return;
          live = false;
          cleanup();
          res({ ok: status >= 200 && status < 300, status: status, json: () => Promise.resolve(body) });
        };
        if (delay) setTimeout(fire, delay); else fire();
      });
    }
  };
  const ctx = vm.createContext(sandbox);
  /* The same concatenation build.py performs, closed with the IIFE's own end. */
  const app = vm.runInContext(CORE + '\n' + MOD + '\nreturn { Cluster: Cluster };\n})();', ctx);
  return { Cluster: app.Cluster, calls: calls, ls: ls, ctx: ctx };
}

/* ------------------------------------------------------------- assertions */
const results = [];
function check(name, cond, detail) {
  results.push({ name: name, ok: !!cond });
  console.log((cond ? 'ok   ' : 'FAIL ') + name + (cond || detail === undefined ? '' : '  → ' + detail));
}
function eq(name, got, want) {
  check(name, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got) + ' vs ' + JSON.stringify(want));
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function apiRoutes(map) {
  return function (url) {
    const m = url.match(/^https:\/\/[^/]+\/api\/address\/([^/]+)(\/txs)?$/);
    if (!m) return { status: 404 };
    const a = decodeURIComponent(m[1]);
    const e = map[a];
    if (!e) return { status: 400, body: { error: 'invalid address' } };
    if (m[2]) return { status: 200, body: e.txs || [] };
    return { status: 200, body: e.summary || summaryJson(a, 0, 0) };
  };
}

(async function main() {

  /* ================================================================= pure == */
  {
    const app = makeApp();
    const C = app.Cluster;

    /* ---- common-input ownership ---- */
    const S1 = addr('seedone'), B = addr('partner'), M = addr('merchant'), CH = addr('change');
    const t1 = mtx('t1'.padEnd(64, '0'), 1000,
      [cin(S1, 100000), cin(B, 50000)],
      [cout(M, 500000), cout(CH, 137432)]);
    let r = C.analyzeTxs([{ address: S1, verified: true }], [{ address: S1, txs: [t1] }]);
    check('one cluster holds both spenders of one transaction',
      r.clusters.length === 1 && r.clusters[0].size === 2, JSON.stringify(r.clusters.map(c => c.size)));
    const byAddr = {};
    r.addresses.forEach(a => { byAddr[a.address] = a; });
    eq('the seed carries the Verified label', byAddr[S1] && byAddr[S1].label, 'Verified');
    eq('the co-spender carries the Common-Input label', byAddr[B] && byAddr[B].label, 'Common-Input');
    eq('the cluster is Verified when it holds a seed', r.clusters[0].label, 'Verified');
    eq('one verified, one heuristic', [r.clusters[0].verified, r.clusters[0].heuristic], [1, 1]);
    check('the recipient and the change address are not cluster members',
      !byAddr[M] && !byAddr[CH], Object.keys(byAddr).join(','));

    /* ---- a payment to the entity must not adopt the payer ---- */
    const P1 = addr('payer1'), P2 = addr('payer2'), S2 = addr('seedtwo');
    const pay = mtx('t2'.padEnd(64, '0'), 2000,
      [cin(P1, 400000), cin(P2, 200000)],
      [cout(addr('dest'), 500000), cout(S2, 90000)]);
    r = C.analyzeTxs([{ address: S2, verified: true }], [{ address: S2, txs: [pay] }]);
    check('a payment to the entity does not adopt the payer',
      r.clusters.length === 1 && r.clusters[0].size === 1 && !r.clusters[0].addresses.some(a => a.address === P1),
      JSON.stringify(r.clusters.map(c => c.addresses.map(a => a.address))));
    eq('no shared-input edge from a payment the entity received', r.shared.length, 0);
    eq('a payment to the entity is never given a change estimate', r.change.length, 0);

    /* ---- change estimation ---- */
    const CH2 = addr('change2'), PAY2 = addr('pay2');
    const t3 = mtx('t3'.padEnd(64, '0'), 3000,
      [cin(S1, 700000)],
      [cout(PAY2, 500000), cout(CH2, 199768)]);
    r = C.analyzeTxs([{ address: S1, verified: true }], [{ address: S1, txs: [t3] }]);
    eq('one change output is estimated', r.change.length, 1);
    eq('the non-round output is the change', r.change[0] && r.change[0].address, CH2);
    eq('the change is labelled Change Est.', C.labels.change, 'Change Est.');
    eq('the change carries a score and reasons',
      [typeof r.change[0].score, r.change[0].why.length > 0], ['number', true]);
    check('the change never joins the cluster',
      !r.clusters[0].addresses.some(a => a.address === CH2), JSON.stringify(r.clusters[0].addresses.map(a => a.address)));
    eq('the change points at its cluster', r.change[0].clusterId, 0);

    /* two plausible outputs: the engine refuses to guess */
    const t4 = mtx('t4'.padEnd(64, '0'), 3100,
      [cin(S1, 700000)],
      [cout(addr('a4'), 333333), cout(addr('b4'), 366667)]);
    r = C.analyzeTxs([{ address: S1 }], [{ address: S1, txs: [t4] }]);
    eq('two equally plausible outputs give no estimate', r.change.length, 0);

    /* both round: no estimate */
    const t5 = mtx('t5'.padEnd(64, '0'), 3200,
      [cin(S1, 700000)],
      [cout(addr('a5'), 300000), cout(addr('b5'), 400000)]);
    r = C.analyzeTxs([{ address: S1 }], [{ address: S1, txs: [t5] }]);
    eq('two round outputs give no estimate', r.change.length, 0);

    /* mixed script types: no estimate */
    const t6 = mtx('t6'.padEnd(64, '0'), 3300,
      [cin(S1, 700000)],
      [cout(addr('a6'), 500000), cout(addr('b6'), 199768, 'p2pkh')]);
    r = C.analyzeTxs([{ address: S1 }], [{ address: S1, txs: [t6] }]);
    eq('mixed script types give no estimate', r.change.length, 0);

    /* three outputs (a batch): no estimate */
    const t7 = mtx('t7'.padEnd(64, '0'), 3400,
      [cin(S1, 900000)],
      [cout(addr('a7'), 300000), cout(addr('b7'), 300000), cout(addr('c7'), 299768)]);
    r = C.analyzeTxs([{ address: S1 }], [{ address: S1, txs: [t7] }]);
    eq('a three-output transaction gives no estimate', r.change.length, 0);

    /* an unverified seed is an attribution the table makes, never something the heuristic
       discovered: it is Attributed, and Common-Input is kept for the addresses it found */
    const U = addr('unver');
    r = C.analyzeTxs([{ address: U, verified: false }], [{ address: U, txs: [t1] }]);
    const uc = r.clusters.filter(c => c.addresses.some(a => a.address === U))[0];
    eq('an unverified seed is Attributed, not Common-Input', uc && uc.label, 'Attributed');
    eq('the row carries the same word', r.addresses.filter(a => a.address === U)[0].label, 'Attributed');
    eq('the cluster counts it apart from verified and common-input', uc && [uc.verified, uc.attributed, uc.heuristic], [0, 1, 0]);
    eq('all four labels are exported', C.limits().labels.length, 4);

    /* ---- coinjoin exclusion ---- */
    const CJIN = [S1, addr('cj2'), addr('cj3'), addr('cj4'), addr('cj5')];
    const CJOUT = [addr('co1'), addr('co2'), addr('co3'), addr('co4'), addr('co5')];
    const cj = mtx('t8'.padEnd(64, '0'), 4000,
      CJIN.map(a => cin(a, 200000)),
      CJOUT.map(a => cout(a, 100000)));
    r = C.analyzeTxs([{ address: S1, verified: true }], [{ address: S1, txs: [cj] }]);
    eq('a five-equal-output coinjoin is excluded', r.coinjoinExcluded, 1);
    eq('the exclusion is reported with its reason', r.coinjoin.length, 1);
    check('the coinjoin does not merge its participants',
      r.clusters.length === 1 && r.clusters[0].size === 1, JSON.stringify(r.clusters.map(c => c.size)));
    eq('a coinjoin is never given a change estimate', r.change.length, 0);
    check('the reason names the repeated amount', /outputs of/.test(r.coinjoin[0].why.join(' ')), r.coinjoin[0].why.join(' '));

    /* a wide fan-in/fan-out with distinct amounts */
    const wideIn = [], wideOut = [];
    for (let i = 0; i < 12; i++) wideIn.push(cin(addr('wi' + i), 100000 + i));
    for (let i = 0; i < 12; i++) wideOut.push(cout(addr('wo' + i), 101000 + i * 7));
    wideIn[0] = cin(S1, 111111);
    const wide = mtx('t9'.padEnd(64, '0'), 4100, wideIn, wideOut);
    r = C.analyzeTxs([{ address: S1 }], [{ address: S1, txs: [wide] }]);
    eq('a wide fan-in/fan-out is excluded', r.coinjoinExcluded, 1);
    check('the exclusion names the fan', /fan-in/.test(r.coinjoin[0].why.join(' ')), r.coinjoin[0].why.join(' '));

    /* two equal outputs are an ordinary payment, not a coinjoin */
    const twin = mtx('t10'.padEnd(63, '0'), 4200,
      [cin(S1, 300000)],
      [cout(addr('w1'), 150000), cout(addr('w2'), 149000)]);
    r = C.analyzeTxs([{ address: S1 }], [{ address: S1, txs: [twin] }]);
    eq('a two-output payment is never a coinjoin', r.coinjoinExcluded, 0);
    eq('both outputs are still seen', r.stats.scanned, 1);

    /* ---- labels are never mixed ---- */
    const L = C.labels;
    check('the three labels are distinct', L.verified !== L.common && L.common !== L.change && L.verified !== L.change,
      JSON.stringify(L));

    /* ---- a transaction too wide to hold whole ---- */
    const wideOuts = [];
    for (let i = 0; i < 600; i++) wideOuts.push({ a: addr('fat' + i), v: 330 });
    const fatRaw = rawTx('f'.repeat(64), 4300, [{ a: S1, v: 1000000 }], wideOuts);
    const fat = C.compressTx(fatRaw);
    eq('a transaction is held to 500 rows a side', [fat.vout.length, fat.no, fat.part], [500, 600, true]);
    const fatCj = C.detectCoinJoin(fat);
    check('a cut transaction is excluded, not read',
      fatCj.coinjoin === true && /too wide/.test(fatCj.why.join(' ')), fatCj.why.join(' '));
    eq('a cut transaction yields no change estimate', C.estimateChange(fat, { seen: {} }), null);
    const smallRaw = rawTx('e'.repeat(64), 4400, [{ a: S1, v: 1000000 }], wideOuts.slice(0, 400));
    const small = C.compressTx(smallRaw);
    eq('an ordinary batch is read whole', [small.vout.length, small.part], [400, false]);
  }

  /* ============================================================== network == */
  {
    /* ---- one full run ---- */
    const S1 = addr('n1'), S2 = addr('n2'), B = addr('n3'), PAY = addr('n4'), CH = addr('n5');
    const map = {};
    map[S1] = {
      summary: summaryJson(S1, 2500000, 3),
      txs: [
        rawTx('c1'.padEnd(64, '0'), 1700000000,
          [{ a: S1, v: 3000000 }, { a: B, v: 500000 }],
          [{ a: PAY, v: 3000000 }, { a: CH, v: 494000 }])
      ]
    };
    map[S2] = { summary: summaryJson(S2, 1000000, 1), txs: [] };
    map[B] = { summary: summaryJson(B, 500000, 1), txs: [] };

    const app = makeApp({ route: apiRoutes(map) });
    const phases = [];
    const res = await app.Cluster.analyzeEntity(
      [{ address: S1, verified: true }, { address: S2, verified: true }],
      { onProgress: p => phases.push(p.phase) });

    check('a run resolves ok', res.ok === true, JSON.stringify(res.error || ''));
    eq('two addresses cost four calls', res.api.calls, 4);
    eq('a live run says live', res.api.source, 'live');
    check('each seed is a cluster of its own when no transaction joins them',
      res.clusters.length === 2 && res.clusters.map(c => c.size).join(',') === '2,1',
      JSON.stringify(res.clusters.map(c => c.size)));
    eq('the verified balance is the sum of the seeds', res.entity.balance, 3500000);
    eq('the entity reports two verified addresses', res.entity.verified, 2);
    const s1row = res.addresses.filter(a => a.address === S1)[0];
    eq('the seed row carries its live balance', s1row && s1row.balance, 2500000);
    eq('the joined address has no balance of its own', res.addresses.filter(a => a.address === B)[0].balance, null);
    check('progress reports start, both phases and done',
      phases[0] === 'start' && phases[phases.length - 1] === 'done' &&
      phases.indexOf('summary') > 0 && phases.indexOf('txs') > 0, phases.join(','));
    check('the run leaves nothing running', app.Cluster.running() === false);
    check('lastResult() is the run that finished', app.Cluster.lastResult() === res);

    /* ---- a second run is served from the cache ---- */
    const callsBefore = app.calls.length;
    const res2 = await app.Cluster.analyzeEntity(
      [{ address: S1, verified: true }, { address: S2, verified: true }]);
    eq('a cached run makes no request', app.calls.length - callsBefore, 0);
    eq('a cached run says cache', res2.api.source, 'cache');
    eq('a cached run spends no API call', res2.api.calls, 0);
    eq('a cached run finds the same cluster', res2.clusters.length, res.clusters.length);
    eq('a cached run keeps the balance', res2.entity.balance, 3500000);
    eq('a cached row is labelled cache', res2.addresses.filter(a => a.address === S1)[0].source, 'cache');

    /* ---- a single address read, served from the same cache ---- */
    const one = await app.Cluster.fetchAddressSummary(S1);
    eq('a single summary read returns the balance', one && one.balance, 2500000);
    eq('a single summary read is cached', one.source, 'cache');
    let threw = null;
    try { await app.Cluster.fetchAddressSummary('!!'); } catch (e) { threw = e.message; }
    eq('an address that cannot exist never reaches the network', threw, 'invalid address');

    /* ---- a stale entry is refetched ---- */
    const raw = JSON.parse(app.ls.get('nodepulse.cluster.v1'));
    Object.keys(raw.e).forEach(k => { raw.e[k].st = Date.now() - 3600 * 1000; raw.e[k].xt = Date.now() - 3600 * 1000; });
    app.ls.set('nodepulse.cluster.v1', JSON.stringify(raw));
    const before = app.calls.length;
    const res3 = await app.Cluster.analyzeEntity([{ address: S1, verified: true }]);
    check('a stale entry is fetched again', app.calls.length - before === 2 && res3.api.source === 'live',
      (app.calls.length - before) + ' / ' + res3.api.source);

    /* ---- a poisoned cache is not believed ---- */
    const S3 = addr('n6');
    app.ls.set('nodepulse.cluster.v1', JSON.stringify({
      v: 1,
      e: {
        [S3]: { t: Date.now(), s: { balance: 'a lot', txCount: {} }, x: 'not an array' },
        [S1]: { t: Date.now(), s: { balance: 'a lot' }, x: [] }
      }
    }));
    const appBad = makeApp({ route: apiRoutes({ [S3]: { summary: summaryJson(S3, 42, 1), txs: [] }, [S1]: { summary: summaryJson(S1, 7, 1), txs: [] } }) });
    appBad.ls.set('nodepulse.cluster.v1', app.ls.get('nodepulse.cluster.v1'));
    const resBad = await appBad.Cluster.analyzeEntity([{ address: S3, verified: true }]);
    eq('a summary with a non-numeric balance is a miss', resBad.api.calls, 2);
    eq('the refetched balance is the answer', resBad.entity.balance, 42);
  }

  /* ------------------------------------------------------------- limits -- */
  {
    const S1 = addr('l1'), S2 = addr('l2');
    const many = [];
    for (let i = 0; i < 40; i++) {
      many.push(rawTx('d' + String(i).padStart(2, '0').padEnd(62, '0'), 1700000000 + i,
        [{ a: S1, v: 1000000 }], [{ a: addr('o' + i), v: 900000 }, { a: addr('q' + i), v: 99000 }]));
    }
    const app = makeApp({ route: apiRoutes({ [S1]: { summary: summaryJson(S1, 100, 40), txs: many } }) });
    const res = await app.Cluster.analyzeEntity([{ address: S1, verified: true }], { maxTxsPerAddress: 20 });
    eq('the per-address cap keeps 20 transactions', res.stats.txs, 20);
    check('the cap is disclosed', res.truncated === true && res.stats.maxTxsPerAddress === 20,
      res.truncated + ' / ' + res.stats.maxTxsPerAddress);
    const cached = JSON.parse(app.ls.get('nodepulse.cluster.v1')).e[S1];
    eq('only the capped list is saved', cached.x.length, 20);

    /* total call ceiling across many addresses */
    const map = {};
    const seeds = [];
    for (let i = 0; i < 6; i++) {
      const a = addr('cap' + i);
      seeds.push({ address: a, verified: true });
      map[a] = { summary: summaryJson(a, 1000 * (i + 1), 1), txs: [] };
    }
    const app2 = makeApp({ route: apiRoutes(map) });
    const res2 = await app2.Cluster.analyzeEntity(seeds, { maxApiCalls: 5 });
    eq('the API ceiling is never passed', res2.api.calls, 5);
    check('a cut run says it was cut', res2.truncated === true);
    check('every seed is still a cluster', res2.clusters.length === 6, res2.clusters.length);
    check('the unread seeds carry no balance',
      res2.clusters.filter(c => c.balance === null).length >= 3,
      res2.clusters.map(c => c.balance).join(','));

    /* the address cap: one seed read, both reported */
    const app4 = makeApp({ route: apiRoutes(map) });
    const res4 = await app4.Cluster.analyzeEntity(seeds, { maxAddresses: 1 });
    eq('the address cap is honored', res4.stats.read, 1);
    check('the seeds beyond the cap are still reported', res4.clusters.length === 6 && res4.truncated === true,
      res4.clusters.length + ' / ' + res4.truncated);
    eq('only the read seed has a balance', res4.clusters.filter(c => c.balance !== null).length, 1);

    /* an address the mirror rejects does not stop the run */
    const okAddr = addr('after');
    const badAddr = addr('badone');
    const app3 = makeApp({
      route: url => {
        if (url.indexOf(badAddr) > 0) return { status: 400, body: { error: 'invalid' } };
        return apiRoutes({ [okAddr]: { summary: summaryJson(okAddr, 500, 1), txs: [] } })(url);
      }
    });
    const res3 = await app3.Cluster.analyzeEntity([{ address: badAddr }, { address: okAddr, verified: true }]);
    eq('a rejected address is counted as a failure', res3.api.failed, 1);
    eq('the rest of the run still finishes', res3.entity.balance, 500);
  }

  /* ------------------------------------------------------------ fallback -- */
  {
    const S1 = addr('m1');
    let n = 0;
    const app = makeApp({
      route: url => {
        n++;
        if (url.indexOf('mempool.space') >= 0) return { status: 500, body: null };
        return apiRoutes({ [S1]: { summary: summaryJson(S1, 900, 1), txs: [] } })(url);
      }
    });
    const res = await app.Cluster.analyzeEntity([{ address: S1, verified: true }]);
    eq('a dead mirror falls to the next one', res.entity.balance, 900);
    check('each request tries the dead mirror once and the next answers',
      app.calls.length === 4 &&
      app.calls[0].indexOf('mempool.space') > 0 && app.calls[1].indexOf('mempool.emzy.de') > 0 &&
      app.calls[2].indexOf('mempool.space') > 0 && app.calls[3].indexOf('mempool.emzy.de') > 0,
      app.calls.join(' | '));

    /* 429: the rotation uses the mirrors, then the run stops asking */
    const app2 = makeApp({ route: () => ({ status: 429, body: { error: 'rate limited' } }) });
    const S2 = addr('m2'), S3 = addr('m3');
    const res2 = await app2.Cluster.analyzeEntity([{ address: S2 }, { address: S3 }]);
    check('a rate limit is reported', res2.rateLimited === true);
    eq('a rate-limited run stops after one address', app2.calls.length, HOSTS.length);
    eq('an unanswered run is still a result', res2.ok, true);
    eq('the failed address has no balance', res2.entity.balance, null);
  }

  /* ------------------------------------------------------------ cancel --- */
  {
    const S1 = addr('c1');
    const app = makeApp({
      delay: 400,
      route: apiRoutes({ [S1]: { summary: summaryJson(S1, 1, 1), txs: [] } })
    });
    const t0 = Date.now();
    const p = app.Cluster.analyzeEntity([{ address: S1, verified: true }]);
    check('a run is marked running', app.Cluster.running() === true);
    await sleep(250);
    eq('cancelCluster() reports it stopped a run', app.Cluster.cancelCluster(), true);
    const res = await p;
    const ms = Date.now() - t0;
    check('cancel resolves promptly', ms < 1500, ms + 'ms');
    eq('a cancelled run says so', res.aborted, true);
    eq('a cancelled run is not an error', res.ok, true);
    check('a cancelled run keeps what it had', Array.isArray(res.clusters) && res.clusters.length === 1);
    eq('no run is left registered', app.Cluster.running(), false);
    eq('cancel with nothing running is a no-op', app.Cluster.cancelCluster(), false);

    /* the caller's own AbortSignal */
    const app2 = makeApp({ delay: 400, route: apiRoutes({ [S1]: { summary: summaryJson(S1, 1, 1), txs: [] } }) });
    const ac = new AbortController();
    const p2 = app2.Cluster.analyzeEntity([{ address: S1, verified: true }], { signal: ac.signal });
    await sleep(150);
    ac.abort();
    const res2 = await p2;
    eq('an aborted signal cancels the run', res2.aborted, true);

    /* a run already aborted before it starts asks nothing */
    const app3 = makeApp({ route: apiRoutes({ [S1]: { summary: summaryJson(S1, 1, 1), txs: [] } }) });
    const ac3 = new AbortController();
    ac3.abort();
    const res3 = await app3.Cluster.analyzeEntity([{ address: S1, verified: true }], { signal: ac3.signal });
    eq('an already-aborted run sends no request', app3.calls.length, 0);
    eq('an already-aborted run says so', res3.aborted, true);
  }

  /* -------------------------------------------------------------- shape --- */
  {
    const app = makeApp();
    const res = await app.Cluster.analyzeEntity(['not an address', '!!']);
    eq('no usable address is answered, not thrown', res.ok, false);
    eq('the reason is named', res.error, 'no valid address');
    eq('the empty result still carries the shape',
      [Array.isArray(res.clusters), Array.isArray(res.addresses), Array.isArray(res.change)], [true, true, true]);
    eq('a limit report is offered to the UI',
      [app.Cluster.limits().maxTxsPerAddress, app.Cluster.limits().maxApiCalls], [20, 18]);

    /* a raw transaction that no shape can be read from is dropped, not fatal */
    const S1 = addr('s1');
    const app2 = makeApp({
      route: url => url.indexOf('/txs') > 0
        ? { status: 200, body: [null, 7, { txid: 'x' }, { txid: 'y'.repeat(64), vin: [], vout: [] }] }
        : { status: 200, body: summaryJson(S1, 5, 1) }
    });
    const res2 = await app2.Cluster.analyzeEntity([{ address: S1, verified: true }]);
    eq('unreadable rows are dropped and the run finishes', res2.ok, true);
    eq('the cluster keeps the seed', res2.clusters.length, 1);
    eq('the seed balance survives', res2.clusters[0].balance, 5);
  }

  /* -------------------------------------------------------------- report -- */
  const bad = results.filter(r => !r.ok);
  console.log('\n================ RESULT ================');
  console.log('checks: ' + results.length + '  passed: ' + (results.length - bad.length) + '  failed: ' + bad.length);
  bad.forEach(b => console.log('  ✗ ' + b.name));
  if (!bad.length) console.log('ALL CHECKS PASSED');
  process.exit(bad.length ? 1 : 0);
})().catch(e => {
  console.error('harness error:', e && e.stack || e);
  process.exit(1);
});
