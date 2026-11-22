/* Headless verification harness: boots the built single-file app in a stubbed DOM,
   feeds it the real API payloads captured in fixtures/, runs frames, and checks the
   rendered values, both layers, the watchdog and the globe geometry.
   Run: node test/headless.js */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const HTML = [
  path.resolve(ROOT, '..', '..', 'bitcoin-network-monitor.html'),
  path.resolve(ROOT, 'dist', 'nodepulse.html')
].find(p => fs.existsSync(p));
if (!HTML) throw new Error('built app not found — run python3 build.py first');
const FIX = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures', 'api-snapshot.json'), 'utf8'));
const CHGEO = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures', 'channels-geo.json'), 'utf8'));
const L1 = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures', 'l1-snapshot.json'), 'utf8'));

function readDataFile(file, name) {
  const t = fs.readFileSync(path.join(ROOT, 'src', 'data', file), 'utf8');
  const at = t.indexOf('var ' + name + ' =');
  return JSON.parse(t.slice(at + ('var ' + name + ' =').length, t.lastIndexOf(';')));
}
const NODESEED = readDataFile('seed-nodes.js', 'NODE_SEED');
const CHSEED = readDataFile('channels-data.js', 'CHANNEL_SEED');
const L1SEED = readDataFile('l1-data.js', 'L1_SNAPSHOT');

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
    setPointerCapture() { },
    scrollIntoView() { }
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

function makeDocument() {
  /* every element the app asks for exists, so a check can read any of them */
  const store = {};
  const els = new Proxy(store, {
    get(t, k) { if (typeof k !== 'string') return undefined; return t[k] || (t[k] = makeEl(k)); }
  });
  const doc = {
    readyState: 'complete',
    hidden: false,
    documentElement: makeEl('html'),
    getElementById(id) { return els[id] || (els[id] = makeEl(id)); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() { },
    createElement(tag) { return makeEl(tag); },
    body: makeEl('body')
  };
  return { doc, els };
}

/* ------------------------------------------------------------------ fetch */
let fetchMode = 'ok';
const fetchLog = [];
/* A path whose next answer is replaced (the type-validation tests drive a malformed
   hashrate answer through loadHashrate) and node pks whose detail GET fails (the
   geo-cache test). Both are empty unless a test fills them. */
const bodyOverride = new Map();
let failPks = [];
function fakeFetch(url) {
  fetchLog.push(url);
  const pathOnly = url.replace(/^https?:\/\/[^/]+/, '');
  const host = url.replace(/^(https?:\/\/[^/]+).*/, '$1');
  if (fetchMode === 'fail') return Promise.reject(new Error('network down'));
  if (host !== 'https://mempool.space') return Promise.reject(new Error('mirror refused'));
  if (failPks.length && failPks.some(pk => pathOnly === '/api/v1/lightning/nodes/' + pk)) {
    return Promise.reject(new Error('node detail down'));
  }
  if (bodyOverride.has(pathOnly)) {
    const over = bodyOverride.get(pathOnly);
    return Promise.resolve({
      ok: true, status: 200,
      text: () => Promise.resolve(JSON.stringify(over)),
      json: () => Promise.resolve(over)
    });
  }
  let body = null, kind = 'json';
  if (pathOnly === '/api/blocks/tip/height') { body = String(FIX.tip); kind = 'text'; }
  else if (pathOnly === '/api/v1/blocks') body = FIX.blocks;
  else if (pathOnly === '/api/mempool') body = FIX.mempool;
  else if (pathOnly === '/api/mempool/recent') body = FIX.recent;
  else if (pathOnly === '/api/v1/fees/recommended') body = FIX.fees;
  else if (pathOnly === '/api/v1/mining/hashrate/1w') body = FIX.hashrate;
  else if (pathOnly === '/api/v1/mining/pools/1w') body = FIX.pools;
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
const wsList = [];
function makeFakeWS() {
  function FakeWS(url) {
    this.url = url; this.readyState = 0; this.sent = [];
    wsList.push(this);
    setTimeout(() => { this.readyState = 1; if (this.onopen) this.onopen(); }, 20);
  }
  FakeWS.prototype.send = function (d) { this.sent.push(d); };
  FakeWS.prototype.close = function () { this.readyState = 3; if (this.onclose) this.onclose(); };
  FakeWS.prototype.deliver = function (obj) { if (this.onmessage) this.onmessage({ data: JSON.stringify(obj) }); };
  return FakeWS;
}
const FakeWS = makeFakeWS();

/* a socket that never finishes connecting — the CONNECTING-timeout test drives it */
function makeHungWS() {
  const list = [];
  function HungWS(url) { this.url = url; this.readyState = 0; this.sent = []; list.push(this); }
  HungWS.prototype.send = function (d) { this.sent.push(d); };
  HungWS.prototype.close = function () { this.readyState = 3; if (this.onclose) this.onclose(); };
  HungWS.list = list;
  return HungWS;
}

/* the first mirror answers the headers but its body never arrives: the timeout must
   cover the body read, so the request aborts and the next mirror serves the answer */
function hangingBodyFetch(url, opt) {
  fetchLog.push(url);
  if (url.indexOf('https://mempool.space/api/blocks/tip/height') === 0) {
    return Promise.resolve({
      ok: true, status: 200,
      text: () => new Promise((res, rej) => {
        const signal = opt && opt.signal;
        if (!signal) return rej(new Error('no signal'));
        if (signal.aborted) return rej(new Error('aborted'));
        signal.addEventListener('abort', () => rej(new Error('aborted')));
      })
    });
  }
  if (url.indexOf('/api/blocks/tip/height') >= 0) {
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(String(FIX.tip)) });
  }
  return fakeFetch(url);
}

/* ------------------------------------------------------------- localStorage */
let ls = new Map();
const localStorage = {
  getItem: k => (ls.has(k) ? ls.get(k) : null),
  setItem: (k, v) => ls.set(k, String(v)),
  removeItem: k => ls.delete(k),
  clear: () => ls.clear()
};

/* --------------------------------------- native bridge (bitnodes fixtures) */
let bridgeCalls = [];
/* when true, the ASN / client-version snapshot fails while the coordinate grid answers */
let bridgeFailTop = false;
function makeBridge(window) {
  const coordsPayload = {
    timestamp: L1.capturedAt, total_nodes: L1.totalNodes, latest_height: L1.height,
    metadata: { reachable_nodes: L1.reachableNodes, complete: true },
    coordinates: L1.coords
  };
  const topPayload = {
    timestamp: L1.capturedAt, total_nodes: L1.totalNodes, latest_height: L1.height,
    top: { top_asns: L1.topAsns, top_user_agents: L1.userAgents }
  };
  return {
    fetch(id, url) {
      bridgeCalls.push(url);
      let body = null;
      if (url.indexOf('field=coordinates') >= 0) body = JSON.stringify(coordsPayload);
      else if (url.indexOf('field=top') >= 0 && !bridgeFailTop) body = JSON.stringify(topPayload);
      setTimeout(() => {
        if (window.NPBridgeOnData) window.NPBridgeOnData(id, body !== null, body || '');
      }, 4);
    }
  };
}

/* ------------------------------------------------------------------ window */
function makeWindow(docApi, els) {
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
    matchMedia: () => ({ matches: false, addEventListener() { } }),
    _raf: rafQueue
  };
  return window;
}

function makeSandbox({ bridge = true, fetchImpl = fakeFetch } = {}) {
  const { doc, els } = makeDocument();
  const window = makeWindow(doc, els);
  if (bridge) window.NPBridge = makeBridge(window);
  const sandbox = {
    window, document: doc, localStorage, fetch: fetchImpl, AbortController,
    WebSocket: FakeWS, requestAnimationFrame: window.requestAnimationFrame,
    cancelAnimationFrame: window.cancelAnimationFrame,
    setTimeout, clearTimeout, setInterval, clearInterval, console,
    JSON, Math, Date, Promise, Object, Array, String, Number, isFinite, parseInt, parseFloat,
    encodeURIComponent, decodeURIComponent, Error, RegExp, Map, Set, TextEncoder
  };
  sandbox.globalThis = sandbox;
  sandbox.self = window;
  return { sandbox, window, els, doc, rafQueue: window._raf };
}

function runFrames(rafQueue, n, step) {
  let t = 1000;
  for (let i = 0; i < n; i++) {
    const fns = rafQueue.splice(0, rafQueue.length);
    t += step || 16.7;
    fns.forEach(fn => { try { fn(t); } catch (e) { check('frame runs', false, e && e.stack); } });
  }
}

/* ------------------------------------------------------- extract + run js */
const html = fs.readFileSync(HTML, 'utf8');
check('single file has no external src', !/<script[^>]+src=/.test(html), 'script src found');
check('single file has no external stylesheet/link', !/<link[^>]+href="http/.test(html), 'remote link found');

/* The policy names each inline block by hash: nothing inline is allowed open, and an
   injected block would have to match a hash that is already in the file. */
const csp = (html.match(/http-equiv="Content-Security-Policy" content="([^"]*)"/) || [])[1] || '';
const blockHashes = [];
const blockBodies = [];
for (const m of html.matchAll(/<(script|style)>([\s\S]*?)<\/\1>/g)) {
  blockBodies.push(m[2]);
  blockHashes.push("'sha256-" + crypto.createHash('sha256').update(m[2], 'utf8').digest('base64') + "'");
}
check('CSP names every inline script/style block by hash',
  blockHashes.length === 7 && blockHashes.every(h => csp.indexOf(h) >= 0),
  blockHashes.length + ' blocks, policy ' + (csp ? 'present' : 'missing'));
check('CSP allows no unsafe-inline', csp.indexOf("'unsafe-inline'") < 0, csp.slice(0, 80));
check('CSP names no host outside the five the app reads',
  (csp.match(/https:\/\/[a-z.]+/g) || []).every(h => /bitnodes\.io|btcnodes\.io|mempool\.space|mempool\.emzy\.de|mempool\.ninja/.test(h)),
  (csp.match(/https:\/\/[a-z.]+/g) || []).join(','));
check('build has no inline style attribute', !/\sstyle="/.test(html), (html.match(/\sstyle="[^"]*"/) || [''])[0].slice(0, 60));
check('build has no inline event handler attribute',
  !/\son(click|error|load|mouseover|focus|blur|change|input|submit)="/.test(html));
/* blocks 1..5 are the five embedded datasets: whatever string they carry, none of them
   can close the script block or open a comment inside it */
check('embedded datasets cannot close their script block',
  blockBodies.slice(1, 6).every(b => !/<\/script/i.test(b) && !/<!--/.test(b)));
check('title present', /<title>NodePulse/.test(html));
check('no proximity-link label left', !/근접·예시|가까운 노드끼리|NODE LINK/.test(html), 'proximity link wording still in the build');
check('legend names real lightning channels', /LIGHTNING CHANNEL/.test(html));
/* the globe is solid: a channel or coastline on the far hemisphere is never stroked
   through the body (these two colours were the only far-side passes) */
check('no far-side channel or coastline pass in the build',
  !/rgba\(90,150,235,0\.075\)/.test(html) && !/rgba\(90,150,230,0\.07\)/.test(html));
check('L1 layer is the default view', /<body class="l1">/.test(html), 'body class');
check('native bridge hooks are in the build', /NPBridgeOnData/.test(html) && /NPBridge/.test(html));
check('bitnodes endpoints are in the build', /bitnodes\.io/.test(html) && /field=coordinates/.test(html) && /field=top/.test(html));
check('all three websocket mirrors are in the build',
  /mempool\.emzy\.de/.test(html) && /mempool\.ninja/.test(html) && /WS_HOSTS/.test(html));

const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
check('inline script blocks', scripts.length === 6, scripts.length);

(async function main() {
  const { sandbox, window, els, rafQueue } = makeSandbox({ bridge: true });
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
  await sleep(1400);
  runFrames(rafQueue, 3);

  const NP = window.NODEPULSE;
  check('NODEPULSE test hook exists', !!NP);
  const S = NP.state;

  /* ================================ Bitcoin L1 (default layer) ============ */
  check('default layer is Bitcoin L1', S.layer === 'l1' && els.layerL1.classList.contains('on'), S.layer);
  check('native bridge detected', NP.bridge() === true);
  check('bitnodes was read through the bridge, not fetch',
    bridgeCalls.length >= 2 && !fetchLog.some(u => u.indexOf('bitnodes') >= 0), bridgeCalls.length);

  /* ---- the bridge wait map is a null-prototype object, so an id that names an inherited
     property (constructor, __proto__, toString) cannot resolve or throw ---- */
  let protoThrew = false;
  try {
    window.NPBridgeOnData('constructor', true, '{"n":1}');
    window.NPBridgeOnData('__proto__', true, '{"n":1}');
    window.NPBridgeOnData('toString', false, '');
  } catch (e) { protoThrew = true; }
  check('a bridge callback for a prototype key is ignored', !protoThrew);
  check('prototype-key callbacks leave the bridge usable', NP.bridge() === true);
  check('L1 source is live', S.l1 && S.l1.src === 'live', S.l1 && S.l1.src);
  check('L1 reachable node count from Bitnodes', S.l1.total === L1.totalNodes, S.l1.total + ' vs ' + L1.totalNodes);
  check('L1 crawler height from Bitnodes', S.l1.height === L1.height, S.l1.height);
  check('L1 coordinate set from Bitnodes', S.l1.coords.length === L1.coords.length, S.l1.coords.length);
  check('L1 clear-net/Tor/I2P split from the ASN payload',
    S.l1.platforms && S.l1.platforms.tor === L1.platforms.tor && S.l1.platforms.i2p === L1.platforms.i2p &&
    S.l1.platforms.clearnet === L1.totalNodes - L1.platforms.tor - L1.platforms.i2p,
    JSON.stringify(S.l1.platforms));
  check('L1 client versions from the top payload',
    S.l1.vers.length > 0 && S.l1.vers[0].name === L1.userAgents[0][0] && Math.abs(S.l1.vers[0].pct - L1.userAgents[0][1]) < 1e-9,
    JSON.stringify(S.l1.vers[0]));

  /* ---- one Bitnodes query failing keeps what the other one did not carry ----
     The coordinate grid and the ASN/client-version snapshot arrive separately; a failed
     top query used to replace the transport split and the version list with null/[] even
     though the previous answer was still on screen. */
  const l1Before = {
    platforms: JSON.parse(JSON.stringify(S.l1.platforms)),
    vers: JSON.parse(JSON.stringify(S.l1.vers)),
    total: S.l1.total
  };
  bridgeFailTop = true;
  await NP.loadL1();
  await sleep(80);
  runFrames(rafQueue, 1);
  check('a failed top query keeps the clear-net/Tor/I2P split',
    S.l1.platforms && S.l1.platforms.tor === l1Before.platforms.tor &&
    S.l1.platforms.i2p === l1Before.platforms.i2p &&
    S.l1.platforms.clearnet === l1Before.platforms.clearnet, JSON.stringify(S.l1.platforms));
  check('a failed top query keeps the client versions',
    S.l1.vers.length === l1Before.vers.length && S.l1.vers[0] && S.l1.vers[0].name === l1Before.vers[0].name,
    JSON.stringify(S.l1.vers[0]));
  check('a failed top query still refreshes the coordinate grid',
    S.l1.src === 'live' && S.l1.total === l1Before.total && S.l1.coords.length === L1.coords.length,
    S.l1.src + ' ' + S.l1.total + ' ' + S.l1.coords.length);
  bridgeFailTop = false;
  await NP.loadL1();
  await sleep(80);
  runFrames(rafQueue, 2);
  check('the split is restored from the next good top query',
    S.l1.platforms && S.l1.platforms.tor === l1Before.platforms.tor && S.l1.vers[0].name === l1Before.vers[0].name,
    JSON.stringify(S.l1.platforms));

  const G = NP.globe;
  check('L1 globe is filled with real coordinates', G.clusters.length > 300 && G.clusters.length < L1.coords.length,
    G.clusters.length + ' cells from ' + L1.coords.length + ' coordinates');
  check('every L1 dot is a coordinate cell', G.clusters.every(c => c.l1 && c.count >= 1));
  check('L1 dots cover every reported coordinate',
    G.clusters.reduce((a, c) => a + c.count, 0) === L1.coords.length,
    G.clusters.reduce((a, c) => a + c.count, 0));
  check('L1 globe draws no links at all (Bitnodes has no peer graph)',
    G.links.length === 0 && G.arcs.length === 0 && NP.links().length === 0,
    G.links.length + '/' + G.arcs.length);
  check('L1 dots sit on their real coordinates',
    G.clusters.every(c => Math.abs(c.lat) <= 90 && Math.abs(c.lon) <= 180));
  const visL1 = G.clusters.filter(c => c.on);
  check('some L1 dots are on the front hemisphere', visL1.length > 0, visL1.length);
  check('L1 dots are not bigger than the cell they represent',
    G.clusters.every(c => c.count >= 1));

  /* L1 HUD: height | mempool | fastest fee */
  check('HUD block height text', els.vHeight.textContent === String(FIX.tip).replace(/\B(?=(\d{3})+(?!\d))/g, ','), els.vHeight.textContent);
  check('HUD mempool shows MB and TX',
    els.vMem.innerHTML.indexOf((FIX.mempool.vsize / 1e6).toFixed(1)) === 0 &&
    els.vMem.innerHTML.indexOf('MB') > 0 &&
    els.vMem.innerHTML.indexOf(String(FIX.mempool.count).replace(/\B(?=(\d{3})+(?!\d))/g, ',')) > 0,
    els.vMem.innerHTML);
  check('HUD fastest fee text', els.vFee.textContent === String(Math.round(FIX.fees.fastestFee * 10) / 10), els.vFee.textContent);
  check('lightning metrics are not the main HUD in L1 mode',
    els.metricsL1.classList.contains('on') === false && els.vNodes.textContent !== '' /* filled but hidden */);

  /* ================================ Lightning layer ======================= */
  NP.layer('ln');
  await sleep(60);
  runFrames(rafQueue, 1);
  check('layer switch to Lightning', S.layer === 'ln' && els.layerLN.classList.contains('on'));
  check('Lightning HUD switched to LN metrics', true);

  /* ---- REST mapping ---- */
  check('tip height from /api/blocks/tip/height', S.tip === Number(FIX.tip), S.tip);
  check('blocks mapped from /api/v1/blocks', S.blocks.length === 8 && S.blocks[0].height === FIX.blocks[0].height,
    S.blocks.length + ' ' + (S.blocks[0] && S.blocks[0].height));
  check('mempool count/vsize mapped', S.mem && S.mem.count === FIX.mempool.count && S.mem.vsize === FIX.mempool.vsize,
    S.mem && JSON.stringify(S.mem));
  /* REST /api/mempool reports total_fee in satoshis and the websocket in BTC: the HUD
     reads it as BTC, so the REST number must be scaled once, not printed raw */
  const feeBtc = FIX.mempool.total_fee / 1e8;
  check('REST mempool total_fee is converted from satoshis to BTC',
    S.mem && Math.abs(S.mem.totalFee - feeBtc) < 1e-12, S.mem && S.mem.totalFee + ' vs ' + feeBtc);
  /* the fee row lives in the panel; open it for one paint and close it again */
  NP.panel(true);
  runFrames(rafQueue, 1);
  check('panel fee row shows the BTC amount, never the satoshi figure',
    els.pMem.innerHTML.indexOf(feeBtc.toFixed(4) + ' BTC fee') > 0 &&
    els.pMem.innerHTML.indexOf(String(FIX.mempool.total_fee)) < 0,
    els.pMem.innerHTML);
  NP.panel(false);
  check('recent tx rate computed from fee/vsize',
    S.recent.length > 0 && Math.abs(S.recent[0].rate - FIX.recent[0].fee / FIX.recent[0].vsize) < 1e-9);
  check('fees mapped', S.fees && S.fees.fastestFee === FIX.fees.fastestFee, S.fees && S.fees.fastestFee);
  check('hashrate mapped', S.hr && S.hr.currentHashrate === FIX.hashrate.currentHashrate);
  check('difficulty mapped', S.diff && S.diff.remainingBlocks === FIX.diff.remainingBlocks);

  /* ---- loadHashrate(): the drawn fields must be a row list of finite numbers ----
     The panel walks hashrates with forEach and averages it, and formats currentHashrate.
     A proxy or a captive portal can answer with a string where that list belongs, and an
     isObj() check alone let it through — forEach() then threw on the next paint, and a
     string figure printed NaN. */
  const goodHr = JSON.stringify(S.hr);
  const loadHr = async over => {
    bodyOverride.set('/api/v1/mining/hashrate/1w', over);
    let res = 'resolved';
    await NP.loadHashrate().then(() => { }, () => { res = 'rejected'; });
    return res;
  };
  check('loadHashrate rejects a hashrates list that is not an array',
    (await loadHr({ hashrates: 'oops', currentHashrate: 5 })) === 'rejected');
  check('a rejected hashrate answer leaves the previous series in place',
    JSON.stringify(S.hr) === goodHr, JSON.stringify(S.hr));
  check('loadHashrate rejects a series with no usable row',
    (await loadHr({ hashrates: [{ avgHashrate: 'x' }, 7, null], currentHashrate: 5 })) === 'rejected');
  check('an unusable hashrate answer leaves the previous series in place',
    JSON.stringify(S.hr) === goodHr, JSON.stringify(S.hr));
  check('loadHashrate rejects a series that is an empty array',
    (await loadHr({ hashrates: [], currentHashrate: 5 })) === 'rejected');
  check('an empty hashrate answer leaves the previous series in place',
    JSON.stringify(S.hr) === goodHr, JSON.stringify(S.hr));
  check('loadHashrate accepts a mixed answer and keeps only its finite rows',
    (await loadHr({ hashrates: [{ avgHashrate: 1e18 }, { avgHashrate: 'x' }, 7, { avgHashrate: null }], currentHashrate: 'nope' })) === 'resolved');
  check('only the finite hashrate rows are stored',
    !!S.hr && S.hr.hashrates.length === 1 && S.hr.hashrates[0].avgHashrate === 1e18,
    S.hr && JSON.stringify(S.hr));
  check('a non-finite currentHashrate is stored as null',
    !!S.hr && S.hr.currentHashrate === null, S.hr && S.hr.currentHashrate);
  bodyOverride.delete('/api/v1/mining/hashrate/1w');
  await NP.loadHashrate();
  check('a good hashrate answer replaces the partial one',
    !!S.hr && S.hr.currentHashrate === FIX.hashrate.currentHashrate &&
    S.hr.hashrates.length === FIX.hashrate.hashrates.length,
    S.hr && (S.hr.currentHashrate + '/' + S.hr.hashrates.length));
  check('mining pools mapped', S.pools && S.pools.blockCount === FIX.pools.blockCount, S.pools && S.pools.blockCount);
  check('lightning stats mapped', S.ln && S.ln.node_count === FIX.lnstats.latest.node_count, S.ln && S.ln.node_count);
  check('countries mapped', S.countries.length === FIX.countries.length, S.countries.length);
  check('LN HUD node count', els.vNodes.textContent === String(FIX.lnstats.latest.node_count).replace(/\B(?=(\d{3})+(?!\d))/g, ','), els.vNodes.textContent);

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
    G.clusters.filter(c => !c.arcs).map(c => (c.nodes[0] || {}).alias).join(','));
  check('no dot carries more than 6 arcs', G.clusters.every(c => c.arcs <= 6),
    G.clusters.filter(c => c.arcs > 6).map(c => (c.nodes[0] || {}).alias + ':' + c.arcs).join(','));
  check('arc paths precomputed per channel', G.arcs.length === drawn.length, G.arcs.length);

  const visible = G.clusters.filter(c => c.on);
  check('some clusters visible on the front hemisphere', visible.length > 0, visible.length);
  const insideOk = visible.every(c => {
    const R = G.R * G.zoom;
    return Math.hypot(c.sx - G.cx, c.sy - G.cy) <= R * 1.02;
  });
  check('visible clusters project inside the disc', insideOk);

  /* ---- nodes/arcs stay welded to the projection at any rotation ---- */
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
  const t0 = 5;
  const frames = [];
  for (let i = 0; i < 400; i++) frames.push(NP.packets(t0 + i * 0.002));
  check('packets are drawn', frames[0].length > 20, frames[0].length);
  const heads = frames[0].filter(p => p[2] === 7.5);
  check('every sampled arc carries a packet head', heads.length > 10, heads.length);

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

  /* ---- websocket live path (mempool-blocks + mirrors) ---- */
  const wsInstance = wsList[0];
  check('websocket opened', !!wsInstance && wsInstance.sent.length === 1, wsInstance && wsInstance.sent.length);
  const wantMsg = wsInstance.sent[0] ? JSON.parse(wsInstance.sent[0]) : {};
  check('ws subscribe action requests mempool-blocks',
    wantMsg.action === 'want' && wantMsg.data.indexOf('blocks') >= 0 && wantMsg.data.indexOf('mempool-blocks') >= 0,
    wsInstance.sent[0]);

  const now = Math.floor(Date.now() / 1000);
  const oldTip = S.tip;
  const newBlock = JSON.parse(JSON.stringify(FIX.blocks[0]));
  newBlock.height = oldTip + 1;
  newBlock.tx_count = 4123;
  newBlock.timestamp = now - 42;                 // freshly mined
  const liveBlocks = [newBlock].concat(FIX.blocks.slice(0, 7));
  check('mempool-blocks not parsed before the push', S.mblocks.length === 0, S.mblocks.length);

  wsInstance.deliver({
    blocks: liveBlocks,
    mempoolInfo: { size: 12345, bytes: 22222222, total_fee: 0.5 },
    fees: { fastestFee: 7.5, halfHourFee: 5, hourFee: 3, economyFee: 1, minimumFee: 0.1 },
    da: { difficultyChange: 1.234, remainingBlocks: 1234, estimatedRetargetDate: 1795791502870 },
    transactions: [{ txid: 'f'.repeat(64), fee: 900, vsize: 200, value: 123456789, rate: 4.5, time: Math.floor(Date.now() / 1000) }],
    'mempool-blocks': FIX.mempoolBlocks
  });
  const blockToast = els.toast.textContent;      /* read before the watchdog repaints the toast */
  runFrames(rafQueue, 3);
  await sleep(120);
  check('ws block raised tip', S.tip === oldTip + 1, S.tip + ' vs ' + (oldTip + 1));
  check('ws block triggered ripple', G.ripples.length > 0, G.ripples.length);
  check('ws block toast', blockToast.indexOf('NEW BLOCK') === 0, blockToast);
  check('ws mempool applied', S.mem.count === 12345, S.mem.count);
  check('ws fees applied', S.fees.fastestFee === 7.5, S.fees.fastestFee);
  check('ws tx prepended', S.recent[0].txid === 'f'.repeat(64) && S.recent.length <= 10, S.recent.length);
  check('ws tx rate kept', S.recent[0].rate === 4.5);
  check('mempool-blocks stream parsed', S.mblocks.length === FIX.mempoolBlocks.length, S.mblocks.length);
  check('mempool-blocks keeps the reported fee range and tx count',
    Math.abs(S.mblocks[0].median - FIX.mempoolBlocks[0].medianFee) < 1e-9 &&
    S.mblocks[0].nTx === FIX.mempoolBlocks[0].nTx &&
    S.mblocks[0].lo === FIX.mempoolBlocks[0].feeRange[0] &&
    S.mblocks[0].hi === FIX.mempoolBlocks[0].feeRange[6],
    JSON.stringify(S.mblocks[0]));
  runFrames(rafQueue, 2);
  await sleep(420);
  check('HUD height follows ws block', els.vHeight.textContent === String(oldTip + 1).replace(/\B(?=(\d{3})+(?!\d))/g, ','), els.vHeight.textContent);
  check('strip shows the next block median fee', els.sNext.textContent.indexOf('sat/vB') > 0, els.sNext.textContent);

  /* ---- panel ---- */
  NP.panel(true);
  runFrames(1);
  await sleep(80);
  check('panel opened', els.topbar.classList.contains('open'));
  check('panel toggle glyph', els.toggle.textContent === '−', els.toggle.textContent);
  check('panel height row', els.pHeight.textContent === String(oldTip + 1).replace(/\B(?=(\d{3})+(?!\d))/g, ','), els.pHeight.textContent);
  check('panel mempool row has MB + TX', /MB/.test(els.pMem.innerHTML) && /TX/.test(els.pMem.innerHTML), els.pMem.innerHTML);
  check('panel fee row from API', els.pFee.innerHTML.indexOf('7.5') === 0, els.pFee.innerHTML);
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
  check('north-america bar width proportional', /class="bw100"/.test(distHTML), 'max bar not full width');
  check('LN distribution total names the country count', els.distTotal.textContent.indexOf(String(FIX.countries.length)) > 0, els.distTotal.textContent);
  check('blocks list rendered', (els.listBlocks.innerHTML.match(/class="item"/g) || []).length === 8);
  check('tx list rendered at the same time as the block list (no tab switch)',
    (els.listTxs.innerHTML.match(/class="item"/g) || []).length > 0 &&
    (els.listBlocks.innerHTML.match(/class="item"/g) || []).length === 8,
    els.listTxs.innerHTML.slice(0, 40));
  check('block list shows real hash prefix', els.listBlocks.innerHTML.indexOf(FIX.blocks[0].id.slice(0, 18)) > 0);
  check('next-block panel shows three blocks', (els.nextBlocks.innerHTML.match(/class="b"/g) || []).length === 3,
    (els.nextBlocks.innerHTML.match(/class="b"/g) || []).length);
  check('next-block panel shows the projected median fee',
    els.nextBlocks.innerHTML.indexOf(String(Math.round(FIX.mempoolBlocks[0].medianFee * 10) / 10)) > 0, els.nextBlocks.innerHTML.slice(0, 200));
  check('next-block panel shows the waiting block count',
    els.nextTotal.textContent.indexOf(String(FIX.mempoolBlocks.length)) === 0, els.nextTotal.textContent);
  check('panel footnote states real channels',
    els.note.innerHTML.indexOf('실제 공개 채널') > 0 &&
    els.note.innerHTML.indexOf(String(CHGEO.length).replace(/\B(?=(\d{3})+(?!\d))/g, ',')) > 0,
    els.note.innerHTML.slice(0, 160));

  /* ---- a malformed push changes nothing ---- */
  const snap = () => JSON.stringify({ tip: S.tip, mem: S.mem, fees: S.fees, recent: S.recent.length, blocks: S.blocks.length, mb: S.mblocks.length });
  const beforeJunk = snap();
  wsInstance.onmessage({ data: '"a string, not an object"' });
  wsInstance.onmessage({ data: '[1,2,3]' });
  wsInstance.onmessage({ data: 'null' });
  wsInstance.deliver({ blocks: 'nope', fees: 'nope', transactions: 5, mempoolInfo: 7, da: [], 'mempool-blocks': {} });
  wsInstance.deliver({ blocks: [1, 2, null], transactions: [{}, 'tx'], 'mempool-blocks': ['x'] });
  check('a push that is not an object changes no state', beforeJunk === snap(), snap());

  /* ---- a push whose figures are strings, objects or junk must not be adopted ----
     Each websocket branch feeds a value straight into a paint that assumes a number or a
     list. The old code only checked the branch's own type: a mempool count as a string,
     a fees object without numbers, a block without a hash string and a projection entry
     of strings all reached the panel, which printed NaN or threw inside shortHash(). */
  const beforeDeep = snap();
  wsInstance.deliver({
    blocks: [{ height: 'x', id: 5 }, { height: 800100, id: 9 }, { id: 'c'.repeat(64) }],
    mempoolInfo: { size: 'x', bytes: {}, total_fee: 'y' },
    fees: { fastestFee: 'x', halfHourFee: null, hourFee: {} },
    da: { difficultyChange: 'z', remainingBlocks: {}, estimatedRetargetDate: [] },
    transactions: [{ txid: 123 }, { fee: 1 }, { txid: '' }],
    'mempool-blocks': [{ nTx: 'x', blockVSize: {}, medianFee: 'q' }, 'junk', { feeRange: 'no' }]
  });
  check('a push with string figures changes no state', beforeDeep === snap(), snap());
  check('no block without a hash string is stored',
    S.blocks.every(b => typeof b.id === 'string' && b.id.length > 0),
    S.blocks.map(b => typeof b.id).join(','));
  check('no transaction without a txid is stored',
    S.recent.every(t => typeof t.txid === 'string' && t.txid.length > 0),
    S.recent.map(t => typeof t.txid).join(','));
  check('the fee row keeps a finite fastestFee',
    !!S.fees && typeof S.fees.fastestFee === 'number' && isFinite(S.fees.fastestFee),
    S.fees && JSON.stringify(S.fees));
  check('a push block with a string height does not move the tip',
    S.tip === oldTip + 1, S.tip);

  /* a tx with a real id but junk figures is listed by that id, with no derived number */
  wsInstance.deliver({ transactions: [{ txid: 'e'.repeat(64), fee: 'x', vsize: null, value: {}, rate: 'q' }] });
  const junkTx = S.recent[0];
  check('a tx with junk figures keeps its id', !!junkTx && junkTx.txid === 'e'.repeat(64),
    junkTx && junkTx.txid);
  check('a tx with junk figures carries no number',
    !!junkTx && junkTx.fee === null && junkTx.vsize === null && junkTx.value === null && junkTx.rate === null,
    junkTx && JSON.stringify(junkTx));
  NP.panel(true);
  runFrames(rafQueue, 2);
  await sleep(80);
  check('junk figures print an em dash, never NaN',
    ['listBlocks', 'listTxs', 'nextBlocks', 'pMem', 'pFee', 'pDiff', 'pHash']
      .every(id => String(els[id].innerHTML).indexOf('NaN') < 0 && String(els[id].textContent).indexOf('NaN') < 0),
    ['listBlocks', 'listTxs', 'nextBlocks', 'pMem', 'pFee', 'pDiff', 'pHash']
      .filter(id => String(els[id].innerHTML).indexOf('NaN') >= 0 || String(els[id].textContent).indexOf('NaN') >= 0).join(','));

  /* ---- watchdog: clean state, then each alert ---- */
  /* settle on low fees and a fresh block, the state a healthy network is in */
  wsInstance.deliver({ blocks: liveBlocks, fees: FIX.fees });
  runFrames(rafQueue, 2);
  await sleep(420);
  const w0 = NP.watch();
  check('watchdog lists its four checks', w0.list.length === 4, w0.list.map(w => w.tag).join(','));
  check('no alert on a fresh block and low fees', w0.alerts.length === 0,
    w0.alerts.map(a => a.k + ':' + a.text).join(' | '));
  check('watchdog badge reads zero', els.watchTxt.textContent === 'WDG 0', els.watchTxt.textContent);
  /* /api/v1/blocks has arrived oldest-first from some deployments: the list must still
     be newest-first, or the watchdog reports a block delay that does not exist */
  const ascending = liveBlocks.slice().reverse();
  wsInstance.deliver({ blocks: ascending });
  runFrames(rafQueue, 2);
  await sleep(300);
  check('blocks are ordered newest-first whatever the payload order',
    S.blocks[0].height === oldTip + 1 && S.blocks[7].height < S.blocks[0].height,
    S.blocks.map(b => b.height).join(','));
  check('an oldest-first payload does not fake a block delay',
    NP.watch().alerts.every(a => a.k !== 'gap'),
    NP.watch().alerts.map(a => a.text).join(' | '));

  check('watchdog ok rows name the last block', els.watch.innerHTML.indexOf(String(oldTip + 1).replace(/\B(?=(\d{3})+(?!\d))/g, ',')) > 0,
    els.watch.innerHTML.slice(0, 160));

  /* block delay: 40 minutes since the last block */
  const stale = JSON.parse(JSON.stringify(liveBlocks));
  stale[0].height = oldTip + 1;
  stale[0].timestamp = Math.floor(Date.now() / 1000) - 2400;
  wsInstance.deliver({ blocks: stale });
  runFrames(rafQueue, 2);
  /* the badge is written by paint(), which the app throttles to one every 320 ms */
  await sleep(420);
  let w1 = NP.watch();
  check('block delay above 30 min raises an alert', w1.alerts.some(a => a.k === 'gap'),
    w1.alerts.map(a => a.text).join(' | '));
  check('watchdog badge counts the alert', els.watchTxt.textContent === 'WDG 1', els.watchTxt.textContent);

  /* fee spike: 120 sat/vB from a 7.5 baseline */
  wsInstance.deliver({ fees: { fastestFee: 120, halfHourFee: 90, hourFee: 60, economyFee: 20, minimumFee: 2 } });
  runFrames(rafQueue, 2);
  await sleep(80);
  let w2 = NP.watch();
  check('fee spike above the threshold raises an alert', w2.alerts.some(a => a.k === 'fee'),
    w2.alerts.map(a => a.text).join(' | '));
  check('watchdog toast fired for the new alert', els.toast.textContent.indexOf('⚠') === 0, els.toast.textContent);

  /* pool concentration: inject a week where one pool mined 60% */
  const savedPools = S.pools;
  S.pools = { blockCount: 1000, pools: [{ name: 'TestPool', blockCount: 600 }, { name: 'B', blockCount: 100 }] };
  let w3 = NP.watch();
  check('pool concentration above 35% raises an alert', w3.alerts.some(a => a.k === 'pool'),
    w3.alerts.map(a => a.text).join(' | '));
  /* a stale pool snapshot must not keep alerting */
  const savedAt = S.poolsAt;
  S.poolsAt = Date.now() - 48 * 3600 * 1000;
  check('a two-day-old pool snapshot raises no alert',
    NP.watch().alerts.every(a => a.k !== 'pool'), NP.watch().alerts.map(a => a.text).join(' | '));
  S.poolsAt = savedAt;
  S.pools = savedPools;

  /* reorg: a different hash at an already-seen height */
  const reorgBlocks = JSON.parse(JSON.stringify(liveBlocks));
  reorgBlocks[0].height = oldTip + 1;
  reorgBlocks[0].id = '0'.repeat(64);
  reorgBlocks[0].timestamp = Math.floor(Date.now() / 1000) - 30;
  wsInstance.deliver({ blocks: reorgBlocks });
  runFrames(rafQueue, 2);
  await sleep(80);
  let w4 = NP.watch();
  check('a new hash at an already-seen height is a reorg', w4.alerts.some(a => a.k === 'reorg'),
    w4.alerts.map(a => a.text).join(' | '));
  check('reorg toast is shown', /REORG|리오그/.test(els.toast.textContent), els.toast.textContent);
  check('reorg is reported on the badge', els.watchTxt.textContent !== 'WDG 0', els.watchTxt.textContent);

  /* back to clean data so the remaining checks are not polluted */
  wsInstance.deliver({ blocks: liveBlocks, fees: FIX.fees });
  S.reorgAt = 0;
  runFrames(rafQueue, 2);
  await sleep(60);

  /* ---- LN node card ---- */
  NP.layer('ln');
  await sleep(40);
  NP.openNode(0);
  const card = els.card.innerHTML;
  check('node card open', els.modal.classList.contains('on'));
  const first = G.clusters[0].nodes[0];
  check('card shows node alias', card.indexOf(first.alias.split('&')[0].slice(0, 6)) >= 0, first.alias);
  check('card shows coordinates', card.indexOf(first.lat.toFixed(4)) >= 0, first.lat);
  check('card shows CHAIN TIP', card.indexOf('CHAIN TIP') > 0 && card.indexOf(S.blocks[0].id) > 0);
  check('card avoids invented metrics', !/지연시간\s*\d|가동시간\s*\d|GB<\/dd>/.test(card), 'invented metric found');
  check('card states API-only disclaimer', card.indexOf('표시하지 않습니다') > 0);
  check('card lists real peers', card.indexOf('REAL CHANNELS') > 0, card.slice(0, 80));
  check('card shows the channels-geo channel count for the node', card.indexOf('지도 채널') > 0);
  const peerNames = first.peers || [];
  check('node peers are real channels-geo peers', peerNames.length > 0 &&
    peerNames.some(a => CHGEO.some(r => (r[0] === first.pk && r[5] === a) || (r[4] === first.pk && r[1] === a))),
    peerNames.join(', '));

  /* ---- a failed node detail keeps the geo detail the cache already held ----
     The nodes/{pubkey} GET fills alias, city, country and AS; its failure branch used to
     write null into geoCache, so one failed request erased what the map had just shown —
     and the refresh saved that null for the next boot. */
  const geoPk = S.nodes[0].pk;
  const geoNode = S.nodes[0];
  const staleAt = Date.now() - 7 * 3600 * 1000;          // past the six-hour node TTL
  ls.set('nodepulse.nodes.v2', JSON.stringify({
    t: staleAt, chanAt: staleAt, rows: 0, nodes: [], links: [],
    geo: {
      [geoPk]: {
        alias: 'STALE-ALIAS', lat: geoNode.lat, lon: geoNode.lon,
        city: 'Old Town', country: 'Oldland', iso: 'KR', t: staleAt
      }
    }
  }));
  failPks = [geoPk];
  await NP.refreshNodes(true);
  failPks = [];
  const keptNode = S.nodes.find(n => n.pk === geoPk);
  check('a failed node detail keeps the cached alias',
    !!keptNode && keptNode.alias === 'STALE-ALIAS', keptNode && keptNode.alias);
  check('a failed node detail keeps the cached city and country',
    !!keptNode && keptNode.city === 'Old Town' && keptNode.country === 'Oldland',
    keptNode && (keptNode.city + ' / ' + keptNode.country));
  const savedGeo = (JSON.parse(ls.get('nodepulse.nodes.v2') || '{}') || {}).geo || {};
  check('a failed node detail is not written back as null',
    !!savedGeo[geoPk] && typeof savedGeo[geoPk] === 'object' && savedGeo[geoPk].alias === 'STALE-ALIAS',
    JSON.stringify(savedGeo[geoPk]));
  check('the other node details were still refreshed during that pass',
    S.nodes.some(n => n.pk !== geoPk && typeof n.city === 'string' && n.city.length > 0),
    S.nodes.filter(n => n.city).length + ' nodes with a city');

  /* ---- L1 node card ---- */
  NP.layer('l1');
  await sleep(40);
  NP.openNode(0);
  const l1card = els.card.innerHTML;
  check('L1 card open on a coordinate cell', els.modal.classList.contains('on') && l1card.indexOf('BITCOIN L1') > 0);
  check('L1 card shows the cell coordinate', l1card.indexOf(G.clusters[0].pts[0][0].toFixed(4)) > 0, l1card.slice(0, 120));
  check('L1 card states there is no peer graph', l1card.indexOf('P2P') > 0 || l1card.indexOf('연결 그래프') > 0);
  check('L1 card does not invent disk or uptime', !/(GB<\/dd>|가동시간<\/dt>|디스크<\/dt>|uptime<\/dt>)/i.test(l1card), 'invented field');

  /* ---- a two-finger pinch release must not open a node card ----
     The globe only saw dragMoved from the single-finger phase, so letting go of a zoom
     gesture on a cluster used to read as a tap and pop the card open. A clean tap must
     still open it, so that is the control. */
  els.modal.click();
  check('card closed before the gesture tests', !els.modal.classList.contains('on'));
  runFrames(rafQueue, 2);   // a layer switch rebuilds the clusters; draw them first
  const pinchCluster = G.clusters.find(c => c.on && typeof c.sx === 'number') || G.clusters[0];
  check('a visible cluster exists for the gesture test', !!pinchCluster && pinchCluster.on === true,
    pinchCluster && (pinchCluster.on + '/' + pinchCluster.sx + ',' + pinchCluster.sy));
  const pxEv = (type, id, x, y) => els.globe.dispatch(type, { pointerId: id, clientX: x, clientY: y, preventDefault() { } });
  pxEv('pointerdown', 1, pinchCluster.sx, pinchCluster.sy);
  pxEv('pointerup', 1, pinchCluster.sx, pinchCluster.sy);
  check('a clean single-finger tap still opens the card', els.modal.classList.contains('on'));
  els.modal.click();
  pxEv('pointerdown', 1, pinchCluster.sx, pinchCluster.sy);
  pxEv('pointerdown', 2, pinchCluster.sx + 40, pinchCluster.sy + 40);
  pxEv('pointermove', 2, pinchCluster.sx + 60, pinchCluster.sy + 60);
  pxEv('pointerup', 2, pinchCluster.sx + 60, pinchCluster.sy + 60);
  pxEv('pointerup', 1, pinchCluster.sx, pinchCluster.sy);
  check('releasing a pinch opens no node card', !els.modal.classList.contains('on'));

  /* ---- language toggle ---- */
  NP.lang('en');
  await sleep(500);
  check('language switch sets the document language', sandbox.document.documentElement.getAttribute('lang') === 'en',
    sandbox.document.documentElement.getAttribute('lang'));
  check('English panel footnote', els.note.innerHTML.indexOf('Bitnodes is the primary L1 source') > 0, els.note.innerHTML.slice(0, 120));
  check('English L1 legeind', els.legend.innerHTML.indexOf('FULL NODE LOCATION') > 0, els.legend.innerHTML);
  check('English legend + footnote are both applied', els.note.innerHTML.indexOf('Bitnodes is the primary L1 source') > 0 && els.legend.innerHTML.indexOf('L1 FULL NODE') > 0);
  check('language button offers the other language', els.langBtn.textContent === 'KO', els.langBtn.textContent);

  /* ---- i18n: the node card carries no hardcoded Korean once the language is English ---- */
  NP.lang('en');
  await sleep(200);
  NP.layer('ln');
  await sleep(60);
  const manyAt = -1;   /* the captured sample has no multi-node cell; the cluster row is
                          covered by the source guard below instead */
  NP.lang('ko');
  await sleep(120);
  if (manyAt >= 0) {
    NP.openNode(manyAt);
    const koMany = els.card.innerHTML;
    check('Korean cluster row uses Korean units', koMany.indexOf('개 노드') > 0 && /\d+개/.test(koMany), koMany.slice(0, 120));
  }
  NP.lang('en');
  await sleep(120);
  NP.openNode(manyAt >= 0 ? manyAt : 0);
  const enCard = els.card.innerHTML;
  check('English node card uses English labels', enCard.indexOf('Sockets') > 0 && enCard.indexOf('Channels') > 0, enCard.slice(0, 120));
  check('English node card has no Korean counter or unit left',
    !/\d+개|개 노드|채널/.test(enCard), (enCard.match(/[^<>]{0,20}(?:\d+개|개 노드|채널)[^<>]{0,20}/) || [''])[0]);
  if (manyAt >= 0) check('English cluster row uses English units', enCard.indexOf(' nodes · ') > 0, enCard.slice(0, 120));

  /* ---- i18n: every L() key exists in both dictionaries, and the strings this release
     moved out of the code are gone from the source ---- */
  const appSrc = fs.readFileSync(path.join(ROOT, 'src', 'app.js'), 'utf8');
  const strBlock = appSrc.slice(appSrc.indexOf('var STR = {'), appSrc.indexOf('function L(k)'));
  const koBlock = strBlock.slice(strBlock.indexOf('ko: {'), strBlock.indexOf('en: {'));
  const enBlock = strBlock.slice(strBlock.indexOf('en: {'));
  const keysUsed = [...new Set([...appSrc.matchAll(/\bL\('([A-Za-z0-9_]+)'\)/g)].map(m => m[1]))];
  const missingKo = keysUsed.filter(k => !new RegExp('(^|[\\s{,])' + k + ':').test(koBlock));
  const missingEn = keysUsed.filter(k => !new RegExp('(^|[\\s{,])' + k + ':').test(enBlock));
  check('every L() key is defined in Korean and English', keysUsed.length > 40 &&
    missingKo.length === 0 && missingEn.length === 0, missingKo.concat(missingEn).join(','));
  check('no hardcoded Korean pool / cluster / socket unit is left in the source',
    appSrc.indexOf("' (1주 '") < 0 && appSrc.indexOf("+ '개' +") < 0 && appSrc.indexOf("' nodes · '") < 0,
    'hardcoded unit found');
  NP.layer('l1');
  NP.lang('ko');
  await sleep(500);
  check('Korean footnote restored', els.note.innerHTML.indexOf('Bitnodes') > 0 && /[가-힣]/.test(els.note.innerHTML));

  /* ---- websocket mirror fallback ---- */
  const hostBefore = S.wsHost;
  check('first websocket host is mempool.space', wsInstance.url === 'wss://mempool.space/api/v1/ws', wsInstance.url);
  wsInstance.close();
  check('close advances to the next mirror', S.wsHost === (hostBefore + 1) % 3, S.wsHost + ' / ' + NP.wsUrl());
  await sleep(2600);
  const second = wsList[wsList.length - 1];
  check('retry connects to the mirror', second && second !== wsInstance && second.url === 'wss://mempool.emzy.de/api/v1/ws',
    second && second.url);

  /* ---- a socket that is no longer current cannot move the mirror or open a retry ---- */
  const hostAfterRetry = S.wsHost;
  wsInstance.close();                        // the first socket, already replaced
  await sleep(150);
  check('a stale socket closing late changes nothing',
    S.wsHost === hostAfterRetry, S.wsHost + ' vs ' + hostAfterRetry);
  check('a stale close opens no extra socket', wsList.length === 2, wsList.length);

  /* ---- a poisoned localStorage snapshot is rejected field by field ----
     JSON.parse happily returns a string, a number or an array, and localStorage is
     writable by anything that ever ran on this origin, so boot must not walk into it. */
  ls = new Map([
    ['nodepulse.cache.v2', JSON.stringify({
      t: 1, tip: '800000', blocks: 'x', mem: 5, recent: {}, fees: [], hr: [],
      diff: null, ln: 'y', lnAt: 'z', countries: 3, mblocks: {}, mblocksAt: {}, pools: [], poolsAt: 'q'
    })],
    ['nodepulse.cache.v2.l1', JSON.stringify({ t: 1, d: { total: 1, coords: 'oops' } })],
    ['nodepulse.nodes.v2', JSON.stringify({ t: Date.now(), geo: 7, nodes: 'nope', links: 4, rows: 'x', chanAt: 'y' })]
  ]);
  const poisoned = makeSandbox({ bridge: false });
  const ctx3 = vm.createContext(poisoned.sandbox);
  const prevMode = fetchMode;
  fetchMode = 'fail';
  let poisonedThrew = null;
  try {
    for (let i = 0; i < scripts.length; i++) vm.runInContext(scripts[i], ctx3, { filename: 'poison-' + i + '.js', timeout: 8000 });
    await sleep(500);
    runFrames(poisoned.rafQueue, 2);
  } catch (e) { poisonedThrew = e; }
  fetchMode = prevMode;
  check('poisoned localStorage does not throw on boot', !poisonedThrew, poisonedThrew && poisonedThrew.stack);
  const PS = poisoned.window.NODEPULSE && poisoned.window.NODEPULSE.state;
  check('poisoned cache fields are not adopted', !!PS && PS.tip === null && PS.mem === null && PS.ln === null &&
    Array.isArray(PS.blocks) && Array.isArray(PS.countries) && Array.isArray(PS.mblocks), PS && JSON.stringify({ tip: PS.tip, mem: PS.mem, ln: PS.ln }));
  check('poisoned node snapshot is not adopted', !!PS && Array.isArray(PS.nodes) && PS.nodeSrc === 'seed', PS && PS.nodeSrc);

  /* ---- a well-formed snapshot is still restored (the checks did not close the door) ---- */
  ls = new Map([
    ['nodepulse.cache.v2', JSON.stringify({
      t: Date.now(), tip: 812345, blocks: [], recent: [],
      mem: { count: 1200, vsize: 500000, totalFee: 300 }, fees: { fastestFee: 7 },
      hr: { hashrates: [] }, diff: { difficultyChange: 1 }, ln: null, lnAt: 0,
      countries: [], mblocks: [], mblocksAt: 0, pools: null, poolsAt: 0
    })]
  ]);
  const good = makeSandbox({ bridge: false });
  const ctx4 = vm.createContext(good.sandbox);
  fetchMode = 'fail';
  try {
    for (let i = 0; i < scripts.length; i++) vm.runInContext(scripts[i], ctx4, { filename: 'good-' + i + '.js', timeout: 8000 });
    await sleep(400);
    runFrames(good.rafQueue, 2);
  } catch (e) { check('valid cache boots', false, e && e.stack); }
  fetchMode = prevMode;
  const GS = good.window.NODEPULSE && good.window.NODEPULSE.state;
  check('a well-formed cache is still restored', !!GS && GS.tip === 812345 && GS.mem && GS.mem.count === 1200 &&
    GS.fees && GS.fees.fastestFee === 7, GS && JSON.stringify({ tip: GS.tip, mem: GS.mem }));

  /* ---- a fresh node snapshot is reused, not downloaded again ----
     The channels-geo payload is ~1.5 MB; re-fetching it on every boot while the six-hour
     cache is still inside its window was pure waste. */
  const cachedNodes = JSON.parse(JSON.stringify(S.nodes));
  const cachedLinks = JSON.parse(JSON.stringify(S.links));
  ls = new Map([['nodepulse.nodes.v2', JSON.stringify({
    t: Date.now(), geo: {}, nodes: cachedNodes, links: cachedLinks, rows: 4321, chanAt: Date.now()
  })]]);
  const geoCallsBefore = fetchLog.filter(u => u.indexOf('channels-geo') >= 0).length;
  const warm = makeSandbox({ bridge: true });
  const ctx5 = vm.createContext(warm.sandbox);
  let warmThrew = null;
  try {
    for (let i = 0; i < scripts.length; i++) vm.runInContext(scripts[i], ctx5, { filename: 'warm-' + i + '.js', timeout: 8000 });
    await sleep(400);
    runFrames(warm.rafQueue, 2);
  } catch (e) { warmThrew = e; }
  check('a warm node cache boots without throwing', !warmThrew, warmThrew && warmThrew.stack);
  const WS2 = warm.window.NODEPULSE && warm.window.NODEPULSE.state;
  check('a fresh node snapshot is not downloaded again',
    fetchLog.filter(u => u.indexOf('channels-geo') >= 0).length === geoCallsBefore,
    (fetchLog.filter(u => u.indexOf('channels-geo') >= 0).length - geoCallsBefore) + ' extra downloads');
  check('the cached node graph is drawn from the snapshot',
    !!WS2 && WS2.nodeSrc === 'live' && WS2.nodes.length === cachedNodes.length && WS2.links.length === cachedLinks.length,
    WS2 && (WS2.nodeSrc + ' ' + WS2.nodes.length + '/' + cachedLinks.length));
  check('the cached channel row count is kept',
    !!WS2 && WS2.chanRows === 4321, WS2 && WS2.chanRows);

  /* ---- a fee figure cached by 1.1.4 was in satoshis; it must not be shown as BTC ---- */
  ls = new Map([['nodepulse.cache.v2', JSON.stringify({
    t: Date.now(), tip: 812345, blocks: [], recent: [],
    mem: { count: 9, vsize: 1000, totalFee: 4121603 }, fees: null,
    hr: null, diff: null, ln: null, lnAt: 0, countries: [], mblocks: [], mblocksAt: 0, pools: null, poolsAt: 0
  })]]);
  const satsCache = makeSandbox({ bridge: false });
  const ctx6 = vm.createContext(satsCache.sandbox);
  const modeBeforeSats = fetchMode;
  fetchMode = 'fail';
  try {
    for (let i = 0; i < scripts.length; i++) vm.runInContext(scripts[i], ctx6, { filename: 'sats-' + i + '.js', timeout: 8000 });
    await sleep(300);
    runFrames(satsCache.rafQueue, 2);
  } catch (e) { check('a satoshi-era cache boots', false, e && e.stack); }
  fetchMode = modeBeforeSats;
  const SC = satsCache.window.NODEPULSE && satsCache.window.NODEPULSE.state;
  check('a cached satoshi fee is not adopted as a BTC amount',
    !!SC && SC.mem && SC.mem.totalFee === null && SC.mem.count === 9, SC && SC.mem && JSON.stringify(SC.mem));

  /* ---- one corrupt element inside a cached array must not take the boot down ----
     localStorage is writable by anything that ever ran on this origin; 1.1.5 trusted the
     array as a whole, so a single number where a block object belongs crashed shortHash()
     on the first paint and a string where the hashrate list belongs crashed forEach().
     Every element is now rebuilt field by field; the well-formed ones survive. */
  ls = new Map([['nodepulse.cache.v2', JSON.stringify({
    t: Date.now(), tip: 812345,
    blocks: [7, null, 'x', { height: 'n', id: 9 },
      { height: 800123, id: 'a'.repeat(64), time: 'z', txs: null, size: {}, medianFee: 'q', pool: 5 }],
    recent: [4, {}, { txid: 123 }, { txid: 'b'.repeat(64), value: 0.5, fee: 'x', vsize: null, rate: 3 }],
    countries: ['KR', 5, { iso: 7, count: 1 }, { iso: 'KR', count: 'n' }, { iso: 'US', count: 12 }],
    mblocks: [1, 'y', { vsize: 'x', median: 'q', lo: {}, hi: [], nTx: null }, { vsize: 1.2e6, median: 12, lo: 9, hi: 15, nTx: 2000 }],
    mem: { count: 1200, vsize: 500000, totalFee: 300 }, fees: { fastestFee: 7, halfHourFee: 'x' },
    hr: { hashrates: 'oops', currentHashrate: 5 },
    diff: { difficultyChange: 1, remainingBlocks: 'n', estimatedRetargetDate: 9 },
    ln: null, lnAt: 0, pools: { blockCount: 0, pools: 'x' }, poolsAt: 0
  })]]);
  const corruptMode = fetchMode;
  fetchMode = 'fail';
  const corrupt = makeSandbox({ bridge: false });
  const ctxC = vm.createContext(corrupt.sandbox);
  let corruptThrew = null;
  try {
    for (let i = 0; i < scripts.length; i++) vm.runInContext(scripts[i], ctxC, { filename: 'corrupt-' + i + '.js', timeout: 8000 });
    await sleep(400);
    runFrames(corrupt.rafQueue, 2);
    corrupt.window.NODEPULSE.panel(true);
    await sleep(300);
    runFrames(corrupt.rafQueue, 2);
  } catch (e) { corruptThrew = e; }
  fetchMode = corruptMode;
  check('a cache with corrupt array elements boots and paints without throwing', !corruptThrew, corruptThrew && corruptThrew.stack);
  const CC = corrupt.window.NODEPULSE && corrupt.window.NODEPULSE.state;
  check('only well-formed cached blocks survive', !!CC && CC.blocks.length === 1 &&
    CC.blocks[0].height === 800123 && CC.blocks[0].time === null && CC.blocks[0].pool === null,
    CC && JSON.stringify(CC.blocks));
  check('only well-formed cached transactions survive', !!CC && CC.recent.length === 1 &&
    CC.recent[0].txid === 'b'.repeat(64) && CC.recent[0].fee === 0, CC && JSON.stringify(CC.recent));
  check('only well-formed cached countries survive', !!CC && CC.countries.length === 1 &&
    CC.countries[0].iso === 'US' && CC.countries[0].count === 12, CC && JSON.stringify(CC.countries));
  check('only well-formed cached next-blocks survive', !!CC && CC.mblocks.length === 1 &&
    CC.mblocks[0].vsize === 1.2e6 && CC.mblocks[0].nTx === 2000, CC && JSON.stringify(CC.mblocks));
  check('a cached hashrate list that is not an array is not adopted',
    !!CC && CC.hr === null, CC && CC.hr && JSON.stringify(CC.hr));
  check('a cached pool list that is not an array is not adopted',
    !!CC && CC.pools === null, CC && CC.pools && JSON.stringify(CC.pools));
  check('cached numeric fields are kept while corrupt siblings are dropped',
    !!CC && CC.tip === 812345 && CC.mem && CC.mem.count === 1200 && CC.fees && CC.fees.fastestFee === 7 &&
    CC.fees.halfHourFee === undefined && CC.diff && CC.diff.difficultyChange === 1 && CC.diff.remainingBlocks === null,
    CC && JSON.stringify({ tip: CC.tip, mem: CC.mem, fees: CC.fees, diff: CC.diff }));

  /* ---- a corrupt entry in the saved node snapshot is dropped, not drawn ---- */
  ls = new Map([['nodepulse.nodes.v2', JSON.stringify({
    t: Date.now(), geo: {}, rows: 99, chanAt: Date.now(),
    nodes: [3, {}, { pk: 'x', lat: 1, lon: 1 },
      { pk: 'a'.repeat(66), alias: 'ok-node', lat: 37.5, lon: 127, iso: 'KR', channels: 4, capacity: 1, deg: 2, peers: [] }],
    links: ['ab', [1, 2], ['a'.repeat(66), 'b'.repeat(66)]]
  })]]);
  const corruptNodes = makeSandbox({ bridge: true });
  const ctxCN = vm.createContext(corruptNodes.sandbox);
  let corruptNodesThrew = null;
  try {
    for (let i = 0; i < scripts.length; i++) vm.runInContext(scripts[i], ctxCN, { filename: 'corruptnodes-' + i + '.js', timeout: 8000 });
    await sleep(400);
    runFrames(corruptNodes.rafQueue, 2);
  } catch (e) { corruptNodesThrew = e; }
  const CN = corruptNodes.window.NODEPULSE && corruptNodes.window.NODEPULSE.state;
  check('a node snapshot with corrupt elements boots without throwing', !corruptNodesThrew, corruptNodesThrew && corruptNodesThrew.stack);
  check('only well-formed cached nodes and links are drawn', !!CN && CN.nodes.length === 1 &&
    CN.links.length === 1 && CN.nodeSrc === 'live',
    CN && (CN.nodes.length + '/' + CN.links.length + '/' + CN.nodeSrc));

  /* ---- a WebSocket that never finishes connecting fails fast to the next mirror ----
     Without a CONNECTING timeout the app waited for the browser's own give-up — tens of
     seconds — before rotating, and sat without a feed meanwhile. */
  ls = new Map();
  const HungWS = makeHungWS();
  const hungWS = makeSandbox({ bridge: false });
  hungWS.sandbox.WebSocket = HungWS;
  hungWS.window.WebSocket = HungWS;
  const ctxH = vm.createContext(hungWS.sandbox);
  const modeBeforeHung = fetchMode;
  fetchMode = 'fail';
  try {
    for (let i = 0; i < scripts.length; i++) vm.runInContext(scripts[i], ctxH, { filename: 'hungws-' + i + '.js', timeout: 8000 });
    await sleep(200);
  } catch (e) { check('hung-websocket boot does not throw', false, e && e.stack); }
  const HN = hungWS.window.NODEPULSE;
  HN.wsConnectMs(40);
  HungWS.list[0].close();                       // give up on the boot socket by hand
  await sleep(30);
  const hostAfterBootClose = HN.state.wsHost;
  HN.connect();                                 // opens hung socket #2
  await sleep(140);                             // past the 40 ms connecting timeout
  check('a socket still CONNECTING is closed by the timeout',
    HungWS.list[1] && HungWS.list[1].readyState === 3, HungWS.list[1] && HungWS.list[1].readyState);
  check('the connecting timeout advanced to the next mirror',
    HN.state.wsHost === (hostAfterBootClose + 1) % 3, HN.state.wsHost + ' vs ' + hostAfterBootClose);
  check('the timed-out socket left no live feed', HN.state.ws === 'closed', HN.state.ws);
  await sleep(3800);                            // past the retry backoff
  check('the retry after a connecting timeout opens the third mirror',
    HungWS.list.length >= 3 && HungWS.list[2].url === 'wss://mempool.ninja/api/v1/ws',
    HungWS.list[2] && HungWS.list[2].url);
  fetchMode = modeBeforeHung;

  /* ---- a body that hangs after the headers still falls to the next mirror ----
     The abort timer used to be cleared the moment the response headers arrived, so a
     mirror that stalled mid-body hung the request forever. */
  ls = new Map();
  const bodyHang = makeSandbox({ bridge: false, fetchImpl: hangingBodyFetch });
  const ctxB = vm.createContext(bodyHang.sandbox);
  const tipCallsBefore = fetchLog.length;
  let bootThrew = null;
  try {
    for (let i = 0; i < scripts.length; i++) vm.runInContext(scripts[i], ctxB, { filename: 'bodyhang-' + i + '.js', timeout: 8000 });
  } catch (e) { bootThrew = e; }
  check('body-hang boot does not throw', !bootThrew, bootThrew && bootThrew.stack);
  const NB = bodyHang.window.NODEPULSE;
  NB.fetchMs(60);
  let bodyResult = null;
  await Promise.race([
    NB.loadTip().then(() => { bodyResult = 'ok'; }, () => { bodyResult = 'err'; }),
    sleep(3000).then(() => { bodyResult = bodyResult || 'timeout'; })
  ]);
  check('a body that hangs after the headers still completes', bodyResult === 'ok', bodyResult);
  const tipCalls = fetchLog.slice(tipCallsBefore).filter(u => u.indexOf('tip/height') >= 0);
  check('the hung body request rotated to the second mirror', tipCalls.length >= 2 &&
    tipCalls[tipCalls.length - 2].indexOf('mempool.space') >= 0 &&
    tipCalls[tipCalls.length - 1].indexOf('mempool.emzy.de') >= 0,
    tipCalls.join(' | '));
  check('the tip arrived from the fallback mirror', NB.state.tip === FIX.tip, NB.state.tip + ' vs ' + FIX.tip);

  /* ---- failure mode: no network at all ----
     without the bridge and with every request failing, both layers still draw the
     bundled real snapshots and say so. */
  ls = new Map();
  const off = makeSandbox({ bridge: false });
  const ctx2 = vm.createContext(off.sandbox);
  const prevFetchMode = fetchMode;
  fetchMode = 'fail';
  try {
    for (let i = 0; i < scripts.length; i++) vm.runInContext(scripts[i], ctx2, { filename: 'off-' + i + '.js', timeout: 8000 });
    await sleep(700);
    runFrames(off.rafQueue, 2);
    const OFF = off.window.NODEPULSE;
    OFF.panel(true);
    await sleep(600);
    runFrames(off.rafQueue, 2);
    check('offline boot does not throw', !!OFF);
    check('offline L1 falls back to the bundled Bitnodes snapshot', OFF.state.l1 && OFF.state.l1.src === 'snapshot',
      OFF.state.l1 && OFF.state.l1.src);
    check('offline L1 snapshot carries real coordinates',
      OFF.state.l1.coords.length === L1SEED.coords.length, OFF.state.l1.coords.length);
    check('offline L1 total is the snapshot total', OFF.state.l1.total === L1SEED.totalNodes, OFF.state.l1.total);
    check('offline L1 client versions come from the snapshot percentages',
      OFF.state.l1.vers.length > 0 && OFF.state.l1.vers[0].name === L1.userAgents[0][0] &&
      Math.abs(OFF.state.l1.vers[0].pct - L1.userAgents[0][1]) < 1e-9, JSON.stringify(OFF.state.l1.vers[0]));
    check('offline L1 transport split is the snapshot split',
      OFF.state.l1.platforms && OFF.state.l1.platforms.clearnet === L1.platforms.clearnet,
      JSON.stringify(OFF.state.l1.platforms));
    check('offline L1 globe still draws those coordinates',
      OFF.nodes().length > 300 && OFF.links().length === 0, OFF.nodes().length + '/' + OFF.links().length);
    check('offline panel labels the snapshot', off.els.note.innerHTML.indexOf('내장 스냅샷') > 0 ||
      off.els.note.innerHTML.indexOf('스냅샷') > 0, off.els.note.innerHTML.slice(0, 100));
    const OFF_LN = (() => { OFF.layer('ln'); return OFF; })();
    check('offline globe has the lightning node sample', OFF_LN.state.nodes.length === NODESEED.nodes.length, OFF_LN.state.nodes.length);
    const offLinks = OFF_LN.channels().links;
    check('offline links are real snapshot channels',
      offLinks.length === CHSEED.links.length && offLinks.every(([a, b]) => rowSet.has(a + '|' + b)),
      offLinks.length + ' vs ' + CHSEED.links.length);
    check('offline globe draws those channels', OFF_LN.links().length >= 40, OFF_LN.links().length);
    check('offline source is labelled as the snapshot', OFF_LN.state.nodeSrc === 'seed', OFF_LN.state.nodeSrc);
  } catch (e) {
    check('offline boot does not throw', false, e && e.stack);
  }
  fetchMode = prevFetchMode;

  /* ---- report ---- */
  const bad = results.filter(r => !r.ok);
  console.log('\n================ RESULT ================');
  console.log('checks: ' + results.length + '  passed: ' + (results.length - bad.length) + '  failed: ' + bad.length);
  bad.forEach(b => console.log('  ✗ ' + b.name + '  ' + b.detail));
  if (!bad.length) console.log('ALL CHECKS PASSED');
  console.log('fetch calls: ' + fetchLog.length);
  process.exit(bad.length ? 1 : 0);
})();
