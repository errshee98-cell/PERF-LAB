import { rng as makeRng } from '../lib/rng.js';
import { Heap } from '../lib/heap.js';
import { checksum, round } from '../lib/stats.js';
import { HttpError } from '../lib/http.js';

/**
 * LAB 3 — Slow algorithms
 *
 * Each case has a "looks fine in code review" slow version and a fix with
 * better complexity. Same inputs, identical outputs (checked by checksum).
 * Inputs are generated deterministically and NOT included in the timing.
 */

const DOMAINS = ['example.com', 'mail.test', 'corp.dev', 'shop.io'];
const WORDS = ['swift', 'quiet', 'bold', 'nimble', 'lunar', 'solar', 'arctic', 'urban', 'classic', 'hyper', 'carbon', 'bamboo', 'steel', 'linen', 'walnut', 'speaker', 'lens', 'lamp', 'kettle', 'chair', 'watch', 'router', 'drone', 'desk'];

export const CASES = {
  dedupe: {
    title: 'Find duplicate customer emails',
    slowLabel: 'Nested loops, normalize inside the inner loop',
    fastLabel: 'Single pass with a hash map',
    slowComplexity: 'O(n²)',
    fastComplexity: 'O(n)',
    defaultN: 3000,
    maxSlowOps: 40e6,
    ops: (n) => (n * n) / 2,
    scaling: [500, 1000, 2000, 4000, 6000],
    input(n) {
      const r = makeRng(7);
      const base = Array.from({ length: n }, (_, i) => `${WORDS[i % WORDS.length]}.${i}@${DOMAINS[i % 4]}`);
      // ~5% duplicates that differ only by case / whitespace
      return base.map((email, i) => {
        if (i > 10 && r() < 0.05) {
          const src = base[Math.floor(r() * i)];
          return { id: i + 1, email: r() < 0.5 ? `  ${src.toUpperCase()} ` : src.replace(/^./, (c) => c.toUpperCase()) };
        }
        return { id: i + 1, email };
      });
    },
    slow(rows) {
      const dupes = [];
      for (let j = 0; j < rows.length; j++) {
        for (let i = 0; i < j; i++) {
          if (rows[i].email.trim().toLowerCase() === rows[j].email.trim().toLowerCase()) {
            dupes.push([rows[i].id, rows[j].id]);
            break;
          }
        }
      }
      return dupes;
    },
    fast(rows) {
      const firstSeen = new Map();
      const dupes = [];
      for (const row of rows) {
        const key = row.email.trim().toLowerCase(); // normalize ONCE per row
        const first = firstSeen.get(key);
        if (first === undefined) firstSeen.set(key, row.id);
        else dupes.push([first, row.id]);
      }
      return dupes;
    },
  },

  topk: {
    title: 'Top 10 products by revenue',
    slowLabel: 'filter() all sales for every product, then sort everything',
    fastLabel: 'One aggregation pass + size-k min-heap',
    slowComplexity: 'O(n·m + m log m)',
    fastComplexity: 'O(n + m log k)',
    defaultN: 20000,
    maxSlowOps: 400e6,
    ops: (n) => n * 2000,
    scaling: [5000, 10000, 20000, 40000, 80000],
    input(n) {
      const r = makeRng(11);
      const products = Array.from({ length: 2000 }, (_, i) => ({ id: i + 1, name: `Product ${i + 1}` }));
      const sales = Array.from({ length: n }, () => ({ productId: 1 + Math.floor(r() ** 2 * 2000), amountCents: 100 + Math.floor(r() * 50000) }));
      return { products, sales };
    },
    slow({ products, sales }) {
      return products
        .map((p) => ({ id: p.id, revenue: sales.filter((s) => s.productId === p.id).reduce((a, s) => a + s.amountCents, 0) }))
        .sort((a, b) => b.revenue - a.revenue || a.id - b.id)
        .slice(0, 10);
    },
    fast({ sales }) {
      const revenue = new Map();
      for (const s of sales) revenue.set(s.productId, (revenue.get(s.productId) ?? 0) + s.amountCents);
      // min-heap of the best k: the root is the *worst* of the current top-k
      const worse = (a, b) => a.revenue - b.revenue || b.id - a.id;
      const heap = new Heap(worse);
      for (const [id, rev] of revenue) {
        const item = { id, revenue: rev };
        if (heap.size < 10) heap.push(item);
        else if (worse(item, heap.peek()) > 0) heap.replaceTop(item);
      }
      return heap.toArray().sort((a, b) => b.revenue - a.revenue || a.id - b.id);
    },
  },

  autocomplete: {
    title: 'Prefix search (autocomplete) — 300 queries',
    slowLabel: 'Lower-case + filter the whole catalog per keystroke, then sort',
    fastLabel: 'Pre-sorted index + binary search for the prefix',
    slowComplexity: 'O(q · n log n)',
    fastComplexity: 'O(n log n) once + O(q · log n)',
    defaultN: 20000,
    maxSlowOps: 60e6,
    ops: (n) => n * 300,
    scaling: [5000, 10000, 20000, 40000, 80000],
    input(n) {
      const r = makeRng(5);
      const names = Array.from({ length: n }, (_, i) => `${cap(WORDS[Math.floor(r() * WORDS.length)])} ${cap(WORDS[Math.floor(r() * WORDS.length)])} ${i}`);
      const queries = Array.from({ length: 300 }, (_, i) => {
        const w = WORDS[i % WORDS.length];
        return w.slice(0, 1 + (i % 4)).toUpperCase();
      });
      return { names, queries };
    },
    slow({ names, queries }) {
      return queries.map((q) =>
        names
          .filter((name) => name.toLowerCase().startsWith(q.toLowerCase()))
          .sort(byLowerThenRaw)
          .slice(0, 10),
      );
    },
    fast({ names, queries }) {
      // Build once (in a real app: at startup or when the catalog changes).
      const index = names.map((raw) => [raw.toLowerCase(), raw]).sort((a, b) => cmpTuple(a, b));
      return queries.map((q) => {
        const p = q.toLowerCase();
        let lo = 0, hi = index.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (index[mid][0] < p) lo = mid + 1;
          else hi = mid;
        }
        const out = [];
        for (let i = lo; i < index.length && out.length < 10 && index[i][0].startsWith(p); i++) out.push(index[i][1]);
        return out;
      });
    },
  },

  membership: {
    title: 'Filter orders from blocked customers',
    slowLabel: 'Array.includes() inside filter()',
    fastLabel: 'Build a Set once, O(1) lookups',
    slowComplexity: 'O(n·b)',
    fastComplexity: 'O(n + b)',
    defaultN: 20000,
    maxSlowOps: 600e6,
    ops: (n) => n * (n / 10),
    scaling: [10000, 20000, 40000, 80000, 120000],
    input(n) {
      const r = makeRng(3);
      const orders = Array.from({ length: n }, (_, i) => ({ id: i + 1, customerId: 1 + Math.floor(r() * n) }));
      const blocked = Array.from({ length: Math.floor(n / 10) }, () => 1 + Math.floor(r() * n));
      return { orders, blocked };
    },
    slow({ orders, blocked }) {
      return orders.filter((o) => !blocked.includes(o.customerId)).length;
    },
    fast({ orders, blocked }) {
      const set = new Set(blocked);
      let n = 0;
      for (const o of orders) if (!set.has(o.customerId)) n++;
      return n;
    },
  },
};

function cap(s) {
  return s[0].toUpperCase() + s.slice(1);
}
function cmpTuple(a, b) {
  return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;
}
function byLowerThenRaw(a, b) {
  return cmpTuple([a.toLowerCase(), a], [b.toLowerCase(), b]);
}

export function describe() {
  return Object.entries(CASES).map(([id, c]) => ({
    id, title: c.title, slowLabel: c.slowLabel, fastLabel: c.fastLabel,
    slowComplexity: c.slowComplexity, fastComplexity: c.fastComplexity,
    defaultN: c.defaultN, scaling: c.scaling,
    slowSource: c.slow.toString(), fastSource: c.fast.toString(),
  }));
}

function guard(c, variant, n) {
  if (variant === 'slow' && c.ops(n) > c.maxSlowOps) {
    throw new HttpError(400, `n=${n} would take too long with the ${c.slowComplexity} version (≈${Math.round(c.ops(n) / 1e6)}M ops). Lower n.`);
  }
}

export function run({ algo = 'dedupe', variant = 'slow', n } = {}) {
  const c = CASES[algo];
  n ??= c.defaultN;
  guard(c, variant, n);
  const input = c.input(n);
  const t0 = performance.now();
  const output = c[variant](input);
  const ms = performance.now() - t0;
  return {
    lab: 'algorithms',
    algo,
    variant,
    n,
    complexity: variant === 'slow' ? c.slowComplexity : c.fastComplexity,
    ms: round(ms, 3),
    checksum: checksum(output),
    resultSize: Array.isArray(output) ? output.length : output,
  };
}

/** Run both variants across growing n to expose the growth curve. */
export function scaling({ algo = 'dedupe' } = {}) {
  const c = CASES[algo];
  const points = c.scaling.map((n) => {
    const input = c.input(n);
    const time = (fn) => {
      let best = Infinity; // best-of-N cuts JIT/GC noise
      for (let i = 0; i < 3; i++) {
        const t = performance.now();
        fn(input);
        best = Math.min(best, performance.now() - t);
        if (best > 200) break;
      }
      return round(best, 3);
    };
    const slowOk = c.ops(n) <= c.maxSlowOps;
    return { n, slowMs: slowOk ? time(c.slow) : null, fastMs: time(c.fast) };
  });
  return { algo, slowComplexity: c.slowComplexity, fastComplexity: c.fastComplexity, points };
}
