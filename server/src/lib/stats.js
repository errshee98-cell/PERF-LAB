import { createHash } from 'node:crypto';

export const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

export function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export function summarize(samples) {
  const s = [...samples].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  return {
    n: s.length,
    avg: round(s.length ? sum / s.length : 0),
    min: round(s[0] ?? 0),
    p50: round(percentile(s, 50)),
    p90: round(percentile(s, 90)),
    p95: round(percentile(s, 95)),
    p99: round(percentile(s, 99)),
    max: round(s.at(-1) ?? 0),
  };
}

/** Short content hash — proves the slow and fast paths return identical data. */
export function checksum(value) {
  return createHash('sha1').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex').slice(0, 12);
}
