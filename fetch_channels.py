#!/usr/bin/env python3
"""Capture the mempool.space payloads the app needs, and choose the globe's node
sample from the REAL Lightning channel graph.

The globe used to pick nodes from the ranking lists and then join them to their
nearest neighbours (an illustration). It now picks nodes that actually have
channels in /api/v1/lightning/channels-geo and draws only those channels.

Outputs
  fixtures/api-snapshot.json  every REST payload used by the headless test
  fixtures/channels-geo.json  the raw channels-geo rows (real channel pairs)
  src/data/seed-nodes.js      NODE_SEED   - offline snapshot of the sample
  src/data/channels-data.js   CHANNEL_SEED- offline snapshot of the real links
"""
import json, re, urllib.request, time, collections, concurrent.futures as cf, os, math

UA = {"User-Agent": "Mozilla/5.0 (compatible; bitcoin-network-monitor/1.0)"}
BASE = "https://mempool.space"
HERE = os.path.dirname(os.path.abspath(__file__))

MAX_NODES = 22
CELL_DEG = 20      # lat/lon bucket used to keep two picks from sitting on one dot
CELL_CAP = 2
REGION_CAP = 5
PEERS_KEPT = 4
LINK_PER_NODE = 5  # channel arcs one dot may carry (must match app.js capLinks)

# A Lightning public key is 33 compressed bytes in hex and is the only value from the API
# that lands in a URL path, so it is checked against that exact shape first.
PK_RE = re.compile(r"^[0-9a-fA-F]{66}$")


def is_pk(v):
    return isinstance(v, str) and PK_RE.match(v) is not None


def get(path):
    url = path if path.startswith("http") else BASE + path
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=40) as r:
        return json.loads(r.read().decode())


# ---------------------------------------------------------------- region buckets
def region_of(lat, lon):
    """Coarse bucket used ONLY to spread the sample around the globe (never displayed)."""
    if lat < -10 and (lon > 110 or lon < -170):
        return "OC"
    if lat >= 12 and -170 < lon < -30:
        return "NA"
    if lat < 12 and -95 < lon < -30:
        return "SA"
    if lat < 12 and -20 <= lon < 52:
        return "AF"
    if 12 <= lat < 40 and 52 <= lon < 100:
        return "AS"
    if lat >= 35 and -25 <= lon < 45:
        return "EU"
    if lat >= 40 and lon >= 45:
        return "AS"
    if lon >= 100:
        return "AS"
    if -30 <= lon < 52:
        return "AF"
    return "OT"


def cell_of(lat, lon):
    return (int((lat + 90) // CELL_DEG), int((lon + 180) // CELL_DEG))


def cluster_key(lat, lon):
    """Must match clusterKeyOf() in app.js: the 4-degree bucket that becomes one dot.
    Math.round() rounds .5 upward, Python's round() rounds to even — so do it by hand."""
    return (int(math.floor(lat / 4 + 0.5)), int(math.floor(lon / 4 + 0.5)))


def is_num(v):
    return isinstance(v, (int, float)) and v == v and abs(v) != float("inf")


# ---------------------------------------------------------------- channel graph
def build_graph(rows):
    """rows: [pubkeyA, aliasA, lonA, latA, pubkeyB, aliasB, lonB, latB]"""
    by, keys, links = {}, [], []
    for r in rows:
        if not isinstance(r, list) or len(r) < 8:
            continue
        a, b = r[0], r[4]
        if not isinstance(a, str) or not isinstance(b, str) or a == b:
            continue
        la, loa, lb, lob = r[3], r[2], r[7], r[6]
        if not (is_num(la) and is_num(loa) and is_num(lb) and is_num(lob)):
            continue
        if abs(la) > 90 or abs(lb) > 90 or abs(loa) > 180 or abs(lob) > 180:
            continue
        na = by.get(a)
        if na is None:
            na = by[a] = {"pk": a, "alias": (r[1] or a[:10]), "lat": float(la), "lon": float(loa), "peers": {}, "deg": 0}
            keys.append(a)
        nb = by.get(b)
        if nb is None:
            nb = by[b] = {"pk": b, "alias": (r[5] or b[:10]), "lat": float(lb), "lon": float(lob), "peers": {}, "deg": 0}
            keys.append(b)
        if b in na["peers"]:
            continue
        na["peers"][b] = 1
        nb["peers"][a] = 1
        na["deg"] += 1
        nb["deg"] += 1
        links.append((a, b))
    return by, keys, links


def pick_nodes(by, keys):
    """Greedy: keep adding the node that brings the most real channels into the
    drawn set, while no cell/region gets crowded. Deterministic for a given payload."""
    order = sorted(keys, key=lambda pk: (-by[pk]["deg"], by[pk]["alias"], pk))
    sel, inset = [], set()
    cells, regs = collections.Counter(), collections.Counter()
    dots = set()

    def fits(n, relax):
        c = cell_of(n["lat"], n["lon"])
        g = region_of(n["lat"], n["lon"])
        if cluster_key(n["lat"], n["lon"]) in dots:      # one dot per place on the globe
            return False
        return cells[c] < CELL_CAP + relax and regs[g] < REGION_CAP + relax

    relax = 0
    while len(sel) < MAX_NODES:
        best, bestkey = None, None
        for pk in order:
            if pk in inset:
                continue
            n = by[pk]
            if not fits(n, relax):
                continue
            v = len(set(n["peers"]) & inset)
            key = (v, n["deg"])
            if bestkey is None or key > bestkey:
                best, bestkey = pk, key
        if best is None:
            if relax < 3:
                relax += 1
                continue
            break
        n = by[best]
        sel.append(best)
        inset.add(best)
        cells[cell_of(n["lat"], n["lon"])] += 1
        regs[region_of(n["lat"], n["lon"])] += 1
        dots.add(cluster_key(n["lat"], n["lon"]))
    return sel


def cap_links(pairs, by, k=LINK_PER_NODE):
    """Keep at most k real channels per dot, never an invented one. The dots with the
    fewest partners choose first, so a small node keeps its one or two real channels
    instead of being pushed out by a hub; inside a dot the strongest peer (highest
    channels-geo degree) wins. Same rule as capLinks() in app.js, ties broken on the
    pubkey as a plain string, so the snapshot and the live view cut the same set."""
    peers = {}
    for a, b in pairs:
        if a == b or a not in by or b not in by:
            continue
        peers.setdefault(a, set()).add(b)
        peers.setdefault(b, set()).add(a)
    cnt, used, out = collections.Counter(), set(), []
    for p in sorted(peers, key=lambda p: (len(peers[p]), p)):
        while cnt[p] < k:
            cands = [q for q in peers[p]
                     if cnt[q] < k and (min(p, q), max(p, q)) not in used]
            if not cands:
                break
            q = min(cands, key=lambda q: (-by[q]["deg"], q))
            used.add((min(p, q), max(p, q)))
            cnt[p] += 1
            cnt[q] += 1
            out.append((p, q))
    return out


def peers_of(pk, by, inset):
    n = by[pk]
    inside = [p for p in n["peers"] if p in inset]
    outside = [p for p in n["peers"] if p not in inset]
    inside.sort(key=lambda p: (-by[p]["deg"], by[p]["alias"]))
    outside.sort(key=lambda p: (-by[p]["deg"], by[p]["alias"]))
    out = inside + outside
    return [by[p]["alias"] for p in out[:PEERS_KEPT]]


# ---------------------------------------------------------------- main
def main():
    print("fetching REST payloads ...")
    snap = {
        "tip": int(get("/api/blocks/tip/height")),
        "blocks": get("/api/v1/blocks"),
        "mempool": get("/api/mempool"),
        "recent": get("/api/mempool/recent"),
        "fees": get("/api/v1/fees/recommended"),
        "hashrate": get("/api/v1/mining/hashrate/1w"),
        "diff": get("/api/v1/difficulty-adjustment"),
        "lnstats": get("/api/v1/lightning/statistics/latest"),
        "countries": get("/api/v1/lightning/nodes/countries"),
        "connectivity": get("/api/v1/lightning/nodes/rankings/connectivity"),
        "liquidity": get("/api/v1/lightning/nodes/rankings/liquidity"),
    }

    print("fetching channels-geo ...")
    rows = get("/api/v1/lightning/channels-geo")
    print("  channels-geo rows:", len(rows))

    by, keys, links = build_graph(rows)
    print("  nodes with coordinates:", len(keys), " usable channels:", len(links))
    sel = [pk for pk in pick_nodes(by, keys) if is_pk(pk)]
    inset = set(sel)
    print("  picked", len(sel), "nodes")

    rank = {}
    for src in (snap["connectivity"], snap["liquidity"]):
        for n in src:
            e = rank.setdefault(n["publicKey"], {"channels": None, "capacity": None, "iso": ""})
            if n.get("channels"):
                e["channels"] = max(e["channels"] or 0, n["channels"])
            if n.get("capacity"):
                e["capacity"] = max(e["capacity"] or 0, n["capacity"])
            e["iso"] = e["iso"] or (n.get("iso_code") or "")

    def detail(pk):
        if not is_pk(pk):
            print("  detail skipped: bad publicKey", repr(pk)[:40])
            return None
        try:
            return get("/api/v1/lightning/nodes/" + pk)
        except Exception as e:                                  # noqa: BLE001
            print("  detail failed", str(pk)[:12], e)
            return None

    print("fetching node details ...")
    with cf.ThreadPoolExecutor(6) as ex:
        details = dict(zip(sel, ex.map(detail, sel)))

    nodes, details_out = [], []
    for pk in sel:
        d = details.get(pk) or {}
        r = rank.get(pk) or {}
        g = by[pk]
        lat = d.get("latitude") if is_num(d.get("latitude")) else g["lat"]
        lon = d.get("longitude") if is_num(d.get("longitude")) else g["lon"]
        ch = r.get("channels") or d.get("active_channel_count")
        cap = r.get("capacity") or d.get("capacity")
        ch = int(ch) if ch is not None else None
        cap = int(cap) if cap is not None else None
        nodes.append({
            "pk": pk,
            "alias": d.get("alias") or g["alias"],
            "lat": lat, "lon": lon,
            "iso": d.get("iso_code") or r.get("iso") or "",
            "city": (d.get("city") or {}).get("en") or "",
            "country": (d.get("country") or {}).get("en") or "",
            "asOrg": d.get("as_organization") or "",
            "firstSeen": d.get("first_seen") or 0,
            "updatedAt": d.get("updated_at") or 0,
            "channels": ch if ch is not None else 0,
            "channelsSrc": "ranking" if r.get("channels") else ("node" if d.get("active_channel_count") is not None else ""),
            "capacity": cap if cap is not None else 0,
            "sockets": len([s for s in (d.get("sockets") or "").split(",") if s]),
            "tor": ".onion" in (d.get("sockets") or ""),
            "deg": g["deg"],
            "peers": [],
        })
        if d:
            details_out.append(d)

    # the sample was spread using channels-geo coordinates; the detail coordinates
    # can put two of them on one 4-degree dot. Keep the stronger node per dot, so
    # the globe's dots and the drawn channels never disagree.
    kept, seen_dot = [], {}
    for n in nodes:
        k = cluster_key(n["lat"], n["lon"])
        i = seen_dot.get(k)
        if i is None:
            seen_dot[k] = len(kept)
            kept.append(n)
        elif n["deg"] > kept[i]["deg"]:
            kept[i] = n
    nodes = kept
    inset = set(n["pk"] for n in nodes)
    inner = [(a, b) for (a, b) in links if a in inset and b in inset]
    print("  kept", len(nodes), "dots with", len(inner), "real channels between them")
    inner = cap_links(inner, by)
    print("  drawn after the per-dot cap:", len(inner), "channels")
    for n in nodes:
        n["peers"] = peers_of(n["pk"], by, inset)
    details_out = [d for d in details_out if d.get("public_key") in inset]

    snap["nodes"] = details_out
    snap["_fetched_at"] = int(time.time())
    with open(os.path.join(HERE, "fixtures", "api-snapshot.json"), "w", encoding="utf-8") as f:
        json.dump(snap, f, ensure_ascii=False, separators=(",", ":"))
    with open(os.path.join(HERE, "fixtures", "channels-geo.json"), "w", encoding="utf-8") as f:
        json.dump(rows, f, ensure_ascii=False, separators=(",", ":"))

    cap_at = int(time.time())
    with open(os.path.join(HERE, "src", "data", "seed-nodes.js"), "w", encoding="utf-8") as f:
        f.write("/* Real mempool.space snapshot, 2026-11-16: the globe's node sample, taken from\n"
                "   the channels-geo graph and completed from nodes/{pubkey}. Fallback only. */\n")
        f.write("var NODE_SEED = " + json.dumps({
            "fetchedAt": cap_at,
            "channelRows": len(links),
            "nodes": nodes,
        }, ensure_ascii=False, separators=(",", ":")) + ";\n")
    with open(os.path.join(HERE, "src", "data", "channels-data.js"), "w", encoding="utf-8") as f:
        f.write("/* Real open Lightning channels from mempool.space/api/v1/lightning/channels-geo,\n"
                "   captured 2026-11-16. Only channels whose two endpoints are both in the node\n"
                "   snapshot above, so the offline globe never draws an invented link. */\n")
        f.write("var CHANNEL_SEED = " + json.dumps({
            "capturedAt": cap_at,
            "source": "https://mempool.space/api/v1/lightning/channels-geo",
            "rows": len(rows),
            "links": [[a, b] for (a, b) in inner],
        }, ensure_ascii=False, separators=(",", ":")) + ";\n")

    print("nodes in snapshot:", len(nodes))
    for n in nodes:
        print("  %-30s %-3s deg=%-3d ch=%s" % (n["alias"][:30], n["iso"], n["deg"], n["channels"]))
    print("written: fixtures/, src/data/seed-nodes.js, src/data/channels-data.js")


if __name__ == "__main__":
    main()
