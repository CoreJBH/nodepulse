/* Ground-truth check for the continent fill. For a grid of screen points inside the
   globe, compute what the correct answer is — take the front-hemisphere 3D point and
   test it against the real land polygons in lon/lat — and compare it with the pixels
   the app actually filled. Any blue pixel over open ocean shows up as a false
   positive; any missing land as a false negative.
   Run: node test/fill-truth.js */
const { chromium, URL: APP_URL, SHOTS } = require('./env');
const fs = require('fs');
const path = require('path');

const FILE = APP_URL + '?v=' + Date.now();
const OUT = path.resolve(__dirname, '..', 'shots', 'probe');
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(FILE, { waitUntil: 'load' });
  await page.waitForTimeout(4200);
  await page.evaluate(() => { window.NODEPULSE.full(); });
  await page.waitForTimeout(700);

  const angles = [];
  for (let yaw = 0; yaw < 6.2; yaw += 0.62) for (const pitch of [-0.9, -0.45, 0, 0.45, 0.9]) angles.push([+yaw.toFixed(3), pitch]);

  const rows = [];
  for (const [yaw, pitch] of angles) {
    const r = await page.evaluate(async ({ yaw, pitch }) => {
      const NP = window.NODEPULSE, G = NP.globe;
      G.spin = 0; G.vYaw = 0; G.spinEase = 0; G.hold = true; G.flash = 0; G.ripples.length = 0;
      G.dragging = false;
      G.hide.arcs = true; G.hide.nodes = true; G.hide.grid = true; G.hide.ripples = true;
      G.hide.sphere = true; G.hide.stars = true; G.hide.landStroke = true;
      G.yaw = yaw; G.pitch = pitch;
      const frame = async () => { for (let w = 0; w < 4; w++) await new Promise(res => requestAnimationFrame(() => res())); await new Promise(res => setTimeout(res, 60)); };
      await frame();

      /* the land polygons exactly as authored (lon/lat), unwrapped across the seam */
      const rings = [];
      for (const ring of G.rings) {
        let unwrapped = false;
        const xs = ring.map(p => p[0]);
        if (Math.max(...xs) > 170 && Math.min(...xs) < -170) unwrapped = true;
        const pts = ring.map(p => unwrapped && p[0] < 0 ? [p[0] + 360, p[1]] : p);
        rings.push(pts);
      }
      const inRing = (pts, lon, lat) => {
        let w = 0;
        for (let i = 0; i < pts.length; i++) {
          const a = pts[i], b = pts[(i + 1) % pts.length];
          const cr = (b[0] - a[0]) * (lat - a[1]) - (b[1] - a[1]) * (lon - a[0]);
          if (a[1] <= lat) { if (b[1] > lat && cr > 0) w++; }
          else if (b[1] <= lat && cr < 0) w--;
        }
        return w !== 0;
      };
      const isLand = (lat, lon) => rings.some(pts => inRing(pts, lon, lat) || inRing(pts, lon + 360, lat) || inRing(pts, lon - 360, lat));

      const cv = document.getElementById('globe'), s = G.dpr * G.resScale;
      const R = G.R * G.zoom, cx = G.cx, cy = G.cy;
      const img = G.ctx.getImageData(0, 0, cv.width, cv.height).data;
      const filled = (x, y) => {
        const px = Math.round(x * s), py = Math.round(y * s);
        const i = (py * cv.width + px) * 4;
        return img[i + 3] > 8;      // with every other layer hidden the land fill is the only paint
      };

      /* sample the disc on a grid, keep only points well inside the limb, and only
         count a mismatch when no neighbour already matches (one-pixel coast tolerance) */
      const step = 2, pts = [];
      for (let py = cy - R; py <= cy + R; py += step) {
        for (let px = cx - R; px <= cx + R; px += step) {
          const dx = (px - cx) / R, dy = (py - cy) / R;
          const r2 = dx * dx + dy * dy;
          if (r2 > 0.9 * 0.9) continue;
          const camz = Math.sqrt(1 - r2), camx = dx, camy = -dy;
          const cp = Math.cos(G.pitch), sp = Math.sin(G.pitch);
          const y1 = camy * cp + camz * sp, z1 = -camy * sp + camz * cp;
          const lat = Math.asin(Math.max(-1, Math.min(1, y1))) * 180 / Math.PI;
          const lon = Math.atan2(camx, z1) * 180 / Math.PI + G.yaw * 180 / Math.PI;
          /* the pole-circling ring (Antarctica) cannot be tested in lon/lat: its own
             reference polygon is degenerate there, so that band is checked by eye */
          if (Math.abs(lat) > 74) continue;
          pts.push({ px, py, lat, lon, want: isLand(lat, ((lon + 540) % 360) - 180) });
        }
      }
      const grid = new Map();
      for (const p of pts) grid.set(Math.round(p.px) + ',' + Math.round(p.py), p);
      let land = 0, ocean = 0, fp = 0, fn = 0, total = 0;
      const worst = [];
      for (const p of pts) {
        const actual = filled(p.px, p.py);
        total++;
        if (p.want) land++; else ocean++;
        if (actual === p.want) continue;
        let rescued = false;
        for (let ox = -step; ox <= step && !rescued; ox += step)
          for (let oy = -step; oy <= step; oy += step) {
            if (ox === 0 && oy === 0) continue;
            const q = grid.get(Math.round(p.px + ox) + ',' + Math.round(p.py + oy));
            if (q && filled(q.px, q.py) === p.want) { rescued = true; break; }
          }
        if (rescued) continue;
        if (actual && !p.want) { fp++; if (worst.length < 6) worst.push({ lat: +p.lat.toFixed(1), lon: +p.lon.toFixed(1) }); }
        if (!actual && p.want) fn++;
      }
      return { total, land, ocean, fp, fn, worst, cvW: cv.width };
    }, { yaw, pitch });
    rows.push(Object.assign({ yaw, pitch }, r));
  }

  const tot = rows.reduce((a, r) => a + r.total, 0);
  const fp = rows.reduce((a, r) => a + r.fp, 0);
  const fn = rows.reduce((a, r) => a + r.fn, 0);
  const worstRow = rows.slice().sort((a, b) => b.fp - a.fp)[0];
  const out = {
    angles: rows.length, samples: tot,
    falsePositivePixels: fp, falsePositiveRate: +(fp / tot).toFixed(4),
    falseNegativePixels: fn, falseNegativeRate: +(fn / tot).toFixed(4),
    worstAngle: { yaw: worstRow.yaw, pitch: worstRow.pitch, fp: worstRow.fp, worst: worstRow.worst },
    errors,
    ok: fp / tot < 0.002 && fn / tot < 0.02
  };
  console.log(JSON.stringify(out, null, 1));
  await browser.close();
  process.exit(out.ok ? 0 : 1);
})();
