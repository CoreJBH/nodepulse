# NodePulse — on-demand clustering API

`src/js/35-cluster.js` is the engine behind the **ENTITIES / Whale Watch** tab. It takes the
public addresses an entity is known by, reads their recent transactions from the mempool
mirrors, and answers the one question the tab needs: *which addresses belong to the same
owner, and how sure are we?*

The module adds one name to the application scope, `Cluster`. It runs nothing at load, opens
no socket until a caller asks for one, and is loaded like every other module (one script
block, joined by `build.py` in file-name order, so there is no registration step and no
second copy to drift). The only hosts it contacts are the three already named in the
Content-Security-Policy: `mempool.space`, `mempool.emzy.de`, `mempool.ninja`.

```js
var res = await Cluster.analyzeEntity(
  [{ address: 'bc1q…', verified: true, label: 'U.S. Marshals', source: 'USMS disclosure' }],
  { maxTxsPerAddress: 20, onProgress: function (p) { paintProgress(p); } }
);
```

---

## 1. Labels

Every address in a result carries exactly one of three labels, and they are never averaged
into a single "confidence" number:

| Label | Meaning | Where it comes from |
| --- | --- | --- |
| `Verified` | The entity table attests this address on a proof of ownership (a self-published list, a court record, the chain itself). | `verified: true` on the seed the caller passed |
| `Attributed` | The entity table lists this address on an analytics attribution — a claim of ownership, not a proof. | `verified: false` on a seed the caller passed |
| `Common-Input` | Spent as an input together with an address the entity owns. | Common-input-ownership heuristic |
| `Change Est.` | An output read as the owner's change. Shown as an estimate, never as a balance fact. | Change heuristic (section 4) |

`Cluster.labels` holds these strings, so the UI never writes them by hand.

A seed that is not `verified` is `Attributed`, never `Common-Input`: the heuristic discovered
common-input addresses, and an address the table already listed was not discovered by it.
A cluster's own `label` is `Verified` when it holds at least one verified seed, `Attributed`
when its seeds are attributed, and otherwise `Common-Input`.

## 2. `Cluster.analyzeEntity(addresses, options) -> Promise<result>`

The on-demand entry point. One run at a time: calling it again cancels the run in flight.

### `addresses`

An array of strings or objects:

```js
{ address: 'bc1q…', verified: true, label: 'U.S. Marshals', source: 'USMS disclosure' }
```

`address` is checked for shape before it can reach a URL; duplicates, empty strings and
malformed addresses are dropped. `label` and `source` are passed through onto the result's
address rows as `entityLabel` / `entitySource` so a card can cite the table it came from.
`verified` defaults to `false`; an entity table should set it to `true` only for addresses
its own source attests.

### `options`

| Option | Default | Meaning |
| --- | --- | --- |
| `maxTxsPerAddress` | `20` | Transactions read per address (1–25). The endpoint returns newest first, so a cap keeps the recent history. |
| `maxApiCalls` | `18` | Hard ceiling on GETs for the whole run (4–40). Cached answers cost nothing. |
| `maxAddresses` | `40` | Seeds analyzed per run (1–40). |
| `ttlMs` | `7 min` | How long a saved answer stays fresh (1–15 min). |
| `signal` | — | An `AbortSignal` from the caller; aborting it cancels the run. |
| `onProgress` | — | Called with `{phase, done, total, address, calls, cacheHits}`. |

`phase` is one of `start`, `summary`, `txs`, `done`, `aborted`.

### `result`

```js
{
  ok: true,                 // false only when no usable address was given
  aborted: false,           // cancelCluster() or the caller's signal stopped it
  truncated: false,         // a cap (transactions, addresses or API calls) cut the scan
  rateLimited: false,       // a mirror answered 429 and the run stopped asking
  error: '',                // the last non-abort failure, for the footnote
  clusters: [ … ],          // one per owner found, see below
  addresses: [ … ],          // the same rows, flat
  change: [ … ],             // change estimates, kept out of the clusters
  shared: [ … ],             // shared-input transactions the merges came from
  coinjoin: [ … ],           // excluded transactions, with the reason (up to 40)
  coinjoinExcluded: 3,       // how many were excluded in total
  entity: { total, verified, balance, balanceKnown,
            attributed, attributedBalance, attributedKnown },
  stats: { addresses, read, txs, scanned, newest, maxTxsPerAddress, maxApiCalls },
  api: { calls, cacheHits, failed, elapsedMs, source },   // source: live | cache | mixed | none
  at: Date.now()
}
```

A cluster:

```js
{
  id: 0,
  label: 'Verified',
  size: 3,
  verified: 1,          // addresses attested by the entity table
  heuristic: 2,         // addresses joined by common input
  addresses: [{ address, verified, label, clusterId, balance, txCount, source, at }],
  balance: 150000000,   // sats, summed over the members whose balance was read
  balanceKnown: 2       // how many members that balance covers
}
```

A change estimate:

```js
{
  txid: '…', address: 'bc1q…', value: 199768, score: 5, peer: 1,
  why: ['script type matches the inputs', 'output address unseen before this transaction',
        'the other output is a round amount'],
  at: 1700000000000, clusterId: 0
}
```

`api.source` is the honest summary of where the figures came from: `live` (every figure was
read during this run), `cache` (all from the saved answers), `mixed`, or `none` (nothing
could be read — show the balances as unknown, not as zero).

`entity.balance` is the **Verified** part only: the sum of the seeded addresses whose
balance was read in this run, and the seeds the caller marked `verified`. A seed that was
not verified is summed into `entity.attributedBalance` and counted in `entity.attributed`,
so a card can print the word the table supports (`Verified` or `Attributed`) without ever
calling an attribution a proof. A card that shows a total adds the estimate the run read
(`change[]` plus the `Common-Input` balances) and prints the split (§8).

`api.source` is honest about a run that read nothing: when every request failed, `calls` is
above zero but `source` is `none`, not `live`.

### Failure modes

The promise does not reject because a mirror was down, a rate limit was hit or the run was
cancelled: those are states the tab has to display, so they come back in the result. It
rejects only for a caller error (an address string so malformed it cannot be read — none of
the seeds could be normalized), and even that case resolves with `ok: false` when the array
is empty rather than throwing.

`balance: null` means *not read*, `0` means *read as zero*. Do not print `—` for one and
`0 BTC` for the other without saying which.

## 3. Common-input ownership

Every transaction is read once, oldest first. Its non-coinbase input addresses that can
carry coins are one owner's, so they are unioned into one cluster — but only when at least
one of those inputs is already the entity's. A transaction where the entity appears only
among the outputs is somebody *paying* it; merging there would hand the entity the payer's
coins, so it is skipped.

Addresses discovered this way are **`Common-Input`**, never `Verified`. The scan does not
follow them further: their own transaction lists are not fetched, so the engine's reach is
one hop from the seeds, bounded by `maxApiCalls`.

## 4. Change estimation

A change output is asserted only when the reading is unambiguous. Requirements, all of them:

1. Exactly two payable outputs (OP_RETURN, anchor and provably-unspendable outputs are not
   payable).
2. The two outputs share one script type.
3. One output scores at least 3 points and leads the other by at least 1:

| Signal | Points |
| --- | --- |
| Script type matches the dominant input type | +2 |
| Address not seen earlier in this scan | +1 |
| The other output is a round amount (whole 0.001 / 0.0001 BTC) | +2 |
| Address already seen in this scan | −1 |
| The address is already an input of this transaction | −3 |
| This output itself is the round amount | −2 |

A three-output transaction, a mixed-type pair, two equally plausible outputs or two round
outputs produce no estimate at all. A change estimate is recorded in `change[]` and attached
to the cluster of the inputs that produced it (`clusterId`), but it **never joins the
cluster**: a wrong estimate must not be able to pull a merchant's coins into the entity
through a later merge. It is summed into the entity's displayed total as its own `Est.`
part, with the verified figure printed beside it (§8), and never into the verified figure.

## 5. CoinJoin exclusion

A transaction is excluded from merging (and from change estimation) when any of these holds:

* three or more outputs carry the same amount;
* 10 or more input addresses fan into 10 or more output addresses;
* 5 or more inputs, 5 or more outputs and two or more equal amounts;
* it carries more than 500 inputs or outputs — a dust or batch shape that cannot be read
  whole on a phone, judged by the totals the API declared.

Excluded transactions are counted in `coinjoinExcluded`, and the first 40 are listed with
the reason in `coinjoin[]`. The bias is deliberate: excluding an ordinary transaction only
loses a possible merge, while merging across a coinjoin would join unrelated owners for
good.

## 6. Network, budgets and cache

* One GET at a time, spaced by 120 ms, through `mempool.space` → `mempool.emzy.de` →
  `mempool.ninja`, then the native bridge when the app runs inside the Android shell.
* A 4xx (other than 429) stops the rotation for that address — it is the address's fault,
  not the mirror's — and the address is marked dead for the rest of the run.
* 429 falls to the next mirror; if every mirror is limited, the run stops asking and reports
  `rateLimited: true` with what it has.
* One GET is bounded at 12 s, and a whole run at 60 s.
* Answers are cached in `localStorage` under `nodepulse.cluster.v1`, with the summary and the
  transaction list dated separately (`st`, `xt`). A fresh part costs no API call. The cache
  keeps at most 24 addresses and 2 MB, evicting the oldest; a transaction list with a
  dust-size fan-out is analyzed but not saved, so a cache entry is always the whole list the
  live run saw.

### Cancel

```js
Cluster.cancelCluster();   // true when a run was stopped
```

It aborts the in-flight socket, not just the wait, and the pending promise resolves with
`aborted: true` and whatever was collected so far. `Cluster.running()` tells a badge whether
to keep spinning.

## 7. Other functions

| Call | Purpose |
| --- | --- |
| `Cluster.fetchAddressSummary(address, {ttlMs, fresh, signal})` | One address's balance and tx count, cached for the same TTL. Use it when a card opens without a full run. |
| `Cluster.analyzeTxs(seeds, lists)` | The pure core: no network, no storage. `lists` is `[{address, txs}]` with transactions in `compressTx()` shape. This is what the unit tests drive. |
| `Cluster.compressTx(tx)` | One mempool.space transaction reduced to the fields the heuristics read (500 rows per side; the declared totals and a `part` flag say when a transaction was cut). |
| `Cluster.detectCoinJoin(tx)` / `Cluster.estimateChange(tx, {seen})` | The two heuristics on their own, for a transaction card. |
| `Cluster.lastResult()` | The last finished result (for a re-render without another run). |
| `Cluster.clearCache()` | Drops the saved answers. |
| `Cluster.limits()` | The defaults and ceilings above, for a settings row. |

## 8. Display rules

* Show `Verified`, `Attributed`, `Common-Input` and `Change Est.` as separate badges, and
  never print a seed the caller passed as `Verified` unless it was marked so.
  Print any total that includes an estimate as the total **with its two parts beside it** —
  for example `TOTAL 413,475.9984 BTC · Verified 413,475.9894 BTC · Est. 0.00900001 BTC`.
  The estimate part is the balance of the `Common-Input` addresses the run actually read plus
  the change outputs it read, each address counted once and never twice. The verified figure
  is never overwritten by an estimate: the sum is what the ranking and the HUD use, and the
  split is always printed on the same line or the line under it.
* An entity whose table entry is an analytics attribution prints `Attributed` where a proven
  entity prints `Verified` — on the run's total line, on the address badges, and in the
  held-total breakdown. The word and the figure come from the same field.
* The same rule covers an estimate the entity table publishes without a run — the Patoshi
  pattern (~1.1M BTC) on Satoshi's card. It is added to that entity's held total, the card
  reads `Verified 109.52 BTC + Patoshi Est. ~1.1M BTC` beside the sum, and the top
  `HELD BTC` figure and the category ranking add the same parts.
* Show `coinjoinExcluded` as its own count ("3 coinjoins skipped"), not as missing data.
* When `truncated`, `rateLimited` or `api.source === 'none'`, say which — "unverified, rate
  limited" is an honest answer; a stale number presented as live is not.
* An address whose balance was not read contributes nothing to the estimate. A figure that
  was assumed is not a figure that was read.
* All figures are sats or BTC, and any fiat figure is USD. The app is English only.

## 9. Tests

```bash
node test/cluster.js
```

This loads `00-core.js` and the module into one `vm` context exactly as `build.py` joins
them, with `fetch` and `localStorage` stubbed, and checks the heuristics, the caps, the
cancel path, the cache (hit, stale, poisoned) and the mirror fallback. It needs no browser,
no build and no network.
