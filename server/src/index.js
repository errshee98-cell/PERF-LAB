import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { getDb } from './db.js';
import { createRouter, makeHandler, readJson, int, num, oneOf, HttpError, pickEncoding, compress } from './lib/http.js';
import { metrics } from './lib/metrics.js';
import { runLoadTest } from './lib/loadtest.js';
import * as nplus from './labs/nplusone.js';
import * as indexing from './labs/indexing.js';
import * as algos from './labs/algorithms.js';
import * as caching from './labs/caching.js';
import * as payload from './labs/payload.js';
import * as frontend from './labs/frontend.js';
import { runOverview } from './labs/overview.js';

const db = getDb();
const r = createRouter();

r.get('/api/health', () => ({ ok: true }));
r.get('/api/metrics', () => metrics.snapshot());
r.post('/api/metrics/reset', () => (metrics.reset(), { ok: true }));
r.get('/api/overview', async ({ query }) => runOverview(db, { rtt: num(query, 'rtt', config.defaultRttMs, 0, 20) }));

// ── Lab 1: N+1 ───────────────────────────────────────────────
r.get('/api/labs/n-plus-one', ({ query }) =>
  nplus.run(db, {
    mode: oneOf(query.get('mode') ?? 'naive', nplus.MODES, 'mode'),
    limit: int(query, 'limit', 100, 1, 500),
    rtt: num(query, 'rtt', config.defaultRttMs, 0, 20),
  }),
);

// ── Lab 2: indexes ───────────────────────────────────────────
r.get('/api/labs/indexing/scenarios', () => indexing.describe());
r.get('/api/labs/indexing/schema', () => indexing.schema(db));
r.get('/api/labs/indexing', ({ query }) =>
  indexing.run(db, {
    scenario: oneOf(query.get('scenario') ?? 'feed', Object.keys(indexing.SCENARIOS), 'scenario'),
    variant: oneOf(query.get('variant') ?? 'slow', ['slow', 'fast'], 'variant'),
    iterations: int(query, 'iterations', 25, 1, 200),
  }),
);
r.post('/api/labs/indexing/explain', async ({ req }) => indexing.explainUserSql(db, (await readJson(req)).sql));

// ── Lab 3: algorithms ────────────────────────────────────────
r.get('/api/labs/algorithms/cases', () => algos.describe());
r.get('/api/labs/algorithms', ({ query }) => {
  const algo = oneOf(query.get('algo') ?? 'dedupe', Object.keys(algos.CASES), 'algo');
  return algos.run({
    algo,
    variant: oneOf(query.get('variant') ?? 'slow', ['slow', 'fast'], 'variant'),
    n: int(query, 'n', algos.CASES[algo].defaultN, 10, 500_000),
  });
});
r.get('/api/labs/algorithms/scaling', ({ query }) => algos.scaling({ algo: oneOf(query.get('algo') ?? 'dedupe', Object.keys(algos.CASES), 'algo') }));

// ── Lab 4: caching ───────────────────────────────────────────
r.get('/api/labs/caching/report', ({ req, query }) => {
  const year = query.get('year') || caching.DEFAULT_YEAR;
  if (!/^20(2[3-5])$/.test(year)) throw new HttpError(400, 'year must be 2023, 2024 or 2025');
  return caching.handleReport(db, req, { mode: oneOf(query.get('mode') ?? 'none', caching.MODES, 'mode'), year });
});
r.post('/api/labs/caching/stampede', async ({ req }) => {
  const b = await readJson(req);
  return caching.stampede(db, { mode: oneOf(b.mode, caching.MODES, 'mode'), concurrency: Math.min(200, Math.max(1, Number(b.concurrency) || 10)) });
});
r.post('/api/labs/caching/series', async ({ req }) => {
  const b = await readJson(req);
  return caching.warmSeries(db, { mode: oneOf(b.mode, caching.MODES, 'mode'), requests: Math.min(30, Math.max(1, Number(b.requests) || 8)) });
});
r.post('/api/labs/caching/invalidate', () => caching.invalidate());
r.post('/api/labs/caching/reset', () => (caching.reset(), { ok: true }));
r.get('/api/labs/caching/stats', () => caching.stats());

// ── Lab 5: payload ───────────────────────────────────────────
r.get('/api/labs/payload/products', ({ req, query }) => {
  const mode = oneOf(query.get('mode') ?? 'bloated', payload.MODES, 'mode');
  return mode === 'bloated'
    ? payload.bloated(db)
    : payload.lean(db, req, { cursor: payload.parseCursor(query), limit: int(query, 'limit', 50, 1, 200) });
});
r.get('/api/labs/payload/compare', () => payload.compare(db));

// ── Lab 6: frontend rendering data ───────────────────────────
r.get('/api/labs/frontend/rows', async ({ query }) => ({
  body: await frontend.rows(db, int(query, 'n', 5000, 10, 10_000)),
  compress: true,
  headers: { 'cache-control': 'private, max-age=300' },
}));

// ── Load testing (separate worker thread) ────────────────────
r.post('/api/loadtest', async ({ req }) => {
  const b = await readJson(req);
  return runLoadTest({ baseUrl: `http://${config.host}:${config.port}`, path: b.path, concurrency: Number(b.concurrency), durationMs: Number(b.durationMs) });
});

// ── Static client (production build) with long-lived caching for hashed assets ──
const staticCache = new Map();
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

async function serveStatic(req, res, url) {
  if (req.method !== 'GET' || url.pathname.startsWith('/api/')) return false;
  let rel = decodeURIComponent(url.pathname);
  let file = path.join(config.clientDist, rel);
  if (!file.startsWith(config.clientDist)) return false;
  const st = await stat(file).catch(() => null);
  if (!st?.isFile()) file = path.join(config.clientDist, 'index.html'); // SPA fallback
  const ext = path.extname(file);
  const enc = /\.(js|css|html|svg|json)$/.test(file) ? pickEncoding(req) : null;
  const k = `${file}|${enc}`;
  let entry = staticCache.get(k);
  if (!entry) {
    const raw = await readFile(file).catch(() => null);
    if (!raw) return false;
    entry = { buf: enc ? compress(raw, enc) : raw };
    staticCache.set(k, entry);
  }
  const hashed = /[.-][A-Za-z0-9_-]{8,}\.(js|css|woff2|svg|png)$/.test(file);
  res.writeHead(200, {
    'content-type': TYPES[ext] ?? 'application/octet-stream',
    'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
    ...(enc && { 'content-encoding': enc, vary: 'Accept-Encoding' }),
  });
  res.end(entry.buf);
  return true;
}

const server = http.createServer(makeHandler(r, { fallback: serveStatic }));
server.keepAliveTimeout = 65_000;
server.listen(config.port, config.host, () => {
  console.log(`⚡ Perf Lab API on http://${config.host}:${config.port}`);
});
