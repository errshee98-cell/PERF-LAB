import { useEffect, useState } from 'react';
import { getJson, fmtMs } from '../api.js';
import { PageHead, Stat, useAsync, ErrorText, Seg, BeforeAfter } from '../components/ui.jsx';
import { LineChart } from '../components/charts.jsx';

export default function Algorithms() {
  const [cases, setCases] = useState([]);
  const [algo, setAlgo] = useState('dedupe');
  const [n, setN] = useState(null);
  const [single, setSingle] = useState({});
  const [curves, setCurves] = useState({});

  useEffect(() => { getJson('/api/labs/algorithms/cases').then(setCases); }, []);
  const c = cases.find((x) => x.id === algo);
  const size = n ?? c?.defaultN ?? 1000;

  const [runState, runOnce] = useAsync(async () => {
    const slow = await getJson(`/api/labs/algorithms?algo=${algo}&variant=slow&n=${size}`);
    const fast = await getJson(`/api/labs/algorithms?algo=${algo}&variant=fast&n=${size}`);
    setSingle((s) => ({ ...s, [algo]: { slow, fast } }));
  });
  const [curveState, runCurve] = useAsync(async () => {
    const data = await getJson(`/api/labs/algorithms/scaling?algo=${algo}`);
    setCurves((s) => ({ ...s, [algo]: data }));
  });

  const r = single[algo];
  const curve = curves[algo];

  return (
    <div className="stack">
      <PageHead kicker="Lab 3 · Backend CPU" title="Slow algorithms">
        These are the bugs that pass code review: <code>.filter()</code> inside <code>.map()</code>,{' '}
        <code>.includes()</code> inside a loop, normalizing inside the inner loop. At n=100 nobody notices.
        At n=10,000 they block the event loop for every other user. Run the scaling curve to see the growth rate
        directly.
      </PageHead>

      <div className="card">
        <div className="row">
          <Seg value={algo} onChange={(v) => (setAlgo(v), setN(null))} label="Case" options={cases.map((x) => ({ value: x.id, label: x.title.split(' (')[0].split(' —')[0] }))} />
        </div>
        {c && (
          <div className="row" style={{ marginTop: 12 }}>
            <label className="field">Input size n: <b className="num">{size.toLocaleString()}</b>
              <input type="range" min={c.scaling[0]} max={c.scaling.at(-1)} step={c.scaling[0]} value={size} onChange={(e) => setN(+e.target.value)} />
            </label>
            <div className="spacer" />
            <button className="btn" disabled={runState.loading} onClick={runOnce}>{runState.loading ? 'Running…' : 'Run once at this n'}</button>
            <button className="btn primary" disabled={curveState.loading} onClick={runCurve}>{curveState.loading ? 'Measuring 5 sizes…' : 'Measure scaling curve'}</button>
          </div>
        )}
        <ErrorText error={runState.error || curveState.error} />
      </div>

      {c && r && (
        <div className="grid g4">
          <Stat swatch="slow" label={`Problem ${c.slowComplexity}`} value={fmtMs(r.slow.ms)} sub={c.slowLabel} />
          <Stat swatch="fast" label={`Fix ${c.fastComplexity}`} value={fmtMs(r.fast.ms)} sub={c.fastLabel} />
          <Stat label="Speedup" value={<span className="delta-good">{Math.round(r.slow.ms / Math.max(r.fast.ms, 0.001))}×</span>} sub={`n = ${r.slow.n.toLocaleString()}`} />
          <Stat label="Same output?" value={r.slow.checksum === r.fast.checksum ? <span className="status good">Yes</span> : <span className="status critical">No</span>} sub={`checksum ${r.fast.checksum}`} />
        </div>
      )}

      {c && curve && (
        <div className="card">
          <h2>Growth curve: {c.slowComplexity} vs {c.fastComplexity}</h2>
          <LineChart
            xLabel="n"
            xFormat={(v) => (v >= 1000 ? `${v / 1000}k` : v)}
            yFormat={fmtMs}
            series={[
              { key: 'slow', label: `Problem ${c.slowComplexity}`, points: curve.points.map((p) => ({ x: p.n, y: p.slowMs })) },
              { key: 'fast', label: `Fix ${c.fastComplexity}`, points: curve.points.map((p) => ({ x: p.n, y: p.fastMs })) },
            ]}
          />
          <GrowthTable points={curve.points} />
        </div>
      )}

      {c && <BeforeAfter before={dedent(c.slowSource)} after={dedent(c.fastSource)} beforeTitle={`Problem: ${c.slowLabel}`} afterTitle={`Fix: ${c.fastLabel}`} />}

      <div className="callout">
        <b>Rule of thumb:</b> doubling n should roughly double the time. If it quadruples, you have O(n²).
        The ratio column below the chart shows this. To find these in production, profile with{' '}
        <code>node --cpu-prof</code> or Chrome DevTools, and watch event-loop delay on the Overview page.
      </div>
    </div>
  );
}

function GrowthTable({ points }) {
  return (
    <div className="table-wrap" style={{ marginTop: 10 }}>
      <table className="t">
        <thead><tr><th className="r">n</th><th className="r">Problem</th><th className="r">×prev</th><th className="r">Fix</th><th className="r">×prev</th></tr></thead>
        <tbody>
          {points.map((p, i) => {
            const prev = points[i - 1];
            const ratio = (a, b) => (a != null && b ? `${(a / b).toFixed(1)}×` : '—');
            return (
              <tr key={p.n}>
                <td className="r">{p.n.toLocaleString()}</td>
                <td className="r">{p.slowMs == null ? 'skipped' : fmtMs(p.slowMs)}</td>
                <td className="r muted">{prev ? ratio(p.slowMs, prev.slowMs) : ''}</td>
                <td className="r">{fmtMs(p.fastMs)}</td>
                <td className="r muted">{prev ? ratio(p.fastMs, prev.fastMs) : ''}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function dedent(src) {
  const lines = src.split('\n');
  const indent = Math.min(...lines.slice(1).filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length));
  return [lines[0], ...lines.slice(1).map((l) => l.slice(Number.isFinite(indent) ? indent - 2 : 0))].join('\n');
}
