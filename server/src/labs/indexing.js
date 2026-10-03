import { measure } from '../lib/measure.js';
import { checksum, summarize } from '../lib/stats.js';
import { HttpError } from '../lib/http.js';
import { openReadOnly } from '../db.js';
import { EVENT_TYPES, TIME_RANGE } from '../seed.js';

/**
 * LAB 2 — Missing database indexes
 *
 * `events` and `events_noidx` contain identical rows. The only difference is
 *   CREATE INDEX idx_events_user_created ON events(user_id, created_at);
 *   CREATE INDEX idx_events_type_created ON events(type, created_at);
 *
 * Scenarios:
 *   feed        — a user's activity feed (equality + ORDER BY + LIMIT)
 *   window      — count by type in a date range (covering-index range scan)
 *   pagination  — deep OFFSET pagination vs keyset ("seek") pagination
 */
const DAY = 86_400;

export const SCENARIOS = {
  feed: {
    title: "User activity feed",
    why: 'Without an index SQLite must SCAN all rows, filter by user_id, then sort the matches in a temp B-tree. A composite index (user_id, created_at) jumps straight to that user\'s rows already in order — LIMIT stops after 20.',
    fix: 'CREATE INDEX idx_events_user_created ON events(user_id, created_at);',
    slow: { sql: 'SELECT id, type, created_at FROM events_noidx WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 20' },
    fast: { sql: 'SELECT id, type, created_at FROM events WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 20' },
    params: (i, ctx) => [1 + ((i * 7919) % ctx.customers)],
  },
  window: {
    title: 'Events of a type in a 30-day window',
    why: 'Range predicates need the equality column first, then the range column. Because both columns live in the index, SQLite answers COUNT(*) from the index alone ("COVERING INDEX") without touching the table.',
    fix: 'CREATE INDEX idx_events_type_created ON events(type, created_at);',
    slow: { sql: 'SELECT COUNT(*) AS n FROM events_noidx WHERE type = ? AND created_at BETWEEN ? AND ?' },
    fast: { sql: 'SELECT COUNT(*) AS n FROM events WHERE type = ? AND created_at BETWEEN ? AND ?' },
    params: (i) => {
      const from = TIME_RANGE.start + ((i * 37) % 900) * DAY;
      return [EVENT_TYPES[i % EVENT_TYPES.length], from, from + 30 * DAY];
    },
  },
  pagination: {
    title: 'Deep pagination (page 5,000+)',
    why: 'OFFSET n still walks and discards n rows — page 5,000 costs 5,000× page 1. Keyset pagination remembers the last id and seeks to it through the primary-key B-tree: every page costs the same.',
    fix: 'WHERE id > :lastSeenId ORDER BY id LIMIT 20   -- instead of OFFSET',
    slow: { sql: 'SELECT id, user_id, type FROM events ORDER BY id LIMIT 20 OFFSET ?' },
    fast: { sql: 'SELECT id, user_id, type FROM events WHERE id > ? ORDER BY id LIMIT 20' },
    // ids are contiguous 1..N, so `id > offset` returns exactly the same page as OFFSET offset
    params: (i, ctx) => [Math.floor(ctx.events * 0.6) + i * 20],
  },
};

function sizes(db) {
  const s = JSON.parse(db.get(`SELECT value FROM meta WHERE key = 'sizes'`).value);
  return { customers: s.customers, events: s.events };
}

export function formatPlan(rows) {
  const depth = new Map([[0, -1]]);
  return rows.map((r) => {
    const d = (depth.get(r.parent) ?? -1) + 1;
    depth.set(r.id, d);
    return { depth: d, detail: r.detail };
  });
}

export async function run(db, { scenario = 'feed', variant = 'slow', iterations = 25 } = {}) {
  const sc = SCENARIOS[scenario];
  const { sql } = sc[variant];
  const ctx = sizes(db);
  const samples = [];
  const results = [];

  const { metrics } = await measure(() => {
    for (let i = 0; i < iterations; i++) {
      const params = sc.params(i, ctx);
      const t = performance.now();
      results.push(db.all(sql, ...params));
      samples.push(performance.now() - t);
    }
  });

  return {
    lab: 'indexing',
    scenario,
    variant,
    title: sc.title,
    sql,
    iterations,
    plan: formatPlan(db.explain(sql, ...sc.params(0, ctx))),
    timing: summarize(samples),
    metrics,
    rowsReturned: results.reduce((n, r) => n + r.length, 0),
    checksum: checksum(results),
  };
}

export function describe() {
  return Object.entries(SCENARIOS).map(([id, s]) => ({ id, title: s.title, why: s.why, fix: s.fix, slowSql: s.slow.sql, fastSql: s.fast.sql }));
}

export function schema(db) {
  const tables = db.raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'meta' ORDER BY name`).all();
  return tables.map(({ name }) => ({
    table: name,
    rows: db.raw.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get().n,
    columns: db.raw.prepare(`PRAGMA table_info("${name}")`).all().map((c) => c.name),
    indexes: db.raw.prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL`).all(name),
  }));
}

// ─── Query-plan explorer + index advisor ───────────────────────────────────

let ro;
const tableRowCache = new Map();

export function explainUserSql(db, sql) {
  sql = String(sql ?? '').trim().replace(/;\s*$/, '');
  if (!/^(select|with)\b/i.test(sql)) throw new HttpError(400, 'Only SELECT / WITH statements can be explained');
  if (sql.includes(';')) throw new HttpError(400, 'One statement at a time');
  if (sql.length > 4000) throw new HttpError(400, 'Query too long');

  ro ??= openReadOnly(db);
  let rows;
  try {
    rows = ro.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(); // plans only — never executes
  } catch (e) {
    throw new HttpError(400, e.message);
  }
  const plan = formatPlan(rows);
  return { sql, plan, advice: advise(db, sql, plan) };
}

function rowCount(db, table) {
  if (!tableRowCache.has(table)) {
    try {
      tableRowCache.set(table, db.raw.prepare(`SELECT COUNT(*) AS n FROM "${table.replace(/"/g, '')}"`).get().n);
    } catch {
      tableRowCache.set(table, 0);
    }
  }
  return tableRowCache.get(table);
}

/** Heuristic advisor: reads the plan, then proposes an index ordered equality → range → ORDER BY. */
export function advise(db, sql, plan) {
  const advice = [];
  const where = (sql.match(/\bwhere\b([\s\S]*?)(\border\s+by\b|\bgroup\s+by\b|\blimit\b|$)/i)?.[1] ?? '');
  const orderBy = sql.match(/\border\s+by\s+([\w.]+)/i)?.[1]?.split('.').pop();
  const eq = [...where.matchAll(/([\w.]+)\s*(=|\bIN\b)/gi)].map((m) => m[1].split('.').pop());
  const range = [...where.matchAll(/([\w.]+)\s*(<=|>=|<|>|\bBETWEEN\b|\bLIKE\b)/gi)].map((m) => m[1].split('.').pop());

  for (const { detail } of plan) {
    const scan = detail.match(/^SCAN (\w+)(?: AS \w+)?$/);
    if (scan) {
      const table = scan[1];
      const rows = rowCount(db, table);
      const cols = [...new Set([...eq, ...range, ...(orderBy ? [orderBy] : [])])];
      advice.push({
        level: rows > 10_000 ? 'critical' : 'warning',
        message: `Full table scan of ${table} (${rows.toLocaleString()} rows) — every row is read.`,
        suggestion: cols.length
          ? `CREATE INDEX idx_${table}_${cols.join('_')} ON ${table}(${cols.join(', ')});`
          : 'Add a WHERE clause on an indexed column, or accept the scan if you really need every row.',
      });
    }
    if (/USE TEMP B-TREE FOR (ORDER BY|GROUP BY|DISTINCT)/.test(detail)) {
      advice.push({
        level: 'warning',
        message: `${detail}: results are sorted after fetching instead of read in index order.`,
        suggestion: orderBy ? `Append ${orderBy} to the end of the index the query uses so rows come out pre-sorted.` : 'Match the index column order to the ORDER BY / GROUP BY.',
      });
    }
    if (/AUTOMATIC (COVERING )?INDEX/.test(detail)) {
      advice.push({ level: 'warning', message: `${detail}: SQLite is building a throw-away index on every execution.`, suggestion: 'Create that index permanently.' });
    }
    if (/USING COVERING INDEX/.test(detail)) {
      advice.push({ level: 'good', message: `${detail}: answered from the index alone, no table lookups.` });
    } else if (/USING (INDEX|INTEGER PRIMARY KEY)/.test(detail)) {
      advice.push({ level: 'good', message: `${detail}: index seek.` });
    }
  }
  if (/\boffset\s+\d{4,}/i.test(sql)) {
    advice.push({ level: 'warning', message: 'Large OFFSET: rows before the offset are still read and thrown away.', suggestion: 'Use keyset pagination: WHERE id > :lastId ORDER BY id LIMIT n' });
  }
  if (/\bselect\s+\*/i.test(sql)) {
    advice.push({ level: 'info', message: 'SELECT * prevents covering-index plans and over-fetches columns.', suggestion: 'List only the columns you need.' });
  }
  if (/like\s+'%/i.test(sql)) {
    advice.push({ level: 'warning', message: "Leading-wildcard LIKE '%…' can't use a B-tree index.", suggestion: 'Use a full-text index (FTS5) or a trigram index.' });
  }
  return advice;
}
