import json, urllib.request, time, concurrent.futures as cf

UA={"User-Agent":"Mozilla/5.0 (compatible; bitcoin-network-monitor/1.0)"}
def get(u):
    return json.load(urllib.request.urlopen(urllib.request.Request(u,headers=UA),timeout=30))

conn=get("https://mempool.space/api/v1/lightning/nodes/rankings/connectivity")
liq=get("https://mempool.space/api/v1/lightning/nodes/rankings/liquidity")
seen=set(); pick=[]
for n in conn[:14]+liq[:10]+conn[14:22]:
    k=n["publicKey"]
    if k in seen: continue
    seen.add(k); pick.append(n)

def detail(n):
    try:
        d=get("https://mempool.space/api/v1/lightning/nodes/"+n["publicKey"])
        return dict(publicKey=n["publicKey"], alias=n["alias"], iso=n.get("iso_code"),
                    channels=n.get("channels"), capacity=n.get("capacity"),
                    lat=d.get("latitude"), lon=d.get("longitude"),
                    city=(n.get("city") or {}).get("en"),
                    country=(n.get("country") or {}).get("en"),
                    as_org=d.get("as_organization"))
    except Exception as e:
        return dict(publicKey=n["publicKey"], alias=n["alias"], error=str(e))

with cf.ThreadPoolExecutor(8) as ex:
    out=list(ex.map(detail, pick))
ok=[o for o in out if o.get("lat") is not None]
print("picked",len(pick),"with geo",len(ok))
for o in out: print(" ", o.get("alias","")[:26], o.get("iso"), o.get("lat"), o.get("lon"), o.get("error",""))
json.dump({"fetched_at":int(time.time()),"nodes":ok}, open("nodes-seed.json","w"), ensure_ascii=False, indent=1)
