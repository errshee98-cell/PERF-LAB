import { memo, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { getJson, fmtMs } from '../api.js';
import { PageHead, Stat, useAsync, ErrorText, Seg, BeforeAfter } from '../components/ui.jsx';
import { CompareBars } from '../components/charts.jsx';

/*
 * LAB 6 — React rendering
 * Same data, same UI, same parent state. Two table implementations:
 *   SlowTable — every common mistake at once
 *   FastTable — memoized derivations, memo rows + stable callbacks,
 *               useDeferredValue for typing, windowing (virtualization)
 * Measured with our own render→commit timer (works in production builds,
 * unlike <Profiler>), a row-render counter, and the Long Tasks API.
 */

const ROW_H = 36;
const counters = { rowRenders: 0, commits: 0, commitMs: 0, lastCommitMs: 0 };
const resetCounters = () => Object.assign(counters, { rowRenders: 0, commits: 0, commitMs: 0, lastCommitMs: 0 });

/** Times this component's render + its children's render + DOM commit. */
function useCommitTimer() {
  const start = performance.now();
  useLayoutEffect(() => {
    const ms = performance.now() - start;
    counters.commits++;
    counters.commitMs += ms;
    counters.lastCommitMs = ms;
  });
}

// Simulates a moderately expensive derived value (e.g. a client-side score).
function riskScore(row) {
  let h = 0;
  for (let k = 0; k < 40; k++) for (let i = 0; i < row.email.length; i++) h = (h * 31 + row.email.charCodeAt(i) + k) | 0;
  return Math.abs(h % 100);
}

const compare = ({ key, dir }) => (a, b) => (a[key] < b[key] ? -dir : a[key] > b[key] ? dir : a.id - b.id);

const COLUMNS = [
  ['id', '★ / #'], ['name', 'Name'], ['email', 'Email'], ['city', 'City'], ['orders', 'Orders'], ['ltvCents', 'Lifetime value'], ['score', 'Score'],
];

function Header({ onSort, sort }) {
  return (
    <div className="vrow head" role="row">
      {COLUMNS.map(([k, label]) => (
        <span key={k} className={['email', 'city', 'score'].includes(k) ? 'hide-sm' : ''}>
          <button onClick={() => onSort(k)}>{label}{sort.key === k ? (sort.dir > 0 ? ' ▲' : ' ▼') : ''}</button>
        </span>
      ))}
    </div>
  );
}

// ───────────────────────── ❌ SLOW ─────────────────────────
function SlowTable({ rows, query, sort, selected, onToggle, onSort }) {
  useCommitTimer();
  // ❌ filter + sort recomputed on EVERY render (including unrelated parent ticks)
  const visible = rows
    .filter((r) => r.name.toLowerCase().includes(query.toLowerCase()) || r.email.toLowerCase().includes(query.toLowerCase()) || r.city.toLowerCase().includes(query.toLowerCase()))
    .sort(compare(sort));
  return (
    <div className="vlist" style={{ contain: 'none' }}>
      <Header onSort={onSort} sort={sort} />
      {/* ❌ renders ALL rows into the DOM; ❌ key = index; ❌ new closure per row */}
      {visible.map((r, i) => (
        <SlowRow key={i} row={r} selected={selected.has(r.id)} onToggle={() => onToggle(r.id)} />
      ))}
    </div>
  );
}

function SlowRow({ row, selected, onToggle }) {
  counters.rowRenders++;
  // ❌ formatter constructed per row per render (Intl objects are expensive)
  const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(row.ltvCents / 100);
  // ❌ expensive derived value recomputed every render
  const score = riskScore(row);
  return (
    <div className={`vrow${selected ? ' sel' : ''}`} role="row">
      <span><button className="star" onClick={onToggle} aria-pressed={selected}>{selected ? '★' : '☆'}</button> {row.id}</span>
      <span>{row.name}</span>
      <span className="hide-sm">{row.email}</span>
      <span className="hide-sm">{row.city}</span>
      <span className="num">{row.orders}</span>
      <span className="num">{money}</span>
      <span className="num hide-sm">{score}</span>
    </div>
  );
}

// ───────────────────────── ✅ FAST ─────────────────────────
const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }); // ✅ hoisted, created once

const FastTable = memo(function FastTable({ rows, query, sort, selected, onToggle, onSort }) {
  useCommitTimer();
  // ✅ expensive per-row work done once per dataset, not per render
  const prepared = useMemo(
    () => rows.map((r) => ({ ...r, haystack: `${r.name} ${r.email} ${r.city}`.toLowerCase(), money: money.format(r.ltvCents / 100), score: riskScore(r) })),
    [rows],
  );
  // ✅ typing stays responsive: the input updates now, the heavy filter renders at lower priority
  const deferredQuery = useDeferredValue(query);
  const visible = useMemo(() => {
    const q = deferredQuery.toLowerCase();
    const out = q ? prepared.filter((r) => r.haystack.includes(q)) : prepared.slice();
    return out.sort(compare(sort));
  }, [prepared, deferredQuery, sort]);

  // ✅ windowing: only ~20 rows in the DOM regardless of dataset size
  const [scrollTop, setScrollTop] = useState(0);
  const viewport = 480 - ROW_H;
  const overscan = 6;
  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - overscan);
  const last = Math.min(visible.length, Math.ceil((scrollTop + viewport) / ROW_H) + overscan);
  const stale = query !== deferredQuery;

  return (
    <div className="vlist" onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)} style={{ opacity: stale ? 0.7 : 1 }}>
      <Header onSort={onSort} sort={sort} />
      <div style={{ height: visible.length * ROW_H, position: 'relative' }}>
        {visible.slice(first, last).map((r, i) => (
          <FastRow key={r.id} row={r} top={(first + i) * ROW_H} selected={selected.has(r.id)} onToggle={onToggle} />
        ))}
      </div>
    </div>
  );
});

// ✅ memo + primitive/stable props → re-renders only when THIS row changes
const FastRow = memo(function FastRow({ row, top, selected, onToggle }) {
  counters.rowRenders++;
  return (
    <div className={`vrow${selected ? ' sel' : ''}`} role="row" style={{ position: 'absolute', top, left: 0, right: 0 }}>
      <span><button className="star" onClick={() => onToggle(row.id)} aria-pressed={selected}>{selected ? '★' : '☆'}</button> {row.id}</span>
      <span>{row.name}</span>
      <span className="hide-sm">{row.email}</span>
      <span className="hide-sm">{row.city}</span>
      <span className="num">{row.orders}</span>
      <span className="num">{row.money}</span>
      <span className="num hide-sm">{row.score}</span>
    </div>
  );
});

// ───────────────────────── page ─────────────────────────
const BEFORE = `function Table({ rows, query }) {
  const visible = rows.filter(...).sort(...);      // every render
  return visible.map((r, i) =>
    <Row key={i} row={r}                            // index keys
         onToggle={() => toggle(r.id)} />);         // new fn per row
}
function Row({ row }) {
  const fmt = new Intl.NumberFormat(...);           // per row, per render
  const score = riskScore(row);                     // per row, per render
  ...                                               // 5,000 DOM rows
}`;

const AFTER = `const fmt = new Intl.NumberFormat(...);            // once
const Table = memo(function Table({ rows, query, onToggle }) {
  const prepared = useMemo(() => precompute(rows), [rows]);
  const q = useDeferredValue(query);                // input stays snappy
  const visible = useMemo(() => filterSort(prepared, q, sort), [...]);
  return <Window items={visible} rowHeight={36}>    // ~20 DOM rows
    {(r) => <Row key={r.id} row={r} onToggle={onToggle} />}
  </Window>;
});
const Row = memo(Row);                              // + stable useCallback`;

const SCRIPT = ['l', 'li', 'lia', 'liam', 'lia', 'li', 'l', '', 'k', 'kh', 'kha', 'khan', ''];

export default function Rendering() {
  const [n, setN] = useState(5000);
  const [impl, setImpl] = useState('slow');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState({ key: 'id', dir: 1 });
  const [selected, setSelected] = useState(() => new Set());
  const [ticker, setTicker] = useState(true);
  const [tick, setTick] = useState(0);
  const [bench, setBench] = useState({});
  const [running, setRunning] = useState(false);

  const [data, load] = useAsync((size) => getJson(`/api/labs/frontend/rows?n=${size}`));
  useEffect(() => { load(n); }, [n, load]);

  // Unrelated state that updates every second (think: clock, presence, notifications badge)
  useEffect(() => {
    if (!ticker) return;
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [ticker]);

  const onToggle = useCallback((id) => setSelected((prev) => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  }), []);
  const onSort = useCallback((key) => setSort((s) => ({ key, dir: s.key === key ? -s.dir : 1 })), []);

  const runBenchmark = async () => {
    if (!data.data) return;
    setRunning(true);
    setTicker(false);
    const results = {};
    for (const which of ['slow', 'fast']) {
      setImpl(which);
      setQuery('');
      setSort({ key: 'id', dir: 1 });
      setSelected(new Set());
      await settle();
      resetCounters();
      const longTasks = observeLongTasks();
      const steps = [];
      const t0 = performance.now();
      for (const q of SCRIPT) steps.push(await step(() => setQuery(q)));
      for (const key of ['ltvCents', 'name', 'orders']) steps.push(await step(() => onSort(key)));
      for (const r of data.data.slice(0, 6)) steps.push(await step(() => onToggle(r.id)));
      await settle();
      results[which] = {
        totalMs: performance.now() - t0,
        p50: pct(steps, 50), max: Math.max(...steps),
        rowRenders: counters.rowRenders, commitMs: counters.commitMs, commits: counters.commits,
        longTasks: longTasks.stop(),
      };
    }
    setBench(results);
    setImpl('fast');
    setRunning(false);
    setTicker(true);
  };

  const rows = data.data;
  const Table = impl === 'slow' ? SlowTable : FastTable;
  // ❌ vs ✅: the slow table gets fresh inline callbacks every render, so memo could never help it
  const handlers = impl === 'slow'
    ? { onToggle: (id) => onToggle(id), onSort: (k) => onSort(k) }
    : { onToggle, onSort };

  return (
    <div className="stack">
      <PageHead kicker="Lab 6 · Frontend" title="React rendering performance">
        A searchable, sortable table of customers. Type in the search box and watch the stats. A one-second
        ticker updates unrelated parent state. The slow table re-renders every row on each tick, while the fast
        table does not re-render at all.
      </PageHead>

      <BeforeAfter before={BEFORE} after={AFTER} />

      <div className="card">
        <div className="row">
          <Seg value={impl} onChange={(v) => (resetCounters(), setImpl(v))} label="Implementation" options={[{ value: 'slow', label: 'Slow table' }, { value: 'fast', label: 'Optimized table' }]} />
          <Seg value={String(n)} onChange={(v) => setN(+v)} label="Rows" options={['1000', '5000', '10000'].map((v) => ({ value: v, label: `${(+v).toLocaleString()} rows` }))} />
          <label className="row small"><input type="checkbox" checked={ticker} onChange={(e) => setTicker(e.target.checked)} /> 1 s ticker (tick {tick})</label>
          <div className="spacer" />
          <button className="btn primary" disabled={running || !rows} onClick={runBenchmark}>{running ? 'Benchmarking…' : 'Run scripted benchmark'}</button>
        </div>
        <div className="small muted" style={{ marginTop: 6 }}>
          The benchmark types "liam" and "khan" one keystroke at a time, clears the box, sorts by three columns and
          stars six rows. It runs against both tables and times each step until the next paint.
        </div>
        <ErrorText error={data.error} />
      </div>

      {bench.slow && <BenchResults bench={bench} />}

      <LiveStats impl={impl} />

      <div className="card">
        <div className="row" style={{ marginBottom: 10 }}>
          <input placeholder="Search name, email, city…" value={query} onChange={(e) => setQuery(e.target.value)} style={{ flex: 1, minWidth: 200 }} aria-label="Search" />
          <span className="small muted">{selected.size} starred</span>
        </div>
        {rows ? <Table rows={rows} query={query} sort={sort} selected={selected} {...handlers} /> : <div className="skeleton" style={{ height: 480 }} />}
      </div>
    </div>
  );
}

function LiveStats({ impl }) {
  // Polls the module-level counters so displaying them doesn't re-render the table.
  const [s, setS] = useState({ ...counters });
  useEffect(() => {
    const t = setInterval(() => setS({ ...counters, dom: document.querySelectorAll('.vlist .vrow:not(.head)').length }), 400);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="grid g4">
      <Stat swatch={impl === 'slow' ? 'slow' : 'fast'} label="Row components rendered" value={s.rowRenders.toLocaleString()} sub="since last reset" />
      <Stat label="Row DOM nodes" value={(s.dom ?? 0).toLocaleString()} sub={impl === 'fast' ? 'windowed' : 'everything'} />
      <Stat label="Last render→commit" value={fmtMs(s.lastCommitMs)} sub={`${s.commits} commits · ${fmtMs(s.commitMs)} total`} />
      <div className="card stat" style={{ display: 'grid', alignContent: 'center' }}>
        <button className="btn" onClick={() => (resetCounters(), setS({ ...counters }))}>Reset counters</button>
      </div>
    </div>
  );
}

function BenchResults({ bench }) {
  const { slow, fast } = bench;
  return (
    <div className="card">
      <h2>Scripted benchmark: 22 interactions</h2>
      <div className="grid g4" style={{ marginBottom: 12 }}>
        <Stat swatch="slow" label="Slow: worst interaction" value={fmtMs(slow.max)} sub={`p50 ${fmtMs(slow.p50)} · ${slow.longTasks.count} long tasks`} />
        <Stat swatch="fast" label="Fast: worst interaction" value={fmtMs(fast.max)} sub={`p50 ${fmtMs(fast.p50)} · ${fast.longTasks.count} long tasks`} />
        <Stat label="Row renders" value={`${slow.rowRenders.toLocaleString()} → ${fast.rowRenders.toLocaleString()}`} sub={`${Math.round(slow.rowRenders / Math.max(1, fast.rowRenders))}× fewer`} />
        <Stat label="Main-thread blocked" value={`${fmtMs(slow.longTasks.ms)} → ${fmtMs(fast.longTasks.ms)}`} sub="Long Tasks API (Chromium)" />
      </div>
      <CompareBars
        log
        format={fmtMs}
        rows={[
          { label: 'Worst interaction (≈INP)', slow: slow.max, fast: fast.max },
          { label: 'Median interaction', slow: slow.p50, fast: fast.p50 },
          { label: 'Total render+commit', slow: slow.commitMs, fast: fast.commitMs },
          { label: 'Whole script', slow: slow.totalMs, fast: fast.totalMs },
        ]}
      />
      <p className="small muted" style={{ marginTop: 8 }}>
        Google rates INP under 200 ms as good. Run the production build (<code>npm run build && npm start</code>) for realistic
        numbers, because the dev build adds React's development-mode overhead.
      </p>
    </div>
  );
}

// ── measurement helpers ──
const nextPaint = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

async function step(action) {
  const t = performance.now();
  action();
  await nextPaint();
  const ms = performance.now() - t;
  await settle(); // let deferred renders finish before the next keystroke
  return ms;
}

async function settle() {
  let last = -1;
  for (let i = 0; i < 100 && counters.commits !== last; i++) {
    last = counters.commits;
    await nextPaint();
    await new Promise((r) => setTimeout(r, 30));
  }
}

function observeLongTasks() {
  const out = { count: 0, ms: 0 };
  let obs;
  if (PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
    obs = new PerformanceObserver((l) => l.getEntries().forEach((e) => { out.count++; out.ms += e.duration; }));
    obs.observe({ type: 'longtask' });
  }
  return { stop: () => (obs?.disconnect(), out) };
}

function pct(arr, p) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
}
