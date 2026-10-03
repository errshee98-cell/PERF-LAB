import { useState } from 'react';
import { api, getJson, fmtMs, fmtBytes } from '../api.js';
import { PageHead, Stat, useAsync, ErrorText, BeforeAfter } from '../components/ui.jsx';
import { CompareBars } from '../components/charts.jsx';

const BEFORE = `app.get('/products', (req, res) => {
  const rows = db.all('SELECT * FROM products');   // every column, every row
  res.type('json').send(JSON.stringify(rows, null, 2));
});
// 2,000 products × (1 KB description + specs JSON + URLs)
// no pagination, no compression, no validators`;

const AFTER = `app.get('/products', (req, res) => {
  const items = db.all(\`
    SELECT p.id, p.name, p.price_cents AS priceCents, c.name AS category
    FROM products p JOIN categories c ON c.id = p.category_id
    WHERE p.id > ? ORDER BY p.id LIMIT ?\`, cursor, 50);  // keyset page
  // + Content-Encoding: br (quality 4 for dynamic responses)
  // + ETag → 304 Not Modified on revisit
  // + Cache-Control: public, max-age=60, stale-while-revalidate=300
});`;

export default function Payload() {
  const [calls, setCalls] = useState({});
  const [cmp, loadCmp] = useAsync(() => getJson('/api/labs/payload/compare'));

  const [state, run] = useAsync(async () => {
    const bloated = await api('/api/labs/payload/products?mode=bloated');
    const lean = await api('/api/labs/payload/products?mode=lean');
    const revisit = await api('/api/labs/payload/products?mode=lean', { headers: { 'if-none-match': lean.meta.etag } });
    setCalls({
      bloated: { ...bloated.meta, rows: bloated.data.length },
      lean: { ...lean.meta, rows: lean.data.items.length, next: lean.data.nextCursor },
      revisit: { ...revisit.meta, status: revisit.status },
    });
  });

  const b = calls.bloated, l = calls.lean, rv = calls.revisit;

  return (
    <div className="stack">
      <PageHead kicker="Lab 5 · Network" title="Payload and network">
        Bytes cost time three ways: on the wire, in <code>JSON.parse</code> on the client (main thread), and in
        <code> JSON.stringify</code> on the server (event loop). Send fewer rows, fewer columns, compressed, and
        don't resend what the client already has.
      </PageHead>

      <BeforeAfter before={BEFORE} after={AFTER} />

      <div className="card">
        <div className="row">
          <h2 style={{ margin: 0 }}>Fetch both from your browser</h2>
          <div className="spacer" />
          <button className="btn primary" disabled={state.loading} onClick={run}>{state.loading ? 'Fetching…' : 'Fetch bloated vs lean'}</button>
        </div>
        <ErrorText error={state.error} />
        {b && (
          <>
            <div className="grid g4" style={{ marginTop: 12 }}>
              <Stat swatch="slow" label="Bloated: on the wire" value={fmtBytes(b.wireBytes)} sub={`${b.rows.toLocaleString()} rows · ${fmtMs(b.clientMs)} · ${b.encoding ?? 'uncompressed'}`} />
              <Stat swatch="fast" label="Lean: on the wire" value={fmtBytes(l.wireBytes)} sub={`${l.rows} rows · ${fmtMs(l.clientMs)} · ${l.encoding ?? 'identity'} (raw ${fmtBytes(l.rawBytes)})`} />
              <Stat label="Reduction" value={<span className="delta-good">{Math.round(b.wireBytes / l.wireBytes)}× smaller</span>} sub="first page vs everything" />
              <Stat label="Revisit (ETag)" value={rv.status === 304 ? <span className="status good">304</span> : rv.status} sub={rv.status === 304 ? '0 body bytes. Client reuses its copy.' : 'not modified check'} />
            </div>
            <div style={{ marginTop: 12 }}>
              <CompareBars log format={fmtBytes} rows={[{ label: 'Bytes on the wire', slow: b.wireBytes, fast: l.wireBytes }]} />
              <CompareBars log format={fmtMs} rows={[{ label: 'Request time (browser)', slow: b.clientMs, fast: l.clientMs }]} />
            </div>
          </>
        )}
      </div>

      <div className="card">
        <div className="row">
          <h2 style={{ margin: 0 }}>Where the bytes go</h2>
          <div className="spacer" />
          <button className="btn" disabled={cmp.loading} onClick={loadCmp}>{cmp.loading ? 'Compressing…' : 'Compare encodings'}</button>
        </div>
        <ErrorText error={cmp.error} />
        {cmp.data && (
          <div className="table-wrap" style={{ marginTop: 10 }}>
            <table className="t">
              <thead>
                <tr><th>Payload</th><th className="r">Raw</th>{cmp.data.rows[0].encodings.map((e) => <th key={e.encoding} className="r">{e.encoding}</th>)}</tr>
              </thead>
              <tbody>
                {cmp.data.rows.map((r) => (
                  <tr key={r.label}>
                    <td>{r.label}</td>
                    <td className="r">{fmtBytes(r.raw)}</td>
                    {r.encodings.map((e) => (
                      <td key={e.encoding} className="r">{e.skipped ? <span className="muted small">skipped: {e.skipped}</span> : <>{fmtBytes(e.bytes)}<div className="small muted">{fmtMs(e.ms)} CPU</div></>}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="small" style={{ marginTop: 8 }}>
              Brotli quality 11 is only a few percent smaller than quality 4, but it costs many times more CPU. On the multi-MB payloads it takes over a minute, so it's skipped there. Use it for
              static assets at build time. For dynamic responses, use q4–5 or gzip-6. Projection and pagination save more
              than any compression setting.
            </p>
          </div>
        )}
      </div>

      <div className="callout">
        <b>Also on the network checklist:</b> HTTP keep-alive (set on this server), HTTP/2 multiplexing, <code>immutable</code>
        caching for hashed bundles (the production static server here does this), preconnect to third-party origins,
        and avoiding request waterfalls by fetching in parallel or at the route level.
      </div>
    </div>
  );
}
