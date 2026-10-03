import { DatabaseSync } from 'node:sqlite';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { createSchema, isSeeded, seed } from './seed.js';

/**
 * Every query runs inside a "tracking context" (AsyncLocalStorage) so we can
 * count round trips and DB time per request / per measured block without
 * threading a counter through every function. Contexts nest: a measure()
 * block inside a request reports to both.
 */
export const tracker = new AsyncLocalStorage();

export function newTrackingContext(parent = tracker.getStore()) {
  return { queries: 0, dbMs: 0, log: [], parent };
}

const MAX_LOG = 40;

function record(sql, ms) {
  for (let ctx = tracker.getStore(); ctx; ctx = ctx.parent) {
    ctx.queries++;
    ctx.dbMs += ms;
    if (ctx.log.length < MAX_LOG) ctx.log.push(sql.replace(/\s+/g, ' ').trim());
  }
}

export class Db {
  #raw;
  #stmts = new Map(); // prepared-statement cache: compile once, reuse forever

  constructor(raw, file) {
    this.#raw = raw;
    this.file = file;
  }

  get raw() {
    return this.#raw;
  }

  #stmt(sql) {
    let s = this.#stmts.get(sql);
    if (!s) {
      s = this.#raw.prepare(sql);
      this.#stmts.set(sql, s);
    }
    return s;
  }

  #timed(sql, fn) {
    const t0 = performance.now();
    try {
      return fn(this.#stmt(sql));
    } finally {
      record(sql, performance.now() - t0);
    }
  }

  all(sql, ...params) {
    return this.#timed(sql, (s) => s.all(...params));
  }

  get(sql, ...params) {
    return this.#timed(sql, (s) => s.get(...params));
  }

  run(sql, ...params) {
    return this.#timed(sql, (s) => s.run(...params));
  }

  /** EXPLAIN QUERY PLAN — never executes the statement itself. Not counted as a query. */
  explain(sql, ...params) {
    return this.#raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params);
  }

  exec(sql) {
    this.#raw.exec(sql);
  }

  close() {
    this.#raw.close();
  }
}

export function openDatabase({ file = config.dbFile, scale = config.seedScale, log = console.log } = {}) {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const raw = new DatabaseSync(file);
  raw.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA cache_size = -65536;
    PRAGMA temp_store = MEMORY;
    PRAGMA mmap_size = 268435456;
  `);
  createSchema(raw);
  if (!isSeeded(raw)) seed(raw, { scale, log });
  return new Db(raw, file);
}

/** Separate read-only connection for the query-plan explorer (user-supplied SQL). */
export function openReadOnly(db) {
  if (db.file === ':memory:') return db.raw;
  return new DatabaseSync(db.file, { readOnly: true });
}

let shared;
export function getDb() {
  shared ??= openDatabase();
  return shared;
}
