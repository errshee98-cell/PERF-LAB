# ⚡ Perf Lab: a full-stack performance engineering lab

A hands-on lab that reproduces the most common real-world performance problems and fixes each one side by side. Both versions run against the same **~1M-row dataset**, and every fix is **checksum-verified to return identical results**.

| # | Lab | Problem | Fix | Typical speedup |
|---|-----|---------|-----|-----------------|
| 1 | **N+1 queries** | ORM-style lazy loading → ~800 round trips per request | DataLoader-style batching (`IN (…)` via `json_each`) or one `JOIN` | **40×** at 0.5 ms RTT |
| 2 | **Missing indexes** | Full table `SCAN` + temp B-tree sort on 250k rows | Composite / covering indexes, keyset pagination | **100–250×** |
| 3 | **Slow algorithms** | O(n²) nested loops, `filter` in `map`, `includes` in loops | Hash maps, Sets, min-heap top-k, binary-search prefix index | **25–280×** |
| 4 | **No caching** | 0.5 s report recomputed per request; cache stampede | LRU + TTL + stale-while-revalidate + single-flight + tag invalidation + ETag/304 | **9×** (repeat), N→1 computations |
| 5 | **Payload & network** | `SELECT *`, pretty JSON, no pagination or compression | Projection + keyset pages + brotli + ETag | **~2,500× fewer bytes** |
| 6 | **React rendering** | Every render re-filters, re-sorts and re-formats 5k rows into 5k DOM nodes | `useMemo`, `memo` + stable callbacks, `useDeferredValue`, windowing | Interactions in the tens of ms instead of seconds |
| 7 | **Load testing** | Single-request timing hides tail latency | Worker-thread load generator → RPS, p50/p95/p99, histogram | |

Plus: a **query-plan explorer and index advisor**, live **event-loop delay and per-route p95** metrics, `Server-Timing` headers on every response, live **Web Vitals** (LCP / CLS / INP / long tasks), route-level **code splitting** with hover prefetch, and immutable caching of hashed assets.

## Quick start

Requires **Node.js 22.13+** (uses the built-in `node:sqlite`; the server has **zero runtime dependencies**).

```bash
npm run setup     # installs client deps + generates the dataset (~10 s, ~60 MB SQLite file)
npm run dev       # API on :4000 + Vite on :5173  → open http://localhost:5173
```

Production mode (more realistic frontend numbers):

```bash
npm run build && npm start   # → http://localhost:4000
```

Other commands:

```bash
npm test          # proves slow ≡ fast for every lab, plus cache/heap unit tests
npm run bench     # every lab from the CLI; exits non-zero if any fix changes results
SEED_SCALE=0.2 npm --prefix server run seed   # smaller dataset for slow machines
```

Example `npm run bench` output:

```
problem                                         slow        fast       speedup  same result
N+1 queries (100 orders)                        490.6 ms    11.61 ms   42.3×    ✔
Missing index (activity feed, avg/query)        246.18 ms   0.99 ms    248.7×   ✔
Deep OFFSET pagination (avg/page)               6.34 ms     0.05 ms    126.8×   ✔
Find duplicate customer emails (n=3,000)        599.13 ms   2.13 ms    281.1×   ✔
Top 10 products by revenue (n=20,000)           727.23 ms   8.15 ms    89.2×    ✔
Prefix search (autocomplete) — 300 queries      1349.29 ms  50.01 ms   27×      ✔
Filter orders from blocked customers            73.95 ms    3.1 ms     23.9×    ✔
Expensive report ×8 requests                    3963.19 ms  433.14 ms  9.1×     ✔
Cache stampede (10 concurrent, cold)            7865.21 ms  1213.62 ms 6.5×     ✔
Product list payload (bytes)                    2898.6 KB   1.1 KB     2599.1×  —
```

## Project layout

```
server/                    node:http + node:sqlite, no npm dependencies
  src/db.js                instrumented DB wrapper: per-request query count & time (AsyncLocalStorage),
                           prepared-statement cache
  src/seed.js              deterministic dataset: 2k products, 10k customers, 120k orders,
                           ~360k line items, 2×250k events (indexed / unindexed copies)
  src/labs/nplusone.js     naive vs batched vs join
  src/labs/indexing.js     scenarios + EXPLAIN QUERY PLAN explorer + index advisor
  src/labs/algorithms.js   4 slow/fast algorithm pairs + scaling curves
  src/labs/caching.js      none / naive TTL / smart cache, stampede + series demos
  src/labs/payload.js      bloated vs lean, encoding comparison
  src/lib/cache.js         SmartCache: LRU, TTL, SWR, single-flight, tags, ETags
  src/lib/http.js          router, compression, Server-Timing, metrics hook
  src/lib/metrics.js       per-route rolling p50/p95/p99 + event-loop delay
  src/lib/loadtest*.js     closed-loop load generator in a worker thread
  scripts/bench.js         CLI benchmark (CI-friendly)
  test/labs.test.js        node:test suite: equivalence + behaviour
client/                    React 18 + Vite, no UI libraries; dependency-free SVG charts
  src/labs/*.jsx           one lazy-loaded page per lab
```

## Why the numbers are honest

- **Same answer:** every slow/fast pair is compared by content hash, both in the UI and in `npm test`. An optimization that changes the result is a bug.
- **Network cost is projected, not faked.** SQLite is in-process, so N+1 looks cheaper than it is against a real database. The lab reports the measured time plus `queries × RTT` (adjustable). Real sleeps aren't used because Windows timer resolution (~15 ms) would distort them.
- **Load is generated in a separate thread**, so the generator doesn't steal the server's event loop.
- **Benchmark noise:** the algorithm scaling curves use the best of 3 runs; the index lab runs 20 different parameter values and reports percentiles.

## Things to try

1. **Indexes →** paste `SELECT * FROM orders WHERE status = 'paid' ORDER BY total_cents DESC LIMIT 10` into the explorer and read the advice.
2. **Caching →** run the stampede with 20 concurrent requests, then open **Overview** and look at the event-loop delay max.
3. **Rendering →** pick 10,000 rows on the slow table and type in the search box. Switch to the optimized table and type again.
4. **Load testing →** compare *O(n²) vs O(n)* at 50 users. One CPU-bound handler hurts every route.
