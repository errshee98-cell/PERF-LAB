import { checksum } from './stats.js';

/**
 * In-memory cache with the features a production cache layer actually needs:
 *
 *  - LRU eviction       — bounded memory (Map keeps insertion order; re-insert on hit)
 *  - TTL                — entries go stale after ttlMs
 *  - stale-while-revalidate — serve the stale value instantly, refresh in background
 *  - single-flight      — N concurrent misses for one key → 1 computation (no stampede)
 *  - tag invalidation   — writes evict every key derived from that data
 *  - ETags              — computed once at store time for cheap 304s
 *
 * Set singleFlight:false / swrMs:0 to get the "naive TTL cache" used for comparison.
 */
export class SmartCache {
  #map = new Map();
  #inflight = new Map();
  #tags = new Map();

  constructor({ max = 500, ttlMs = 30_000, swrMs = 60_000, singleFlight = true, now = () => Date.now() } = {}) {
    Object.assign(this, { max, ttlMs, swrMs, singleFlight, now });
    this.resetStats();
  }

  resetStats() {
    this.stats = { hits: 0, misses: 0, stale: 0, coalesced: 0, computations: 0, evictions: 0, revalidations: 0, errors: 0 };
  }

  /** @returns {Promise<{ value: any, etag: string, status: 'HIT'|'MISS'|'STALE'|'COALESCED', ageMs: number }>} */
  async getOrCompute(key, compute, { ttlMs = this.ttlMs, swrMs = this.swrMs, tags = [] } = {}) {
    const now = this.now();
    const entry = this.#map.get(key);

    if (entry) {
      this.#touch(key, entry);
      if (now < entry.expiresAt) {
        this.stats.hits++;
        return view(entry, 'HIT', now);
      }
      if (now < entry.expiresAt + swrMs) {
        this.stats.stale++;
        if (!this.#inflight.has(key)) {
          this.stats.revalidations++;
          this.#load(key, compute, ttlMs, tags).catch(() => this.stats.errors++);
        }
        return view(entry, 'STALE', now);
      }
    }

    if (this.singleFlight && this.#inflight.has(key)) {
      this.stats.coalesced++;
      return view(await this.#inflight.get(key), 'COALESCED', this.now());
    }

    this.stats.misses++;
    return view(await this.#load(key, compute, ttlMs, tags), 'MISS', this.now());
  }

  #load(key, compute, ttlMs, tags) {
    const p = (async () => {
      this.stats.computations++;
      const value = await compute();
      const createdAt = this.now();
      const entry = { value, etag: `"${checksum(value)}"`, createdAt, expiresAt: createdAt + ttlMs, tags };
      this.#set(key, entry);
      return entry;
    })();
    if (this.singleFlight) {
      this.#inflight.set(key, p);
      const clear = () => this.#inflight.get(key) === p && this.#inflight.delete(key);
      p.then(clear, clear);
    }
    return p;
  }

  #set(key, entry) {
    this.#map.delete(key);
    this.#map.set(key, entry);
    for (const t of entry.tags) {
      if (!this.#tags.has(t)) this.#tags.set(t, new Set());
      this.#tags.get(t).add(key);
    }
    while (this.#map.size > this.max) {
      const oldest = this.#map.keys().next().value; // LRU = first in insertion order
      this.delete(oldest);
      this.stats.evictions++;
    }
  }

  #touch(key, entry) {
    this.#map.delete(key);
    this.#map.set(key, entry);
  }

  delete(key) {
    const e = this.#map.get(key);
    if (!e) return false;
    this.#map.delete(key);
    for (const t of e.tags) this.#tags.get(t)?.delete(key);
    return true;
  }

  invalidateTag(tag) {
    const keys = [...(this.#tags.get(tag) ?? [])];
    keys.forEach((k) => this.delete(k));
    this.#tags.delete(tag);
    return keys.length;
  }

  clear() {
    this.#map.clear();
    this.#tags.clear();
  }

  snapshot() {
    const total = this.stats.hits + this.stats.misses + this.stats.stale + this.stats.coalesced;
    const now = this.now();
    return {
      ...this.stats,
      size: this.#map.size,
      max: this.max,
      hitRatio: total ? Math.round(((total - this.stats.misses) / total) * 1000) / 10 : 0,
      keys: [...this.#map].map(([k, e]) => ({ key: k, ageMs: now - e.createdAt, fresh: now < e.expiresAt, etag: e.etag })),
    };
  }
}

function view(entry, status, now) {
  return { value: entry.value, etag: entry.etag, status, ageMs: now - entry.createdAt };
}
