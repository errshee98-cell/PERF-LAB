import { monitorEventLoopDelay } from 'node:perf_hooks';
import { summarize, round } from './stats.js';

const WINDOW = 500; // rolling samples per route

/**
 * Event-loop delay is THE health metric for Node: any synchronous work
 * (an O(n²) loop, a huge JSON.stringify, brotli q11) blocks every other request.
 */
const loopDelay = monitorEventLoopDelay({ resolution: 10 });
loopDelay.enable();

class Metrics {
  #routes = new Map();
  startedAt = Date.now();

  record(label, ms, status) {
    let r = this.#routes.get(label);
    if (!r) this.#routes.set(label, (r = { count: 0, errors: 0, samples: [], i: 0 }));
    r.count++;
    if (status >= 500) r.errors++;
    if (r.samples.length < WINDOW) r.samples.push(ms);
    else r.samples[r.i++ % WINDOW] = ms;
  }

  snapshot() {
    const mem = process.memoryUsage();
    const ns = (v) => round(v / 1e6);
    return {
      uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
      memory: { rssMb: round(mem.rss / 2 ** 20, 1), heapUsedMb: round(mem.heapUsed / 2 ** 20, 1) },
      eventLoopDelayMs: { p50: ns(loopDelay.percentile(50)), p99: ns(loopDelay.percentile(99)), max: ns(loopDelay.max) },
      routes: [...this.#routes]
        .map(([route, r]) => ({ route, count: r.count, errors: r.errors, ...summarize(r.samples) }))
        .sort((a, b) => b.p95 - a.p95),
    };
  }

  reset() {
    this.#routes.clear();
    loopDelay.reset();
  }
}

export const metrics = new Metrics();
