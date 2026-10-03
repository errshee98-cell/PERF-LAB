import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const config = {
  port: Number(process.env.PORT ?? 4000),
  host: process.env.HOST ?? '127.0.0.1',
  dbFile: process.env.DB_FILE ?? path.join(root, 'data', 'lab.db'),
  // 1 = ~1M rows (customers 10k, orders 120k, items ~360k, events 2×250k).
  seedScale: Number(process.env.SEED_SCALE ?? 1),
  // Default simulated DB network round-trip (ms) used to project N+1 cost.
  // SQLite is in-process, so a real Postgres/MySQL RTT (0.3–2 ms) is projected on top.
  defaultRttMs: Number(process.env.DB_RTT_MS ?? 0.5),
  clientDist: path.resolve(root, '..', 'client', 'dist'),
};
