import { SmartCache } from '../lib/cache.js';
import { round } from '../lib/stats.js';
import { measure } from '../lib/measure.js';

/**
 * LAB 4 — No caching
 *
 * An expensive analytics report (~120k-row join + GROUP BY for one year, ~0.5 s) that every dashboard
 * load requests. Three strategies:
 *
 *   none   — recompute on every request
 *   naive  — plain TTL map. Fast when warm, but on a cold/expired key N
 *            concurrent requests all miss and all recompute (cache stampede).
 *   smart  — LRU + TTL + stale-while-revalidate + single-flight + tag
 *            invalidation + ETag/304 + Cache-Control for the browser.
 */
export const MODES = ['none', 'naive', 'smart'];

export const caches = {
  naive: new SmartCache({ ttlMs: 15_000, swrMs: 0, singleFlight: false }),
  smart: new SmartCache({ ttlMs: 15_000, swrMs: 60_000, singleFlight: true }),
};

let computations = 0;

const REPORT_SQL = `
  SELECT cat.name AS category,
         strftime('%Y-%m', o.created_at, 'unixepoch') AS month,
         COUNT(*) AS line_items,
         SUM(oi.quantity * oi.unit_price_cents) AS revenue_cents
  FROM orders o
  JOIN order_items oi ON oi.order_id = o.id
  JOIN products p     ON p.id = oi.product_id
  JOIN categories cat ON cat.id = p.category_id
  -- sargable range on created_at (uses idx_orders_created); wrapping the column
  -- in strftime() here would force a full scan
  WHERE o.status <> 'cancelled' AND o.created_at >= ? AND o.created_at < ?
  GROUP BY category, month
  ORDER BY month, category`;

/** The expensive thing. Async because real reports wait on I/O; yields once so concurrency is real. */
export const DEFAULT_YEAR = '2025';

export async function computeReport(db, year = DEFAULT_YEAR) {
  await new Promise((r) => setImmediate(r));
  computations++;
  const rows = db.all(REPORT_SQL, Date.UTC(+year, 0, 1) / 1000, Date.UTC(+year + 1, 0, 1) / 1000);
  const byCategory = new Map();
  const byMonth = new Map();
  for (const r of rows) {
    byCategory.set(r.category, (byCategory.get(r.category) ?? 0) + r.revenue_cents);
    byMonth.set(r.month, (byMonth.get(r.month) ?? 0) + r.revenue_cents);
  }
  return {
    year,
    rows: rows.length,
    topCategories: [...byCategory].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([category, revenueCents]) => ({ category, revenueCents })),
    monthly: [...byMonth].map(([month, revenueCents]) => ({ month, revenueCents })),
  };
}

const key = (year) => `report:${year}`;

export async function getReport(db, mode, year = DEFAULT_YEAR) {
  if (mode === 'none') {
    const value = await computeReport(db, year);
    return { value, status: 'BYPASS', etag: null, ageMs: 0 };
  }
  return caches[mode].getOrCompute(key(year), () => computeReport(db, year), { tags: ['orders'] });
}

/** HTTP handler: adds ETag / Cache-Control so the *browser* can cache too. */
export async function handleReport(db, req, { mode, year }) {
  const { result: r, metrics } = await measure(() => getReport(db, mode, year));
  const headers = { 'x-cache': r.status };
  if (mode === 'smart') {
    headers.etag = r.etag;
    headers['cache-control'] = 'private, max-age=0, must-revalidate';
    if (req.headers['if-none-match'] === r.etag) return { status: 304, headers, body: undefined };
  } else {
    headers['cache-control'] = 'no-store';
  }
  return { headers, compress: true, body: { lab: 'caching', mode, cache: r.status, ageMs: r.ageMs, metrics, data: r.value } };
}

/** Fire `concurrency` simultaneous requests at a COLD cache and count real computations. */
export async function stampede(db, { mode, concurrency = 10 }) {
  if (caches[mode]) caches[mode].clear();
  const before = computations;
  const t0 = performance.now();
  const results = await Promise.all(Array.from({ length: concurrency }, () => getReport(db, mode)));
  const statuses = results.reduce((acc, r) => ((acc[r.status] = (acc[r.status] ?? 0) + 1), acc), {});
  return {
    lab: 'caching',
    mode,
    concurrency,
    computations: computations - before,
    wallMs: round(performance.now() - t0),
    statuses,
  };
}

/** Sequential traffic: first request misses, the rest should hit. */
export async function warmSeries(db, { mode, requests = 8 }) {
  if (caches[mode]) caches[mode].clear();
  const samples = [];
  for (let i = 0; i < requests; i++) {
    const t = performance.now();
    const r = await getReport(db, mode);
    samples.push({ i, ms: round(performance.now() - t), status: r.status });
  }
  return { mode, samples, totalMs: round(samples.reduce((a, s) => a + s.ms, 0)) };
}

/** A write happened → evict everything derived from orders. */
export function invalidate() {
  return { evicted: { naive: caches.naive.invalidateTag('orders'), smart: caches.smart.invalidateTag('orders') } };
}

export function stats() {
  return { computations, naive: caches.naive.snapshot(), smart: caches.smart.snapshot() };
}

export function reset() {
  for (const c of Object.values(caches)) {
    c.clear();
    c.resetStats();
  }
  computations = 0;
}
