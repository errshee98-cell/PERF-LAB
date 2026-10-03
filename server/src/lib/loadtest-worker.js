import { parentPort, workerData } from 'node:worker_threads';

/**
 * Runs in its own thread (own event loop) so generating load doesn't steal
 * time from the server's event loop. Closed-loop model: each virtual user
 * sends a request, waits for the full body, then sends the next one.
 */
const { url, concurrency, durationMs } = workerData;
const latencies = [];
const perSecond = [];
const statuses = {};
let errors = 0;
let bytes = 0;
const start = performance.now();
const end = start + durationMs;

async function user() {
  while (performance.now() < end) {
    const t = performance.now();
    try {
      const res = await fetch(url, { headers: { 'accept-encoding': 'br, gzip' } });
      const buf = await res.arrayBuffer();
      bytes += buf.byteLength;
      statuses[res.status] = (statuses[res.status] ?? 0) + 1;
      if (res.status >= 500) errors++;
    } catch {
      errors++;
    }
    const done = performance.now();
    latencies.push(done - t);
    const sec = Math.floor((done - start) / 1000);
    perSecond[sec] = (perSecond[sec] ?? 0) + 1;
  }
}

await Promise.all(Array.from({ length: concurrency }, user));
parentPort.postMessage({ latencies, perSecond: Array.from(perSecond, (v) => v ?? 0), statuses, errors, bytes, elapsedMs: performance.now() - start });
