import zlib from 'node:zlib';
import { tracker, newTrackingContext } from '../db.js';
import { metrics } from './metrics.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Tiny router: exact paths + `:param` segments. Zero dependencies on purpose. */
export function createRouter() {
  const routes = [];
  const add = (method) => (pattern, handler) => {
    const keys = [];
    const re = new RegExp(
      '^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '/?$',
    );
    routes.push({ method, re, keys, handler, pattern });
  };
  return {
    get: add('GET'),
    post: add('POST'),
    match(method, pathname) {
      for (const r of routes) {
        if (r.method !== method) continue;
        const m = r.re.exec(pathname);
        if (m) return { ...r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
      }
      return null;
    },
  };
}

export async function readJson(req, limit = 64 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, 'Body too large');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

export function pickEncoding(req) {
  const ae = String(req.headers['accept-encoding'] ?? '');
  if (/\bbr\b/.test(ae)) return 'br';
  if (/\bgzip\b/.test(ae)) return 'gzip';
  return null;
}

/**
 * Compression is a CPU-vs-bytes trade. For *dynamic* responses use fast
 * settings (brotli q4 ≈ gzip-6 speed with better ratio). Brotli q11 is for
 * build-time static assets only — it can be 50× slower.
 */
export function compress(buf, encoding) {
  if (encoding === 'br') {
    return zlib.brotliCompressSync(buf, {
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length },
    });
  }
  if (encoding === 'gzip') return zlib.gzipSync(buf, { level: 6 });
  return buf;
}

/**
 * Handler return value:
 *   { status?, body, headers?, compress?: boolean, pretty?: boolean, raw?: Buffer }
 * Anything else is treated as a JSON body.
 */
export function makeHandler(router, { fallback } = {}) {
  return async function handle(req, res) {
    const start = performance.now();
    const url = new URL(req.url, 'http://localhost');
    const route = router.match(req.method, url.pathname);
    const ctx = newTrackingContext(null);
    let status = 500;

    try {
      if (!route) {
        if (fallback && (await fallback(req, res, url))) {
          status = res.statusCode;
          return;
        }
        throw new HttpError(404, `No route for ${req.method} ${url.pathname}`);
      }
      const out = await tracker.run(ctx, () => route.handler({ req, res, url, params: route.params, query: url.searchParams }));
      if (res.writableEnded) {
        status = res.statusCode;
        return;
      }
      status = send(req, res, out, ctx, start);
    } catch (err) {
      status = err.status ?? 500;
      if (status === 500) console.error(err);
      send(req, res, { status, body: { error: err.message } }, ctx, start);
    } finally {
      const label = route ? `${req.method} ${route.pattern}${modeLabel(url)}` : null;
      if (label && url.pathname.startsWith('/api/')) metrics.record(label, performance.now() - start, status);
    }
  };
}

function modeLabel(url) {
  const m = url.searchParams.get('mode') ?? url.searchParams.get('variant');
  return m ? `?mode=${m}` : '';
}

function send(req, res, out, ctx, start) {
  const o = out && typeof out === 'object' && ('body' in out || 'raw' in out || 'status' in out) ? out : { body: out };
  const status = o.status ?? 200;
  const headers = { 'content-type': 'application/json; charset=utf-8', ...o.headers };

  let buf = o.raw ?? (o.body === undefined ? Buffer.alloc(0) : Buffer.from(o.pretty ? JSON.stringify(o.body, null, 2) : JSON.stringify(o.body)));
  headers['x-raw-bytes'] = String(buf.length);

  if (o.compress && buf.length > 1024) {
    const enc = pickEncoding(req);
    if (enc) {
      const t = performance.now();
      buf = compress(buf, enc);
      headers['content-encoding'] = enc;
      headers.vary = 'Accept-Encoding';
      ctx.compressMs = performance.now() - t;
    }
  }
  headers['x-wire-bytes'] = String(buf.length);

  const total = performance.now() - start;
  const timing = [`db;dur=${ctx.dbMs.toFixed(2)};desc="${ctx.queries} queries"`];
  if (ctx.compressMs != null) timing.push(`compress;dur=${ctx.compressMs.toFixed(2)}`);
  timing.push(`total;dur=${total.toFixed(2)}`);
  headers['server-timing'] = timing.join(', ');
  headers['x-db-queries'] = String(ctx.queries);
  headers['timing-allow-origin'] = '*';
  headers['access-control-expose-headers'] = 'server-timing, x-raw-bytes, x-wire-bytes, x-db-queries, x-cache, etag';

  res.writeHead(status, headers);
  res.end(status === 304 ? undefined : buf);
  return status;
}

export function int(q, name, def, min, max) {
  const raw = q.get(name);
  const v = raw == null || raw === '' ? def : Number(raw);
  if (!Number.isFinite(v)) throw new HttpError(400, `${name} must be a number`);
  return Math.min(max, Math.max(min, Math.floor(v)));
}

export function num(q, name, def, min, max) {
  const raw = q.get(name);
  const v = raw == null || raw === '' ? def : Number(raw);
  if (!Number.isFinite(v)) throw new HttpError(400, `${name} must be a number`);
  return Math.min(max, Math.max(min, v));
}

export function oneOf(value, allowed, name) {
  if (!allowed.includes(value)) throw new HttpError(400, `${name} must be one of: ${allowed.join(', ')}`);
  return value;
}
