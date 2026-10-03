import { tracker, newTrackingContext } from '../db.js';
import { round } from './stats.js';

/**
 * Run fn inside a fresh tracking context and report:
 *   queries     – DB round trips issued
 *   dbMs        – time spent inside SQLite
 *   wallMs      – total elapsed
 *   networkMs   – queries × rtt (SQLite is in-process; a networked DB pays this)
 *   projectedMs – wallMs + networkMs  ≈ what you'd see against Postgres/MySQL
 */
export async function measure(fn, { rtt = 0 } = {}) {
  const ctx = newTrackingContext();
  const t0 = performance.now();
  const result = await tracker.run(ctx, fn);
  const wallMs = performance.now() - t0;
  const networkMs = ctx.queries * rtt;
  return {
    result,
    metrics: {
      queries: ctx.queries,
      dbMs: round(ctx.dbMs),
      wallMs: round(wallMs),
      networkMs: round(networkMs),
      projectedMs: round(wallMs + networkMs),
      rtt,
    },
    queryLog: ctx.log,
  };
}
