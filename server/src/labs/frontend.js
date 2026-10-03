import { SmartCache } from '../lib/cache.js';

/**
 * Data for the React rendering lab: customers with lifetime value.
 * Served compactly (arrays of columns → objects on the client would be even
 * smaller; kept as objects for readability) and cached server-side.
 */
const cache = new SmartCache({ ttlMs: 5 * 60_000, max: 10 });

export async function rows(db, n) {
  const { value } = await cache.getOrCompute(`rows:${n}`, async () =>
    db.all(
      `SELECT c.id, c.name, c.email, c.city,
              COUNT(o.id) AS orders,
              COALESCE(SUM(o.total_cents), 0) AS ltvCents,
              MAX(o.created_at) AS lastOrderAt
       FROM (SELECT * FROM customers ORDER BY id LIMIT ?) c
       LEFT JOIN orders o ON o.customer_id = c.id
       GROUP BY c.id ORDER BY c.id`,
      n,
    ),
  );
  return value;
}
