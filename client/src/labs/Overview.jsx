import { useEffect, useState } from 'react';
import { getJson, postJson, fmtMs, fmtBytes, fmtX } from '../api.js';
import { PageHead, Stat, useAsync, ErrorText } from '../components/ui.jsx';
import { CompareBars } from '../components/charts.jsx';

const LAB_LINKS = {
  'n-plus-one': '#/n-plus-one', indexing: '#/indexing', algorithms: '#/algorithms', caching: '#/caching', payload: '#/payload',
};

export default function Overview() {
  const [bench, runBench] = useAsync(() => getJson('/api/overview'));
  const [metrics, setMetrics] = useState(null);

  useEffect(() => {
    let alive = true;
    const tick = () => getJson('/api/metrics').then((m) => alive && setMetrics(m)).catch(() => {});
    tick();
    const t = setInterval(tick, 3000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const rows = bench.data ?? [];
  const timed = rows.filter((r) => r.slowMs != null);
  const best = rows.length ? Math.max(...rows.map((r) => r.speedup)) : null;
  const median = timed.length ? [...timed].sort((a, b) => a.speedup - b.speedup)[Math.floor(timed.length / 2)].speedup : null;

  return (
    <div className="stack">
      <PageHead kicker="Full-stack performance engineering" title="Find it. Measure it. Fix it. Prove it.">
        Six labs, each with a realistic slow implementation and an optimized fix running against the same
        ~1M-row SQLite dataset. Every fix is checked to return the same result as the slow version, so the
        speedups below are like-for-like.
      </PageHead>

      <div className="card">
        <div className="row">
          <div>
            <h2 style={{ margin: 0 }}>Benchmark every lab</h2>
            <div className="small muted">Runs one problem-vs-fix comparison per lab on the server. It takes about 15 seconds, because the slow paths really are slow.</div>
          </div>
          <div className="spacer" />
          <button className="btn primary" disabled={bench.loading} onClick={runBench}>
            {bench.loading ? 'Running…' : rows.length ? 'Run again' : 'Run all benchmarks'}
          </button>
        </div>
        <ErrorText error={bench.error} />
      </div>

      {rows.length > 0 && (
        <>
          <div className="grid g4">
            <Stat label="Problems fixed" value={rows.length} sub="across 5 server labs" />
            <Stat label="Median speedup" value={median ? fmtX(median) : '—'} sub="timed comparisons" />
            <Stat label="Biggest win" value={best ? fmtX(best) : '—'} sub={rows.find((r) => r.speedup === best)?.problem} />
            <Stat label="Same results" value={`${rows.filter((r) => r.sameResult !== false).length}/${rows.length}`} sub="checksum-verified" />
          </div>

          <div className="card">
            <h2>Time per problem: before and after</h2>
            <CompareBars
              log
              ariaLabel="Slow vs optimized time per problem"
              format={fmtMs}
              rows={timed.map((r) => ({ label: r.problem, slow: r.slowMs, fast: r.fastMs, slowText: r.slowDetail, fastText: r.fastDetail }))}
            />
          </div>

          <div className="card table-wrap">
            <table className="t">
              <thead>
                <tr><th>Lab</th><th>Problem</th><th>Fix</th><th className="r">Before</th><th className="r">After</th><th className="r">Speedup</th><th>Result</th></tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td><a href={LAB_LINKS[r.lab]}>{r.lab}</a></td>
                    <td>{r.problem}<div className="small muted">{r.slowDetail} → {r.fastDetail}</div></td>
                    <td>{r.fix}</td>
                    <td className="r">{r.slowMs != null ? fmtMs(r.slowMs) : fmtBytes(r.slowBytes)}</td>
                    <td className="r">{r.fastMs != null ? fmtMs(r.fastMs) : fmtBytes(r.fastBytes)}</td>
                    <td className="r delta-good">{fmtX(r.speedup)}</td>
                    <td>{r.sameResult == null ? <span className="muted">n/a</span> : r.sameResult ? <span className="status good">identical</span> : <span className="status critical">mismatch</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <ServerHealth metrics={metrics} />
    </div>
  );
}

function ServerHealth({ metrics }) {
  if (!metrics) return null;
  const eld = metrics.eventLoopDelayMs;
  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 10 }}>
        <h2 style={{ margin: 0 }}>Live server health</h2>
        <span className="small muted">refreshes every 3 s</span>
        <div className="spacer" />
        <button className="btn" onClick={() => postJson('/api/metrics/reset')}>Reset</button>
      </div>
      <div className="grid g4" style={{ marginBottom: 12 }}>
        <Stat label="Event-loop delay p99" value={fmtMs(eld.p99)} sub={`max ${fmtMs(eld.max)} · blocking work shows up here`} />
        <Stat label="Heap used" value={`${metrics.memory.heapUsedMb} MB`} sub={`RSS ${metrics.memory.rssMb} MB`} />
        <Stat label="Routes seen" value={metrics.routes.length} sub={`${metrics.routes.reduce((a, r) => a + r.count, 0)} requests`} />
        <Stat label="Uptime" value={`${Math.floor(metrics.uptimeSec / 60)}m ${metrics.uptimeSec % 60}s`} />
      </div>
      {metrics.routes.length > 0 && (
        <div className="table-wrap">
          <table className="t">
            <thead><tr><th>Route (slowest p95 first)</th><th className="r">Count</th><th className="r">p50</th><th className="r">p95</th><th className="r">p99</th><th className="r">Errors</th></tr></thead>
            <tbody>
              {metrics.routes.slice(0, 12).map((r) => (
                <tr key={r.route}>
                  <td className="mono">{r.route}</td>
                  <td className="r">{r.count}</td><td className="r">{fmtMs(r.p50)}</td><td className="r">{fmtMs(r.p95)}</td><td className="r">{fmtMs(r.p99)}</td><td className="r">{r.errors}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
