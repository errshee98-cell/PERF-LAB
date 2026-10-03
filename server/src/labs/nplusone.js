import { measure } from '../lib/measure.js';
import { checksum } from '../lib/stats.js';

/**
 * LAB 1 — N+1 queries
 *
 * Endpoint: "latest N orders with customer, line items, product and category".
 *
 *  naive    — 1 query for orders, then per order: customer + items, then per item:
 *             product + category.  ≈ 1 + 2N + 2·(items) round trips (~800 for N=100).
 *  batched  — DataLoader style: one `WHERE id IN (…)` per relation → 5 queries total,
 *             independent of N. Ids are passed as ONE JSON param (json_each) so the
 *             statement text is constant → the prepared-statement cache stays hot.
 *  join     — one SQL statement with JOINs, rows folded into a tree in JS.
 *
 * All three return byte-identical output (verified by checksum + tests).
 */
export const MODES = ['naive', 'batched', 'join'];

const RECENT_ORDERS = `
  SELECT id, customer_id, status, total_cents, created_at
  FROM orders ORDER BY created_at DESC, id DESC LIMIT ?`;

function shapeOrder(o, customer, items) {
  return {
    id: o.id,
    status: o.status,
    totalCents: o.total_cents,
    createdAt: o.created_at,
    customer: { id: customer.id, name: customer.name, email: customer.email, city: customer.city },
    items,
  };
}

function shapeItem(it, product, categoryName) {
  return {
    id: it.id,
    quantity: it.quantity,
    unitPriceCents: it.unit_price_cents,
    product: { id: product.id, name: product.name, sku: product.sku, category: categoryName },
  };
}

// ─── naive: the code an ORM writes when you access relations lazily in a loop ───
function naive(db, limit) {
  const orders = db.all(RECENT_ORDERS, limit);
  return orders.map((o) => {
    const customer = db.get('SELECT id, name, email, city FROM customers WHERE id = ?', o.customer_id);
    const items = db.all('SELECT id, product_id, quantity, unit_price_cents FROM order_items WHERE order_id = ? ORDER BY id', o.id);
    return shapeOrder(
      o,
      customer,
      items.map((it) => {
        const product = db.get('SELECT id, name, sku, category_id FROM products WHERE id = ?', it.product_id);
        const category = db.get('SELECT name FROM categories WHERE id = ?', product.category_id);
        return shapeItem(it, product, category.name);
      }),
    );
  });
}

// ─── batched: collect keys, load each relation once, stitch in memory with Maps ───
const byId = (rows, key = 'id') => new Map(rows.map((r) => [r[key], r]));
const inList = (col) => `${col} IN (SELECT value FROM json_each(?))`;
const unique = (xs) => JSON.stringify([...new Set(xs)]);

function batched(db, limit) {
  const orders = db.all(RECENT_ORDERS, limit);
  const customers = byId(db.all(`SELECT id, name, email, city FROM customers WHERE ${inList('id')}`, unique(orders.map((o) => o.customer_id))));
  const items = db.all(
    `SELECT id, order_id, product_id, quantity, unit_price_cents FROM order_items WHERE ${inList('order_id')} ORDER BY id`,
    unique(orders.map((o) => o.id)),
  );
  const products = byId(db.all(`SELECT id, name, sku, category_id FROM products WHERE ${inList('id')}`, unique(items.map((i) => i.product_id))));
  const categories = byId(db.all(`SELECT id, name FROM categories WHERE ${inList('id')}`, unique([...products.values()].map((p) => p.category_id))));

  const itemsByOrder = new Map();
  for (const it of items) {
    const p = products.get(it.product_id);
    if (!itemsByOrder.has(it.order_id)) itemsByOrder.set(it.order_id, []);
    itemsByOrder.get(it.order_id).push(shapeItem(it, p, categories.get(p.category_id).name));
  }
  return orders.map((o) => shapeOrder(o, customers.get(o.customer_id), itemsByOrder.get(o.id) ?? []));
}

// ─── join: one round trip, fold the flat rows into a tree ───
function joined(db, limit) {
  const rows = db.all(
    `WITH recent AS (${RECENT_ORDERS})
     SELECT r.id AS order_id, r.customer_id, r.status, r.total_cents, r.created_at,
            c.name AS customer_name, c.email, c.city,
            oi.id AS item_id, oi.quantity, oi.unit_price_cents,
            p.id AS product_id, p.name AS product_name, p.sku, cat.name AS category
     FROM recent r
     JOIN customers c          ON c.id = r.customer_id
     LEFT JOIN order_items oi  ON oi.order_id = r.id
     LEFT JOIN products p      ON p.id = oi.product_id
     LEFT JOIN categories cat  ON cat.id = p.category_id
     ORDER BY r.created_at DESC, r.id DESC, oi.id`,
    limit,
  );
  const out = [];
  let cur = null;
  for (const r of rows) {
    if (!cur || cur.id !== r.order_id) {
      cur = shapeOrder(
        { id: r.order_id, status: r.status, total_cents: r.total_cents, created_at: r.created_at },
        { id: r.customer_id, name: r.customer_name, email: r.email, city: r.city },
        [],
      );
      out.push(cur);
    }
    if (r.item_id != null) {
      cur.items.push(
        shapeItem(
          { id: r.item_id, quantity: r.quantity, unit_price_cents: r.unit_price_cents },
          { id: r.product_id, name: r.product_name, sku: r.sku },
          r.category,
        ),
      );
    }
  }
  return out;
}

const IMPL = { naive, batched, join: joined };

export async function run(db, { mode = 'naive', limit = 100, rtt = 0.5 } = {}) {
  const { result, metrics, queryLog } = await measure(() => IMPL[mode](db, limit), { rtt });
  return {
    lab: 'n-plus-one',
    mode,
    limit,
    metrics,
    orders: result.length,
    items: result.reduce((n, o) => n + o.items.length, 0),
    checksum: checksum(result),
    queryLog,
    preview: result.slice(0, 2),
  };
}
