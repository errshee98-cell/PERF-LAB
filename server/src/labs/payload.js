import zlib from 'node:zlib';
import { HttpError } from '../lib/http.js';
import { checksum, round } from '../lib/stats.js';

/**
 * LAB 5 — Payload & network
 *
 *  bloated — SELECT * of the whole catalog (descriptions, specs JSON, image URLs),
 *            pretty-printed, no compression, no pagination, no validators.
 *  lean    — only the 4 fields a product grid renders, keyset-paginated (50/page),
 *            compressed (br/gzip), ETag → 304 on revisit.
 */
export const MODES = ['bloated', 'lean'];

export function bloated(db) {
  return { body: db.all('SELECT * FROM products ORDER BY id'), pretty: true, headers: { 'cache-control': 'no-store' } };
}

export function leanPage(db, { cursor = 0, limit = 50 }) {
  const items = db.all(
    `SELECT p.id, p.name, p.price_cents AS priceCents, c.name AS category
     FROM products p JOIN categories c ON c.id = p.category_id
     WHERE p.id > ? ORDER BY p.id LIMIT ?`,
    cursor,
    limit,
  );
  return { items, nextCursor: items.length === limit ? items.at(-1).id : null };
}

export function lean(db, req, { cursor, limit }) {
  const body = leanPage(db, { cursor, limit });
  const etag = `"${checksum(body)}"`;
  const headers = { etag, 'cache-control': 'public, max-age=60, stale-while-revalidate=300' };
  if (req.headers['if-none-match'] === etag) return { status: 304, headers };
  return { body, compress: true, headers };
}

/** Byte accounting for every option, so the trade-offs are visible side by side. */
export function compare(db) {
  const all = db.all('SELECT * FROM products ORDER BY id');
  const variants = {
    'SELECT * · pretty JSON': Buffer.from(JSON.stringify(all, null, 2)),
    'SELECT * · minified': Buffer.from(JSON.stringify(all)),
    'Projected fields · all rows': Buffer.from(JSON.stringify(leanAll(db))),
    'Projected · 1 page (50)': Buffer.from(JSON.stringify(leanPage(db, { cursor: 0, limit: 50 }))),
  };
  const rows = [];
  for (const [label, buf] of Object.entries(variants)) {
    const enc = (name, fn) => {
      // br-11 on multi-MB input takes tens of seconds and would freeze the event loop:
      // exactly the mistake this lab warns about. Only demo it on small payloads.
      if (name === 'br-11' && buf.length > 256 * 1024) return { encoding: name, bytes: null, ms: null, skipped: 'too slow for >256 KB' };
      const t = performance.now();
      const out = fn(buf);
      return { encoding: name, bytes: out.length, ms: round(performance.now() - t) };
    };
    rows.push({
      label,
      raw: buf.length,
      encodings: [
        enc('gzip-6', (b) => zlib.gzipSync(b, { level: 6 })),
        enc('br-4', (b) => zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } })),
        enc('br-11', (b) => zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } })),
      ],
    });
  }
  return { rows, products: all.length };
}

function leanAll(db) {
  return db.all('SELECT p.id, p.name, p.price_cents AS priceCents, c.name AS category FROM products p JOIN categories c ON c.id = p.category_id ORDER BY p.id');
}

export function parseCursor(q) {
  const c = Number(q.get('cursor') ?? 0);
  if (!Number.isInteger(c) || c < 0) throw new HttpError(400, 'bad cursor');
  return c;
}
