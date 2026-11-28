/* Globe: the Canvas 2D orthographic renderer, its two palettes, the hit test and the
   pointer handling. build.py inlines every module into one script block in this order. */

  /* ---------------------------------------------------------------- globe */
  /* Two palettes, one renderer. The L1 identity is the original cyan / deep blue;
     Lightning is electric violet. Every colour the globe draws comes from here. */
  var THEME = {
    l1: {
      body: [[0, 'rgba(20,46,96,0.52)'], [0.30, 'rgba(10,26,58,0.66)'], [0.66, 'rgba(6,16,38,0.82)'], [0.90, 'rgba(3,9,22,0.92)'], [1, 'rgba(2,6,16,0.96)']],
      rim: [[0, 'rgba(4,10,22,0)'], [0.70, 'rgba(3,9,22,0.14)'], [0.92, 'rgba(6,22,48,0.30)'], [0.978, 'rgba(38,140,225,0.20)'], [1, 'rgba(125,211,252,0.12)']],
      at1: [[0, 'rgba(150,215,255,0.40)'], [0.35, 'rgba(56,170,255,0.13)'], [1, 'rgba(56,150,255,0)']],
      at2: [[0, 'rgba(56,145,255,0.10)'], [0.45, 'rgba(40,110,220,0.04)'], [1, 'rgba(40,110,220,0)']],
      hi: 'rgba(150,210,255,0.055)',
      rimLine: 'rgba(140,214,255,0.44)', rimLine2: 'rgba(56,189,248,0.12)',
      land: 'rgba(37,99,235,0.14)', coast: 'rgba(150,214,255,0.5)', coastGlow: 'rgba(56,160,250,0.18)',
      grid: 'rgba(76,140,225,0.09)', gridBack: 'rgba(56,110,190,0.032)', equator: 'rgba(90,164,244,0.15)',
      dot: '226,246,255', halo: '120,205,255', arc: '110,190,255', packet: '80,165,255',
      glow: ['rgba(226,246,255,0.95)', 'rgba(140,215,255,0.60)', 'rgba(56,165,255,0.20)', 'rgba(56,150,255,0.055)', 'rgba(56,150,255,0)']
    },
    ln: {
      body: [[0, 'rgba(48,38,98,0.52)'], [0.30, 'rgba(26,21,60,0.66)'], [0.66, 'rgba(15,12,40,0.82)'], [0.90, 'rgba(8,6,24,0.92)'], [1, 'rgba(4,3,14,0.96)']],
      rim: [[0, 'rgba(8,6,20,0)'], [0.70, 'rgba(6,5,18,0.14)'], [0.92, 'rgba(22,16,56,0.30)'], [0.978, 'rgba(139,92,246,0.20)'], [1, 'rgba(196,181,253,0.12)']],
      at1: [[0, 'rgba(208,196,255,0.34)'], [0.35, 'rgba(139,92,246,0.13)'], [1, 'rgba(139,92,246,0)']],
      at2: [[0, 'rgba(139,92,246,0.10)'], [0.45, 'rgba(110,70,220,0.04)'], [1, 'rgba(110,70,220,0)']],
      hi: 'rgba(196,181,253,0.05)',
      rimLine: 'rgba(200,186,255,0.42)', rimLine2: 'rgba(167,139,250,0.12)',
      land: 'rgba(124,92,246,0.15)', coast: 'rgba(206,200,255,0.5)', coastGlow: 'rgba(139,120,250,0.18)',
      grid: 'rgba(140,120,235,0.085)', gridBack: 'rgba(100,85,190,0.030)', equator: 'rgba(160,140,250,0.14)',
      dot: '232,226,255', halo: '170,145,255', arc: '172,150,255', packet: '150,120,255',
      glow: ['rgba(240,236,255,0.95)', 'rgba(198,184,255,0.60)', 'rgba(139,92,246,0.20)', 'rgba(139,92,246,0.055)', 'rgba(139,92,246,0)']
    }
  };
  function TH() { return THEME[S.layer] || THEME.l1; }

  var Globe = (function () {
    var G = {
      cv: null, ctx: null, w: 0, h: 0, dpr: 1, cx: 0, cy: 0, R: 0,
      yaw: -0.35, pitch: 0.36, zoom: 1, zoomT: 1, vYaw: 0,
      spin: 0.045, spinEase: 1, hold: false,
      dragging: false, lastTouch: 0, clusters: [], links: [], arcs: [], flash: 0, ripples: [],
      rings: [], grats: [], raf: 0, lastTs: 0, hit: null,
      bg: null, ball: null, ballSize: 0, glow: null,
      slow: false, ft: 0.016, miss: 0, age: 0, goodMs: 0, stepAt: 0, prevScale: 1, lockScale: 0,
      hide: {}, adaptive: true, resScale: 1, forceFull: false,
      xs: [], ys: [], zs: []
    };
    var P = { x: 0, y: 0, z: 0 };
    var pointers = {}, pinch = null, dragMoved = 0, dragStart = null, pinchHappened = false;

    function normLon(l) { while (l > 180) l -= 360; while (l < -180) l += 360; return l; }

    function decodeRings(str) {
      if (!str) return [];
      var rings = [];
      str.split('|').forEach(function (r) {
        var pts = [], parts = r.split(' ');
        for (var i = 0; i < parts.length; i++) {
          var ab = parts[i].split(',');
          if (ab.length !== 2) continue;
          var lon = parseInt(ab[0], 36) / 10, lat = parseInt(ab[1], 36) / 10;
          if (isFinite(lon) && isFinite(lat)) pts.push([lon, lat]);
        }
        if (pts.length > 2) rings.push(pts);
      });
      return rings;
    }

    function buildGraticule() {
      var g = [];
      for (var lon = -180; lon < 180; lon += 30) {
        var m = [];
        for (var lat = -88; lat <= 88; lat += 4) m.push([lon, lat]);
        g.push(m);
      }
      for (var la = -60; la <= 60; la += 30) {
        var p = [];
        for (var lo = -180; lo <= 180; lo += 4) p.push([lo, la]);
        g.push(p);
      }
      return g;
    }

    function resize() {
      var w = window.innerWidth, h = window.innerHeight;
      G.dpr = Math.min(2, window.devicePixelRatio || 1);
      G.w = w; G.h = h;
      G.hudBox = 0;                 // a new viewport: measure the HUD again
      if (!G.cv) G.cv = $('globe');
      if (!G.cv) return;
      applyRes();
      layout();
      buildBackground();
      buildBall();
    }

    function applyRes() {
      var s = G.dpr * G.resScale;
      var cv = G.cv;
      cv.width = Math.round(G.w * s);
      cv.height = Math.round(G.h * s);
      G.ctx = cv.getContext('2d');
      G.ctx.setTransform(s, 0, 0, s, 0, 0);
      G.ctx.lineCap = 'round';
      G.ctx.lineJoin = 'round';
    }

    function setRes(scale) {
      if (scale === G.resScale || !G.cv) return;
      G.resScale = scale;
      applyRes();
    }

    /* The toast and the hint sit above the HUD, and the HUD's measured height is what
       decides where that is: the two fixed offsets (148px, 196px) were right for one HUD
       size only, so on a short screen the toast dropped into the middle of the globe.
       The globe itself gets the room between the topbar and the toast's top edge. The old
       layout reserved a floor of 200px whatever the screen — at 450px tall in landscape
       that floor was larger than the space there was, and the sphere was drawn behind the
       toast. The floor is now the toast line, and a small minimum keeps the globe visible
       on a very short viewport instead of letting it vanish. */
    var TOAST_GAP = 14, TOAST_H = 32, HINT_GAP = 62, MIN_BOX = 120, MIN_R = 56;
    /* Zoom: 1 is the globe at its laid-out radius, 5.8 is close enough to read a city-sized
       patch of coastline on a phone. The ceiling was 2.2, which made a pinch feel like it
       had stopped working after the second gesture. The floor stays below 1 so the whole
       sphere can still be pulled away from the edge of a short screen. */
    var ZOOM_MIN = 0.8, ZOOM_MAX = 5.8;
    /* Dragging rotates the globe by the angle under the finger: at 5.8× every pixel is
       5.8× less of the sphere, so the same drag must turn it proportionally less or the
       world flies past. The idle spin and the inertia follow the same factor. */
    var DRAG_YAW = 0.0072, DRAG_PITCH = 0.0045, DRAG_V = 0.00025;
    /* A finger is about 40 px wide. The hit radius was 26 px at every zoom, which is a
       miss-and-try-again target once the dots are spread apart, so it grows with the zoom
       and never drops below 28 px. */
    var HIT_MIN = 28, HIT_ZOOM = 3.4;

    function setVar(name, px) {
      var el = document.documentElement;
      if (el && el.style && typeof el.style.setProperty === 'function') el.style.setProperty(name, Math.round(px) + 'px');
    }

    function layout() {
      var w = G.w, h = G.h;
      var head = document.querySelector('.topbar .head');
      var layers = document.querySelector('.layers');
      var sub = document.querySelector('.subrow');
      var hud = document.querySelector('.hud');
      var topH = (head ? head.offsetHeight : 56) + (layers ? layers.offsetHeight : 28) + (sub ? sub.offsetHeight : 18) + 16;
      /* The HUD's height is measured once per viewport and then kept. Measuring it on
         every layer switch moved the globe's centre and radius by the few pixels the
         legend or the strip happened to need in that tab — a visible jump for a change
         that has nothing to do with the globe. resize() clears the reservation, so a
         rotation, a window resize or a keyboard still gets a fresh measure. */
      if (!(G.hudBox > 0)) G.hudBox = hud ? hud.offsetHeight : 150;
      var hudH = G.hudBox;
      var toastTop = h - (hudH + TOAST_GAP + TOAST_H);
      var box = Math.max(MIN_BOX, toastTop - topH);
      G.cx = w / 2;
      G.cy = topH + box * 0.50;
      G.R = Math.max(MIN_R, Math.min(w * 0.44, box * 0.46));
      if (h > w * 1.6) G.cy = topH + box * 0.52;
      setVar('--toast-bottom', hudH + TOAST_GAP);
      setVar('--hint-bottom', hudH + HINT_GAP);
    }

    function buildBackground() {
      var cv = document.createElement('canvas');
      cv.width = Math.round(G.w * G.dpr);
      cv.height = Math.round(G.h * G.dpr);
      var c = cv.getContext('2d');
      c.setTransform(G.dpr, 0, 0, G.dpr, 0, 0);
      var n = Math.round(Math.min(220, Math.max(110, G.w * G.h / 4800)));
      for (var i = 0; i < n; i++) {
        var x = Math.random() * G.w, y = Math.random() * G.h;
        var big = Math.random() > 0.88;
        var r = big ? 1.2 + Math.random() * 0.8 : 0.45 + Math.random() * 0.6;
        c.globalAlpha = 0.18 + Math.random() * 0.5;
        c.fillStyle = i % 11 === 0 ? (S.layer === 'l1' ? '#9fd0ff' : '#c9b6ff') : (S.layer === 'l1' ? '#cfe4ff' : '#e4deff');
        if (big) { c.beginPath(); c.arc(x, y, r * 0.7, 0, TAU); c.fill(); }
        else c.fillRect(x, y, r, r);
      }
      c.globalAlpha = 1;
      G.bg = cv;
      buildGlow();
    }

    function buildGlow() {
      var th = TH(), g = th.glow, size = 64;
      var cv = document.createElement('canvas');
      cv.width = cv.height = size;
      var c = cv.getContext('2d');
      var grd = c.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      grd.addColorStop(0, g[0]);
      grd.addColorStop(0.16, g[1]);
      grd.addColorStop(0.42, g[2]);
      grd.addColorStop(0.70, g[3]);
      grd.addColorStop(1, g[4]);
      c.fillStyle = grd;
      c.fillRect(0, 0, size, size);
      G.glow = cv;
    }

    function buildBall() {
      var th = TH();
      var R = Math.max(40, G.R);
      var pad = 1.30, s = Math.ceil(R * 2 * pad);
      var cv = document.createElement('canvas');
      cv.width = Math.ceil(s * G.dpr);
      cv.height = Math.ceil(s * G.dpr);
      var c = cv.getContext('2d');
      c.setTransform(G.dpr, 0, 0, G.dpr, 0, 0);
      var cx = s / 2, cy = s / 2;

      var body = c.createRadialGradient(cx - R * 0.40, cy - R * 0.46, R * 0.04, cx, cy, R * 1.04);
      th.body.forEach(function (st) { body.addColorStop(st[0], st[1]); });
      c.beginPath(); c.arc(cx, cy, R, 0, TAU); c.fillStyle = body; c.fill();

      var rim = c.createRadialGradient(cx, cy, R * 0.52, cx, cy, R);
      th.rim.forEach(function (st) { rim.addColorStop(st[0], st[1]); });
      c.beginPath(); c.arc(cx, cy, R, 0, TAU); c.fillStyle = rim; c.fill();

      c.globalCompositeOperation = 'lighter';
      var at1 = c.createRadialGradient(cx, cy, R * 0.99, cx, cy, R * 1.075);
      th.at1.forEach(function (st) { at1.addColorStop(st[0], st[1]); });
      c.beginPath();
      c.arc(cx, cy, R * 1.075, 0, TAU);
      c.arc(cx, cy, R * 0.99, 0, TAU, true);
      c.fillStyle = at1; c.fill();

      var at2 = c.createRadialGradient(cx, cy, R, cx, cy, R * 1.28);
      th.at2.forEach(function (st) { at2.addColorStop(st[0], st[1]); });
      c.beginPath();
      c.arc(cx, cy, R * 1.28, 0, TAU);
      c.arc(cx, cy, R, 0, TAU, true);
      c.fillStyle = at2; c.fill();

      var hi = c.createRadialGradient(cx - R * 0.42, cy - R * 0.48, 0, cx - R * 0.42, cy - R * 0.48, R * 0.58);
      hi.addColorStop(0, th.hi);
      hi.addColorStop(1, 'rgba(255,255,255,0)');
      c.beginPath(); c.arc(cx, cy, R, 0, TAU); c.fillStyle = hi; c.fill();
      c.globalCompositeOperation = 'source-over';

      c.beginPath(); c.arc(cx, cy, R, 0, TAU);
      c.strokeStyle = th.rimLine; c.lineWidth = 1.05; c.stroke();
      c.beginPath(); c.arc(cx, cy, R - 1.2, 0, TAU);
      c.strokeStyle = th.rimLine2; c.lineWidth = 2.4; c.stroke();

      G.ball = cv;
      G.ballSize = s;
    }

    function project(lat, lon, o) {
      var la = lat * DEG, lo = lon * DEG - G.yaw;
      var cl = Math.cos(la), sl = Math.sin(la);
      var x = cl * Math.sin(lo), y = sl, z = cl * Math.cos(lo);
      var cp = Math.cos(G.pitch), sp = Math.sin(G.pitch);
      var y1 = y * cp - z * sp, z1 = y * sp + z * cp;
      var R = G.R * G.zoom;
      o.x = G.cx + x * R; o.y = G.cy - y1 * R; o.z = z1;
      return o;
    }

    function drawStars() {
      if (G.bg) G.ctx.drawImage(G.bg, 0, 0, G.w, G.h);
    }

    function drawSphere() {
      if (!G.ball) return;
      var size = G.ballSize * G.zoom;
      G.ctx.drawImage(G.ball, G.cx - size / 2, G.cy - size / 2, size, size);
    }

    function prepRing(ring) {
      var pts = [], brk = [], prev = null;
      for (var i = 0; i < ring.length; i++) {
        var lon = ring[i][0], lat = ring[i][1];
        var la = lat * DEG, lo = lon * DEG;
        pts.push(Math.cos(la), Math.sin(la), Math.sin(lo), Math.cos(lo));
        brk.push(prev !== null && Math.abs(lon - prev) > 180 ? 1 : 0);
        prev = lon;
      }
      return { p: pts, b: brk, n: ring.length, xs: new Array(ring.length), ys: new Array(ring.length),
        zs: new Array(ring.length), ox: new Array(ring.length), oy: new Array(ring.length), max: 0, min: 0 };
    }

    function projectRing(r, cam) {
      var p = r.p, n = r.n, xs = r.xs, ys = r.ys, zs = r.zs, ox = r.ox, oy = r.oy;
      var syw = cam.syw, cyw = cam.cyw, cp = cam.cp, sp = cam.sp;
      var R = cam.R, cx = cam.cx, cy = cam.cy, max = -2, min = 2;
      for (var i = 0, k = 0; k < n; i += 4, k++) {
        var cl = p[i], sl = p[i + 1], slon = p[i + 2], clon = p[i + 3];
        var x = cl * (slon * cyw - clon * syw);
        var z0 = cl * (clon * cyw + slon * syw);
        var z1 = sl * sp + z0 * cp;
        ox[k] = x * R;
        oy[k] = -(sl * cp - z0 * sp) * R;
        xs[k] = cx + ox[k];
        ys[k] = cy + oy[k];
        zs[k] = z1;
        if (z1 > max) max = z1;
        if (z1 < min) min = z1;
      }
      r.max = max; r.min = min;
    }

    function runPath(r, ctx, wantFront, close) {
      var n = r.n, xs = r.xs, ys = r.ys, zs = r.zs, brk = r.b;
      var startIdx = -1, any = false, k;
      for (k = 0; k < n; k++) {
        var vis = wantFront ? (zs[k] > 0) : (zs[k] <= 0);
        if (vis && !brk[k]) {
          if (startIdx < 0) startIdx = k;
        } else {
          if (startIdx >= 0 && k - 1 > startIdx) { emit(startIdx, k - 1, ctx, xs, ys, close); any = true; }
          startIdx = (vis && brk[k]) ? k : -1;
        }
      }
      if (startIdx >= 0 && n - 1 > startIdx) { emit(startIdx, n - 1, ctx, xs, ys, close); any = true; }
      return any;
    }

    function fillRing(r, ctx) {
      var n = r.n, zs = r.zs, ox = r.ox, oy = r.oy, cam = G.cam;
      var cx = cam.cx, cy = cam.cy, k, front = 0, start = -1;
      for (k = 0; k < n; k++) {
        if (zs[k] >= 0) {
          front++;
          if (start < 0 && zs[(k + n - 1) % n] < 0) start = k;
        }
      }
      if (!front) return false;
      if (start < 0) {
        ctx.moveTo(cx + ox[0], cy + oy[0]);
        for (k = 1; k < n; k++) ctx.lineTo(cx + ox[k], cy + oy[k]);
        ctx.closePath();
        return true;
      }
      var t = 0, sx, sy;
      while (t < n) {
        while (t < n && zs[(start + t) % n] < 0) t++;
        if (t >= n) break;
        sx = 0; sy = 0;
        var i0 = (start + t) % n;
        while (t < n && zs[(start + t) % n] >= 0) {
          var ii = (start + t) % n;
          sx += ox[ii]; sy += oy[ii];
          t++;
        }
        fillRun(r, ctx, i0, (start + t - 1) % n, sx, sy);
      }
      return true;
    }

    function fillRun(r, ctx, i0, i1, sx, sy) {
      var n = r.n, ox = r.ox, oy = r.oy, zs = r.zs, cam = G.cam;
      var cx = cam.cx, cy = cam.cy, R = cam.R, i;
      var b = (i0 + n - 1) % n, a = (i1 + 1) % n;
      var e = crossing(ox[b], oy[b], zs[b], ox[i0], oy[i0], zs[i0]);
      var x = crossing(ox[i1], oy[i1], zs[i1], ox[a], oy[a], zs[a]);
      var aE = Math.atan2(x[1], x[0]), aI = Math.atan2(e[1], e[0]);
      var mean = Math.atan2(sy, sx);
      ctx.moveTo(cx + e[0], cy + e[1]);
      for (i = i0; ; i = (i + 1) % n) {
        ctx.lineTo(cx + ox[i], cy + oy[i]);
        if (i === i1) break;
      }
      var ccw = (aI - aE + TAU) % TAU;
      var span = angTo(aE + ccw / 2, mean) <= angTo(aE + (ccw + TAU) / 2, mean) ? ccw : TAU - ccw;
      var dir = span === ccw ? 1 : -1;
      var steps = Math.max(2, Math.ceil(span / 0.12));
      for (i = 1; i <= steps; i++) {
        var ang = aE + dir * span * (i / steps);
        ctx.lineTo(cx + Math.cos(ang) * R, cy + Math.sin(ang) * R);
      }
      ctx.closePath();
    }

    function crossing(x0, y0, z0, x1, y1, z1) {
      var t = z0 / (z0 - z1);
      if (!(t >= 0)) t = 0; else if (t > 1) t = 1;
      return [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t];
    }

    function angTo(p, q) { return Math.abs((((p - q) % TAU) + TAU + Math.PI) % TAU - Math.PI); }

    function emit(a, b, ctx, xs, ys, close) {
      ctx.moveTo(xs[a], ys[a]);
      for (var j = a + 1; j <= b; j++) ctx.lineTo(xs[j], ys[j]);
      if (close) ctx.closePath();
    }

    function drawGraticule() {
      var th = TH(), cam = G.cam, ctx = G.ctx, i, r, list = G.gratsP, anyFront = false, anyBack = false;
      for (i = 0; i < list.length; i++) projectRing(list[i], cam);

      if (!G.slow) {
        ctx.beginPath();
        for (i = 0; i < list.length; i++) {
          r = list[i];
          if (r.max <= 0) continue;
          if (runPath(r, ctx, false, false)) anyBack = true;
        }
        if (anyBack) { ctx.strokeStyle = th.gridBack; ctx.lineWidth = 0.6; ctx.stroke(); }
      }

      ctx.beginPath();
      for (i = 0; i < list.length; i++) {
        r = list[i];
        if (r.max <= 0) continue;
        if (runPath(r, ctx, true, false)) anyFront = true;
      }
      if (anyFront) { ctx.strokeStyle = th.grid; ctx.lineWidth = 0.6; ctx.stroke(); }

      var eq = list[list.length - 3];
      if (eq && eq.max > 0) {
        ctx.beginPath();
        if (runPath(eq, ctx, true, false)) {
          ctx.strokeStyle = th.equator; ctx.lineWidth = 0.8; ctx.stroke();
        }
      }
    }

    function drawLand() {
      var th = TH(), cam = G.cam, ctx = G.ctx, i, r, list = G.ringsP, anyFill = false, anyLine = false;
      for (i = 0; i < list.length; i++) projectRing(list[i], cam);

      if (!G.slow && !G.hide.landFill) {
        ctx.beginPath();
        for (i = 0; i < list.length; i++) {
          r = list[i];
          if (r.max <= 0) continue;
          if (fillRing(r, ctx)) anyFill = true;
        }
        if (anyFill) { ctx.fillStyle = th.land; ctx.fill(); }
      }

      ctx.beginPath();
      for (i = 0; i < list.length; i++) {
        r = list[i];
        if (r.max <= 0) continue;
        if (runPath(r, ctx, true, false)) anyLine = true;
      }
      if (anyLine && !G.hide.landStroke) {
        if (!G.slow && !G.hide.landGlow) {
          ctx.strokeStyle = th.coastGlow; ctx.lineWidth = 2.2; ctx.stroke();
        }
        ctx.strokeStyle = th.coast; ctx.lineWidth = 0.8; ctx.stroke();
      }
    }

    function vec(lat, lon) {
      var la = lat * DEG, lo = lon * DEG;
      return [Math.cos(la) * Math.sin(lo), Math.sin(la), Math.cos(la) * Math.cos(lo)];
    }
    function slerpPoint(a, b, t) {
      var A = vec(a.lat, a.lon), B = vec(b.lat, b.lon);
      var dot = Math.max(-1, Math.min(1, A[0] * B[0] + A[1] * B[1] + A[2] * B[2]));
      var om = Math.acos(dot);
      if (om < 1e-6) return { lat: a.lat, lon: a.lon };
      var so = Math.sin(om);
      var w1 = Math.sin((1 - t) * om) / so, w2 = Math.sin(t * om) / so;
      var x = w1 * A[0] + w2 * B[0], y = w1 * A[1] + w2 * B[1], z = w1 * A[2] + w2 * B[2];
      var lat = Math.asin(Math.max(-1, Math.min(1, y))) / DEG;
      var lon = Math.atan2(x, z) / DEG;
      return { lat: lat, lon: lon };
    }

    function buildArcs() {
      var cs = G.clusters, out = [], i;
      for (i = 0; i < G.links.length; i++) {
        var a = cs[G.links[i][0]], b = cs[G.links[i][1]];
        if (!a || !b) continue;
        var dist = Math.abs(a.lat - b.lat) + Math.abs(((b.lon - a.lon + 540) % 360) - 180);
        var N = Math.max(12, Math.min(32, Math.round(dist / 2.2)));
        var path = [];
        for (var s = 0; s <= N; s++) {
          var p = slerpPoint(a, b, s / N);
          var la = p.lat * DEG, lo = p.lon * DEG;
          path.push(Math.cos(la), Math.sin(la), Math.sin(lo), Math.cos(lo));
        }
        out.push({
          p: path, n: N + 1, seed: (i * 0.137) % 1,
          xs: new Array(N + 1), ys: new Array(N + 1), zs: new Array(N + 1), max: 0
        });
      }
      G.arcs = out;
    }

    function projectArc(arc, cam) {
      var p = arc.p, n = arc.n, xs = arc.xs, ys = arc.ys, zs = arc.zs;
      var syw = cam.syw, cyw = cam.cyw, cp = cam.cp, sp = cam.sp;
      var R = cam.R, cx = cam.cx, cy = cam.cy, max = -2;
      for (var i = 0, k = 0; k < n; i += 4, k++) {
        var cl = p[i], sl = p[i + 1], slon = p[i + 2], clon = p[i + 3];
        var x = cl * (slon * cyw - clon * syw);
        var z0 = cl * (clon * cyw + slon * syw);
        var z1 = sl * sp + z0 * cp;
        xs[k] = cx + x * R;
        ys[k] = cy - (sl * cp - z0 * sp) * R;
        zs[k] = z1;
        if (z1 > max) max = z1;
      }
      arc.max = max;
    }

    function smooth(t) { return t * t * (3 - 2 * t); }

    function drawArcs(t) {
      var th = TH(), ctx = G.ctx, cam = G.cam, boost = G.flash, arcs = G.arcs, glow = G.glow;
      if (!arcs.length) return;
      var frontA = 0.33 + 0.30 * boost;
      var bands = G.slow ? 2 : 3;
      var i, arc, k, n;

      for (i = 0; i < arcs.length; i++) projectArc(arcs[i], cam);

      for (var b = 0; b < bands; b++) {
        var lo = b / bands, hi = (b + 1) / bands, a = smooth((lo + hi) / 2);
        ctx.beginPath();
        var any = false;
        for (i = 0; i < arcs.length; i++) {
          arc = arcs[i];
          if (arc.max <= 0) continue;
          var xs = arc.xs, ys = arc.ys, zs = arc.zs;
          n = arc.n;
          var started = false;
          for (k = 1; k < n; k++) {
            var zm = (zs[k - 1] + zs[k]) * 0.5;
            if (zm <= 0 || zm < lo || zm >= hi) { started = false; continue; }
            if (!started) { ctx.moveTo(xs[k - 1], ys[k - 1]); started = true; }
            ctx.lineTo(xs[k], ys[k]);
            any = true;
          }
        }
        if (!any) continue;
        ctx.strokeStyle = 'rgba(' + th.arc + ',' + (frontA * a).toFixed(3) + ')';
        ctx.lineWidth = 0.75;
        ctx.stroke();
      }

      var topLo = (bands - 1) / bands;
      ctx.beginPath();
      var anyTop = false;
      for (i = 0; i < arcs.length; i++) {
        arc = arcs[i];
        if (arc.max <= 0) continue;
        var tx = arc.xs, ty = arc.ys, tz = arc.zs;
        n = arc.n;
        var on = false;
        for (k = 1; k < n; k++) {
          var tm = (tz[k - 1] + tz[k]) * 0.5;
          if (tm <= topLo) { on = false; continue; }
          if (!on) { ctx.moveTo(tx[k - 1], ty[k - 1]); on = true; }
          ctx.lineTo(tx[k], ty[k]);
          anyTop = true;
        }
      }
      if (anyTop && !G.slow && !G.hide.bloom) {
        ctx.strokeStyle = 'rgba(' + th.packet + ',' + (0.035 + 0.05 * boost).toFixed(3) + ')';
        ctx.lineWidth = 2.4;
        ctx.stroke();
      }

      if (!glow || G.hide.packets) return;
      eachPacket(t, function (x, y, size, alpha) {
        ctx.globalAlpha = alpha;
        ctx.drawImage(glow, x - size / 2, y - size / 2, size, size);
      });
      ctx.globalAlpha = 1;
    }

    function eachPacket(t, fn) {
      var arcs = G.arcs, phase = t * 0.085, boost = G.flash, i, q;
      var skip = G.slow ? 2 : 1;
      for (i = 0; i < arcs.length; i++) {
        var arc = arcs[i];
        if ((i % skip) !== 0 || arc.max <= 0) continue;
        var px = arc.xs, py = arc.ys, pz = arc.zs, n = arc.n;
        var tt = (phase + arc.seed) % 1;
        for (q = 0; q <= 2; q++) {
          var at = tt - 0.03 * q;
          if (at < 0) break;
          var u = at * (n - 1), i0 = u | 0, f = u - i0, i1 = i0 + 1 < n ? i0 + 1 : i0;
          var hz = pz[i0] + (pz[i1] - pz[i0]) * f;
          if (hz <= 0.12) break;
          fn(px[i0] + (px[i1] - px[i0]) * f, py[i0] + (py[i1] - py[i0]) * f,
            q === 0 ? 7.5 : 4.6 / q,
            q === 0 ? Math.min(1, 0.55 + 0.45 * boost) : 0.42 / q, i, tt);
        }
      }
    }

    function drawNodes(t) {
      var th = TH(), ctx = G.ctx, glow = G.glow;
      var cl = G.clusters, n = cl.length;
      if (!n) return;
      /* Batched by alpha level. Every dot used to begin its own path and flip
         fillStyle/strokeStyle — two state changes and up to four draw calls per node,
         across a couple of thousand nodes per frame. The alpha each of those calls
         needed is continuous in the limb fade and the pulse, so it is quantised to a
         few levels and the dots of one level share a single path and one fill/stroke;
         the geometry, radii and colours are unchanged. Levels sit in flat [x,y,r]
         triples, and a level with no dots costs nothing. */
      var DOTS = 10, HALOS = 8;
      var dotLv = [], haloLv = [], ringLv = [], i, c, k;
      for (i = 0; i < n; i++) {
        c = cl[i];
        project(c.lat, c.lon, P);
        c.sx = P.x; c.sy = P.y; c.on = P.z > 0.02;
        if (!c.on) continue;
        var edge = Math.min(1, P.z * 4);
        /* Lightning dot size follows its real channel degree; an L1 dot follows how
           many distinct geolocated nodes Bitnodes put in this cell. */
        var r = c.l1
          ? 0.85 + Math.min(1.15, Math.log(1 + (c.count || 1)) / 2.6)
          : 1.15 + Math.min(0.95, Math.log(1 + c.channels) / 8) + (c.count > 1 ? 0.3 : 0);
        var pulse = 0.70 + 0.30 * Math.sin(t * 1.5 + i);

        if (glow) {
          var gs = r * 7.5;
          ctx.globalAlpha = Math.min(1, (0.42 + 0.26 * pulse) * edge + 0.35 * G.flash);
          ctx.drawImage(glow, P.x - gs / 2, P.y - gs / 2, gs, gs);
        }

        k = Math.round(edge * (DOTS - 1));
        if (k > 0) (dotLv[k] || (dotLv[k] = [])).push(P.x, P.y, r);
        k = Math.round(edge * pulse * (HALOS - 1));
        if (k > 0) (haloLv[k] || (haloLv[k] = [])).push(P.x, P.y, r * (1.9 + 0.30 * Math.sin(t * 1.9 + i)));
        if (!c.l1 && c.count > 1) {
          k = Math.round(edge * (HALOS - 1));
          if (k > 0) (ringLv[k] || (ringLv[k] = [])).push(P.x, P.y, r + 2.4);
        }
      }
      if (glow) ctx.globalAlpha = 1;

      var cells, j, x, y, rr;
      for (k = 1; k < DOTS; k++) {
        cells = dotLv[k];
        if (!cells) continue;
        ctx.beginPath();
        for (j = 0; j < cells.length; j += 3) {
          x = cells[j]; y = cells[j + 1]; rr = cells[j + 2];
          ctx.moveTo(x + rr, y);
          ctx.arc(x, y, rr, 0, TAU);
        }
        ctx.fillStyle = 'rgba(' + th.dot + ',' + (0.95 * k / (DOTS - 1)).toFixed(2) + ')';
        ctx.fill();
      }
      ctx.lineWidth = 0.6;
      for (k = 1; k < HALOS; k++) {
        cells = haloLv[k];
        if (!cells) continue;
        ctx.beginPath();
        for (j = 0; j < cells.length; j += 3) {
          x = cells[j]; y = cells[j + 1]; rr = cells[j + 2];
          ctx.moveTo(x + rr, y);
          ctx.arc(x, y, rr, 0, TAU);
        }
        ctx.strokeStyle = 'rgba(' + th.halo + ',' + (0.18 * k / (HALOS - 1)).toFixed(2) + ')';
        ctx.stroke();
      }
      ctx.lineWidth = 0.5;
      for (k = 1; k < HALOS; k++) {
        cells = ringLv[k];
        if (!cells) continue;
        ctx.beginPath();
        for (j = 0; j < cells.length; j += 3) {
          x = cells[j]; y = cells[j + 1]; rr = cells[j + 2];
          ctx.moveTo(x + rr, y);
          ctx.arc(x, y, rr, 0, TAU);
        }
        ctx.strokeStyle = 'rgba(' + th.halo + ',' + (0.24 * k / (HALOS - 1)).toFixed(2) + ')';
        ctx.stroke();
      }
    }

    function drawRipples(dt) {
      var th = TH();
      var ctx = G.ctx;
      var cLat = G.pitch * 180 / Math.PI, cLon = G.yaw * 180 / Math.PI;
      var la1 = cLat * DEG, cos1 = Math.cos(la1), sin1 = Math.sin(la1);
      for (var i = G.ripples.length - 1; i >= 0; i--) {
        var r = G.ripples[i];
        r.t += dt;
        if (r.t > 1.9) { G.ripples.splice(i, 1); continue; }
        var k = r.t / 1.9;
        var ang = 0.05 + k * 2.5;
        var alpha = (1 - k) * 0.55;
        ctx.beginPath();
        var started = false;
        for (var b = 0; b <= 360; b += 4) {
          var br = b * DEG;
          var la2 = Math.asin(Math.max(-1, Math.min(1, sin1 * Math.cos(ang) + cos1 * Math.sin(ang) * Math.cos(br))));
          var lo2 = Math.atan2(Math.sin(br) * Math.sin(ang) * cos1, Math.cos(ang) - sin1 * Math.sin(la2));
          var lon2 = cLon + lo2 / DEG;
          project(la2 * 180 / Math.PI, lon2, P);
          if (P.z > 0.01) {
            if (!started) { ctx.moveTo(P.x, P.y); started = true; }
            else ctx.lineTo(P.x, P.y);
          } else started = false;
        }
        ctx.strokeStyle = 'rgba(' + th.halo + ',' + alpha.toFixed(3) + ')';
        ctx.lineWidth = 1.5 * (1 - k) + 0.35;
        ctx.stroke();
        ctx.strokeStyle = 'rgba(' + th.arc + ',' + (alpha * 0.35).toFixed(3) + ')';
        ctx.lineWidth = 5 * (1 - k) + 0.8;
        ctx.stroke();
      }
    }

    function frame(ts) {
      if (!G.lastTs) G.lastTs = ts;
      var raw = (ts - G.lastTs) / 1000;
      var dt = Math.min(0.05, raw);
      G.lastTs = ts;
      var t = ts / 1000;

      var r = Math.abs(raw);
      G.age += r;
      if (G.age > 1.2) {
        G.miss = G.miss * 0.94 + (r > 0.024 ? 1 : 0) * 0.06;
        G.slow = G.forceFull ? false : G.miss > 0.30;
      }
      if (G.adaptive) {
        if (G.lockScale) {
          if (G.resScale !== G.lockScale) setRes(G.lockScale);
        } else {
          if (G.miss > 0.55 && G.resScale > 0.5) setRes(0.5);
          else if (G.miss > 0.28 && G.resScale > 0.62) setRes(0.62);
          else if (G.miss > 0.10 && G.resScale > 0.75) setRes(0.75);
          if (G.miss < 0.02 && G.resScale < 1) {
            G.goodMs += r;
            if (G.goodMs > 6) {
              G.goodMs = 0;
              G.prevScale = G.resScale;
              G.stepAt = G.age;
              setRes(G.resScale < 0.62 ? 0.62 : G.resScale < 0.75 ? 0.75 : 1);
            }
          } else if (G.miss > 0.04) G.goodMs = 0;
          if (G.stepAt && G.age - G.stepAt < 3 && G.miss > 0.12) {
            G.lockScale = G.prevScale;
            G.stepAt = 0;
            setRes(G.prevScale);
          }
        }
      }

      var want = (!G.dragging && !pinch && !G.hold) ? 1 : 0;
      G.spinEase += (want - G.spinEase) * Math.min(1, dt * 2.0);
      if (!G.dragging && !pinch) {
        /* Inertia runs on dt, not on the raw frame delta: raw is unbounded, so one long
           frame (a first frame after a stall, a GC pause, a tab coming back) moved the
           globe by hundreds of frames' worth of velocity in a single step and it jumped
           to a new angle. dt is clamped to 50 ms, so the same stall coasts at most three
           frames' worth. */
        var k = Math.max(0, dt) / 0.0167;
        G.yaw += G.vYaw * k;
        G.vYaw *= Math.pow(0.90, k);
        G.yaw += G.spin * G.spinEase * Math.min(0.25, Math.abs(dt));
      }
      G.zoom += (G.zoomT - G.zoom) * 0.16;
      if (G.flash > 0) G.flash = Math.max(0, G.flash - dt * 0.9);

      G.cam = {
        syw: Math.sin(G.yaw), cyw: Math.cos(G.yaw),
        cp: Math.cos(G.pitch), sp: Math.sin(G.pitch),
        R: G.R * G.zoom, cx: G.cx, cy: G.cy
      };

      var ctx = G.ctx, H = G.hide;
      ctx.clearRect(0, 0, G.w, G.h);
      if (!H.stars) drawStars();
      if (!H.sphere) drawSphere();
      if (!H.grid) drawGraticule();
      if (!H.land) drawLand();
      if (!H.arcs) drawArcs(t);
      if (!H.nodes) drawNodes(t);
      if (!H.ripples) drawRipples(dt);

      G.raf = requestAnimationFrame(frame);
    }

    function start() {
      if (!G.raf) { G.lastTs = 0; G.raf = requestAnimationFrame(frame); }
    }
    function stop() {
      if (G.raf) { cancelAnimationFrame(G.raf); G.raf = 0; }
    }

    /* Lightning layer: one dot per sampled node, one arc per real channel between
       two dots. Nothing else is ever added here. */
    function buildLN() {
      var buckets = Object.create(null), order = [], byPk = Object.create(null);
      S.nodes.forEach(function (n) {
        if (!num(n.lat) || !num(n.lon)) return;
        var key = Math.round(n.lat / 4) + ':' + Math.round(n.lon / 4);
        var b = buckets[key];
        if (!b) { b = buckets[key] = { lat: 0, lon: 0, n: 0, nodes: [] }; order.push(key); }
        b.lat += n.lat; b.lon += n.lon; b.n++; b.nodes.push(n);
      });
      G.clusters = order.map(function (k) {
        var b = buckets[k], ch = 0, cap = 0, deg = 0;
        b.nodes.forEach(function (n) { ch += n.channels || 0; cap += n.capacity || 0; deg += n.deg || 0; });
        return {
          lat: b.lat / b.n, lon: normLon(b.lon / b.n), count: b.n,
          channels: ch, capacity: cap, deg: deg, nodes: b.nodes, sx: 0, sy: 0, on: false, arcs: 0
        };
      });
      G.clusters.forEach(function (c, i) {
        c.nodes.forEach(function (n) { byPk[n.pk] = i; });
      });

      var links = [], used = Object.create(null), key, a, b;
      for (var i = 0; i < (S.links || []).length; i++) {
        a = byPk[S.links[i][0]];
        b = byPk[S.links[i][1]];
        if (a === undefined || b === undefined || a === b) continue;
        key = Math.min(a, b) + '-' + Math.max(a, b);
        if (used[key]) continue;
        used[key] = 1;
        links.push([a, b]);
        G.clusters[a].arcs++;
        G.clusters[b].arcs++;
      }
      G.links = links;
      buildArcs();
    }

    /* L1 layer: one dot per bucket of Bitnodes coordinates. A coordinate is a real
       node location the crawler geolocated; the cell only stops the dots from
       piling up on top of each other at phone size. No arcs — Bitnodes publishes
       no peer graph, so there is nothing real to draw between them. */
    function buildL1() {
      var coords = (S.l1 && S.l1.coords) ? S.l1.coords : [];
      var buckets = Object.create(null), order = [];
      for (var i = 0; i < coords.length; i++) {
        var p = coords[i];
        if (!p || !num(p[0]) || !num(p[1])) continue;
        var lat = p[0], lon = p[1];
        if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
        var key = Math.floor((lat + 90) / L1_CELL_DEG) + ':' + Math.floor((lon + 180) / L1_CELL_DEG);
        var b = buckets[key];
        if (!b) { b = buckets[key] = { lat: 0, lon: 0, n: 0, pts: [] }; order.push(key); }
        b.lat += lat; b.lon += lon; b.n++; b.pts.push([lat, lon]);
      }
      G.clusters = order.map(function (k) {
        var b = buckets[k];
        return {
          lat: b.lat / b.n, lon: normLon(b.lon / b.n), count: b.n,
          channels: 0, capacity: 0, deg: 0, nodes: [], pts: b.pts,
          l1: true, sx: 0, sy: 0, on: false, arcs: 0,
          iso: l1CellCountry(b.pts)
        };
      });
      G.links = [];
      buildArcs();
    }

    /* The ENTITIES layer places nothing on the globe. An entity address has no location —
       not a city, not a country — so drawing dots here would be inventing geography for
       it. The sphere, its land and its graticule stay as the backdrop the panel sits on. */
    function buildEmpty() {
      G.clusters = [];
      G.links = [];
      buildArcs();
    }

    function build() {
      if (S.layer === 'l1') buildL1();
      else if (S.layer === 'entities') buildEmpty();
      else buildLN();
    }

    function pulse() { G.flash = 1; if (!document.hidden) G.ripples.push({ t: 0 }); }

    function geoProbe(yaw, pitch) {
      var sYaw = G.yaw, sPitch = G.pitch, sCam = G.cam;
      G.yaw = yaw; G.pitch = pitch;
      G.cam = {
        syw: Math.sin(yaw), cyw: Math.cos(yaw),
        cp: Math.cos(pitch), sp: Math.sin(pitch),
        R: G.R * G.zoom, cx: G.cx, cy: G.cy
      };
      var cam = G.cam, o = { x: 0, y: 0, z: 0 }, i, k, e;
      var out = { yaw: yaw, pitch: pitch, ringErr: 0, arcErr: 0, samples: 0, worst: null };

      var all = [G.ringsP, G.gratsP];
      for (var g = 0; g < all.length; g++) {
        var list = all[g];
        for (i = 0; i < list.length; i++) {
          var r = list[i];
          projectRing(r, cam);
          var src = g === 0 ? G.rings[i] : G.grats[i];
          for (k = 0; k < src.length; k += 3) {
            project(src[k][1], src[k][0], o);
            e = Math.max(Math.abs(o.x - r.xs[k]), Math.abs(o.y - r.ys[k]), Math.abs(o.z - r.zs[k]));
            if (e > out.ringErr) { out.ringErr = e; out.worst = { lat: src[k][1], lon: src[k][0] }; }
            out.samples++;
          }
        }
      }

      for (i = 0; i < G.arcs.length; i++) {
        var arc = G.arcs[i], lk = G.links[i];
        if (!lk) continue;
        projectArc(arc, cam);
        for (var side = 0; side < 2; side++) {
          var c = G.clusters[lk[side]], idx = side === 0 ? 0 : arc.n - 1;
          if (!c) continue;
          project(c.lat, c.lon, o);
          e = Math.max(Math.abs(o.x - arc.xs[idx]), Math.abs(o.y - arc.ys[idx]), Math.abs(o.z - arc.zs[idx]));
          if (e > out.arcErr) out.arcErr = e;
          out.samples++;
        }
      }

      G.yaw = sYaw; G.pitch = sPitch; G.cam = sCam;
      return out;
    }

    function hitTest(x, y) {
      /* A finger, not a cursor: the radius is a phone-sized target and widens with the
         zoom so a dot that has been pulled apart from its neighbours is still easy to
         hit. It never shrinks below HIT_MIN. */
      var best = null, bestD = HIT_MIN + Math.max(0, G.zoom - 1) * HIT_ZOOM;
      for (var i = 0; i < G.clusters.length; i++) {
        var c = G.clusters[i];
        if (!c.on) continue;
        var d = Math.sqrt((c.sx - x) * (c.sx - x) + (c.sy - y) * (c.sy - y));
        if (d < bestD) { bestD = d; best = c; }
      }
      return best;
    }

    function bind() {
      var cv = G.cv;
      if (!cv) return;
      cv.addEventListener('pointerdown', function (e) {
        pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
        var keys = Object.keys(pointers);
        if (keys.length === 2) {
          var a = pointers[keys[0]], b = pointers[keys[1]];
          pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, z: G.zoomT };
          G.dragging = false;
          /* A pinch never opens a card: dragMoved is not advanced while two fingers are
             down, so the release below would read a zoom gesture as a tap. */
          pinchHappened = true;
        } else {
          G.dragging = true; G.vYaw = 0;
          dragStart = { x: e.clientX, y: e.clientY, yaw: G.yaw, pitch: G.pitch };
          dragMoved = 0;
          pinchHappened = false;
        }
        G.lastTouch = Date.now();
        try { cv.setPointerCapture(e.pointerId); } catch (err) { }
      });
      cv.addEventListener('pointermove', function (e) {
        if (!pointers[e.pointerId]) return;
        pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
        G.lastTouch = Date.now();
        var keys = Object.keys(pointers);
        if (pinch && keys.length === 2) {
          var a = pointers[keys[0]], b = pointers[keys[1]];
          var d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
          G.zoomT = clamp(pinch.z * (d / pinch.d), ZOOM_MIN, ZOOM_MAX);
          e.preventDefault();
          return;
        }
        if (!G.dragging || !dragStart) return;
        /* Sensitivity follows the zoom: one pixel drags 1/zoom as far across the surface. */
        var s = 1 / Math.max(1, G.zoom);
        var dx = e.clientX - dragStart.x, dy = e.clientY - dragStart.y;
        dragMoved = Math.max(dragMoved, Math.abs(dx) + Math.abs(dy));
        G.yaw = dragStart.yaw - dx * DRAG_YAW * s;
        G.pitch = clamp(dragStart.pitch + dy * DRAG_PITCH * s, -1.05, 1.05);
        G.vYaw = -dx * DRAG_V * s;
        e.preventDefault();
      });
      function release(e) {
        /* a pointer this globe never saw go down (it was dropped by resetTouch) owns no
           part of the gesture: releasing it must not open a card */
        if (!pointers[e.pointerId]) return;
        var wasDrag = dragMoved;
        if (pointers[e.pointerId]) delete pointers[e.pointerId];
        var keys = Object.keys(pointers);
        if (keys.length < 2) pinch = null;
        if (keys.length === 0) {
          G.dragging = false;
          if (wasDrag < 6 && !pinchHappened) {
            var c = hitTest(e.clientX, e.clientY);
            if (c) showNodeCard(c);
          }
          G.lastTouch = Date.now();
        }
      }
      /* Two fingers down, then the page loses focus (the app is backgrounded, a call
         arrives, the WebView hands focus to native): no pointerup ever follows, so the
         old touch state stayed behind — a stale second pointer, a live pinch base, a
         drag that never ended. The globe then ignored the next tap and kept re-scaling
         from a distance it no longer knew. Drop the whole gesture instead. */
      function resetTouch() {
        pointers = {};
        pinch = null;
        G.dragging = false;
        dragStart = null;
        dragMoved = 0;
        pinchHappened = false;
      }
      cv.addEventListener('touchcancel', resetTouch);
      window.addEventListener('blur', resetTouch);
      window.addEventListener('pagehide', resetTouch);
      document.addEventListener('visibilitychange', function () { if (document.hidden) resetTouch(); });
      cv.addEventListener('pointerup', release);
      cv.addEventListener('pointercancel', release);
      cv.addEventListener('wheel', function (e) {
        e.preventDefault();
        G.zoomT = clamp(G.zoomT * Math.exp(-e.deltaY * 0.0014), ZOOM_MIN, ZOOM_MAX);
        G.lastTouch = Date.now();
      }, { passive: false });
      cv.addEventListener('gesturestart', function (e) { e.preventDefault(); });
    }

    function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

    return {
      init: function () {
        G.rings = decodeRings(typeof WORLD_LAND !== 'undefined' ? WORLD_LAND : '');
        G.grats = buildGraticule();
        G.ringsP = G.rings.map(prepRing);
        G.gratsP = G.grats.map(prepRing);
        resize(); bind(); start();
        window.addEventListener('resize', function () { resize(); });
        window.addEventListener('orientationchange', function () { setTimeout(resize, 250); });
        document.addEventListener('visibilitychange', function () {
          if (document.hidden) stop(); else start();
        });
      },
      build: build,
      pulse: pulse,
      geoProbe: geoProbe,
      packets: function (t) {
        var out = [];
        eachPacket(t, function (x, y, size, alpha, arc, tt) { out.push([x, y, size, arc, tt]); });
        return out;
      },
      projectPoint: function (lat, lon) {
        var o = { x: 0, y: 0, z: 0 };
        project(lat, lon, o);
        return { x: o.x, y: o.y, z: o.z };
      },
      resize: resize,
      /* a layer switch changes the palette and the node set: rebuild both caches */
      relayout: function () { layout(); buildBall(); buildGlow(); },
      retheme: function () { buildBackground(); buildBall(); buildGlow(); },
      setRes: setRes,
      hold: function (on) { G.hold = !!on; G.lastTouch = Date.now(); },
      /* the zoom ceiling and the touch radius, for the HUD hint and the regression tests */
      zoomMax: function () { return ZOOM_MAX; },
      hitRadius: function () { return HIT_MIN + Math.max(0, G.zoom - 1) * HIT_ZOOM; },
      hitTest: hitTest,
      state: G
    };
  })();

  /* country of an L1 cell: every coordinate in it that the Bitnodes snapshot
     geolocated, and only if they agree */
  function l1CellCountry(pts) {
    var s = l1Snap();
    if (!s || !s.coordCountry) return '';
    var seen = Object.create(null), any = '';
    for (var i = 0; i < pts.length; i++) {
      var iso = s.coordCountry[(pts[i][0]).toFixed(4) + ',' + (pts[i][1]).toFixed(4)];
      if (iso) { seen[iso] = 1; any = iso; }
    }
    var keys = Object.keys(seen);
    return keys.length === 1 ? any : '';
  }

