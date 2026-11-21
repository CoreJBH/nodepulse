#!/usr/bin/env python3
"""Build the bundled Bitcoin L1 (Bitnodes) snapshot: src/data/l1-data.js + fixtures/l1-snapshot.json

Bitnodes (bitnodes.io, now btcnodes.io) publishes the crawler export of reachable
Bitcoin P2P nodes. Three cheap endpoints carry what the globe needs:

  /api/v1/snapshots/latest/                 total_nodes, latest_height, compact 5-field nodes
  /api/v1/snapshots/latest/?field=coordinates   unique latitude/longitude pairs
  /api/v1/snapshots/latest/?field=top           top ASNs and top user agents (client versions)

The paginated node list (/api/v1/nodes/?limit=1000) is used here, at build time, to
aggregate the country counts and the coordinate -> country map: that is the only place
Bitnodes exposes per-node location, and pulling 20+ MB on a phone would be wrong.

Everything written here is a value Bitnodes reported; nothing is estimated.
"""
import json
import os
import time
import urllib.request
import concurrent.futures as cf

HERE = os.path.dirname(os.path.abspath(__file__))
UA = {"User-Agent": "Mozilla/5.0 (compatible; nodepulse/1.1; +https://github.com/CoreJBH/nodepulse)"}
BASE = "https://bitnodes.io"
PAGE = 1000


def get(path, tries=3):
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(BASE + path, headers=UA)
            with urllib.request.urlopen(req, timeout=120) as r:
                return json.loads(r.read())
        except Exception as e:  # noqa: BLE001 - retry any transport error
            last = e
            time.sleep(2 + i * 3)
    raise last


def main():
    latest = get("/api/v1/snapshots/latest/")
    coords = get("/api/v1/snapshots/latest/?field=coordinates")
    top = get("/api/v1/snapshots/latest/?field=top")

    total = latest["total_nodes"]
    height = latest["latest_height"]
    stamp = latest["timestamp"]
    meta = latest.get("metadata") or {}

    # ---- the full node list, page by page: country counts + coordinate -> country ----
    first = get("/api/v1/nodes/?limit=%d&page=1" % PAGE)
    count = first["count"]
    pages = max(1, -(-count // PAGE))
    rows = list(first.get("results") or [])
    print("nodes %d, %d pages" % (count, pages))

    def page(n):
        return get("/api/v1/nodes/?limit=%d&page=%d" % (PAGE, n))

    if pages > 1:
        with cf.ThreadPoolExecutor(3) as ex:
            for n, res in enumerate(ex.map(page, range(2, pages + 1)), start=2):
                rows.extend(res.get("results") or [])
                print("  page %d/%d  rows %d" % (n, pages, len(rows)))

    countries = {}
    country_names = {}
    versions = {}
    platforms = {"tor": 0, "i2p": 0, "clearnet": 0}
    coord_country = {}
    for r in rows:
        iso = r.get("country") or ""
        if iso == "n/a":
            iso = ""          # Bitnodes' own placeholder for a node it could not locate
        if iso:
            countries[iso] = countries.get(iso, 0) + 1
            name = r.get("country_name")
            if name and name != "n/a":
                country_names.setdefault(iso, name)
        ua = r.get("user_agent") or "n/a"
        versions[ua] = versions.get(ua, 0) + 1
        addr = r.get("address") or ""
        if addr.endswith(".onion"):
            platforms["tor"] += 1
        elif addr.endswith(".i2p"):
            platforms["i2p"] += 1
        else:
            platforms["clearnet"] += 1
        lat, lon = r.get("lat"), r.get("lon")
        # Bitnodes reports 0.0/0.0 for nodes it cannot geolocate (Tor/I2P); not a place.
        if isinstance(lat, (int, float)) and isinstance(lon, (int, float)) and (lat or lon):
            if iso:
                coord_country["%.4f,%.4f" % (lat, lon)] = iso

    # the coordinate endpoint is the authoritative unique-location set Bitnodes publishes
    live_coords = coords.get("coordinates") or []
    coord_list = [[round(float(a), 4), round(float(b), 4)] for a, b in live_coords]

    top_asns = (top.get("top") or {}).get("top_asns") or []
    top_ua = (top.get("top") or {}).get("top_user_agents") or []

    out = {
        "capturedAt": stamp,
        "source": "https://bitnodes.io/api/v1/snapshots/latest/",
        "totalNodes": total,
        "reachableNodes": meta.get("reachable_nodes"),
        "height": height,
        "round": {"complete": bool(meta.get("complete")), "validatedAt": meta.get("validated_at")},
        "countries": sorted(countries.items(), key=lambda kv: (-kv[1], kv[0])),
        "countryNames": country_names,
        "coordCount": len(coord_list),
        "coords": coord_list,
        "coordCountry": coord_country,
        "userAgents": top_ua,
        "topAsns": top_asns,
        "versions": sorted(versions.items(), key=lambda kv: (-kv[1], kv[0]))[:24],
        "platforms": platforms,
        "sampleNodes": len(rows),
    }

    data_dir = os.path.join(HERE, "src", "data")
    with open(os.path.join(data_dir, "l1-data.js"), "w", encoding="utf-8") as f:
        f.write("/* Real Bitnodes L1 snapshot, captured %s (unix %d): %s reachable Bitcoin\n"
                "   P2P nodes, their country counts, unique reported coordinates and client\n"
                "   versions. Fallback only: the app fetches the live Bitnodes endpoints.\n"
                "   Built by fetch_l1.py from bitnodes.io/api/v1 - no value is estimated. */\n"
                % (time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime(stamp)), stamp, format(total, ","),))
        f.write("var L1_SNAPSHOT = ")
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
        f.write(";\n")

    os.makedirs(os.path.join(HERE, "fixtures"), exist_ok=True)
    with open(os.path.join(HERE, "fixtures", "l1-snapshot.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False)

    print("total %d  height %d  countries %d  coords %d  versions %d"
          % (total, height, len(out["countries"]), len(coord_list), len(out["versions"])))
    print("tor %d  i2p %d  clearnet %d" % (platforms["tor"], platforms["i2p"], platforms["clearnet"]))


if __name__ == "__main__":
    main()
