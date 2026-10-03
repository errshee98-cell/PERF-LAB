import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import * as nplus from '../src/labs/nplusone.js';
import * as indexing from '../src/labs/indexing.js';
import * as algos from '../src/labs/algorithms.js';
import * as caching from '../src/labs/caching.js';
import * as payload from '../src/labs/payload.js';
import { SmartCache } from '../src/lib/cache.js';
import { Heap } from '../src/lib/heap.js';

// An optimization that changes the answer is a bug, not an optimization.
// These tests pin slow ≡ fast for every lab.

let db;
before(() => {
  db = openDatabase({ file: ':memory:', scale: 0.05, log: null });
});
after(() => db.close());

describe('N+1', () => {
  test('naive, batched and join return identical data', async () => {
    const [a, b, c] = await Promise.all(nplus.MODES.map((mode) => nplus.run(db, { mode, limit: 40, rtt: 0 })));
    assert.equal(a.checksum, b.checksum);
    assert.equal(a.checksum, c.checksum);
    assert.equal(a.orders, 40);
  });

  test('batched issues a constant number of queries; join issues one', async () => {
    const small = await nplus.run(db, { mode: 'batched', limit: 5 });
    const big = await nplus.run(db, { mode: 'batched', limit: 80 });
    assert.equal(small.metrics.queries, 5);
    assert.equal(big.metrics.queries, 5);
    assert.equal((await nplus.run(db, { mode: 'join', limit: 80 })).metrics.queries, 1);
    const naive = await nplus.run(db, { mode: 'naive', limit: 80 });
    assert.ok(naive.metrics.queries > 80 * 2, `naive should be N+1, got ${naive.metrics.queries}`);
  });
});

describe('Indexing', () => {
  for (const scenario of Object.keys(indexing.SCENARIOS)) {
    test(`${scenario}: same rows with and without the fix`, async () => {
      const s = await indexing.run(db, { scenario, variant: 'slow', iterations: 5 });
      const f = await indexing.run(db, { scenario, variant: 'fast', iterations: 5 });
      assert.equal(s.checksum, f.checksum);
    });
  }

  test('plans: scan without index, search with index', async () => {
    const s = await indexing.run(db, { scenario: 'feed', variant: 'slow', iterations: 1 });
    const f = await indexing.run(db, { scenario: 'feed', variant: 'fast', iterations: 1 });
    assert.match(s.plan.map((p) => p.detail).join('\n'), /SCAN events_noidx/);
    assert.match(f.plan.map((p) => p.detail).join('\n'), /SEARCH events USING INDEX idx_events_user_created/);
    const w = await indexing.run(db, { scenario: 'window', variant: 'fast', iterations: 1 });
    assert.match(w.plan[0].detail, /COVERING INDEX/);
  });

  test('advisor suggests a composite index for a full scan', () => {
    const out = indexing.explainUserSql(db, 'SELECT * FROM events_noidx WHERE user_id = 5 ORDER BY created_at');
    const crit = out.advice.find((a) => a.suggestion?.startsWith('CREATE INDEX'));
    assert.ok(crit);
    assert.match(crit.suggestion, /events_noidx\(user_id, created_at\)/);
  });

  test('explain rejects non-SELECT statements', () => {
    assert.throws(() => indexing.explainUserSql(db, 'DELETE FROM events'), /Only SELECT/);
    assert.throws(() => indexing.explainUserSql(db, 'SELECT 1; DROP TABLE events'), /One statement/);
  });
});

describe('Algorithms', () => {
  for (const algo of Object.keys(algos.CASES)) {
    test(`${algo}: slow ≡ fast`, () => {
      const n = algos.CASES[algo].scaling[0];
      assert.equal(algos.run({ algo, variant: 'slow', n }).checksum, algos.run({ algo, variant: 'fast', n }).checksum);
    });
  }
  test('guard rejects runaway O(n²) inputs', () => {
    assert.throws(() => algos.run({ algo: 'dedupe', variant: 'slow', n: 100_000 }), /too long/);
  });
  test('heap yields sorted output', () => {
    const h = new Heap((a, b) => a - b);
    [5, 1, 9, 3, 7, 2].forEach((x) => h.push(x));
    assert.deepEqual([1, 2, 3, 5, 7, 9], Array.from({ length: 6 }, () => h.pop()));
  });
});

describe('Caching', () => {
  test('stampede: naive recomputes per request, smart computes once', async () => {
    caching.reset();
    const naive = await caching.stampede(db, { mode: 'naive', concurrency: 12 });
    const smart = await caching.stampede(db, { mode: 'smart', concurrency: 12 });
    assert.equal(naive.computations, 12);
    assert.equal(smart.computations, 1);
    assert.equal(smart.statuses.COALESCED, 11);
  });

  test('cached report equals uncached report', async () => {
    caching.reset();
    const a = await caching.getReport(db, 'none');
    const b = await caching.getReport(db, 'smart');
    assert.deepEqual(a.value, b.value);
  });

  test('TTL → stale-while-revalidate → refresh, with a fake clock', async () => {
    let now = 0;
    let calls = 0;
    const c = new SmartCache({ ttlMs: 100, swrMs: 100, now: () => now });
    const load = async () => ++calls;
    assert.equal((await c.getOrCompute('k', load)).status, 'MISS');
    now = 50;
    assert.equal((await c.getOrCompute('k', load)).status, 'HIT');
    now = 150;
    const stale = await c.getOrCompute('k', load);
    assert.equal(stale.status, 'STALE');
    assert.equal(stale.value, 1); // old value served instantly…
    await new Promise((r) => setImmediate(r));
    assert.equal((await c.getOrCompute('k', load)).value, 2); // …fresh one after background refresh
    now = 1000;
    assert.equal((await c.getOrCompute('k', load)).status, 'MISS'); // past swr window
  });

  test('LRU eviction and tag invalidation', async () => {
    const c = new SmartCache({ max: 2 });
    await c.getOrCompute('a', async () => 1, { tags: ['t'] });
    await c.getOrCompute('b', async () => 2, { tags: ['t'] });
    await c.getOrCompute('a', async () => 1); // touch a → b is now LRU
    await c.getOrCompute('c', async () => 3);
    assert.deepEqual(c.snapshot().keys.map((k) => k.key).sort(), ['a', 'c']);
    assert.equal(c.invalidateTag('t'), 1);
    assert.equal(c.snapshot().size, 1);
  });

  test('failed computation is not cached and does not wedge single-flight', async () => {
    const c = new SmartCache();
    await assert.rejects(c.getOrCompute('x', async () => { throw new Error('boom'); }));
    assert.equal((await c.getOrCompute('x', async () => 42)).value, 42);
  });
});

describe('Payload', () => {
  test('lean pagination walks every product exactly once', () => {
    const total = db.get('SELECT COUNT(*) AS n FROM products').n;
    const seen = new Set();
    let cursor = 0;
    while (cursor != null) {
      const page = payload.leanPage(db, { cursor, limit: 17 });
      page.items.forEach((p) => seen.add(p.id));
      cursor = page.nextCursor;
    }
    assert.equal(seen.size, total);
  });

  test('lean is an order of magnitude smaller', () => {
    const { rows } = payload.compare(db);
    assert.ok(rows[0].raw > rows[2].raw * 10);
  });
});
