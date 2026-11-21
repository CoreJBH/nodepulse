<div align="center">

<img src="assets/icon-192.png" width="132" height="132" alt="NodePulse">

# NodePulse

**Bitcoin L1 mainnet full-node map and real-time network monitor, with the Lightning channel graph one tap away.**

![zero dependencies](https://img.shields.io/badge/dependencies-0-0b1220?style=flat-square)
![single file](https://img.shields.io/badge/build-single%20file%20HTML-0b1220?style=flat-square)
![canvas 2d](https://img.shields.io/badge/render-Canvas%202D-38bdf8?style=flat-square)
![tests](https://img.shields.io/badge/assertions-169%20passing-2ea043?style=flat-square)
![data](https://img.shields.io/badge/L1-bitnodes-38bdf8?style=flat-square)
![data](https://img.shields.io/badge/mainnet-mempool.space-orange?style=flat-square)

</div>

NodePulse watches Bitcoin **L1 mainnet** first: the reachable full-node network as the
Bitnodes crawler sees it — node count, clear-net/Tor/I2P split, country and continent spread,
client versions — plus the chain tip, mempool pressure, fee market and the next-block fee
projection. The Lightning channel graph is still there as a second layer, one tap away.

It runs with **zero dependencies**: no framework, no bundler, no package manager, no CDN, no
external image or font request; the entire application is a single self-contained document
that draws every frame with the Canvas 2D API.

## Two layers

| Layer | What the globe shows | Primary data |
| --- | --- | --- |
| **Bitcoin L1** (default) | every unique coordinate the Bitnodes crawler geolocated, one dot per 3° cell | `bitnodes.io/api/v1/snapshots/latest/?field=coordinates` |
| **Lightning** | up to 22 nodes sampled from the real channel graph, one arc per open channel between drawn dots | `mempool.space/api/v1/lightning/channels-geo` |

The switcher sits under the title (`BITCOIN L1 | LIGHTNING`); the `EN / KO` button next to it
switches language, and both choices are remembered.

Each layer carries its own palette, so the globe you are looking at is readable at a glance:
**Bitcoin L1** keeps the original cyan / deep-blue identity (`#38bdf8` on `#040914`), and
**Lightning** has a distinct electric violet one. Neither layer borrows the other's signal
colour.

The L1 layer draws **no links at all**. Bitnodes publishes no per-node peer graph, so the only
honest options are to draw nothing or to invent a mesh — it draws nothing. Tor and I2P nodes
(15,577 of 21,826 in the bundled snapshot) carry no coordinates, so they are counted in the
totals and the transport split but not placed on the globe.

<div align="center">
<img src="assets/screenshot-mobile.jpg" width="46%" alt="NodePulse on a phone: Bitcoin L1 full-node globe, cyan / deep-blue identity">
<img src="assets/screenshot-lightning.jpg" width="46%" alt="NodePulse on a phone: Lightning channel graph, electric violet identity">
</div>

<div align="center">
<img src="assets/screenshot-desktop.jpg" width="92%" alt="NodePulse on a desktop browser">
</div>

---

## Core design principle — zero simulated data

Every number and every line on the globe is a value the network actually reported. Nothing
is generated, interpolated from a model, or placed for visual balance.

| Element on screen | Source | Transport |
| --- | --- | --- |
| Block height, latest blocks, block interval | `mempool.space/api/blocks/tip/height`, `/api/v1/blocks` | REST |
| Hashrate, difficulty adjustment | `/api/v1/mining/hashrate/1w`, `/api/v1/difficulty-adjustment` | REST |
| Mempool size, transaction count, fee histogram | `/api/mempool`, `/api/mempool/recent`, `/api/v1/fees/recommended` | REST |
| Lightning node count, channel count, total capacity | `/api/v1/lightning/statistics/latest` | REST |
| Node distribution by country | `/api/v1/lightning/nodes/countries` | REST |
| Globe node positions, aliases, capacities, degrees | `/api/v1/lightning/channels-geo`, `/api/v1/lightning/nodes/{pubkey}`, `nodes/rankings/{connectivity,liquidity}` | REST |
| Inter-node arcs | `channels-geo` — one arc per **real open channel** | REST |
| L1 reachable node count, crawler height | `bitnodes.io/api/v1/snapshots/latest/?field=coordinates` | REST (native bridge on Android) |
| L1 unique node coordinates (the globe dots) | same `?field=coordinates` payload | REST (native bridge on Android) |
| L1 clear-net / Tor / I2P split | `?field=top` → `top_asns` (`TOR`, `I2P`, `AS…`) | REST (native bridge on Android) |
| L1 client versions (`/Satoshi:x.y.z/`) | `?field=top` → `top_user_agents` | REST (native bridge on Android) |
| L1 countries / continents | `bitnodes.io/api/v1/nodes/` (all pages) folded into the bundled snapshot by `fetch_l1.py` | build time |
| Next-block fee projection | `mempool-blocks` stream | WebSocket |
| Mining pool share of the last week | `/api/v1/mining/pools/1w` | REST |
| Live block / mempool / fee pushes | `wss://mempool.space/api/v1/ws`, with `mempool.emzy.de` and `mempool.ninja` as mirror fallbacks | WebSocket |
| Watchdog alerts | derived from the values above: last block age, fee spike, pool share, a hash change at a seen height | local |

* **The arcs are channels, not decoration.** A line is drawn only when both endpoints are
  among the nodes on screen *and* the pair exists as an open channel in `channels-geo`.
  There is no proximity heuristic, no nearest-neighbour fallback, no synthetic mesh.
* **Node selection is topology-driven.** Up to 22 nodes are sampled from the real channel
  graph, not from a ranking list, so every dot is a node that actually holds channels that
  can be drawn (`fetch_channels.py`, `MAX_NODES`).
* **Built-in snapshot, honestly labelled.** A snapshot of the same real payloads is
  embedded at build time (`src/data/seed-nodes.js`, `src/data/channels-data.js`) so the app
  still shows the network's last known geometry with no connection. The UI never passes the
  snapshot off as live: the status pill and the data row report the state, the source, and
  the timestamp of what is being shown.
* **Rate limits are surfaced, not hidden.** Requests rotate across
  `mempool.space`, `mempool.emzy.de`, and `mempool.ninja`, and the WebSocket rotates through
  the same three mirrors; when all of them fail the app degrades to the snapshot and says so
  instead of substituting values.
* **Country counts say which snapshot they are.** Bitnodes exposes per-node country only
  through a paginated 21,826-row list (~20 MB). The app fetches it at build time
  (`fetch_l1.py`) and stamps that block with the capture date instead of pretending it is
  live; the live number, height, transport split, client versions and globe dots come from
  the two light endpoints above.
* **Nothing the crawler cannot know is invented.** No per-node latency, uptime, disk size or
  per-node height; no guessed P2P connection between L1 nodes.

---

## Architecture and technical highlights

The constraint that shapes the whole codebase is that a phone must hold 60 fps on a
software-rasterised Canvas while the network is still arriving. Each decision below exists
to remove per-frame work.

### 1. 3D orthographic projection with pre-computed ring caches
The globe is an orthographic projection of lon/lat geometry, not a raster or a WebGL
texture. `prepRing()` converts every coastline ring once into unit-sphere vectors; each frame
`projectRing()` applies the camera's pre-computed sin/cos matrix and produces screen-space
points plus a `z` value per point. No trigonometric function is evaluated at draw time, and
the same cache feeds land, graticule, and hit-testing.

### 2. A geometric horizon, and fills that close on the limb
Naive polygon filling of a sphere breaks in two ways: rings that cross the antimeridian
produce chords straight across the disc, and closing a ring along the back of the sphere
inverts the covered area. Here the horizon is solved analytically — the visible hemisphere is
exactly `z = 0` — so a ring is split into visible runs at its own `z = 0` crossings, and
`fillRun()` closes each run along the limb arc between those crossings. `fillRing()` then
batches every run of every continent into **one** path and **one** fill call per frame. The
result is a solid body with no seam, no chord, and no ocean filled at any rotation
(verified pixel-by-pixel by `test/fill-truth.js`, below).

### 3. Real-topology graph pruning that keeps the edge of the network
`channels-geo` returns thousands of channels; drawing them all is noise. The graph is pruned
to `LINK_PER_NODE = 5` arcs per node by processing nodes in ascending real degree, so a
small regional node keeps its one or two channels instead of being crowded out by a hub.
Out of 5 812 usable channels in the current snapshot, the globe draws about 44 arcs between
20 plotted nodes: a single connected component that still keeps low-degree regional nodes
visible, at under 1 % of the raw edge count.

### 4. A 60 fps mobile budget
* **No `shadowBlur`, ever.** Every glow is a pre-rendered radial-gradient sprite blitted
  with `drawImage`; `shadowBlur` alone costs more than the whole rest of the frame on a
  mid-range Android GPU.
* **Baked offscreen layers.** Starfield, globe body, atmosphere rim and land glow are
  rendered once per resize into offscreen canvases; a frame only blits them.
* **Depth-banded strokes.** Channel arcs are projected once, then stroked in 2–3 batched
  depth bands whose alpha follows `smoothstep(z)`, so near arcs read as bright and far arcs
  fade toward the limb — a handful of stroke calls for the entire network.
* **Continuous packet interpolation.** `eachPacket()` places each moving light packet by
  interpolating along its arc with the real timestamp, so motion stays correct even when a
  frame is late; packets are not stepped per frame.
* **Adaptive resolution.** Device pixel ratio is capped at 2, and an adaptive tier drops the
  backing store to 0.75, 0.62, then 0.50 when frames persistently miss vsync, stepping back
  up when they do not.
* **Time-driven animation.** Rotation and pulses are computed from the `requestAnimationFrame`
  timestamp, so the globe's motion is independent of frame loss.

### 5. Zero-dependency build and an automated verification suite
`build.py` inlines CSS, geometry, snapshots, application code, and the base64 app icon into
one document — about 355 KB — with tokens that fail the build if any substitution is missed,
and it refuses to emit a file that could break out of its own `<script>` block.

| Harness | What it proves | Result |
| --- | --- | --- |
| `test/headless.js` | DOM + rendering contract against stubbed canvas with real recorded payloads: both layers, bridge, snapshots, mempool-blocks, all four watchdog alerts, mirror fallback, EN/KO | **169 / 169 assertions pass** |
| `test/fill-truth.js` | Rendered continent fill compared with the land polygons over 50 camera angles, 743 k sampled pixels | ≈ 0.4 % false-positive / 0.26 % false-negative, all on sub-pixel Antarctic coastline edges |
| `test/perf.js` | Frame cadence at a 390×844 phone viewport, DPR clamped to 2, then with 4× CPU throttling | p50 16.7 ms (60 fps), p95 33.4 ms under throttle |
| `test/offline.js` | Boot with every network route aborted: snapshot geometry, status disclosure, no JS errors | pass |

---

## Quick start

**Use it.** Open the built file in any modern desktop or mobile browser:

```
dist/nodepulse.html
```

Add it to the home screen on Android or iOS and it launches full-screen with its own icon —
the icon and PWA metadata are embedded in the HTML, so no server and no asset directory are
involved.

**Build it.** Sources live in `src/`; the build is one stdlib-only Python script:

```bash
python3 build.py          # -> dist/nodepulse.html  (and the workspace copy)
node --check src/app.js   # syntax gate
```

**Test it.**

```bash
node test/headless.js               # 169 assertions, no browser required
python3 build.py && node test/fill-truth.js   # browser harness, needs Playwright
node test/perf.js                   # frame-time probe
```

The browser harnesses resolve the built file and a Playwright installation through
`test/env.js`; set `PLAYWRIGHT_PKG` (and `CHROME` for a specific binary) if they are not on
the default module path.

**Refresh the snapshot.** The embedded node sample and channel graph are regenerated from
live API data; after refreshing, rebuild:

```bash
python3 fetch_channels.py   # mempool REST + channels-geo + node details -> src/data/*.js, fixtures/
python3 fetch_l1.py         # bitnodes crawler export -> src/data/l1-data.js, fixtures/l1-snapshot.json
python3 build.py
```

---

## Android APK

The same single file ships as a native Android app: a minimal `WebView` shell
(`android/`) that loads `file:///android_asset/index.html`, with JavaScript and DOM storage
enabled, universal access from file URLs so the live `fetch`/WebSocket calls work without a
local server, an edge-to-edge `#040914` dark system bar treatment, and the NodePulse icon as
`ic_launcher` / `ic_launcher_round` (legacy mipmaps plus an adaptive icon).

* **Package:** `com.jbitmstr.nodepulse`
* **Min / target SDK:** 24 / 34
* **Version:** 1.1.0 (`versionCode` 2)

**Native HTTP bridge.** `bitnodes.io` answers without an `Access-Control-Allow-Origin`
header, so a WebView `fetch` would be blocked by CORS — and the L1 layer is the primary
dataset. `MainActivity.HttpBridge` exposes `NPBridge.fetch(id, url)`, performs the GET on a
small thread pool (`HttpURLConnection`, gzip, 12 s connect / 25 s read) and calls
`window.NPBridgeOnData(id, ok, body)` with the body unchanged. Hosts are whitelisted
(`bitnodes.io`, `btcnodes.io`, `mempool.space`, `mempool.emzy.de`, `mempool.ninja`), so the
interface cannot be used as an open proxy. When the bridge is absent — the plain web build —
the page tries `fetch` and falls back to the bundled Bitnodes snapshot, labelled by date.

**Build it automatically.** `.github/workflows/build-apk.yml` runs on every push to `main`
and on demand:

1. `python3 build.py` builds the single-file app.
2. The built HTML is copied to `android/app/src/main/assets/index.html`.
3. `gradle assembleDebug` produces a debug-signed, directly installable APK.
4. The APK is uploaded as the workflow artifact **`nodepulse-apk`** (file `nodepulse.apk`).

**Get the APK.**

* GitHub → **Actions** → *Build Android APK* → latest run → **Artifacts** →
  `nodepulse-apk`, or
* from a shell: `gh run download --name nodepulse-apk -R JBITmstr/nodepulse`

Install it on the phone (allow "install unknown apps" for the browser or file manager you
open it with). Debug signing is deliberate: it keeps the build reproducible in CI without
shipping a keystore. For a Play-style release, add your own signing config and run
`gradle assembleRelease`.

**Build locally.** With JDK 17 and the Android SDK installed:

```bash
cd android
gradle assembleDebug     # -> app/build/outputs/apk/debug/app-debug.apk
```

---

## Repository layout

```
src/
  index.template.html      document shell: head, metadata, inline icon slots, both layers
  app.css                  layout, panels, typography
  app.js                   projection, fill, graph, packets, data layer, UI (~2 000 lines)
  data/                    world geometry, country table, real node + channel + L1 snapshots
assets/                    app icon (64/180/192/512), README screenshots
build.py                   single-file assembly (inlines CSS/JS/data/base64 icon)
dist/nodepulse.html        build output, ready to open
fixtures/                  recorded API payloads the headless test replays
fetch_l1.py                Bitnodes crawler export -> src/data/l1-data.js (L1 snapshot)
test/                      headless contract, fill truth, perf, offline, screenshot harnesses
fetch_channels.py          snapshot capture from the live API into src/data/ + fixtures/
fetch_nodes.py             node-detail capture helper
make_launcher_icons.py     regenerates the Android launcher icons from assets/icon-512.png
make_icons.py              regenerates the web icon set from assets/icon-master.png
android/                   WebView wrapper: Gradle project, manifest, launcher icons
.github/workflows/         build-apk.yml — build + package the APK on CI
```

---

## Data sources and attribution

Bitcoin mainnet values come from [mempool.space](https://mempool.space) (REST + WebSocket),
with `mempool.emzy.de` and `mempool.ninja` as fallbacks. L1 full-node values come from
[Bitnodes](https://bitnodes.io) (`/api/v1/snapshots/latest/`), the independent crawler of the
Bitcoin P2P network. NodePulse is an independent visualiser and is not affiliated with or
endorsed by either project. Public API endpoints are rate limited; the app is designed to
disclose throttling and outages rather than to hide them.

---

## Contributors

* **[@JBITmstr](https://github.com/JBITmstr)** — Creator, product direction & design
* **Gilbert ([Pickle](https://pickle.com))** — AI co-builder (implementation, 3D globe rendering & CI)

