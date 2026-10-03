import { useEffect, useState } from 'react';
import { api, getJson, postJson, fmtMs } from '../api.js';
import { PageHead, Stat, useAsync, ErrorText, Seg, BeforeAfter } from '../components/ui.jsx';
import { Columns, CompareBars } from '../components/charts.jsx';

const BEFORE = `// Every dashboard load re-runs a ~0.5 s analytical query.
app.get('/report', async (req, res) => {
  res.json(await computeReport(db, year));
});

// "Fixed" with a plain TTL map. Still broken:
//  - no size bound: memory leak
//  - on expiry, 50 concurrent requests all miss and
//    all recompute (thundering herd / cache stampede)
//  - users wait for the recompute on every expiry`;

const AFTER = `const cache = new SmartCache({
  max: 500,              // LRU-bounded
  ttlMs: 15_000,         // fresh window
  swrMs: 60_000,         // then serve stale + refresh in background
  singleFlight: true,    // concurrent misses share ONE computation
});

const r = await cache.getOrCompute(\`report:\${year}\`,
  () => computeReport(db, year), { tags: ['orders'] });

res.setHeader('ETag', r.etag);                 // browser revalidates…
if (req.headers['if-none-match'] === r.etag)   // …and gets a 0-byte 304
  return res.status(304).end();

// on write:  cache.invalidateTag('orders')`;

export default function Caching() {
  const [mode, setMode] = useState('smart');
  const [log, setLog] = useState([]);
  const [stats, setStats] = useState(null);
  const refreshStats = () => getJson('/api/labs/caching/stats').then(setStats);
  useEffect(() => { refreshStats(); }, []);

  const [reqState, request] = useAsync(async () => {
    const last = log.find((l) => l.mode === mode && l.etag);
    const r = await api(`/api/labs/caching/report?mode=${mode}`, { headers: mode === 'smart' && last ? { 'if-none-match': last.etag } : {} });
    setLog((l) => [{ i: l.length + 1, mode, status: r.status, cache: r.meta.cache, ms: r.meta.clientMs, bytes: r.meta.wireBytes, etag: r.meta.etag }, ...l].slice(0, 30));
    refreshStats();
  });

  const [stampedeState, runStampede] = useAsync(async (concurrency) => {
    const out = {};
    for (const m of ['none', 'naive', 'smart']) out[m] = await postJson('/api/labs/caching/stampede', { mode: m, concurrency });
    refreshStats();
    return out;
  });

  const [seriesState, runSeries] = useAsync(async () => {
    const out = {};
    for (const m of ['none', 'smart']) out[m] = await postJson('/api/labs/caching/series', { mode: m, requests: 8 });
    refreshStats();
    return out;
  });

  const s = stampedeState.data;
  const series = seriesState.data;

  return (
    <div className="stack">
      <PageHead kicker="Lab 4 · Backend" title="Caching">
        The report joins about 120,000 order rows and groups them by category and month, which takes roughly half a
        second. This lab compares three strategies: no cache, a naive TTL cache, and a production-grade cache with
        LRU eviction, TTL, stale-while-revalidate, single-flight, tag invalidation and ETag/304.
      </PageHead>

      <BeforeAfter before={BEFORE} after={AFTER} />

      <div className="card">
        <h2>1 · Repeat traffic</h2>
        <p className="small">Eight sequential requests. Without a cache, every request pays the full cost. With the cache, only the first does.</p>
        <button className="btn primary" disabled={seriesState.loading} onClick={runSeries}>{seriesState.loading ? 'Running…' : 'Send 8 requests per strategy'}</button>
        <ErrorText error={seriesState.error} />
        {series && (
          <div className="grid g2" style={{ marginTop: 12 }}>
            {['none', 'smart'].map((m) => (
              <div key={m}>
                <div className="row small" style={{ marginBottom: 4 }}>
                  <span className="swatch" style={{ background: `var(--${m === 'none' ? 'slow' : 'fast'})` }} />
                  <b>{m === 'none' ? 'No cache' : 'Smart cache'}</b>
                  <span className="muted">total {fmtMs(series[m].totalMs)}</span>
                </div>
                <Columns
                  color={m === 'none' ? 'slow' : 'fast'}
                  yFormat={fmtMs}
                  ariaLabel={`Per-request latency, ${m}`}
                  data={series[m].samples.map((x) => ({ label: `#${x.i + 1}`, value: x.ms, note: x.status }))}
                />
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <h2>2 · Cache stampede</h2>
        <p className="small">
          The key expires while traffic is high, and N requests arrive at the same moment. A naive cache lets
          all N miss and all N recompute, blocking the event loop for N × 0.5 s. Single-flight makes the other
          N−1 requests wait on the first computation instead.
        </p>
        <div className="row">
          {[5, 10, 20].map((c) => <button key={c} className="btn" disabled={stampedeState.loading} onClick={() => runStampede(c)}>{c} concurrent</button>)}
          {stampedeState.loading && <span className="small muted">Running. The no-cache and naive runs are slow on purpose.</span>}
        </div>
        <ErrorText error={stampedeState.error} />
        {s && (
          <>
            <div className="grid g3" style={{ marginTop: 12 }}>
              <Stat swatch="slow" label="No cache" value={`${s.none.computations} computations`} sub={fmtMs(s.none.wallMs)} />
              <Stat swatch="slow" label="Naive TTL cache" value={`${s.naive.computations} computations`} sub={`${fmtMs(s.naive.wallMs)} · it's cold, so every request misses`} />
              <Stat swatch="fast" label="Single-flight cache" value={`${s.smart.computations} computation`} sub={`${fmtMs(s.smart.wallMs)} · ${s.smart.statuses.COALESCED ?? 0} coalesced`} />
            </div>
            <div style={{ marginTop: 12 }}>
              <CompareBars format={fmtMs} rows={[{ label: `${s.smart.concurrency} concurrent: wall time`, slow: s.naive.wallMs, fast: s.smart.wallMs, slowText: 'naive', fastText: 'single-flight' }]} />
            </div>
          </>
        )}
      </div>

      <div className="card">
        <h2>3 · Try it by hand</h2>
        <div className="row">
          <Seg value={mode} onChange={setMode} label="Mode" options={[{ value: 'none', label: 'No cache' }, { value: 'naive', label: 'Naive TTL' }, { value: 'smart', label: 'Smart + ETag' }]} />
          <button className="btn primary" disabled={reqState.loading} onClick={request}>GET /report</button>
          <button className="btn" onClick={() => postJson('/api/labs/caching/invalidate').then(refreshStats)}>Simulate a write (invalidate tag)</button>
          <button className="btn" onClick={() => postJson('/api/labs/caching/reset').then(() => (setLog([]), refreshStats()))}>Reset</button>
        </div>
        <ErrorText error={reqState.error} />
        <p className="small muted" style={{ marginTop: 8 }}>
          In smart mode the second request sends <code>If-None-Match</code> and gets a <b>304</b> with no body.
          The entry is fresh for 15 s and stale-but-served for 60 s more, so wait 15 s to see <b>STALE</b>.
        </p>
        {log.length > 0 && (
          <div className="table-wrap">
            <table className="t">
              <thead><tr><th>#</th><th>Mode</th><th>HTTP</th><th>Cache</th><th className="r">Time</th><th className="r">Bytes on wire</th></tr></thead>
              <tbody>
                {log.map((l) => (
                  <tr key={l.i}>
                    <td>{l.i}</td><td>{l.mode}</td><td>{l.status}</td>
                    <td><span className={`status ${l.cache === 'MISS' || l.cache === 'BYPASS' ? 'warning' : 'good'}`}>{l.cache}</span></td>
                    <td className="r">{fmtMs(l.ms)}</td><td className="r">{l.status === 304 ? '0 (304)' : l.bytes.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {stats && (
        <div className="card">
          <h2>Cache internals</h2>
          <div className="small muted" style={{ marginBottom: 8 }}>Total report computations since reset: <b className="num">{stats.computations}</b></div>
          <div className="table-wrap">
            <table className="t">
              <thead><tr><th>Cache</th><th className="r">Hit ratio</th><th className="r">Hits</th><th className="r">Misses</th><th className="r">Stale</th><th className="r">Coalesced</th><th className="r">Computations</th><th className="r">Size</th></tr></thead>
              <tbody>
                {['naive', 'smart'].map((k) => (
                  <tr key={k}>
                    <td>{k}</td><td className="r">{stats[k].hitRatio}%</td><td className="r">{stats[k].hits}</td><td className="r">{stats[k].misses}</td>
                    <td className="r">{stats[k].stale}</td><td className="r">{stats[k].coalesced}</td><td className="r">{stats[k].computations}</td><td className="r">{stats[k].size}/{stats[k].max}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="callout">
        <b>Caching layers, from closest to the user outward:</b> browser (<code>Cache-Control</code>, <code>ETag</code>) → CDN
        (<code>s-maxage</code>, <code>stale-while-revalidate</code>) → app memory (this lab) → shared cache such as Redis (same
        single-flight idea, implemented with <code>SET NX</code> locks) → database buffer pool. Invalidation is the hard part,
        so use tags or versioned keys rather than guessing TTLs.
      </div>
    </div>
  );
}
