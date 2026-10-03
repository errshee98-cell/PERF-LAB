import { rmSync } from 'node:fs';
import { config } from '../src/config.js';
import { openDatabase } from '../src/db.js';

// npm run seed  → wipe and regenerate the dataset (SEED_SCALE=0.2 for a smaller one)
for (const suffix of ['', '-wal', '-shm']) rmSync(config.dbFile + suffix, { force: true });
openDatabase().close();
