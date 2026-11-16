/* Headless verification harness: boots the built single-file app in a stubbed DOM,
   feeds it the real API payloads captured in fixtures/, runs frames, and checks the
   rendered values + globe geometry. Run: node test/headless.js */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const HTML = path.resolve(ROOT, '..', '..', 'bitcoin-network-monitor.html');
const FIX = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures', 'api-snapshot.json'), 'utf8'));
const CHGEO = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures', 'channels-geo.json'), 'utf8'));

function readDataFile(file, name) {
  const t = fs.readFileSync(path.join(ROOT, 'src', 'data', file), 'utf8');
  const at = t.indexOf('var ' + name + ' =');
  return JSON.parse(t.slice(at + ('var ' + name + ' =').length, t.lastIndexOf(';')));
}
const NODESEED = readDataFile('seed-nodes.js', 'NODE_SEED');
const CHSEED = readDataFile('channels-data.js', 'CHANNEL_SEED');

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail: detail === undefined ? '' : String(detail) });
  if (!cond) console.log('FAIL ' + name + (detail ? '  → ' + detail : ''));
}

/* ---------------------------------------------------------------- DOM stub */
function makeEl(id) {
  const el = {
    id, textContent: '', innerHTML: '', value: '', offsetWidth: 100, scrollTop: 0,
    width: 0, height: 0, attrs: {}, listeners: {}, children: [], style: {},
    classList: (() => {
      const set = new Set();
      return {
        add: (...c) => c.forEach(x => set.add(x)),
        remove: (...c) => c.forEach(x => set.delete(x)),
        toggle: (c, force) => { const on = force === undefined ? !set.has(c) : !!force; on ? set.add(c) : set.delete(c); return on; },
        contains: c => set.has(c),
        _set: set
      };
    })(),
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    removeEventListener() { },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    appendChild(c) { this.children.push(c); return c; },
    querySelector() { return null; },
    click() { (this.listeners.click || []).forEach(f => f({ target: this, preventDefault() { } })); },
    dispatch(type, ev) { (this.listeners[type] || []).forEach(f => f(ev || { target: this, preventDefault() { }, pointerId: 1, clientX: 0, clientY: 0 })); },
    getContext() { return ctx2d; },
    setPointerCapture() { }
  };
  return el;
}

const ctxCalls = { arc: 0, lineTo: 0, fill: 0, stroke: 0 };
const ctx2d = {
  canvas: null,
  globalAlpha: 1, fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: '',
  setTransform() { }, save() { }, restore() { }, translate() { }, scale() { },
  clearRect() { }, fillRect() { },
  beginPath() { }, closePath() { }, moveTo() { }, lineTo() { ctxCalls.lineTo++; },
  arc() { ctxCalls.arc++; }, fill() { ctxCalls.fill++; }, stroke() { ctxCalls.stroke++; },
  createRadialGradient() { return { addColorStop() { } }; },
  createLinearGradient() { return { addColorStop() { } }; },
  fillText() { }, measureText() { return { width: 10 }; },
  drawImage() { }
};

const els = {};
const document = {
  readyState: 'complete',
  hidden: false,
  getElementById(id) { return els[id] || (els[id] = makeEl(id)); },
  querySelector(sel) { return null; },
  querySelectorAll() { return []; },
  addEventListener() { },
  createElement(tag) { return makeEl(tag); },
  body: makeEl('body')
};

/* ------------------------------------------------------------------ fetch */
let fetchMode = 'ok';
const fetchLog = [];
function fakeFetch(url) {
  fetchLog.push(url);
  const pathOnly = url.replace(/^https?:\/\/[^/]+/, '');
  const host = url.replace(/^(https?:\/\/[^/]+).*/, '$1');
  if (fetchMode === 'fail') return Promise.reject(new Error('network down'));
  if (host !== 'https://mempool.space') return Promise.reject(new Error('mirror refused'));
  let body = null, kind = 'json';
  if (pathOnly === '/api/blocks/tip/height') { body = String(FIX.tip); kind = 'text'; }
  else if (pathOnly === '/api/v1/blocks') body = FIX.blocks;
  else if (pathOnly === '/api/mempool') body = FIX.mempool;
  else if (pathOnly === '/api/mempool/recent') body = FIX.recent;
  else if (pathOnly === '/api/v1/fees/recommended') body = FIX.fees;
  else if (pathOnly === '/api/v1/mining/hashrate/1w') body = FIX.hashrate;
  else if (pathOnly === '/api/v1/difficulty-adjustment') body = FIX.diff;
  else if (pathOnly === '/api/v1/lightning/statistics/latest') body = FIX.lnstats;
  else if (pathOnly === '/api/v1/lightning/nodes/countries') body = FIX.countries;
  else if (pathOnly === '/api/v1/lightning/channels-geo') body = CHGEO;
  else if (pathOnly === '/api/v1/lightning/nodes/rankings/connectivity') body = FIX.connectivity;
  else if (pathOnly === '/api/v1/lightning/nodes/rankings/liquidity') body = FIX.liquidity;
  else if (/^\/api\/v1\/lightning\/nodes\/[0-9a-f]{66}$/.test(pathOnly)) {
    const pk = pathOnly.split('/').pop();
    const hit = FIX.nodes.find(n => n.public_key === pk);
    if (!hit) return Promise.reject(new Error('404'));
    body = hit;
  } else return Promise.reject(new Error('404 ' + pathOnly));

  return Promise.resolve({
    ok: true, status: 200,
    text: () => Promise.resolve(kind === 'text' ? body : JSON.stringify(body)),
    json: () => Promise.resolve(body)
  });
}

/* --------------------------------------------------------------- WebSocket */
let wsInstance = null;
function FakeWS(url) {
  this.url = url; this.readyState = 0; this.sent = [];
  wsInstance = this;
  setTimeout(() => { this.readyState = 1; if (this.onopen) this.onopen(); }, 20);
}
FakeWS.prototype.send = function (d) { this.sent.push(d); };
FakeWS.prototype.close = function () { this.readyState = 3; if (this.onclose) this.onclose(); };
FakeWS.prototype.deliver = function (obj) { if (this.onmessage) this.onmessage({ data: JSON.stringify(obj) }); };

/* ------------------------------------------------------------- localStorage */
const ls = new Map();
const localStorage = {
  getItem: k => (ls.has(k) ? ls.get(k) : null),
  setItem: (k, v) => ls.set(k, String(v)),
  removeItem: k => ls.delete(k),
  clear: () => ls.clear()
};

/* ------------------------------------------------------------------ window */
const rafQueue = [];
const window = {
  innerWidth: 400, innerHeight: 860, devicePixelRatio: 2,
  addEventListener() { }, removeEventListener() { },
  requestAnimationFrame: fn => { rafQueue.push(fn); return rafQueue.length; },
  cancelAnimationFrame() { },
  WebSocket: FakeWS,
  localStorage,
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: id => clearTimeout(id),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: id => clearInterval(id),
  location: { href: 'file:///bitcoin-network-monitor.html' },
  matchMedia: () => ({ matches: false, addEventListener() { } })
};

const sandbox = {
  window, document, localStorage, fetch: fakeFetch, AbortController,
  WebSocket: FakeWS, requestAnimationFrame: window.requestAnimationFrame,
  cancelAnimationFrame: window.cancelAnimationFrame,
  setTimeout, clearTimeout, setInterval, clearInterval, console,
  JSON, Math, Date, Promise, Object, Array, String, Number, isFinite, parseInt, parseFloat,
  encodeURIComponent, decodeURIComponent, Error, RegExp, Map, Set, TextEncoder
};
sandbox.globalThis = sandbox;
sandbox.self = window;

/* ------------------------------------------------------- extract + run js */
const html = fs.readFileSync(HTML, 'utf8');
check('single file has no external src', !/<script[^>]+src=/.test(html), 'script src found');
check('single file has no external stylesheet/link', !/<link[^>]+href="http/.test(html), 'remote link found');
check('title present', /<title>NODEPULSE/.test(html));
check('no proximity-link label left', !/근접·예시|가까운 노드끼리|NODE LINK/.test(html), 'proximity link wording still in the build');
check('legend names real lightning channels', /LIGHTNING CHANNEL/.test(html));
/* the globe is solid: a channel or coastline on the far hemisphere is never stroked
   through the body (these two colours were the only far-side passes) */
check('no far-side channel or coastline pass in the build',
  !/rgba\(90,150,235,0\.075\)/.test(html) && !/rgba\(90,150,230,0\.07\)/.test(html));

const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
check('inline script blocks', scripts.length === 5, scripts.length);

const ctx = vm.createContext(sandbox);
for (let i = 0; i < scripts.length; i++) {
  try {
    vm.runInContext(scripts[i], ctx, { filename: 'inline-' + i + '.js', timeout: 8000 });
  } catch (e) {
    check('script ' + i + ' executes', false, e && e.stack);
  }
}
check('scripts executed without throwing', true);

const sleep = ms => new Promise(r => setTimeout(r, ms));

function runFrames(n, step) {
  let t = 1000;
  for (let i = 0; i < n; i++) {
    const fns = rafQueue.splice(0, rafQueue.length);
    t += step || 16.7;
    fns.forEach(fn => { try { fn(t); } catch (e) { check('frame runs', false, e && e.stack); } });
  }
}

(async function main() {
  await sleep(1200);
  runFrames(3);

  const NP = window.NODEPULSE;
  check('NODEPULSE test hook exists', !!NP);
  const S = NP.state;

  /* ---- REST mapping ---- */
  check('tip height from /api/blocks/tip/height', S.tip === Number(FIX.tip), S.tip);
  check('blocks mapped from /api/v1/blocks', S.blocks.length === 8 && S.blocks[0].height === FIX.blocks[0].height,
    S.blocks.length + ' ' + (S.blocks[0] && S.blocks[0].height));
  check('mempool count/vsize mapped', S.mem && S.mem.count === FIX.mempool.count && S.mem.vsize === FIX.mempool.vsize,
    S.mem && JSON.stringify(S.mem));
  check('recent tx rate computed from fee/vsize',
    S.recent.length > 0 && Math.abs(S.recent[0].rate - FIX.recent[0].fee / FIX.recent[0].vsize) < 1e-9);
  check('fees mapped', S.fees && S.fees.fastestFee === FIX.fees.fastestFee, S.fees && S.fees.fastestFee);
  check('hashrate mapped', S.hr && S.hr.currentHashrate === FIX.hashrate.currentHashrate);
  check('difficulty mapped', S.diff && S.diff.remainingBlocks === FIX.diff.remainingBlocks);
  check('lightning stats mapped', S.ln && S.ln.node_count === FIX.lnstats.latest.node_count, S.ln && S.ln.node_count);
  check('countries mapped', S.countries.length === FIX.countries.length, S.countries.length);

  /* ---- the globe's nodes ARE channels-geo nodes ---- */
  const rowSet = new Set();
  const degInGeo = {};
  CHGEO.forEach(r => {
    rowSet.add(r[0] + '|' + r[4]);
    rowSet.add(r[4] + '|' + r[0]);
    degInGeo[r[0]] = (degInGeo[r[0]] || 0) + 1;
    degInGeo[r[4]] = (degInGeo[r[4]] || 0) + 1;
  });
  check('channels-geo fetched', S.chanRows === CHGEO.length, S.chanRows + ' vs ' + CHGEO.length);
  check('node sample filled', S.nodes.length === NODESEED.nodes.length && S.nodes.length >= 20, S.nodes.length);
  check('every globe node appears in channels-geo', S.nodes.every(n => degInGeo[n.pk] > 0),
    S.nodes.filter(n => !degInGeo[n.pk]).map(n => n.alias).join(','));
  check('node lat/lon inside valid ranges',
    S.nodes.every(n => typeof n.lat === 'number' && Math.abs(n.lat) <= 90 && Math.abs(n.lon) <= 180));
  check('node degree equals its channels-geo row count',
    S.nodes.every(n => n.deg === degInGeo[n.pk]),
    S.nodes.filter(n => n.deg !== degInGeo[n.pk]).map(n => n.alias + ':' + n.deg + '/' + degInGeo[n.pk]).join(','));
  const byPk = {};
  FIX.nodes.forEach(d => { byPk[d.public_key] = d; });
  check('every node has its nodes/{pubkey} detail', S.nodes.every(n => !!byPk[n.pk]),
    S.nodes.filter(n => !byPk[n.pk]).map(n => n.alias).join(','));
  const geoMatch = S.nodes.every(n => {
    const f = byPk[n.pk];
    return !f || (Math.abs(f.latitude - n.lat) < 1e-9 && Math.abs(f.longitude - n.lon) < 1e-9);
  });
  check('node coords equal the API response', geoMatch);
  const chMatch = S.nodes.every(n => {
    const rows = FIX.connectivity.concat(FIX.liquidity).filter(x => x.publicKey === n.pk && x.channels);
    if (rows.length) return n.channels === Math.max(...rows.map(x => x.channels)) && n.channelsSrc === 'ranking';
    return n.channels === byPk[n.pk].active_channel_count && n.channelsSrc === 'node';
  });
  check('node channel counts come from the API (ranking or active count)', chMatch,
    S.nodes.filter(n => {
      const rows = FIX.connectivity.concat(FIX.liquidity).filter(x => x.publicKey === n.pk && x.channels);
      return rows.length ? n.channels !== Math.max(...rows.map(x => x.channels)) : n.channels !== byPk[n.pk].active_channel_count;
    }).map(n => n.alias).join(','));
  check('node source is live', S.nodeSrc === 'live', S.nodeSrc);
  check('node sample covers several continents', new Set(S.nodes.map(n => n.iso)).size >= 8,
    new Set(S.nodes.map(n => n.iso)).size);

  /* ---- every drawn arc is a real channel ---- */
  const G = NP.globe;
  check('clusters built', G.clusters.length >= 5, G.clusters.length);
  const pkToCluster = {};
  G.clusters.forEach((c, i) => c.nodes.forEach(n => { pkToCluster[n.pk] = i; }));
  const expectArcs = new Set();
  CHGEO.forEach(r => {
    const a = pkToCluster[r[0]], b = pkToCluster[r[4]];
    if (a === undefined || b === undefined || a === b) return;
    expectArcs.add(Math.min(a, b) + '-' + Math.max(a, b));
  });
  const drawn = NP.links();
  check('at least 40 real channels are drawn', drawn.length >= 40, drawn.length);
  check('arc count stays in the clean band (40-60)', drawn.length >= 40 && drawn.length <= 60, drawn.length);
  check('drawn arcs are a subset of the real channels between drawn nodes',
    drawn.length <= expectArcs.size, drawn.length + ' of ' + expectArcs.size);
  check('no arc exists that is not a channels-geo row',
    drawn.every(([i, j]) => expectArcs.has(Math.min(i, j) + '-' + Math.max(i, j))),
    drawn.length + ' arcs');
  const noRealPair = drawn.filter(([i, j]) => {
    const A = G.clusters[i].nodes, B = G.clusters[j].nodes;
    return !A.some(x => B.some(y => rowSet.has(x.pk + '|' + y.pk)));
  });
  check('each arc has a concrete channel row behind it', noRealPair.length === 0, noRealPair.length);
  check('arcs survive clustering (no self link)',
    drawn.every(([i, j]) => i !== j && G.clusters[i] && G.clusters[j]));
  check('every drawn node carries at least one arc', G.clusters.every(c => c.arcs > 0),
    G.clusters.filter(c => !c.arcs).map(c => c.nodes[0].alias).join(','));
  check('no dot carries more than 6 arcs', G.clusters.every(c => c.arcs <= 6),
    G.clusters.filter(c => c.arcs > 6).map(c => c.nodes[0].alias + ':' + c.arcs).join(','));
  check('arc paths precomputed per channel', G.arcs.length === drawn.length, G.arcs.length);

  const visible = G.clusters.filter(c => c.on);
  check('some clusters visible on the front hemisphere', visible.length > 0, visible.length);
  const insideOk = visible.every(c => {
    const R = G.R * G.zoom;
    return Math.hypot(c.sx - G.cx, c.sy - G.cy) <= R * 1.02;
  });
  check('visible clusters project inside the disc', insideOk);

  /* ---- nodes/arcs stay welded to the projection at any rotation -
         project() (dots, ripples, cards) must equal projectRing() (continents)
         and projectArc() (channels) to the pixel, at every yaw/pitch. */
  let ringErr = 0, arcErr = 0, ringAt = null, arcAt = null, probeSamples = 0;
  [0, 0.6, 1.5, 2.4, 3.9, 5.2].forEach(y => [0, 0.35, -0.4].forEach(p => {
    const g = NP.geoProbe(y, p);
    probeSamples += g.samples;
    if (g.ringErr > ringErr) { ringErr = g.ringErr; ringAt = { yaw: y, pitch: p, worst: g.worst }; }
    if (g.arcErr > arcErr) { arcErr = g.arcErr; arcAt = { yaw: y, pitch: p }; }
  }));
  check('geoProbe sampled the globe', probeSamples > 5000, probeSamples);
  check('project() matches the continent projection at every rotation',
    ringErr < 1e-6, ringErr + ' px @ ' + JSON.stringify(ringAt));
  check('project() matches the arc endpoints at every rotation',
    arcErr < 1e-6, arcErr + ' px @ ' + JSON.stringify(arcAt));

  /* ---- light packets glide smoothly (no snapping to arc vertices) ---- */
  const t0 = 5;                                   /* seconds, as the frame loop passes it */
  const frames = [];
  for (let i = 0; i < 400; i++) frames.push(NP.packets(t0 + i * 0.002));
  check('packets are drawn', frames[0].length > 20, frames[0].length);
  const heads = frames[0].filter(p => p[2] === 7.5);
  check('every sampled arc carries a packet head', heads.length > 10, heads.length);

  /* follow one long arc's head through a stretch of its pass that cannot wrap, and
     check it advances a little every 2 ms — a snapped packet would stand still and
     then jump a whole segment */
  let best = null;
  for (const h of heads) {
    const arc = G.arcs[h[3]];
    if (!arc || arc.n < 20) continue;
    let prev = null, steps = 0, minD = 9, maxD = 0, onVertex = 0, total = 0;
    for (let i = 0; i < 300; i++) {
      const p = frames[i].find(q => q[2] === 7.5 && q[3] === h[3]);
      if (!p) break;
      if (p[4] < 0.15 || p[4] > 0.85) { prev = null; continue; }
      if (prev) {
        const d = Math.hypot(p[0] - prev[0], p[1] - prev[1]);
        if (d < minD) minD = d;
        if (d > maxD) maxD = d;
        steps++;
      }
      let near = 1e9;
      for (let k = 0; k < arc.n; k++) near = Math.min(near, Math.hypot(p[0] - arc.xs[k], p[1] - arc.ys[k]));
      if (near < 0.05) onVertex++;
      total++;
      prev = p;
    }
    if (steps > 40 && (!best || total > best.total)) best = { steps, minD, maxD, onVertex, total, n: arc.n };
  }
  check('a packet can be followed along one arc', !!best, JSON.stringify(best));
  if (false) {
    const h = frames[0].filter(p => p[2] === 7.5).map(p => p[3]).find(a => G.arcs[a] && G.arcs[a].n >= 20);
    const seq = frames.slice(0, 120).map(f => { const q = f.find(p => p[2] === 7.5 && p[3] === h); return q ? [q[4].toFixed(4), q[0].toFixed(1), q[1].toFixed(1)].join(' ') : '-'; });
    console.log('ARC', h, 'n', G.arcs[h].n, '\n' + seq.join('\n'));
  }
  if (best) {
    check('packet advances every 2 ms (never frozen on a vertex)', best.steps > 40 && best.minD > 0.01,
      best.steps + ' steps, min step ' + best.minD.toFixed(3) + ' px');
    check('packet step stays sub-pixel (no teleporting a segment)', best.maxD < 1,
      'max step ' + best.maxD.toFixed(3) + ' px over a ' + best.n + '-vertex arc');
    check('packet sits between vertices, not on one', best.onVertex < best.total * 0.1,
      best.onVertex + ' of ' + best.total + ' samples on a vertex');
  }

  check('canvas drew arcs/nodes', ctxCalls.arc > 10 && ctxCalls.stroke > 10, ctxCalls.arc + '/' + ctxCalls.stroke);
  check('canvas size uses devicePixelRatio', els.globe.width === Math.round(400 * 2), els.globe.width);
  check('world land rings decoded', G.rings.length > 40, G.rings.length);
  check('graticule built', G.grats.length === 17, G.grats.length);

  /* ---- offline snapshot is the same real graph ---- */
  const seedPk = NODESEED.nodes.map(n => n.pk);
  check('snapshot holds the sample', seedPk.length >= 20, seedPk.length);
  check('live selection reproduces the snapshot node set',
    seedPk.length === S.nodes.length && seedPk.every(p => S.nodes.some(n => n.pk === p)),
    seedPk.filter(p => !S.nodes.some(n => n.pk === p)).length + ' missing');
  check('snapshot links are all real channel rows',
    CHSEED.links.every(([a, b]) => rowSet.has(a + '|' + b)), CHSEED.links.length);
  const seedClusterArcs = new Set();
  CHSEED.links.forEach(([a, b]) => {
    const ca = pkToCluster[a], cb = pkToCluster[b];
    if (ca === undefined || cb === undefined || ca === cb) return;
    seedClusterArcs.add(Math.min(ca, cb) + '-' + Math.max(ca, cb));
  });
  const drawnSet = new Set(drawn.map(([i, j]) => Math.min(i, j) + '-' + Math.max(i, j)));
  check('snapshot channels are exactly the drawn arcs',
    seedClusterArcs.size === drawnSet.size && [...drawnSet].every(k => seedClusterArcs.has(k)),
    seedClusterArcs.size + ' vs ' + drawnSet.size);
  check('each globe dot is one node', G.clusters.every(c => c.count === 1),
    G.clusters.filter(c => c.count > 1).length + ' merged dots');

  /* ---- HUD text = API values ---- */
  check('HUD block height text', els.vHeight.textContent === String(FIX.tip).replace(/\B(?=(\d{3})+(?!\d))/g, ','), els.vHeight.textContent);
  check('HUD lightning count text', els.vNodes.textContent === String(FIX.lnstats.latest.node_count).replace(/\B(?=(\d{3})+(?!\d))/g, ','), els.vNodes.textContent);
  const eh = (FIX.hashrate.currentHashrate / 1e18);
  const ehTxt = eh >= 100 ? eh.toFixed(0) : eh >= 10 ? eh.toFixed(1) : eh.toFixed(2);
  check('HUD hashrate text', els.vHash.innerHTML.indexOf(ehTxt) === 0 && els.vHash.innerHTML.indexOf('EH/s') > 0, els.vHash.innerHTML);
  check('mempool strip text', els.sMem.textContent.indexOf((FIX.mempool.vsize / 1e6).toFixed(1) + ' MB') === 0, els.sMem.textContent);

  /* ---- panel ---- */
  NP.panel(true);
  runFrames(1);
  await sleep(60);
  check('panel opened', els.topbar.classList.contains('open'));
  check('panel toggle glyph', els.toggle.textContent === '−', els.toggle.textContent);
  check('panel height row', els.pHeight.textContent === String(FIX.tip).replace(/\B(?=(\d{3})+(?!\d))/g, ','), els.pHeight.textContent);
  check('panel mempool row has MB + TX', /MB/.test(els.pMem.innerHTML) && /TX/.test(els.pMem.innerHTML), els.pMem.innerHTML);
  check('panel fee row from API', els.pFee.innerHTML.indexOf(String(FIX.fees.fastestFee)) === 0, els.pFee.innerHTML);
  check('panel difficulty row shows %', els.pDiff.innerHTML.indexOf('%') > 0, els.pDiff.innerHTML);
  check('panel lightning stats date shown', /기준 \d{4}-\d{2}-\d{2}/.test(els.pLN.innerHTML), els.pLN.innerHTML);
  const distHTML = els.dist.innerHTML;
  check('continent bars rendered (6 buckets)', (distHTML.match(/class="dist"/g) || []).length === 6, (distHTML.match(/class="dist"/g) || []).length);
  const agg = NP.conts(FIX.countries);
  check('continent aggregation total equals sum of country counts',
    agg.total === FIX.countries.reduce((a, c) => a + c.count, 0), agg.total);
  check('continent NA count covers US+CA+MX from API',
    agg.count.NA >= FIX.countries.filter(c => ['US', 'CA', 'MX'].indexOf(c.iso) >= 0).reduce((a, c) => a + c.count, 0), agg.count.NA);
  const bucketSum = Object.keys(agg.count).reduce((a, k) => a + agg.count[k], 0);
  check('continent buckets sum to the country total', bucketSum === agg.total, bucketSum + ' vs ' + agg.total);
  check('north-america bar width proportional', /width:100\.0%/.test(distHTML), 'max bar not 100%');
  check('blocks list rendered', (els.listBlocks.innerHTML.match(/class="item"/g) || []).length === 8);
  check('block list shows real hash prefix', els.listBlocks.innerHTML.indexOf(FIX.blocks[0].id.slice(0, 22)) > 0);
  els.tabTxs.click();
  check('tx tab switch', els.listTxs.classList.contains('on') && els.listBlocks.classList.contains('on') === false);
  check('tx list rendered', (els.listTxs.innerHTML.match(/class="item"/g) || []).length === 8);
  check('panel footnote states real channels',
    els.note.innerHTML.indexOf('실제 공개 라이트닝 채널') > 0 &&
    els.note.innerHTML.indexOf(String(CHGEO.length).replace(/\B(?=(\d{3})+(?!\d))/g, ',')) > 0,
    els.note.innerHTML.slice(0, 160));

  /* ---- node card ---- */
  NP.openNode(0);
  const card = els.card.innerHTML;
  check('node card open', els.modal.classList.contains('on'));
  const first = G.clusters[0].nodes[0];
  check('card shows node alias', card.indexOf(first.alias.split('&')[0].slice(0, 6)) >= 0, first.alias);
  check('card shows coordinates', card.indexOf(first.lat.toFixed(4)) >= 0, first.lat);
  check('card shows CHAIN TIP', card.indexOf('CHAIN TIP') > 0 && card.indexOf(FIX.blocks[0].id) > 0);
  check('card avoids invented metrics', !/지연시간\s*\d|가동시간\s*\d|GB<\/dd>/.test(card), 'invented metric found');
  check('card states API-only disclaimer', card.indexOf('표시하지 않습니다') > 0);
  check('card lists real peers', card.indexOf('REAL CHANNELS') > 0, card.slice(0, 80));
  check('card discloses real-channel links', card.indexOf('실제 공개 채널') > 0);
  check('card shows the channels-geo channel count for the node', card.indexOf('지도 채널') > 0);
  const peerNames = first.peers || [];
  check('node peers are real channels-geo peers', peerNames.length > 0 &&
    peerNames.some(a => CHGEO.some(r => (r[0] === first.pk && r[5] === a) || (r[4] === first.pk && r[1] === a))),
    peerNames.join(', '));

  /* ---- websocket live path ---- */
  check('websocket opened', !!wsInstance && wsInstance.sent.length === 1, wsInstance && wsInstance.sent.length);
  const wantMsg = wsInstance.sent[0] ? JSON.parse(wsInstance.sent[0]) : {};
  check('ws subscribe action', wantMsg.action === 'want' && wantMsg.data.indexOf('blocks') >= 0, wsInstance.sent[0]);

  const oldTip = S.tip;
  const newBlock = JSON.parse(JSON.stringify(FIX.blocks[0]));
  newBlock.height = oldTip + 1;
  newBlock.tx_count = 4123;
  const liveBlocks = [newBlock].concat(FIX.blocks.slice(0, 7));
  wsInstance.deliver({
    blocks: liveBlocks,
    mempoolInfo: { size: 12345, bytes: 22222222, total_fee: 0.5 },
    fees: { fastestFee: 7.5, halfHourFee: 5, hourFee: 3, economyFee: 1, minimumFee: 0.1 },
    da: { difficultyChange: 1.234, remainingBlocks: 1234, estimatedRetargetDate: 1795791502870 },
    transactions: [{ txid: 'f'.repeat(64), fee: 900, vsize: 200, value: 123456789, rate: 4.5, time: Math.floor(Date.now() / 1000) }]
  });
  runFrames(3);
  await sleep(80);
  check('ws block raised tip', S.tip === oldTip + 1, S.tip + ' vs ' + (oldTip + 1));
  check('ws block triggered ripple', G.ripples.length > 0, G.ripples.length);
  check('ws block toast', els.toast.textContent.indexOf('NEW BLOCK') === 0, els.toast.textContent);
  check('ws mempool applied', S.mem.count === 12345, S.mem.count);
  check('ws fees applied', S.fees.fastestFee === 7.5, S.fees.fastestFee);
  check('ws tx prepended', S.recent[0].txid === 'f'.repeat(64) && S.recent.length <= 8, S.recent.length);
  check('ws tx rate kept', S.recent[0].rate === 4.5);
  runFrames(2);
  check('HUD height follows ws block', els.vHeight.textContent === String(oldTip + 1).replace(/\B(?=(\d{3})+(?!\d))/g, ','), els.vHeight.textContent);

  /* ---- failure mode: no network at all — the offline snapshot still draws
          real channels, never a proximity fallback ---- */
  fetchMode = 'fail';
  ls.clear();
  await sleep(50);
  const ctx2 = vm.createContext(Object.assign({}, sandbox));
  ctx2.window = Object.assign({}, window);
  ctx2.document = {
    readyState: 'complete', hidden: false, addEventListener() { },
    getElementById(id) { return makeEl(id); }, querySelector() { return null; },
    createElement(tag) { return makeEl(tag); }
  };
  ctx2.localStorage = { getItem: () => null, setItem() { }, removeItem() { } };
  try {
    vm.runInContext(scripts[0], ctx2, { filename: 'w.js' });
    vm.runInContext(scripts[1], ctx2, { filename: 'c.js' });
    vm.runInContext(scripts[2], ctx2, { filename: 's.js' });
    vm.runInContext(scripts[3], ctx2, { filename: 'ch.js' });
    vm.runInContext(scripts[4], ctx2, { filename: 'fail-boot.js', timeout: 8000 });
    await sleep(500);
    check('offline boot does not throw', true);
    const OFF = ctx2.window.NODEPULSE;
    check('offline globe has nodes', !!OFF && OFF.state.nodes.length === NODESEED.nodes.length, OFF && OFF.state.nodes.length);
    const offLinks = OFF ? OFF.channels().links : [];
    check('offline links are real snapshot channels',
      offLinks.length === CHSEED.links.length &&
      offLinks.every(([a, b]) => rowSet.has(a + '|' + b)), offLinks.length + ' vs ' + CHSEED.links.length);
    check('offline globe draws those channels', OFF && OFF.links().length >= 40, OFF && OFF.links().length);
    check('offline source is labelled as the snapshot', OFF && OFF.state.nodeSrc === 'seed', OFF && OFF.state.nodeSrc);
  } catch (e) {
    check('offline boot does not throw', false, e && e.stack);
  }

  /* ---- report ---- */
  const bad = results.filter(r => !r.ok);
  console.log('\n================ RESULT ================');
  console.log('checks: ' + results.length + '  passed: ' + (results.length - bad.length) + '  failed: ' + bad.length);
  bad.forEach(b => console.log('  ✗ ' + b.name + '  ' + b.detail));
  if (!bad.length) console.log('ALL CHECKS PASSED');
  console.log('fetch calls: ' + fetchLog.length);
  process.exit(bad.length ? 1 : 0);
})();
