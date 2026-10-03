import { openDatabase } from '../src/db.js';
import { runOverview } from '../src/labs/overview.js';
import { config } from '../src/config.js';

// npm run bench — every lab, slow vs fast, from the CLI. Use in CI to catch regressions.
const db = openDatabase();
const rtt = Number(process.argv[2] ?? config.defaultRttMs);
console.log(`\nPerformance Lab benchmark  (projected DB RTT = ${rtt} ms)\n`);
const rows = await runOverview(db, { rtt });
const fmt = (r, k) => (r[k + 'Ms'] != null ? `${r[k + 'Ms']} ms` : `${(r[k + 'Bytes'] / 1024).toFixed(1)} KB`);
console.table(
  rows.map((r) => ({
    problem: r.problem,
    slow: fmt(r, 'slow'),
    fast: fmt(r, 'fast'),
    speedup: `${r.speedup}×`,
    'same result': r.sameResult == null ? '—' : r.sameResult ? '✔' : '✘ MISMATCH',
  })),
);
const bad = rows.filter((r) => r.sameResult === false);
if (bad.length) {
  console.error('Optimized path returned different data for:', bad.map((r) => r.problem));
  process.exit(1);
}
db.close();
process.exit(0);
