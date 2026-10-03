import { useState } from 'react';
import { getJson, fmtMs } from '../api.js';
import { PageHead, Stat, useAsync, ErrorText, BeforeAfter, Seg } from '../components/ui.jsx';
import { CompareBars } from '../components/charts.jsx';

const BEFORE = `// Looks innocent. With a lazy-loading ORM this is exactly what runs.
const orders = await Order.findAll({ limit: 100 });          // 1 query
for (const order of orders) {
  order.customer = await order.getCustomer();                // +100
  for (const item of await order.getItems()) {               // +100
    item.product  = await item.getProduct();                 // +~300
    item.category = await item.product.getCategory();        // +~300
  }
}
// ≈ 800 sequential round trips × network RTT`;

const AFTER = `// Batch per relation (DataLoader pattern): 5 queries, regardless of N.
const orders    = db.all(RECENT_ORDERS, limit);
const customers = byId(db.all(
  'SELECT … FROM customers WHERE id IN (SELECT value FROM json_each(?))',
  JSON.stringify(unique(orders.map(o => o.customer_id)))));
const items     = db.all('… WHERE order_id IN (SELECT value FROM json_each(?))', …);
const products  = byId(db.all('… WHERE id IN (…)', …));
const categories= byId(db.all('… WHERE id IN (…)', …));
// stitch in memory with Map lookups: O(1) each

// ORM equivalents: include / eager_load / select_related / JOIN FETCH`;

const MODES = [
  { value: 'naive', label: 'Naive (N+1)' },
  { value: 'batched', label: 'Batched IN (…)' },
  { value: 'join', label: 'Single JOIN' },
];

export default function NPlusOne() {
  const [limit, setLimit] = useState(100);
  const [rtt, setRtt] = useState(0.5);
  const [results, setResults] = useState({});
  const [focus, setFocus] = useState('naive');

  const [state, runAll] = useAsync(async () => {
    const out = {};
    for (const m of MODES) out[m.value] = await getJson(`/api/labs/n-plus-one?mode=${m.value}&limit=${limit}&rtt=${rtt}`);
    setResults(out);
    return out;
  });

  const r = results;
  const shown = r[focus];
  const allSame = r.naive && r.naive.checksum === r.batched.checksum && r.naive.checksum === r.join.checksum;

  return (
    <div className="stack">
      <PageHead kicker="Lab 1 · Database" title="N+1 queries">
        Loading a list and then lazily loading each row's relations turns 1 request into hundreds of
        sequential database round trips. SQLite runs in-process here, so each run also projects the cost onto
        a networked database by adding <b>queries × RTT</b>.
      </PageHead>

      <BeforeAfter before={BEFORE} after={AFTER} />

      <div className="card">
        <div className="row">
          <label className="field">Orders to load: <b className="num">{limit}</b>
            <input type="range" min="10" max="500" step="10" value={limit} onChange={(e) => setLimit(+e.target.value)} />
          </label>
          <label className="field">DB round-trip time: <b className="num">{rtt} ms</b>
            <input type="range" min="0" max="5" step="0.1" value={rtt} onChange={(e) => setRtt(+e.target.value)} />
          </label>
          <div className="spacer" />
          <button className="btn primary" disabled={state.loading} onClick={runAll}>{state.loading ? 'Running…' : 'Run all three strategies'}</button>
        </div>
        <div className="small muted" style={{ marginTop: 6 }}>Typical RTT: 0.2–0.5 ms on the same host or availability zone, 1–2 ms across zones, 20 ms or more across regions.</div>
        <ErrorText error={state.error} />
      </div>

      {r.naive && (
        <>
          <div className="grid g3">
            {MODES.map((m) => (
              <Stat
                key={m.value}
                swatch={m.value === 'naive' ? 'slow' : 'fast'}
                label={m.label}
                value={`${r[m.value].metrics.queries.toLocaleString()} queries`}
                sub={`${fmtMs(r[m.value].metrics.projectedMs)} projected · ${fmtMs(r[m.value].metrics.wallMs)} in-process`}
              />
            ))}
          </div>

          <div className="card">
            <h2>Projected response time at {rtt} ms RTT</h2>
            <CompareBars
              format={fmtMs}
              ariaLabel="Projected latency"
              rows={[
                { label: 'vs. batched IN (…)', slow: r.naive.metrics.projectedMs, fast: r.batched.metrics.projectedMs, slowText: `${r.naive.metrics.queries} queries`, fastText: `${r.batched.metrics.queries} queries` },
                { label: 'vs. single JOIN', slow: r.naive.metrics.projectedMs, fast: r.join.metrics.projectedMs, slowText: `${r.naive.metrics.queries} queries`, fastText: `${r.join.metrics.queries} query` },
              ]}
            />
            <p className="small" style={{ marginTop: 8 }}>
              {allSame ? <span className="status good">All three return identical data (checksum {r.naive.checksum})</span> : <span className="status critical">Checksums differ</span>}
              {' · '}{r.naive.orders} orders, {r.naive.items} line items.
              {' '}Batched usually beats the JOIN on wide trees: a JOIN repeats each parent's columns on every child row.
            </p>
          </div>

          <div className="card">
            <div className="row" style={{ marginBottom: 10 }}>
              <h2 style={{ margin: 0 }}>Query log</h2>
              <Seg value={focus} onChange={setFocus} options={MODES} label="Strategy" />
            </div>
            <div className="small muted" style={{ marginBottom: 6 }}>
              First {shown.queryLog.length} of {shown.metrics.queries.toLocaleString()} statements
            </div>
            <pre className="code" style={{ maxHeight: 260 }}>{shown.queryLog.map((q, i) => `${String(i + 1).padStart(3)}  ${q}`).join('\n')}{shown.metrics.queries > shown.queryLog.length ? `\n     … ${shown.metrics.queries - shown.queryLog.length} more` : ''}</pre>
          </div>
        </>
      )}

      <div className="callout">
        <b>How to catch it in production:</b> log the query count per request (this server sends it as the
        <code> x-db-queries</code> header and in <code>Server-Timing</code>), alert when it scales with page size,
        and add a test that asserts the count stays constant, as <code>server/test/labs.test.js</code> does.
      </div>
    </div>
  );
}
