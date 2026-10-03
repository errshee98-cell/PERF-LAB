import { Worker } from 'node:worker_threads';
import { summarize, round } from './stats.js';
import { HttpError } from './http.js';

let running = false;

export async function runLoadTest({ baseUrl, path, concurrency = 20, durationMs = 5000 }) {
  if (typeof path !== 'string' || !path.startsWith('/api/labs/') || path.includes('..')) {
    throw new HttpError(400, 'path must be a GET endpoint under /api/labs/');
  }
  if (running) throw new HttpError(409, 'A load test is already running');
  concurrency = Math.min(200, Math.max(1, Math.floor(concurrency)));
  durationMs = Math.min(15_000, Math.max(1000, Math.floor(durationMs)));

  running = true;
  try {
    const out = await new Promise((resolve, reject) => {
      const w = new Worker(new URL('./loadtest-worker.js', import.meta.url), { workerData: { url: baseUrl + path, concurrency, durationMs } });
      w.once('message', resolve);
      w.once('error', reject);
    });
    const latency = summarize(out.latencies);
    // histogram, log-spaced buckets
    const edges = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, Infinity];
    const histogram = edges.map((le, i) => ({ le: le === Infinity ? '+Inf' : le, count: out.latencies.filter((v) => v <= le && v > (edges[i - 1] ?? 0)).length }));
    return {
      path, concurrency, durationMs,
      requests: out.latencies.length,
      rps: round(out.latencies.length / (out.elapsedMs / 1000), 1),
      errors: out.errors,
      statuses: out.statuses,
      mbReceived: round(out.bytes / 2 ** 20, 2),
      latency,
      histogram,
      perSecond: out.perSecond,
    };
  } finally {
    running = false;
  }
}
