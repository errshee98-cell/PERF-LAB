import { useState } from 'react';
import { postJson, fmtMs } from '../api.js';
import { PageHead, Stat, useAsync, ErrorText, Seg } from '../components/ui.jsx';
import { CompareBars, Columns, Legend } from '../components/charts.jsx';

const PRESETS = [
  { id: 'nplus', label: 'N+1 vs batched', slow: '/api/labs/n-plus-one?mode=naive&limit=50&rtt=0', fast: '/api/labs/n-plus-one?mode=batched&limit=50&rtt=0' },
  { id: 'index', label: 'No index vs index', slow: '/api/labs/indexing?scenario=feed&variant=slow&iterations=1', fast: '/api/labs/indexing?scenario=feed&variant=fast&iterations=1' },
  { id: 'cache', label: 'No cache vs cache', slow: '/api/labs/caching/report?mode=none', fast: '/api/labs/caching/report?mode=smart' },
  { id: 'payload', label: 'Bloated vs lean payload', slow: '/api/labs/payload/products?mode=bloated', fast: '/api/labs/payload/products?mode=lean' },
  { id: 'algo', label: 'O(n²) vs O(n)', slow: '/api/labs/algorithms?algo=dedupe&variant=slow&n=1000', fast: '/api/labs/algorithms?algo=dedupe&variant=fast&n=1000' },
];

export default function LoadTest() {
  const [preset, setPreset] = useState('index');
  const [concurrency, setConcurrency] = useState(20);
  const [duration, setDuration] = useState(4);
  const p = PRESETS.find((x) => x.id === preset);

  const [state, run] = useAsync(async () => {
    const slow = await postJson('/api/loadtest', { path: p.slow, concurrency, durationMs: duration * 1000 });
    const fast = await postJson('/api/loadtest', { path: p.fast, concurrency, durationMs: duration * 1000 });
    return { slow, fast, preset: p.label };
  });
  const r = state.data;

  return (
    <div className="stack">
      <PageHead kicker="Lab 7 · Under load" title="Load testing">
        A single request at 5 ms tells you little about behaviour under traffic. This lab runs a closed-loop load
        generator in a separate worker thread, so it doesn't share the server's event loop, and reports throughput and
        tail latency (p95/p99). Tail latency is what users actually feel.
      </PageHead>

      <div className="card">
        <div className="row">
          <Seg value={preset} onChange={setPreset} label="Scenario" options={PRESETS.map((x) => ({ value: x.id, label: x.label }))} />
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <label className="field">Virtual users: <b className="num">{concurrency}</b>
            <input type="range" min="1" max="100" value={concurrency} onChange={(e) => setConcurrency(+e.target.value)} />
          </label>
          <label className="field">Duration per side: <b className="num">{duration} s</b>
            <input type="range" min="2" max="10" value={duration} onChange={(e) => setDuration(+e.target.value)} />
          </label>
          <div className="spacer" />
          <button className="btn primary" disabled={state.loading} onClick={run}>{state.loading ? `Running about ${duration * 2} s…` : 'Run load test'}</button>
        </div>
        <div className="small muted mono" style={{ marginTop: 8 }}>
          <div><span className="swatch" style={{ background: 'var(--slow)' }} /> {p.slow}</div>
          <div><span className="swatch" style={{ background: 'var(--fast)' }} /> {p.fast}</div>
        </div>
        <ErrorText error={state.error} />
      </div>

      {r && (
        <>
          <div className="grid g4">
            <Stat swatch="slow" label="Problem: throughput" value={`${r.slow.rps} req/s`} sub={`${r.slow.requests} requests · ${r.slow.errors} errors`} />
            <Stat swatch="fast" label="Fix: throughput" value={`${r.fast.rps} req/s`} sub={`${r.fast.requests} requests · ${r.fast.errors} errors`} />
            <Stat swatch="slow" label="Problem: p99" value={fmtMs(r.slow.latency.p99)} sub={`p50 ${fmtMs(r.slow.latency.p50)}`} />
            <Stat swatch="fast" label="Fix: p99" value={fmtMs(r.fast.latency.p99)} sub={`p50 ${fmtMs(r.fast.latency.p50)}`} />
          </div>

          <div className="card">
            <h2>Latency percentiles at {r.slow.concurrency} concurrent users</h2>
            <CompareBars log format={fmtMs} rows={['p50', 'p90', 'p95', 'p99', 'max'].map((k) => ({ label: k, slow: r.slow.latency[k], fast: r.fast.latency[k] }))} />
          </div>

          <div className="card">
            <h2>Latency distribution</h2>
            <Legend />
            <div className="grid g2" style={{ marginTop: 8 }}>
              {['slow', 'fast'].map((k) => (
                <Columns key={k} color={k} ariaLabel={`${k} latency histogram`} yFormat={(v) => Math.round(v)}
                  data={r[k].histogram.map((b) => ({ label: b.le === '+Inf' ? '>5s' : `≤${b.le}`, value: b.count, note: 'requests' }))} />
              ))}
            </div>
            <p className="small muted">Bucket upper bounds in ms. With a closed-loop generator, a slow server also receives fewer requests. That's why throughput and latency must be read together.</p>
          </div>

          <div className="callout">
            <b>Little's law:</b> concurrency = throughput × latency. With {r.slow.concurrency} users and a{' '}
            {fmtMs(r.slow.latency.avg)} average, the slow path tops out near {Math.round((r.slow.concurrency / Math.max(r.slow.latency.avg, 0.01)) * 1000)} req/s.
            Node runs your JavaScript on one thread, so CPU-bound handlers (O(n²) loops, huge JSON) serialize every
            request behind them. For real tests use k6, autocannon or wrk from another machine.
          </div>
        </>
      )}
    </div>
  );
}
