import { useEffect, useState } from 'react';
import { getJson, postJson, fmtMs } from '../api.js';
import { PageHead, Stat, useAsync, ErrorText, PlanView, Seg, Code } from '../components/ui.jsx';
import { CompareBars } from '../components/charts.jsx';

const EXAMPLES = [
  'SELECT * FROM events_noidx WHERE user_id = 42 ORDER BY created_at DESC LIMIT 20',
  'SELECT id, type FROM events WHERE user_id = 42 ORDER BY created_at DESC LIMIT 20',
  "SELECT COUNT(*) FROM events WHERE type = 'click' AND created_at > 1700000000",
  "SELECT * FROM customers WHERE email LIKE '%@example.com'",
  'SELECT o.id, c.name FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.status = \'paid\' ORDER BY o.total_cents DESC LIMIT 10',
  'SELECT id FROM events ORDER BY id LIMIT 20 OFFSET 200000',
];

export default function Indexing() {
  const [scenarios, setScenarios] = useState([]);
  const [scenario, setScenario] = useState('feed');
  const [res, setRes] = useState({});

  useEffect(() => { getJson('/api/labs/indexing/scenarios').then(setScenarios); }, []);

  const [state, run] = useAsync(async () => {
    const slow = await getJson(`/api/labs/indexing?scenario=${scenario}&variant=slow&iterations=20`);
    const fast = await getJson(`/api/labs/indexing?scenario=${scenario}&variant=fast&iterations=20`);
    setRes((r) => ({ ...r, [scenario]: { slow, fast } }));
  });

  const sc = scenarios.find((s) => s.id === scenario);
  const cur = res[scenario];

  return (
    <div className="stack">
      <PageHead kicker="Lab 2 · Database" title="Missing indexes">
        <code>events</code> and <code>events_noidx</code> each hold the same 250,000 rows. The only difference is two
        <code> CREATE INDEX</code> statements. Run a scenario to see the query plan change from <b>SCAN</b> (read every
        row) to <b>SEARCH</b> (seek through the B-tree).
      </PageHead>

      <div className="card">
        <div className="row">
          <Seg value={scenario} onChange={setScenario} label="Scenario" options={scenarios.map((s) => ({ value: s.id, label: s.title }))} />
          <div className="spacer" />
          <button className="btn primary" disabled={state.loading} onClick={run}>{state.loading ? 'Running 2×20 queries…' : 'Run scenario'}</button>
        </div>
        {sc && <p style={{ marginTop: 12 }}>{sc.why}</p>}
        {sc && <Code title="Fix">{sc.fix}</Code>}
        <ErrorText error={state.error} />
      </div>

      {cur && (
        <>
          <div className="grid g4">
            <Stat swatch="slow" label="Without fix: p50" value={fmtMs(cur.slow.timing.p50)} sub={`p95 ${fmtMs(cur.slow.timing.p95)}`} />
            <Stat swatch="fast" label="With fix: p50" value={fmtMs(cur.fast.timing.p50)} sub={`p95 ${fmtMs(cur.fast.timing.p95)}`} />
            <Stat label="Speedup (avg)" value={<span className="delta-good">{Math.round(cur.slow.timing.avg / Math.max(cur.fast.timing.avg, 0.001))}×</span>} sub="per query" />
            <Stat label="Same rows?" value={cur.slow.checksum === cur.fast.checksum ? <span className="status good">Yes</span> : <span className="status critical">No</span>} sub={`${cur.fast.rowsReturned} rows over 20 runs`} />
          </div>
          <div className="card">
            <h2>Latency per query (20 runs, different parameters)</h2>
            <CompareBars
              log
              format={fmtMs}
              rows={['p50', 'p95', 'max'].map((k) => ({ label: k, slow: cur.slow.timing[k], fast: cur.fast.timing[k] }))}
            />
          </div>
          <div className="grid g2">
            {['slow', 'fast'].map((v) => (
              <div className="card" key={v}>
                <h3 className="row"><span className="swatch" style={{ background: `var(--${v})` }} />{v === 'slow' ? 'Without fix' : 'With fix'}: query plan</h3>
                <pre className="code" style={{ marginBottom: 10, whiteSpace: 'pre-wrap' }}>{cur[v].sql}</pre>
                <PlanView plan={cur[v].plan} />
              </div>
            ))}
          </div>
        </>
      )}

      <Explorer />
      <SchemaPanel />
    </div>
  );
}

function Explorer() {
  const [sql, setSql] = useState(EXAMPLES[0]);
  const [state, explain] = useAsync(() => postJson('/api/labs/indexing/explain', { sql }));
  return (
    <div className="card">
      <h2>Query-plan explorer and index advisor</h2>
      <p className="small">
        Paste any <code>SELECT</code>. It runs <code>EXPLAIN QUERY PLAN</code> on a read-only connection, so the query
        itself never executes. The advisor reads the plan and proposes an index, with equality columns first, then range
        columns, then the ORDER BY column.
      </p>
      <div className="row" style={{ marginBottom: 8 }}>
        <select value="" onChange={(e) => e.target.value && setSql(e.target.value)} aria-label="Examples">
          <option value="">Examples…</option>
          {EXAMPLES.map((e) => <option key={e} value={e}>{e.slice(0, 80)}</option>)}
        </select>
      </div>
      <textarea rows={3} value={sql} onChange={(e) => setSql(e.target.value)} aria-label="SQL" />
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn primary" onClick={explain} disabled={state.loading}>Explain</button>
        <ErrorText error={state.error} />
      </div>
      {state.data && (
        <div className="grid g2" style={{ marginTop: 12 }}>
          <div><h3>Plan</h3><PlanView plan={state.data.plan} /></div>
          <div>
            <h3>Advice</h3>
            <div className="stack" style={{ gap: 8 }}>
              {state.data.advice.length === 0 && <span className="status good">Nothing to flag.</span>}
              {state.data.advice.map((a, i) => (
                <div key={i}>
                  <span className={`status ${a.level === 'critical' ? 'critical' : a.level}`}>{a.message}</span>
                  {a.suggestion && <pre className="code" style={{ marginTop: 4, whiteSpace: 'pre-wrap' }}>{a.suggestion}</pre>}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SchemaPanel() {
  const [state, load] = useAsync(() => getJson('/api/labs/indexing/schema'));
  return (
    <details className="card" onToggle={(e) => e.target.open && !state.data && load()}>
      <summary>Schema, row counts and indexes</summary>
      {state.data && (
        <div className="table-wrap" style={{ marginTop: 10 }}>
          <table className="t">
            <thead><tr><th>Table</th><th className="r">Rows</th><th>Columns</th><th>Indexes</th></tr></thead>
            <tbody>
              {state.data.map((t) => (
                <tr key={t.table}>
                  <td className="mono">{t.table}</td>
                  <td className="r">{t.rows.toLocaleString()}</td>
                  <td className="small">{t.columns.join(', ')}</td>
                  <td className="mono small">{t.indexes.length ? t.indexes.map((i) => <div key={i.name}>{i.sql}</div>) : <span className="status critical">none</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </details>
  );
}
