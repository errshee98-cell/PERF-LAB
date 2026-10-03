import * as nplus from './nplusone.js';
import * as indexing from './indexing.js';
import * as algos from './algorithms.js';
import * as caching from './caching.js';
import * as payload from './payload.js';
import { round } from '../lib/stats.js';

/**
 * One representative slow-vs-fast comparison per lab. Shared by the dashboard
 * (GET /api/overview) and the CLI benchmark (npm run bench).
 */
export async function runOverview(db, { rtt = 0.5 } = {}) {
  const rows = [];
  const push = (lab, problem, fix, slow, fast, slowDetail, fastDetail, same) =>
    rows.push({ lab, problem, fix, slowMs: round(slow), fastMs: round(fast), speedup: round(slow / Math.max(fast, 0.001), 1), slowDetail, fastDetail, sameResult: same });

  {
    const s = await nplus.run(db, { mode: 'naive', limit: 100, rtt });
    const f = await nplus.run(db, { mode: 'batched', limit: 100, rtt });
    push('n-plus-one', 'N+1 queries (100 orders)', 'Batch loading with IN (…)', s.metrics.projectedMs, f.metrics.projectedMs,
      `${s.metrics.queries} queries`, `${f.metrics.queries} queries`, s.checksum === f.checksum);
  }
  {
    const s = await indexing.run(db, { scenario: 'feed', variant: 'slow', iterations: 10 });
    const f = await indexing.run(db, { scenario: 'feed', variant: 'fast', iterations: 10 });
    push('indexing', 'Missing index (activity feed, avg/query)', 'Composite index (user_id, created_at)', s.timing.avg, f.timing.avg,
      s.plan.map((p) => p.detail).join(' → '), f.plan.map((p) => p.detail).join(' → '), s.checksum === f.checksum);
  }
  {
    const s = await indexing.run(db, { scenario: 'pagination', variant: 'slow', iterations: 10 });
    const f = await indexing.run(db, { scenario: 'pagination', variant: 'fast', iterations: 10 });
    push('indexing', 'Deep OFFSET pagination (avg/page)', 'Keyset pagination', s.timing.avg, f.timing.avg, 'OFFSET 150,000', 'WHERE id > ?', s.checksum === f.checksum);
  }
  for (const algo of ['dedupe', 'topk', 'autocomplete', 'membership']) {
    const s = algos.run({ algo, variant: 'slow' });
    const f = algos.run({ algo, variant: 'fast' });
    const c = algos.CASES[algo];
    push('algorithms', `${c.title} (n=${s.n.toLocaleString()})`, c.fastLabel, s.ms, f.ms, c.slowComplexity, c.fastComplexity, s.checksum === f.checksum);
  }
  {
    caching.reset();
    const s = await caching.warmSeries(db, { mode: 'none', requests: 8 });
    const f = await caching.warmSeries(db, { mode: 'smart', requests: 8 });
    push('caching', 'Expensive report ×8 requests', 'LRU + TTL + SWR cache', s.totalMs, f.totalMs, '8 computations', '1 computation, 7 hits', true);
    const ss = await caching.stampede(db, { mode: 'naive', concurrency: 10 });
    const fs = await caching.stampede(db, { mode: 'smart', concurrency: 10 });
    push('caching', 'Cache stampede (10 concurrent, cold)', 'Single-flight request coalescing', ss.wallMs, fs.wallMs,
      `${ss.computations} computations`, `${fs.computations} computation`, true);
  }
  {
    const cmp = payload.compare(db);
    const fat = cmp.rows[0];
    const page = cmp.rows[3];
    const br = page.encodings.find((e) => e.encoding === 'br-4');
    rows.push({
      lab: 'payload', problem: 'Product list payload (bytes)', fix: 'Projection + pagination + brotli',
      slowMs: null, fastMs: null, slowBytes: fat.raw, fastBytes: br.bytes, speedup: round(fat.raw / br.bytes, 1),
      slowDetail: `${(fat.raw / 1024).toFixed(0)} KB`, fastDetail: `${(br.bytes / 1024).toFixed(1)} KB`, sameResult: null,
    });
  }
  return rows;
}
