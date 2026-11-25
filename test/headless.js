/* Headless verification harness: boots the built single-file app in a stubbed DOM,
   feeds it the real API payloads captured in fixtures/, runs frames, and checks the
   rendered values, both layers, the watchdog and the globe geometry.

   Two builds are produced before anything is checked, so the assertions always describe
   the current src/ instead of a stale file: dist/nodepulse.html — the file that ships and
   the one the APK stages — and dist/nodepulse.test.html, the same build with the
   window.NODEPULSE hook the checks drive the app through. The shipping file is asserted to
   carry no hook at all; only the test build is executed here.
   Run: node test/headless.js */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BUILD = path.join(ROOT, 'build.py');
const HTML = path.join(ROOT, 'dist', 'nodepulse.html');
const TEST_HTML = path.join(ROOT, 'dist', 'nodepulse.test.html');

function build(test) {
  const args = test ? [BUILD, '--test'] : [BUILD];
  try {
    execFileSync(process.env.PYTHON || 'python3', args, { cwd: ROOT, stdio: 'pipe' });
  } catch (e) {
    console.error('build.py ' + (test ? '--test' : '') + ' failed\n' +
      String(e.stdout || '') + String(e.stderr || ''));
    process.exit(1);
  }
}
build(false);
build(true);

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

/* The application code as build.py assembles it: src/js/*.js in file-name order, one
   script block. The modules share one function scope, so a check that reads the code has
   to read them together. */
function appSource() {
  const dir = path.join(ROOT, 'src', 'js');
  return fs.readdirSync(dir).filter(f => f.endsWith('.js')).sort()
    .map(f => fs.readFileSync(path.join(dir, f), 'utf8').trim()).join('\n\n');
}

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail: detail === undefined ? '' : String(detail) });
  if (!cond) console.log('FAIL ' + name + (detail ? '  → ' + detail : ''));
}

/* ---------------------------------------------------------------- DOM stub */
function makeEl(id) {
  const el = {
    id, textContent: '', innerHTML: '', value: '', offsetWidth: 100, scrollTop: 0,
    width: 0, height: 0, attrs: {}, listeners: {}, children: [],
    /* CSS custom properties: Globe.layout() publishes the measured HUD height this way so
       the toast and the hint sit on top of the real HUD, not a hard-coded offset. */
    style: {
      _p: {},
      setProperty(k, v) { this._p[k] = String(v); },
      getPropertyValue(k) { return this._p[k] || ''; }
    },
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
  /* The real page answers these selectors and the app lays itself out against them: the
     HUD's height decides how much room the globe gets, and the topbar rows bound it from
     above. Every one of them answered null before, so Globe.layout() fell back to its
     defaults in every test and paint() never relaid the globe out. */
  const sized = (id, h) => { const el = els[id]; el.offsetHeight = h; return el; };
  const doc = {
    readyState: 'complete',
    hidden: false,
    documentElement: makeEl('html'),
    getElementById(id) { return els[id] || (els[id] = makeEl(id)); },
    querySelector(sel) {
      if (sel === '.hud') return sized('hud', 150);
      if (sel === '.topbar .head') return sized('topbarHead', 56);
      if (sel === '.layers') return sized('layers', 28);
      if (sel === '.subrow') return sized('subrow', 18);
      return null;
    },
    querySelectorAll() { return []; },
    listeners: {},
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    dispatch(type, ev) { (this.listeners[type] || []).forEach(f => f(ev || { target: this })); },
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
/* when set, the bridge answers the way the Java side now does: one callback per bounded
   chunk with (id, true, part, fin, seq). "hole" drops one middle part, so the page is
   offered a sequence it can never join. */
let bridgeChunked = false;
let bridgeChunkHole = false;
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
        if (!window.NPBridgeOnData) return;
        if (!bridgeChunked) {
          window.NPBridgeOnData(id, body !== null, body || '');
          return;
        }
        if (body === null) { window.NPBridgeOnData(id, false, '', true, 0); return; }
        const CH = 997;
        let seq = 0;
        for (let off = 0; off < body.length; off += CH) {
          seq++;
          if (bridgeChunkHole && seq === 2 && off + CH < body.length) continue;
          const fin = off + CH >= body.length;
          window.NPBridgeOnData(id, true, body.slice(off, off + CH), fin, seq);
        }
        if (seq === 0) window.NPBridgeOnData(id, true, '', true, 1);
      }, 4);
    }
  };
}

/* ------------------------------------------------------------------ window */
function makeWindow(docApi, els) {
  const rafQueue = [];
  const window = {
    innerWidth: 400, innerHeight: 860, devicePixelRatio: 2,
    listeners: {},
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    removeEventListener(type, fn) {
      const l = this.listeners[type];
      if (l) { const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); }
    },
    dispatch(type, ev) { (this.listeners[type] || []).forEach(f => f(ev || { target: this })); },
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

function makeSandbox({ bridge = true, fetchImpl = fakeFetch, online = true } = {}) {
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
  /* the platform's own online flag, which the app reads to stop a doomed walk early */
  if (online !== true) sandbox.navigator = { onLine: online };
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
const testHtml = fs.readFileSync(TEST_HTML, 'utf8');
check('the shipping build carries no test hook',
  html.indexOf('window.NODEPULSE = {') < 0 && html.indexOf('__TEST_HOOK') < 0,
  'the release build still has the NODEPULSE hook');
check('the test build the harness runs carries the hook',
  testHtml.indexOf('window.NODEPULSE = {') > 0);
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
/* Exactly the hosts the app reads: bitnodes.io for the L1 layer and the three mempool.space
   mirrors, ws for the three mirrors. Two hosts nothing in the app has ever requested
   (www.bitnodes.io, btcnodes.io) were still named by the policy and whitelisted in the
   native bridge, which is an allowance no code needs. */
const CSP_HOSTS = new Set([
  'https://bitnodes.io', 'https://mempool.space', 'https://mempool.emzy.de', 'https://mempool.ninja',
  'wss://mempool.space', 'wss://mempool.emzy.de', 'wss://mempool.ninja'
]);
const cspHosts = csp.match(/(?:https|wss):\/\/[a-z.]+/g) || [];
check('CSP names exactly the hosts the app reads',
  cspHosts.length === CSP_HOSTS.size && cspHosts.every(h => CSP_HOSTS.has(h)), cspHosts.join(','));
check('CSP names no host the app never reads',
  csp.indexOf('www.bitnodes.io') < 0 && csp.indexOf('btcnodes.io') < 0, csp.slice(0, 160));
check('the build never mentions the two dropped hosts',
  html.indexOf('www.bitnodes.io') < 0 && html.indexOf('btcnodes.io') < 0,
  (html.match(/[a-z.]*btcnodes\.io|www\.bitnodes\.io/g) || [''])[0]);
check('build has no inline style attribute', !/\sstyle="/.test(html), (html.match(/\sstyle="[^"]*"/) || [''])[0].slice(0, 60));
/* the reduced-motion rule used to name `.body`, a class nothing carries, so the body kept
   its transition for a reader who asked for none */
check('reduced-motion rule names body, not a .body class',
  html.indexOf('.topbar,.panel,.toggle,body{transition:none}') >= 0 && !/\.body\{transition:none\}/.test(html));
check('build has no inline event handler attribute',
  !/\son(click|error|load|mouseover|focus|blur|change|input|submit)="/.test(html));
/* blocks 1..5 are the five embedded datasets: whatever string they carry, none of them
   can close the script block or open a comment inside it */
check('embedded datasets cannot close their script block',
  blockBodies.slice(1, 6).every(b => !/<\/script/i.test(b) && !/<!--/.test(b)));
check('title present', /<title>NodePulse/.test(html));
check('no proximity-link label left', !/NODE LINK/.test(html), 'proximity link wording still in the build');
check('legend names real lightning channels', /LIGHTNING CHANNEL/.test(html));
/* the globe is solid: a channel or coastline on the far hemisphere is never stroked
   through the body (these two colours were the only far-side passes) */
check('no far-side channel or coastline pass in the build',
  !/rgba\(90,150,235,0\.075\)/.test(html) && !/rgba\(90,150,230,0\.07\)/.test(html));
check('L1 layer is the default view', /<body class="l1 en">/.test(html), 'body class');
check('the page declares English', /<html lang="en">/.test(html), 'document language');
/* The app is English only: no second string table, no language button and no Hangul is
   left in the page that ships. */
check('the build is English only',
  !/[\uac00-\ud7af]/.test(html) && html.indexOf('data-i18n') < 0 && html.indexOf('langBtn') < 0,
  (html.match(/[^\n]{0,30}[\uac00-\ud7af][^\n]{0,30}/) || [''])[0]);
check('native bridge hooks are in the build', /NPBridgeOnData/.test(html) && /NPBridge/.test(html));
check('bitnodes endpoints are in the build', /bitnodes\.io/.test(html) && /field=coordinates/.test(html) && /field=top/.test(html));
check('all three websocket mirrors are in the build',
  /mempool\.emzy\.de/.test(html) && /mempool\.ninja/.test(html) && /WS_HOSTS/.test(html));

const scripts = [...testHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
check('inline script blocks', scripts.length === 6, scripts.length);

/* ---- the Android shell's own contract, read from its source ----
   The Java side cannot be executed here, so the checks below hold it to the shape the
   review asked for and the headless build cannot see. The chunk-boundary rule itself is
   exercised for real by HttpBridgeChunkTest on the JVM (:app:testDebugUnitTest). */
{
  const java = fs.readFileSync(path.join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'corejbh', 'nodepulse', 'MainActivity.java'), 'utf8');
  const gradle = fs.readFileSync(path.join(ROOT, 'android', 'app', 'build.gradle.kts'), 'utf8');
  check('the bridge allowlist is the four hosts the page reads',
    /"bitnodes\.io"[\s\S]{0,80}"mempool\.space"[\s\S]{0,40}"mempool\.emzy\.de"[\s\S]{0,40}"mempool\.ninja"/.test(java) &&
    java.indexOf('www.bitnodes.io') < 0 && java.indexOf('btcnodes.io') < 0);
  check('a chunk boundary never splits a surrogate pair',
    /Character\.isHighSurrogate\(body\.charAt\(end - 1\)\)/.test(java) &&
    /int end = chunkEnd\(body, off, MAX_CHUNK_CHARS\)/.test(java));
  check('the chunk walk continues at the end it used, not at a fixed step',
    /off = end;/.test(java) && !/off \+= MAX_CHUNK_CHARS/.test(java));
  check('onSaveInstanceState checks the WebView exists',
    /onSaveInstanceState[\s\S]{0,300}?if \(web != null\) web\.saveState\(out\)/.test(java));
  check('onDestroy detaches the WebView before destroying it',
    /if \(web != null\) \{[\s\S]{0,200}?detach\(web\);\s*\n\s*web\.destroy\(\)/.test(java));
  check('a dead renderer is handled instead of killing the app',
    /onRenderProcessGone\(WebView view, RenderProcessGoneDetail detail\)[\s\S]{0,700}?recoverFromRendererGone\(\);[\s\S]{0,120}?return true;/.test(java));
  check('the renderer recovery rebuilds the shell',
    /recoverFromRendererGone\(\)[\s\S]{0,600}?installWebView\(\)/.test(java));
  check('the release signature is v2 only',
    /enableV1Signing = false/.test(gradle) && !/enableV1Signing = true/.test(gradle));
  check('the version bumped to 1.1.13 (versionCode 15)',
    /versionCode = 15/.test(gradle) && /versionName = "1\.1\.13"/.test(gradle));
  check('the unit test that walks the chunk boundaries is in the tree',
    fs.existsSync(path.join(ROOT, 'android', 'app', 'src', 'test', 'java', 'com', 'corejbh', 'nodepulse', 'HttpBridgeChunkTest.java')) &&
    /testImplementation\("junit:junit:4\.13\.2"\)/.test(gradle));
  /* v1.1.12: the back gesture, the id shape and the address guard. */
  check('the shell registers an OnBackPressedCallback instead of overriding onBackPressed()',
    /extends ComponentActivity/.test(java) && /new OnBackPressedCallback\(true\)/.test(java) &&
    /getOnBackPressedDispatcher\(\)\.addCallback\(this, backCallback\)/.test(java) &&
    !/public void onBackPressed\(\)/.test(java));
  check('the back callback asks the page to close its own layers first',
    /backDepth > 0[\s\S]{0,200}?window\.NodepulseBack&&window\.NodepulseBack\(\)/.test(java));
  check('the page reports its open layers through NPBack',
    /addJavascriptInterface\(new BackSignal\(\), "NPBack"\)/.test(java) && /public void setDepth\(int depth\)/.test(java));
  check('the navigation policy is one static function both overloads use',
    /static boolean navigationBlocked\(String url\)/.test(java) &&
    (java.match(/navigationBlocked\(/g) || []).length >= 3);
  check('a bridge request id must have the allowed shape',
    /static boolean validId\(String id\)/.test(java) && /if \(!validId\(id\)\) return;/.test(java));
  check('a resolved address must be public before it is contacted',
    /static boolean blockedAddress\(InetAddress a\)/.test(java) &&
    /static boolean hostSafe\(String host\)/.test(java) &&
    /hostSafe\(target\.getHost\(\)\)/.test(java) &&
    /isSiteLocalAddress\(\)/.test(java) && /isLoopbackAddress\(\)/.test(java) &&
    /isLinkLocalAddress\(\)/.test(java) && /isMulticastAddress\(\)/.test(java));
  check('every redirect hop is checked before it is fetched',
    /static String nextHop\(String base, String location\)/.test(java) &&
    /url = nextHop\(url, c\.getHeaderField\("Location"\)\)/.test(java));
  check('the policy tests are in the tree',
    fs.existsSync(path.join(ROOT, 'android', 'app', 'src', 'test', 'java', 'com', 'corejbh', 'nodepulse', 'HttpBridgePolicyTest.java')));
  check('the Android shell uses androidx.activity, and the project says so',
    /implementation\("androidx\.activity:activity:1\.9\.3"\)/.test(gradle) &&
    /android\.useAndroidX=true/.test(fs.readFileSync(path.join(ROOT, 'android', 'gradle.properties'), 'utf8')));
}

(async function main() {
  const { sandbox, window, els, rafQueue, doc } = makeSandbox({ bridge: true });
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

  /* ---- a live grid read does not adopt the stored cache for the top fields ----
     The object this load builds is stamped live. With the session's own top fields gone
     and the top query failing, the old code read them back from localStorage and printed
     a stored payload under LIVE; now it keeps only this session's answer (here: nothing). */
  {
    const keepTop = { asns: S.l1.asns, platforms: S.l1.platforms, vers: S.l1.vers };
    ls.set('nodepulse.cache.v2.l1', JSON.stringify({
      t: 1, d: { total: 1, coords: L1.coords.slice(0, 1), asns: [['CACHE-ONLY', 9]], ua: [['/CACHE-ONLY:1/', 1]] }
    }));
    S.l1.asns = null; S.l1.platforms = null; S.l1.vers = [];
    bridgeFailTop = true;
    await NP.loadL1();
    await sleep(80);
    bridgeFailTop = false;
    const seen = JSON.stringify(S.l1.asns || []) + JSON.stringify(S.l1.vers || []);
    check('a live grid read never adopts the stored cache for the top fields',
      seen.indexOf('CACHE-ONLY') < 0, seen.slice(0, 80));
    check('that live read is still a live answer', S.l1.src === 'live', S.l1.src);
    ls.delete('nodepulse.cache.v2.l1');
    S.l1.asns = keepTop.asns; S.l1.platforms = keepTop.platforms; S.l1.vers = keepTop.vers;
    await NP.loadL1();
    await sleep(120);
    runFrames(rafQueue, 2);
  }

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

  /* ---- loadLightning(): only finite figures and a string `added` are stored ----
     The HUD and the panel read node_count, channel_count, total_capacity and added
     straight off the answer; a string where a number belongs printed NaN into all of
     them. The stats are re-typed field by field and an answer left with nothing usable
     is rejected, keeping the previous ones on screen. */
  const goodLn = JSON.stringify(S.ln);
  const loadLn = async over => {
    bodyOverride.set('/api/v1/lightning/statistics/latest', over);
    let res = 'resolved';
    await NP.loadLightning().then(() => { }, () => { res = 'rejected'; });
    return res;
  };
  check('loadLightning rejects stats whose figures are all strings',
    (await loadLn({ latest: { node_count: '13777', channel_count: '22680', total_capacity: '253094023783', added: 5 } })) === 'rejected');
  check('a rejected lightning answer leaves the previous stats in place',
    JSON.stringify(S.ln) === goodLn, JSON.stringify(S.ln));
  check('loadLightning rejects a latest that is not an object',
    (await loadLn([1, 2, 3])) === 'rejected');
  check('loadLightning rejects stats with no usable figure at all',
    (await loadLn({ latest: { tor_nodes: 'x', med_fee_rate: null, added: '2026-11-01T00:00:00.000Z' } })) === 'rejected');
  check('a figure-less lightning answer leaves the previous stats in place',
    JSON.stringify(S.ln) === goodLn, JSON.stringify(S.ln));
  check('loadLightning accepts a mixed answer and keeps only its finite figures',
    (await loadLn({ latest: {
      node_count: 42, channel_count: 7, total_capacity: 'oops', med_fee_rate: 'NaN',
      clearnet_tor_nodes: 1292, added: '2026-11-22T00:00:00.000Z'
    } })) === 'resolved');
  check('string figures are dropped and finite ones kept',
    !!S.ln && S.ln.node_count === 42 && S.ln.channel_count === 7 &&
    S.ln.clearnet_tor_nodes === 1292 &&
    S.ln.total_capacity === undefined && S.ln.med_fee_rate === undefined,
    S.ln && JSON.stringify(S.ln));
  check('a string added survives',
    !!S.ln && S.ln.added === '2026-11-22T00:00:00.000Z', S.ln && S.ln.added);
  check('a numeric added is not adopted',
    (await loadLn({ latest: { node_count: 1, channel_count: 1, added: 1795267457 } })) === 'resolved' && S.ln.added === '',
    S.ln && S.ln.added);
  bodyOverride.delete('/api/v1/lightning/statistics/latest');
  await NP.loadLightning();
  check('a good lightning answer replaces the partial one',
    !!S.ln && S.ln.node_count === FIX.lnstats.latest.node_count &&
    S.ln.channel_count === FIX.lnstats.latest.channel_count &&
    S.ln.added === FIX.lnstats.latest.added,
    S.ln && JSON.stringify({ n: S.ln.node_count, a: S.ln.added }));

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
  check('panel lightning stats date shown', /as of \d{4}-\d{2}-\d{2}/.test(els.pLN.innerHTML), els.pLN.innerHTML);
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
    els.note.innerHTML.indexOf('real open channels') > 0 &&
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
  check('reorg toast is shown', /reorg/i.test(els.toast.textContent), els.toast.textContent);
  check('reorg is reported on the badge', els.watchTxt.textContent !== 'WDG 0', els.watchTxt.textContent);

  /* ---- a slow device clock: the API's block timestamp sits a few seconds ahead ----
     mempool.space stamps a block server-side and the phone's clock may run a little slow,
     so Date.now() - timestamp comes out negative. The block row printed the em dash
     durSec() returns for a negative second count ("—") and the watchdog a negative gap;
     every elapsed figure is clamped at zero now and reads "0s". */
  const skewed = JSON.parse(JSON.stringify(liveBlocks));
  skewed[0].height = oldTip + 2;
  skewed[0].id = '1'.repeat(64);
  skewed[0].timestamp = Math.floor(Date.now() / 1000) + 5;
  wsInstance.deliver({ blocks: skewed, fees: FIX.fees });
  runFrames(rafQueue, 2);
  await sleep(420);
  runFrames(rafQueue, 2);
  await sleep(80);
  const skewHTML = els.listBlocks.innerHTML;
  check('a block stamped ahead of the phone clock reads 0 seconds, not an em dash',
    skewHTML.indexOf(' · 0s</span>') > 0, skewHTML.slice(0, 220));
  check('no block age in the list is negative', !/-\d+s<\/span>/.test(skewHTML), skewHTML.slice(0, 220));
  const wSkew = NP.watch();
  check('a future block timestamp raises no block-delay alert',
    wSkew.alerts.every(a => a.k !== 'gap'), wSkew.alerts.map(a => a.text).join(' | '));
  check('the watchdog block row prints 0 seconds, not a negative or em-dash gap',
    /0s\b/.test(els.watch.innerHTML) && !/-\d+\s*s\b/.test(els.watch.innerHTML), els.watch.innerHTML.slice(0, 220));

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
  check('card avoids invented metrics', !/latency\s*\d|uptime\s*\d|GB<\/dd>/i.test(card), 'invented metric found');
  check('card states API-only disclaimer', card.indexOf('are not shown') > 0);
  check('card lists real peers', card.indexOf('REAL CHANNELS') > 0, card.slice(0, 80));
  check('card shows the channels-geo channel count for the node', card.indexOf('Mapped channels') > 0);
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
  check('L1 card states there is no peer graph', l1card.indexOf('peer graph') > 0);
  check('L1 card does not invent disk or uptime', !/(GB<\/dd>|uptime<\/dt>)/i.test(l1card), 'invented field');

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

  /* ---- focus loss mid-pinch: no pointerup follows when the WebView loses focus (the app
     is backgrounded, a call arrives, the window is sent to the back). The stale second
     pointer, the live pinch base and the unfinished drag used to stay behind, so the next
     tap was read against two old pointers and never opened the card. */
  pxEv('pointerdown', 1, pinchCluster.sx, pinchCluster.sy);
  pxEv('pointerdown', 2, pinchCluster.sx + 40, pinchCluster.sy + 40);
  const zoomAtBlur = G.zoomT;
  window.dispatch('blur', {});
  pxEv('pointermove', 2, pinchCluster.sx + 400, pinchCluster.sy + 400);
  check('losing focus drops the pinch instead of zooming from a stale base',
    G.zoomT === zoomAtBlur, G.zoomT + ' vs ' + zoomAtBlur);
  pxEv('pointerup', 2, pinchCluster.sx + 400, pinchCluster.sy + 400);
  pxEv('pointerup', 1, pinchCluster.sx, pinchCluster.sy);
  check('a pointerup for a dropped pointer opens no card', !els.modal.classList.contains('on'));
  pxEv('pointerdown', 1, pinchCluster.sx, pinchCluster.sy);
  pxEv('pointerup', 1, pinchCluster.sx, pinchCluster.sy);
  check('after a lost focus mid-pinch the next tap opens the card again',
    els.modal.classList.contains('on'));
  els.modal.click();

  /* the same reset for the touchcancel the platform reports */
  pxEv('pointerdown', 1, pinchCluster.sx, pinchCluster.sy);
  pxEv('pointerdown', 2, pinchCluster.sx + 30, pinchCluster.sy + 30);
  els.globe.dispatch('touchcancel', {});
  const zoomAtCancel = G.zoomT;
  pxEv('pointermove', 2, pinchCluster.sx + 300, pinchCluster.sy + 300);
  check('a touchcancel clears the pinch base too', G.zoomT === zoomAtCancel, G.zoomT + ' vs ' + zoomAtCancel);
  pxEv('pointerup', 2, pinchCluster.sx + 300, pinchCluster.sy + 300);
  pxEv('pointerup', 1, pinchCluster.sx, pinchCluster.sy);
  check('a stray pointerup after a touchcancel opens no card', !els.modal.classList.contains('on'));
  pxEv('pointerdown', 1, pinchCluster.sx, pinchCluster.sy);
  pxEv('pointerup', 1, pinchCluster.sx, pinchCluster.sy);
  check('the globe still answers a tap after a touchcancel', els.modal.classList.contains('on'));
  els.modal.click();

  /* ---- English only ---- */
  NP.layer('l1');
  await sleep(500);
  check('English panel footnote', els.note.innerHTML.indexOf('Bitnodes is the primary L1 source') > 0, els.note.innerHTML.slice(0, 120));
  check('English L1 legend', els.legend.innerHTML.indexOf('FULL NODE LOCATION') > 0, els.legend.innerHTML);
  check('English legend + footnote are both applied', els.note.innerHTML.indexOf('Bitnodes is the primary L1 source') > 0 && els.legend.innerHTML.indexOf('L1 FULL NODE') > 0);

  /* ---- the node card carries no second-language counter or unit ---- */
  NP.layer('ln');
  await sleep(60);
  const manyAt = -1;   /* the captured sample has no multi-node cell; the cluster row is
                          covered by the source guard below instead */
  NP.openNode(manyAt >= 0 ? manyAt : 0);
  const enCard = els.card.innerHTML;
  check('English node card uses English labels', enCard.indexOf('Sockets') > 0 && enCard.indexOf('Channels') > 0, enCard.slice(0, 120));
  check('English node card has no Hangul left',
    !/[\uac00-\ud7af]/.test(enCard), (enCard.match(/[^<>]{0,20}[\uac00-\ud7af][^<>]{0,20}/) || [''])[0]);
  if (manyAt >= 0) check('English cluster row uses English units', enCard.indexOf(' nodes · ') > 0, enCard.slice(0, 120));
  els.modal.click();

  /* ---- every L() key exists in the string table, and no second language or language
     switch is left in the source ---- */
  const appSrc = appSource();
  const strBlock = appSrc.slice(appSrc.indexOf('var STR = {'), appSrc.indexOf('function L(k)'));
  const keysUsed = [...new Set([...appSrc.matchAll(/\bL\('([A-Za-z0-9_]+)'\)/g)].map(m => m[1]))];
  const missingEn = keysUsed.filter(k => !new RegExp('(^|[\\s{,])' + k + ':').test(strBlock));
  check('every L() key is defined in the string table', keysUsed.length > 40 && missingEn.length === 0, missingEn.join(','));
  check('no language switch is left in the source',
    appSrc.indexOf('STR.ko') < 0 && appSrc.indexOf('applyLang') < 0 && appSrc.indexOf('langBtn') < 0 &&
    appSrc.indexOf('data-i18n') < 0 && appSrc.indexOf('S.lang') < 0,
    'language switch found');
  check('the source carries no Hangul', !/[\uac00-\ud7af]/.test(appSrc),
    (appSrc.match(/[^\n]*[\uac00-\ud7af][^\n]*/) || [''])[0].slice(0, 80));
  NP.layer('l1');
  await sleep(500);
  check('the footnote stays English', els.note.innerHTML.indexOf('Bitnodes') > 0 && !/[\uac00-\ud7af]/.test(els.note.innerHTML));

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

  /* ---- a cached lightning snapshot is re-typed like a live one ----
     restoreCache() used to adopt c.ln as it stood, so an object whose figures are all
     junk passed isObj() and either printed NaN or, with nothing usable, still made boot
     report a cache it does not have. */
  ls = new Map([
    ['nodepulse.cache.v2', JSON.stringify({
      t: Date.now(),
      ln: { node_count: '13777', channel_count: null, total_capacity: {}, added: 7, tor_nodes: 'x' },
      lnAt: Date.now()
    })]
  ]);
  const junkLn = makeSandbox({ bridge: false });
  const ctxJ = vm.createContext(junkLn.sandbox);
  const modeJunk = fetchMode;
  fetchMode = 'fail';
  try {
    for (let i = 0; i < scripts.length; i++) vm.runInContext(scripts[i], ctxJ, { filename: 'junkln-' + i + '.js', timeout: 8000 });
    await sleep(400);
    runFrames(junkLn.rafQueue, 2);
  } catch (e) { check('junk-ln cache boot does not throw', false, e && e.stack); }
  fetchMode = modeJunk;
  const JL = junkLn.window.NODEPULSE && junkLn.window.NODEPULSE.state;
  check('a lightning snapshot whose figures are junk is not adopted', !!JL && JL.ln === null, JL && JSON.stringify(JL.ln));
  check('junk lightning figures do not report a cache that is not there',
    !!JL && junkLn.els.toast.classList.contains('on') === false, junkLn.els.toast.textContent);

  ls = new Map([
    ['nodepulse.cache.v2', JSON.stringify({
      t: Date.now(),
      ln: { node_count: 13777, channel_count: 'x', total_capacity: 253094023783, added: '2026-10-21T00:00:00.000Z' },
      lnAt: Date.now()
    })]
  ]);
  const mixedLn = makeSandbox({ bridge: false });
  const ctxM = vm.createContext(mixedLn.sandbox);
  const modeMixed = fetchMode;
  fetchMode = 'fail';
  try {
    for (let i = 0; i < scripts.length; i++) vm.runInContext(scripts[i], ctxM, { filename: 'mixedln-' + i + '.js', timeout: 8000 });
    await sleep(400);
    runFrames(mixedLn.rafQueue, 2);
  } catch (e) { check('mixed-ln cache boot does not throw', false, e && e.stack); }
  fetchMode = modeMixed;
  const ML = mixedLn.window.NODEPULSE && mixedLn.window.NODEPULSE.state;
  check('a mixed lightning snapshot restores only its finite figures',
    !!ML && ML.ln && ML.ln.node_count === 13777 && ML.ln.total_capacity === 253094023783 &&
    ML.ln.channel_count === undefined,
    ML && JSON.stringify(ML.ln));
  check('a mixed lightning snapshot keeps its string added',
    !!ML && ML.ln.added === '2026-10-21T00:00:00.000Z', ML && ML.ln && ML.ln.added);

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

  /* ---- browser-only mode: a Bitnodes CORS refusal stops the L1 poll ----
     bitnodes.io sends no Access-Control-Allow-Origin, so a page without the native bridge
     can never read it, and the 5-minute timer used to repeat the two doomed requests for
     as long as the page stayed open. One attempt per page load is allowed; after it fails
     the poll is off and the bundled snapshot stays on screen. */
  {
    ls = new Map();
    const before = fetchLog.length;
    const bit = () => fetchLog.slice(before).filter(u => u.indexOf('bitnodes.io') >= 0).length;
    const browserOnly = makeSandbox({ bridge: false });
    const ctxO = vm.createContext(browserOnly.sandbox);
    try {
      for (let i = 0; i < scripts.length; i++) vm.runInContext(scripts[i], ctxO, { filename: 'browseronly-' + i + '.js', timeout: 8000 });
      await sleep(700);
      runFrames(browserOnly.rafQueue, 2);
    } catch (e) { check('browser-only boot does not throw', false, e && e.stack); }
    const BO = browserOnly.window.NODEPULSE;
    check('browser-only mode tries Bitnodes once per page load', bit() === 2, bit() + ' requests');
    check('the refused L1 read leaves the bundled snapshot on screen',
      !!BO.state.l1 && BO.state.l1.src === 'snapshot' && BO.state.l1.coords.length > 0,
      BO.state.l1 && BO.state.l1.src);
    check('the refusal switches the browser L1 poll off', BO.state.l1Off === true, BO.state.l1Off);
    await BO.loadL1();
    await BO.loadL1();
    await BO.loadL1();
    await sleep(60);
    check('later L1 ticks make no further Bitnodes request', bit() === 2, bit() + ' requests');
    check('the snapshot is still the L1 source after those ticks', BO.state.l1.src === 'snapshot', BO.state.l1.src);
  }

  /* ---- a cached Bitnodes answer is never marked live ----
     The cache is what the layer shows when the live read fails, so it must never look
     like a fresh answer: src stays 'cache' and it does not touch the session's last-ok. */
  {
    ls = new Map();
    ls.set('nodepulse.cache.v2.l1', JSON.stringify({
      t: Date.now(),
      d: {
        total: L1.totalNodes, reachable: L1.reachableNodes, height: L1.height,
        at: L1.capturedAt * 1000, coords: L1.coords.slice(0, 40),
        asns: L1.topAsns, ua: L1.userAgents, platforms: L1.platforms
      }
    }));
    const modeBeforeCache = fetchMode;
    fetchMode = 'fail';
    const cachedOnly = makeSandbox({ bridge: false });
    /* no feed either: an open socket calls ok() by itself, and this test is about an
       offline session where only the local cache can answer */
    const OfflineWS = function () { throw new Error('offline'); };
    cachedOnly.sandbox.WebSocket = OfflineWS;
    cachedOnly.window.WebSocket = OfflineWS;
    const ctxK = vm.createContext(cachedOnly.sandbox);
    try {
      for (let i = 0; i < scripts.length; i++) vm.runInContext(scripts[i], ctxK, { filename: 'cachedl1-' + i + '.js', timeout: 8000 });
      await sleep(600);
      runFrames(cachedOnly.rafQueue, 2);
    } catch (e) { check('cached-L1 boot does not throw', false, e && e.stack); }
    const CK = cachedOnly.window.NODEPULSE;
    check('an offline boot serves the cached Bitnodes answer',
      !!CK.state.l1 && CK.state.l1.src === 'cache', CK.state.l1 && CK.state.l1.src);
    check('the cached answer leaves the session un-live', CK.state.lastOk === 0, CK.state.lastOk);
    check('the status pill reads WAIT, not LIVE, for a cached answer',
      cachedOnly.els.liveTxt.textContent === 'WAIT', cachedOnly.els.liveTxt.textContent);
    fetchMode = modeBeforeCache;
  }

  /* ---- a working L1 read keeps the status live on its own ----
     loadL1() used to apply the answer without calling ok(), so a fresh Bitnodes read
     left the pill on STALE/WAIT while the L1 panel showed live data. */
  {
    ls = new Map();
    const l1Only = makeSandbox({ bridge: true, fetchImpl: () => Promise.reject(new Error('mempool down')) });
    /* the feed is down as well, so the only ok() this session can earn is the L1 one */
    const DeadWS = function () { throw new Error('offline'); };
    l1Only.sandbox.WebSocket = DeadWS;
    l1Only.window.WebSocket = DeadWS;
    const ctxL = vm.createContext(l1Only.sandbox);
    try {
      for (let i = 0; i < scripts.length; i++) vm.runInContext(scripts[i], ctxL, { filename: 'l1only-' + i + '.js', timeout: 8000 });
      await sleep(600);
      runFrames(l1Only.rafQueue, 2);
    } catch (e) { check('L1-only boot does not throw', false, e && e.stack); }
    const LO = l1Only.window.NODEPULSE;
    check('the Bitnodes answer arrives with no mempool host reachable',
      !!LO.state.l1 && LO.state.l1.src === 'live', LO.state.l1 && LO.state.l1.src);
    check('the L1 answer alone marks the session live', LO.state.lastOk > 0, LO.state.lastOk);
    check('the status pill reads LIVE from the L1 answer',
      l1Only.els.liveTxt.textContent === 'LIVE', l1Only.els.liveTxt.textContent);
  }

  /* ---- the page's bridge wait outlasts the native HttpBridge timeouts ----
     HttpBridge gives up after CONNECT_MS (connect) + READ_MS (read) per hop. A page timer
     below that cut the request short while Android was still reading, so a slow network
     never delivered an L1 answer. The JS floor is read from the Java source here, so the
     two sides cannot drift apart unnoticed. */
  {
    const java = fs.readFileSync(path.join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'corejbh', 'nodepulse', 'MainActivity.java'), 'utf8');
    const connect = Number((java.match(/CONNECT_MS\s*=\s*(\d+)/) || [])[1]);
    const read = Number((java.match(/READ_MS\s*=\s*(\d+)/) || [])[1]);
    check('the native bridge timeouts are declared', connect > 0 && read > 0, connect + ' + ' + read);
    check('the JS bridge wait is greater than the native connect + read timeout',
      NP.bridgeMs() > connect + read, NP.bridgeMs() + ' ms vs ' + (connect + read) + ' ms');
    check('the JS bridge wait keeps a margin over the native ceiling',
      NP.bridgeMs() - (connect + read) >= 3000, NP.bridgeMs() - (connect + read) + ' ms');

    /* a caller asking for 1 ms still gets the floor: the answer that arrives 50 ms later
       is delivered instead of a 'bridge timeout' */
    ls = new Map();
    const slow = makeSandbox({ bridge: false });
    slow.window.NPBridge = {
      fetch(id) {
        setTimeout(() => {
          if (slow.window.NPBridgeOnData) slow.window.NPBridgeOnData(id, true, '"ok"');
        }, 50);
      }
    };
    const ctxS = vm.createContext(slow.sandbox);
    try {
      for (let i = 0; i < scripts.length; i++) vm.runInContext(scripts[i], ctxS, { filename: 'slowbridge-' + i + '.js', timeout: 8000 });
      await sleep(120);
    } catch (e) { check('slow-bridge boot does not throw', false, e && e.stack); }
    const SB = slow.window.NODEPULSE;
    let slowGot = null;
    await SB.bridgeGet('https://bitnodes.io/api/v1/snapshots/latest/?field=top', 1)
      .then(t => { slowGot = t; }, e => { slowGot = 'err:' + (e && e.message); });
    check('a 1 ms bridge wait is floored, so the 50 ms answer is still delivered',
      slowGot === '"ok"', slowGot);
  }

  /* ---- the DATA footnote names the cached answer when the L1 source is cached ----
     The old two-state wording printed "the built-in snapshot" for the cache case too:
     a Bitnodes answer re-served from localStorage was described as the bundled snapshot,
     with the snapshot's capture date instead of the answer's own. */
  {
    S.l1.src = 'cache';
    NP.layer('l1');
    await sleep(450);
    runFrames(rafQueue, 1);
    check('EN footnote names the cached Bitnodes answer for a cached source',
      els.note.innerHTML.indexOf('currently the cached Bitnodes answer of') > 0,
      els.note.innerHTML.slice(0, 200));
    check('EN footnote no longer calls a cached answer the built-in snapshot',
      els.note.innerHTML.indexOf('currently the built-in snapshot') < 0,
      els.note.innerHTML.slice(0, 200));
    check('EN globe-points line says the answer is cached',
      els.note.innerHTML.indexOf('unique coordinates Bitnodes geolocated (cached answer)') > 0,
      els.note.innerHTML.slice(0, 400));
    S.l1.src = 'live';
    NP.layer('l1');
    await sleep(450);
    runFrames(rafQueue, 1);
    check('a live source is labelled live again',
      els.note.innerHTML.indexOf(' (live now)') > 0,
      els.note.innerHTML.slice(0, 200));
  }

  check('every repeating boot timer registers through the visibility-aware wrapper',
    NP.timers() >= 11, NP.timers());

  /* ---- the native bridge hands big bodies over in bounded chunks ----
     The Java side sends one call per chunk, (id, ok, part, fin, seq), so no call string
     scales with the body size; the page reassembles the parts in sequence order, and a
     sequence with a hole fails the request instead of splicing a body it never saw. */
  {
    bridgeChunked = true;
    ls = new Map();
    const chunked = makeSandbox({ bridge: true });
    const ctxC = vm.createContext(chunked.sandbox);
    try {
      for (let i = 0; i < scripts.length; i++) vm.runInContext(scripts[i], ctxC, { filename: 'chunk-' + i + '.js', timeout: 8000 });
      await sleep(500);
      runFrames(chunked.rafQueue, 2);
    } catch (e) { check('chunked bridge boot does not throw', false, e && e.stack); }
    const CS = chunked.window.NODEPULSE && chunked.window.NODEPULSE.state;
    check('a chunked bridge answer is reassembled in order',
      !!CS && CS.l1 && CS.l1.src === 'live', CS && CS.l1 && CS.l1.src);
    check('the reassembled coordinate grid is complete',
      !!CS && CS.l1 && CS.l1.coords.length === L1.coords.length,
      CS && CS.l1 && CS.l1.coords.length + ' vs ' + L1.coords.length);
    check('the reassembled transport split is intact',
      !!CS && CS.l1 && CS.l1.platforms && CS.l1.platforms.tor === L1.platforms.tor,
      CS && CS.l1 && JSON.stringify(CS.l1.platforms));

    bridgeChunkHole = true;
    ls = new Map();
    const hole = makeSandbox({ bridge: true });
    const ctxH = vm.createContext(hole.sandbox);
    try {
      for (let i = 0; i < scripts.length; i++) vm.runInContext(scripts[i], ctxH, { filename: 'hole-' + i + '.js', timeout: 8000 });
      await sleep(500);
      runFrames(hole.rafQueue, 2);
    } catch (e) { check('hole bridge boot does not throw', false, e && e.stack); }
    const HS = hole.window.NODEPULSE && hole.window.NODEPULSE.state;
    check('a lost chunk fails the request instead of splicing the body',
      !!HS && HS.l1 && HS.l1.src === 'snapshot', HS && HS.l1 && HS.l1.src);
    bridgeChunkHole = false;
    bridgeChunked = false;
  }

  /* ================= the 10th-round fixes, checked where they live ========= */

  /* ---- a newer block from /api/v1/blocks raises the tip and rings the event ----
     /api/blocks/tip/height is the endpoint upstream caches, so the blocks answer regularly
     carried a height the HUD had not published: the list below showed the newer block
     while the row above it sat one behind, and nothing raised it until the tip endpoint
     caught up. */
  {
    const real = FIX.blocks[0].height;
    S.tip = real - 1;
    els.toast.textContent = '';
    let r = 'pending';
    await NP.loadBlocks().then(() => { r = 'ok'; }, () => { r = 'err'; });
    check('loadBlocks accepts a good blocks answer', r === 'ok', r);
    check('a newer block from the blocks answer raises the tip', S.tip === real, S.tip + ' vs ' + real);
    check('that block rings the block event', els.toast.textContent.indexOf('NEW BLOCK') === 0, els.toast.textContent);
    check('the tip seen time moves with it', S.tipSeenAt > 0 && Date.now() - S.tipSeenAt < 5000, S.tipSeenAt);
    /* the same block again is not a second event */
    els.toast.textContent = '';
    await NP.loadBlocks();
    check('the same height again is not a new block event', els.toast.textContent === '', els.toast.textContent);
    check('and the tip is unchanged', S.tip === real, S.tip);
  }

  /* ---- a reconnect that comes due behind a hidden page is held, not repeated ---- */
  {
    ls = new Map();
    const hidden = makeSandbox({ bridge: true });
    const ctxHd = vm.createContext(hidden.sandbox);
    try {
      for (let i = 0; i < scripts.length; i++) vm.runInContext(scripts[i], ctxHd, { filename: 'hidden-' + i + '.js', timeout: 8000 });
      await sleep(300);
    } catch (e) { check('hidden-page boot does not throw', false, e && e.stack); }
    const HD = hidden.window.NODEPULSE;
    const live = wsList[wsList.length - 1];
    check('the socket of the hidden-page check is open first', !!live && live.readyState === 1, live && live.readyState);
    const sockets = wsList.length;
    const tries = HD.state.wsTries;
    hidden.doc.hidden = true;
    live.close();                                  // the close handler schedules the retry
    await sleep(40);
    check('the close is recorded while the page is hidden', HD.state.ws === 'closed', HD.state.ws);
    check('no retry timer is armed while the page is hidden', HD.wsTimerPending() === false);
    check('the held retry does not consume a backoff step', HD.state.wsTries === tries, HD.state.wsTries + ' vs ' + tries);
    check('the retry is remembered instead of dropped', HD.wsHeld() === true);
    check('no socket is opened behind the hidden page', wsList.length === sockets, wsList.length - sockets);
    hidden.doc.hidden = false;
    hidden.doc.dispatch('visibilitychange');
    await sleep(30);
    check('the page coming back starts the held retry at once',
      wsList.length === sockets + 1 && /^(connecting|open)$/.test(HD.state.ws),
      (wsList.length - sockets) + ' socket(s), ' + HD.state.ws);
    check('the held flag is cleared', HD.wsHeld() === false);
  }

  /* ---- country rows must be summable, in the live answer as in the cache ---- */
  {
    const real = S.countries.length;
    bodyOverride.set('/api/v1/lightning/nodes/countries', [
      { iso: 'US', count: '4329', capacity: '1' },
      { iso: 'DE', count: 10, capacity: '2' },
      { iso: 7, count: 3 },
      null
    ]);
    let r = 'pending';
    await NP.loadCountries().then(() => { r = 'ok'; }, () => { r = 'err'; });
    check('a country row with a string count is dropped', r === 'ok' && S.countries.length === 1 && S.countries[0].iso === 'DE',
      r + ' ' + JSON.stringify(S.countries));
    check('the continent sums stay numeric, never concatenated strings',
      Object.keys(S.conts.count).every(k => typeof S.conts.count[k] === 'number') && S.conts.total === 10,
      JSON.stringify(S.conts.count));
    bodyOverride.set('/api/v1/lightning/nodes/countries', [{ iso: 'US', count: 'x' }, null]);
    r = 'pending';
    await NP.loadCountries().then(() => { r = 'ok'; }, () => { r = 'err'; });
    check('an answer with no usable country row is rejected', r === 'err', r);
    check('a rejected country answer leaves the previous rows in place', S.countries.length === 1 && S.countries[0].iso === 'DE',
      JSON.stringify(S.countries));
    bodyOverride.delete('/api/v1/lightning/nodes/countries');
    await NP.loadCountries();
    check('a good country answer is adopted again', S.countries.length === real, S.countries.length + ' vs ' + real);
  }

  /* ---- the L1 split and version list are type-checked before they are printed ---- */
  {
    check('a split is not derived from a string ASN count',
      NP.l1Platforms({ total: 100, asns: [['TOR', '20'], ['I2P', 3]] }) === null,
      JSON.stringify(NP.l1Platforms({ total: 100, asns: [['TOR', '20'], ['I2P', 3]] })));
    const p = NP.l1Platforms({ total: 100, asns: [['TOR', 20], ['I2P', 3]] });
    check('a split is derived from numeric ASN rows',
      !!p && p.tor === 20 && p.i2p === 3 && p.clearnet === 77, JSON.stringify(p));
    check('a given split with a string figure is not adopted',
      NP.l1Platforms({ total: 10, platforms: { clearnet: '10', tor: 5, i2p: 5 } }) === null);
    check('a split whose counts exceed the total is not drawn',
      NP.l1Platforms({ total: 10, asns: [['TOR', 20]] }) === null);
    const v = NP.l1Versions({ ua: [[123, 5], ['/Satoshi:27.0.0/', 10], 7, ['x'], ['/Satoshi:26.0.0/', 'y']] });
    check('version rows that are not [name, count] pairs are dropped',
      v.length === 2 && v[0].name === '/Satoshi:27.0.0/' && v[0].pct === 10, JSON.stringify(v));
    check('a version row with a string count has no percentage', v[1] && v[1].pct === null, JSON.stringify(v[1]));
    const v2 = NP.l1Versions({ versions: [['/A/', '5'], ['/B/', 5], ['/C/', 10]] });
    check('a version list with a string count never produces NaN',
      v2.every(x => x.pct === null || isFinite(x.pct)) && Math.abs(v2[2].pct - 200 / 3) < 1e-9, JSON.stringify(v2));
  }

  /* ---- a dead network: three mirrors, then one bridge attempt, not three ---- */
  {
    const mode = fetchMode;
    fetchMode = 'fail';
    const bridges = bridgeCalls.length;
    const fetches = fetchLog.length;
    let r = 'pending';
    await NP.loadTip().then(() => { r = 'ok'; }, () => { r = 'err'; });
    fetchMode = mode;
    check('all three mirrors are still tried', fetchLog.length - fetches === 3, (fetchLog.length - fetches) + ' fetches');
    check('the bridge is asked once, not once per mirror', bridgeCalls.length - bridges === 1, (bridgeCalls.length - bridges) + ' bridge calls');
    check('a failed path is reported as failed', r === 'err', r);
    check('the whole walk is bounded far below the old 153 s cascade', NP.reqBudgetMs() < 153000, NP.reqBudgetMs() + ' ms');
  }

  /* ---- a phone that reports itself offline does not walk the mirrors at all ---- */
  {
    ls = new Map();
    const fetches = fetchLog.length;
    const bridges = bridgeCalls.length;
    const offl = makeSandbox({ bridge: true, online: false });
    const ctxOff = vm.createContext(offl.sandbox);
    try {
      for (let i = 0; i < scripts.length; i++) vm.runInContext(scripts[i], ctxOff, { filename: 'offline-' + i + '.js', timeout: 8000 });
      await sleep(250);
    } catch (e) { check('offline boot does not throw', false, e && e.stack); }
    const OF = offl.window.NODEPULSE;
    check('an offline page asks no host at all',
      fetchLog.length === fetches && bridgeCalls.length === bridges,
      (fetchLog.length - fetches) + ' fetch / ' + (bridgeCalls.length - bridges) + ' bridge');
    let r = 'pending';
    await OF.loadTip().then(() => { r = 'ok'; }, () => { r = 'err'; });
    check('an offline request fails at once instead of timing out',
      r === 'err' && fetchLog.length === fetches, r + ' ' + (fetchLog.length - fetches));
    check('the offline page still shows the bundled snapshot',
      !!OF.state.l1 && OF.state.l1.src === 'snapshot', OF.state.l1 && OF.state.l1.src);
  }

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
    check('offline panel labels the snapshot', off.els.note.innerHTML.indexOf('built-in snapshot') > 0,
      off.els.note.innerHTML.slice(0, 100));
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

  /* ---- one long frame must not fling the globe ----
     Inertia used the raw frame delta, which is unbounded: after a stall — a GC pause, a
     tab coming back, the first frame after the globe restarts — a single step moved the
     globe by hundreds of frames' worth of velocity. dt is clamped to 50 ms, so the same
     stall coasts at most three frames' worth. */
  {
    const g = NP.globe;
    runFrames(rafQueue, 1);
    const t0 = 100000;
    g.lastTs = t0;
    g.vYaw = 0.6;
    g.dragging = false;
    g.hold = false;
    const yaw0 = g.yaw;
    const fns = rafQueue.splice(0, rafQueue.length);
    fns.forEach(fn => fn(t0 + 5000));            // one five-second frame
    const moved = Math.abs(g.yaw - yaw0);
    check('a five-second frame coasts a few frames of inertia, not hundreds',
      moved < 0.6 * 4, moved.toFixed(3) + ' rad');
    check('the inertia is damped by that frame, not amplified',
      Math.abs(g.vYaw) < 0.6, g.vYaw);
    g.vYaw = 0;
    g.lastTs = 0;                                 // let the next frame re-anchor
    runFrames(rafQueue, 1);
  }

  /* ======================================================================
     v1.1.12 — the saved snapshot, the L1 label, the shell back gesture, the
     landscape layout, the graph path and the module split.
     ====================================================================== */

  /* ---- a poisoned node snapshot is re-typed field by field ----------------
     localStorage is writable by anything that ever ran on this origin and JSON.parse
     returns whatever the string held. A node used to be accepted when its key and two
     coordinates were numbers and everything else in it was copied as it stood, so a
     string channel count, an object capacity, a string in the tor flag, an object in
     the alias or a number in the peers list reached the detail card and the globe. */
  {
    const PK1 = cachedNodes[0].pk, PK2 = cachedNodes[1].pk;
    const poison = {
      t: Date.now(), rows: 7773, chanAt: Date.now(),
      links: [['aa', 'bb'], [PK1, PK1], 5, null, [PK1, PK2], ['z'.repeat(66), PK2]],
      geo: { [PK1]: { lat: 'x', lon: 2, alias: { a: 1 } }, evil: { lat: 1, lon: 2 }, [PK2]: { lat: 10, lon: 20, alias: 'GEO' } },
      nodes: [7, null, { pk: 'nothex', lat: 1, lon: 2 }, { pk: PK1, lat: '12', lon: 2 },
        {
          pk: PK2, lat: 10, lon: 20, alias: { x: 1 }, channels: '12', capacity: { a: 1 }, tor: 'yes',
          peers: [1, { a: 1 }, 'Alias-k'], deg: 'x', sockets: [], iso: 'KOR', firstSeen: 'x',
          updatedAt: {}, city: 5, country: [], asOrg: {}, channelsSrc: 'evil', tag: 'evil'
        }]
    };
    ls = new Map([['nodepulse.nodes.v2', JSON.stringify(poison)]]);
    const sb = makeSandbox({ bridge: false });
    const c = vm.createContext(sb.sandbox);
    const mode = fetchMode; fetchMode = 'fail';
    let threw = null;
    try {
      for (let i = 0; i < scripts.length; i++) vm.runInContext(scripts[i], c, { filename: 'poison-node-' + i + '.js', timeout: 8000 });
      await sleep(400);
      runFrames(sb.rafQueue, 2);
    } catch (e) { threw = e; }
    fetchMode = mode;
    const NS = sb.window.NODEPULSE && sb.window.NODEPULSE.state;
    check('a poisoned node snapshot does not throw on boot', !threw, threw && threw.stack);
    check('only a cached node with a real key and coordinates survives',
      !!NS && NS.nodes.length === 1 && NS.nodes[0].pk === PK2, NS && NS.nodes.length);
    const n0 = NS && NS.nodes[0];
    check('a cached node carries a string alias',
      !!n0 && typeof n0.alias === 'string' && n0.alias === PK2.slice(0, 10), n0 && String(n0.alias));
    check('a cached string channel count is not adopted', !!n0 && n0.channels === null, n0 && String(n0.channels));
    check('a cached object capacity is not adopted', !!n0 && n0.capacity === null, n0 && String(n0.capacity));
    check('a cached non-boolean tor flag is not adopted', !!n0 && n0.tor === false, n0 && String(n0.tor));
    check('cached peers keep only their string entries',
      !!n0 && Array.isArray(n0.peers) && n0.peers.length === 1 && n0.peers[0] === 'Alias-k', n0 && JSON.stringify(n0.peers));
    check('cached numeric fields keep only finite counts',
      !!n0 && n0.deg === 0 && n0.sockets === 0 && n0.firstSeen === 0 && n0.updatedAt === 0,
      n0 && JSON.stringify({ deg: n0.deg, sockets: n0.sockets, firstSeen: n0.firstSeen }));
    check('a cached ISO code is two upper-case letters', !!n0 && n0.iso === 'KO', n0 && n0.iso);
    check('cached text fields are strings or empty',
      !!n0 && n0.city === '' && n0.country === '' && n0.asOrg === '' && n0.channelsSrc === '',
      n0 && JSON.stringify({ city: n0.city, country: n0.country, asOrg: n0.asOrg }));
    check('a cached tag outside the known set is not adopted', !!n0 && n0.tag === 'cache', n0 && n0.tag);
    check('only a link between two real, different keys survives the cache',
      !!NS && NS.links.length === 1 && NS.links[0][0] === PK1 && NS.links[0][1] === PK2, NS && NS.links.length);
    const PNP = sb.window.NODEPULSE;
    if (PNP) {
      PNP.layer('ln');
      PNP.openNode(0);
      const cardHTML = sb.els.card.innerHTML;
      check('a cached node card prints no object and no NaN',
        cardHTML.indexOf('[object Object]') < 0 && cardHTML.indexOf('NaN') < 0, cardHTML.slice(0, 160));
    } else check('a cached node card prints no object and no NaN', false, 'no test hook');
  }

  /* ---- the price cache is re-typed too ----------------------------------- */
  {
    ls = new Map([['nodepulse.cache.v2', JSON.stringify({
      t: Date.now(), tip: 812345,
      diff: { difficultyChange: 1.5, remainingBlocks: '7', estimatedRetargetDate: { evil: 1 } },
      fees: { fastestFee: 7, halfHourFee: '3', hourFee: { a: 1 } },
      mem: { count: 5, vsize: 1000, totalFee: 3 },
      countries: [{ iso: 'KR', count: 1, capacity: { a: 1 } }, { iso: 'US', count: 'x' }]
    })]]);
    const sb = makeSandbox({ bridge: false });
    const c = vm.createContext(sb.sandbox);
    const mode = fetchMode; fetchMode = 'fail';
    let threw = null;
    try {
      for (let i = 0; i < scripts.length; i++) vm.runInContext(scripts[i], c, { filename: 'poison-price-' + i + '.js', timeout: 8000 });
      await sleep(350);
      runFrames(sb.rafQueue, 2);
    } catch (e) { threw = e; }
    fetchMode = mode;
    const PS = sb.window.NODEPULSE && sb.window.NODEPULSE.state;
    check('a poisoned price cache does not throw on boot', !threw, threw && threw.stack);
    check('a cached retarget keeps only its own types',
      !!PS && PS.diff && PS.diff.difficultyChange === 1.5 && PS.diff.remainingBlocks === null &&
      PS.diff.estimatedRetargetDate === null, PS && JSON.stringify(PS.diff));
    check('a cached fee row keeps only finite figures',
      !!PS && PS.fees && PS.fees.fastestFee === 7 && PS.fees.halfHourFee === undefined && PS.fees.hourFee === undefined,
      PS && JSON.stringify(PS.fees));
    check('a cached country row needs a finite count',
      !!PS && PS.countries.length === 1 && PS.countries[0].iso === 'KR' && PS.countries[0].capacity === 0,
      PS && JSON.stringify(PS.countries));
  }

  /* ---- the L1 layer says which kind of answer it is showing -------------- */
  {
    ls = new Map();
    const sb = makeSandbox({ bridge: false });
    const c = vm.createContext(sb.sandbox);
    let threw = null;
    try {
      for (let i = 0; i < scripts.length; i++) vm.runInContext(scripts[i], c, { filename: 'cors-' + i + '.js', timeout: 8000 });
      await sleep(600);
      runFrames(sb.rafQueue, 2);
    } catch (e) { threw = e; }
    const B = sb.window.NODEPULSE;
    check('a browser boot does not throw', !threw, threw && threw.stack);
    check('a browser that cannot read bitnodes is left with the snapshot',
      !!B && B.state.l1.src === 'snapshot' && B.state.l1.why === 'cors' && B.state.l1Off === true,
      B && (B.state.l1.src + '/' + B.state.l1.why + '/' + B.state.l1Off));
    check('the row under the title marks the static snapshot',
      /SNAPSHOT/.test(sb.els.subrow.textContent) && /CORS/.test(sb.els.subrow.textContent), sb.els.subrow.textContent);
    check('the legend marks static coordinates', /static snapshot/.test(sb.els.legend.innerHTML), sb.els.legend.innerHTML.slice(0, 120));
    if (B) B.panel(true);
    check('the L1 tag is not LIVE in that browser', sb.els.l1Tag.textContent === 'SNAPSHOT', sb.els.l1Tag.textContent);
    check('the L1 freshness row names the CORS block',
      /CORS/.test(sb.els.pL1Fresh.innerHTML) && /bridge/.test(sb.els.pL1Fresh.innerHTML), sb.els.pL1Fresh.innerHTML.slice(0, 160));
    check('the country split names its snapshot basis',
      /snapshot/.test(sb.els.distTotal.textContent), sb.els.distTotal.textContent);

    /* the same page with the native bridge is live, and says so */
    check('a bridged L1 read is live and says so', S.l1.src === 'live' && S.l1.why === 'live', S.l1.src + '/' + S.l1.why);
    NP.panel(true);
    check('the live L1 freshness row says live', /live/.test(els.pL1Fresh.innerHTML), els.pL1Fresh.innerHTML.slice(0, 120));
    check('the title row says live for a bridged read', /LIVE/.test(els.subrow.textContent), els.subrow.textContent);
    check('the legend carries no static marker when the dots are live',
      !/static snapshot/.test(els.legend.innerHTML), els.legend.innerHTML.slice(0, 120));
    NP.panel(false);
  }

  /* ---- the shell back gesture closes the page's own layers first ---------- */
  {
    ls = new Map();
    const sb = makeSandbox({ bridge: true });
    const depths = [];
    sb.window.NPBack = { setDepth(d) { depths.push(d); } };
    const c = vm.createContext(sb.sandbox);
    let threw = null;
    try {
      for (let i = 0; i < scripts.length; i++) vm.runInContext(scripts[i], c, { filename: 'back-' + i + '.js', timeout: 8000 });
      await sleep(500);
      runFrames(sb.rafQueue, 2);
    } catch (e) { threw = e; }
    const W = sb.window, B = W.NODEPULSE;
    check('a sandbox with a back signal boots', !threw && !!B, threw && threw.stack);
    if (B) {
      B.openNode(0);
      check('an open node card reports depth 2 to the shell', depths[depths.length - 1] === 2, depths.join(','));
      check('the shell back call closes the card first',
        W.NodepulseBack() === true && sb.els.modal.classList.contains('on') === false);
      check('closing the card returns the depth to 0', depths[depths.length - 1] === 0, depths.join(','));
      B.panel(true);
      check('an open panel reports depth 1 to the shell', depths[depths.length - 1] === 1, depths.join(','));
      check('the shell back call closes the panel next',
        W.NodepulseBack() === true && B.state.panelOpen === false);
      check('with nothing open the shell is allowed to leave the app', W.NodepulseBack() === false);
    }
  }

  /* ---- landscape: the globe stops above the toast ------------------------ */
  {
    const g = NP.globe;
    const hudH = els.hud.offsetHeight;
    window.innerWidth = 800; window.innerHeight = 450;
    window.dispatch('resize');
    const toastTop = 450 - (hudH + 14 + 32);
    check('a landscape globe stays above the toast',
      g.cy + g.R <= toastTop + 0.5, 'bottom ' + (g.cy + g.R).toFixed(1) + ' vs toast top ' + toastTop);
    check('the toast offset follows the measured HUD height',
      doc.documentElement.style.getPropertyValue('--toast-bottom') === (hudH + 14) + 'px',
      doc.documentElement.style.getPropertyValue('--toast-bottom'));
    check('the hint rides above the toast on the same measure',
      doc.documentElement.style.getPropertyValue('--hint-bottom') === (hudH + 62) + 'px',
      doc.documentElement.style.getPropertyValue('--hint-bottom'));
    check('the globe keeps a usable size in landscape', g.R >= 56 && g.R < 200, g.R.toFixed(1));
    window.innerWidth = 400; window.innerHeight = 860;
    window.dispatch('resize');
    check('portrait keeps the globe above the toast too',
      g.cy + g.R <= 860 - (hudH + 14 + 32) + 0.5, (g.cy + g.R).toFixed(1));
  }

  /* ---- the channels-geo graph path --------------------------------------- */
  {
    const r = NP.graph(CHGEO);
    check('the channels-geo graph keeps its real shape',
      r.nodes > 1000 && r.picked > 0 && r.picked <= 22 && r.links > 0,
      JSON.stringify({ nodes: r.nodes, picked: r.picked, links: r.links }));
    /* A wide ceiling: the parse and the pick are a few milliseconds of real work, and
       this only has to catch a return of the old quadratic walk, not a slow machine. */
    check('the graph path stays inside its budget', r.ms < 2000, r.ms + 'ms');
    console.log('graph: ' + r.ms + 'ms for ' + CHGEO.length + ' rows → ' + r.nodes + ' nodes, ' +
      r.picked + ' picked, ' + r.links + ' links');
  }

  /* ---- the application is one script block assembled from modules -------- */
  {
    const files = fs.readdirSync(path.join(ROOT, 'src', 'js')).sort();
    check('the application is split into numbered modules',
      files.length === 11 && files[0] === '00-core.js' && files[10] === '90-boot.js', files.join(','));
    check('src/app.js is gone, so no second copy can drift', !fs.existsSync(path.join(ROOT, 'src', 'app.js')));
    const appBlock = blockBodies[6] || '';
    const notes = ['Core:', 'Network:', 'Market:', 'Bitcoin L1:', 'Lightning graph:', 'Saved answers:',
      'Live feeds', 'UI painting:', 'Globe:', 'Cards and view state:', 'Boot:'];
    check('every module is inside the one script block',
      notes.every(k => appBlock.indexOf('/* ' + k) >= 0),
      notes.filter(k => appBlock.indexOf('/* ' + k) < 0).join(','));
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
