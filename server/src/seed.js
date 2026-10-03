import { rng as makeRng } from './lib/rng.js';

/**
 * Schema notes
 *  - orders / order_items / products have the *normal* FK indexes, so the
 *    N+1 lab measures round trips, not missing indexes.
 *  - `events` and `events_noidx` hold IDENTICAL rows. Only `events` has
 *    secondary indexes — that's the missing-index lab.
 */
export function createSchema(raw) {
  raw.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

    CREATE TABLE IF NOT EXISTS categories (
      id   INTEGER PRIMARY KEY,
      name TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS products (
      id          INTEGER PRIMARY KEY,
      category_id INTEGER NOT NULL REFERENCES categories(id),
      name        TEXT NOT NULL,
      sku         TEXT NOT NULL,
      price_cents INTEGER NOT NULL,
      description TEXT NOT NULL,
      specs_json  TEXT NOT NULL,
      image_url   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);

    CREATE TABLE IF NOT EXISTS customers (
      id         INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      email      TEXT NOT NULL,
      city       TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS orders (
      id          INTEGER PRIMARY KEY,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      status      TEXT NOT NULL,
      total_cents INTEGER NOT NULL,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
    CREATE INDEX IF NOT EXISTS idx_orders_created  ON orders(created_at);

    CREATE TABLE IF NOT EXISTS order_items (
      id               INTEGER PRIMARY KEY,
      order_id         INTEGER NOT NULL REFERENCES orders(id),
      product_id       INTEGER NOT NULL REFERENCES products(id),
      quantity         INTEGER NOT NULL,
      unit_price_cents INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_items_order   ON order_items(order_id);
    CREATE INDEX IF NOT EXISTS idx_items_product ON order_items(product_id);

    CREATE TABLE IF NOT EXISTS events_noidx (
      id         INTEGER PRIMARY KEY,
      user_id    INTEGER NOT NULL,
      type       TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      payload    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS events (
      id         INTEGER PRIMARY KEY,
      user_id    INTEGER NOT NULL,
      type       TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      payload    TEXT NOT NULL
    );
    -- equality column first, then the range / ORDER BY column
    CREATE INDEX IF NOT EXISTS idx_events_user_created ON events(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_events_type_created ON events(type, created_at);
  `);
}

export function isSeeded(raw) {
  return raw.prepare(`SELECT value FROM meta WHERE key = 'seeded'`).get()?.value === '1';
}

export const EVENT_TYPES = ['page_view', 'click', 'search', 'add_to_cart', 'checkout', 'login', 'logout', 'review'];
export const ORDER_STATUSES = ['paid', 'paid', 'paid', 'shipped', 'shipped', 'delivered', 'delivered', 'cancelled'];

const CATEGORIES = [
  'Audio', 'Cameras', 'Laptops', 'Phones', 'Tablets', 'Wearables', 'Gaming', 'Smart Home',
  'Kitchen', 'Furniture', 'Lighting', 'Garden', 'Fitness', 'Outdoor', 'Books', 'Music',
  'Toys', 'Beauty', 'Fashion', 'Shoes', 'Office', 'Pets', 'Automotive', 'Tools',
];
const ADJ = ['Swift', 'Quiet', 'Bold', 'Nimble', 'Lunar', 'Solar', 'Arctic', 'Urban', 'Classic', 'Hyper', 'Mellow', 'Prime', 'Vivid', 'Zen', 'Rapid', 'Cosmic'];
const MATERIAL = ['Carbon', 'Bamboo', 'Steel', 'Linen', 'Walnut', 'Ceramic', 'Glass', 'Copper', 'Velvet', 'Granite', 'Cotton', 'Titanium'];
const NOUN = ['Speaker', 'Lens', 'Notebook', 'Lamp', 'Kettle', 'Chair', 'Backpack', 'Watch', 'Router', 'Blender', 'Jacket', 'Drone', 'Mouse', 'Desk', 'Bottle', 'Headset', 'Planter', 'Tripod'];
const FIRST = ['Ava', 'Liam', 'Noah', 'Mia', 'Zara', 'Omar', 'Arjun', 'Sara', 'Leo', 'Yuki', 'Ines', 'Kofi', 'Elena', 'Ravi', 'Hana', 'Diego', 'Fatima', 'Ivan', 'Chloe', 'Musa'];
const LAST = ['Khan', 'Smith', 'Garcia', 'Chen', 'Okafor', 'Silva', 'Patel', 'Novak', 'Kim', 'Haddad', 'Rossi', 'Mensah', 'Ito', 'Dubois', 'Sharma', 'Lopez'];
const CITIES = ['Lahore', 'Berlin', 'Austin', 'Lagos', 'Osaka', 'Lisbon', 'Toronto', 'Nairobi', 'Pune', 'Seoul', 'Lima', 'Oslo', 'Dubai', 'Sydney'];
const LOREM = 'performance latency throughput cache index query render bundle payload network memory batch stream compress profile measure optimize scale budget vital paint layout'.split(' ');

const T_START = Date.UTC(2023, 0, 1) / 1000;
const T_END = Date.UTC(2025, 11, 31) / 1000;

export function seed(raw, { scale = 1, log = console.log } = {}) {
  const r = makeRng(42);
  const pick = (arr) => arr[Math.floor(r() * arr.length)];
  const int = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
  const n = (base) => Math.max(20, Math.round(base * scale));

  const sizes = {
    products: n(2000),
    customers: n(10_000),
    orders: n(120_000),
    events: n(250_000),
  };
  const t0 = performance.now();
  log?.(`[seed] generating dataset (scale=${scale}) …`);

  raw.exec('PRAGMA synchronous = OFF; BEGIN');
  try {
    const insCat = raw.prepare('INSERT INTO categories (id, name) VALUES (?, ?)');
    CATEGORIES.forEach((name, i) => insCat.run(i + 1, name));

    const insProd = raw.prepare(
      'INSERT INTO products (id, category_id, name, sku, price_cents, description, specs_json, image_url) VALUES (?,?,?,?,?,?,?,?)',
    );
    const prices = [];
    for (let id = 1; id <= sizes.products; id++) {
      const words = Array.from({ length: 140 }, () => pick(LOREM));
      const specs = {
        weightGrams: int(50, 9000), color: pick(['black', 'white', 'sand', 'teal', 'rust']),
        warrantyMonths: pick([6, 12, 24, 36]), origin: pick(CITIES), batteryHours: int(0, 48),
        dims: { w: int(5, 120), h: int(5, 120), d: int(1, 60) }, tags: [pick(LOREM), pick(LOREM), pick(LOREM)],
      };
      const price = int(299, 149_900);
      prices[id] = price;
      insProd.run(
        id, int(1, CATEGORIES.length), `${pick(ADJ)} ${pick(MATERIAL)} ${pick(NOUN)} ${id}`,
        `SKU-${String(id).padStart(6, '0')}`, price, words.join(' '), JSON.stringify(specs),
        `https://cdn.example.com/p/${id}/hero-2048.jpg`,
      );
    }

    const insCust = raw.prepare('INSERT INTO customers (id, name, email, city, created_at) VALUES (?,?,?,?,?)');
    for (let id = 1; id <= sizes.customers; id++) {
      const f = pick(FIRST), l = pick(LAST);
      insCust.run(id, `${f} ${l}`, `${f}.${l}${id}@example.com`.toLowerCase(), pick(CITIES), int(T_START, T_END));
    }

    const insOrder = raw.prepare('INSERT INTO orders (id, customer_id, status, total_cents, created_at) VALUES (?,?,?,?,?)');
    const insItem = raw.prepare('INSERT INTO order_items (order_id, product_id, quantity, unit_price_cents) VALUES (?,?,?,?)');
    for (let id = 1; id <= sizes.orders; id++) {
      // Skewed: 20% of customers place most orders (realistic hot keys)
      const customer = r() < 0.6 ? int(1, Math.ceil(sizes.customers * 0.2)) : int(1, sizes.customers);
      const lines = int(1, 5);
      let total = 0;
      const items = [];
      for (let k = 0; k < lines; k++) {
        const pid = int(1, sizes.products), qty = int(1, 4);
        total += prices[pid] * qty;
        items.push([pid, qty, prices[pid]]);
      }
      insOrder.run(id, customer, pick(ORDER_STATUSES), total, int(T_START, T_END));
      for (const [pid, qty, price] of items) insItem.run(id, pid, qty, price);
    }

    const insA = raw.prepare('INSERT INTO events (id, user_id, type, created_at, payload) VALUES (?,?,?,?,?)');
    const insB = raw.prepare('INSERT INTO events_noidx (id, user_id, type, created_at, payload) VALUES (?,?,?,?,?)');
    for (let id = 1; id <= sizes.events; id++) {
      const row = [id, int(1, sizes.customers), pick(EVENT_TYPES), int(T_START, T_END), `{"path":"/p/${int(1, sizes.products)}","ms":${int(5, 900)}}`];
      insA.run(...row);
      insB.run(...row);
    }

    raw.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('seeded', '1'), ('sizes', ?)`).run(JSON.stringify(sizes));
    raw.exec('COMMIT');
  } catch (err) {
    raw.exec('ROLLBACK');
    throw err;
  }
  raw.exec('PRAGMA synchronous = NORMAL; ANALYZE;');
  log?.(`[seed] done in ${Math.round(performance.now() - t0)} ms`, sizes);
}

export const TIME_RANGE = { start: T_START, end: T_END };
