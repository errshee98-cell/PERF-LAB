import { useEffect, useState } from 'react';
import { fmtMs } from '../api.js';

/**
 * Live Core-Web-Vitals-style readout for THIS page, via PerformanceObserver:
 *   LCP  – largest contentful paint
 *   CLS  – cumulative layout shift
 *   INP≈ – worst interaction latency observed (event timing)
 *   Long tasks – main-thread blocks > 50 ms (Chromium)
 */
export function Vitals() {
  const [v, setV] = useState({ lcp: null, cls: 0, inp: null, longTasks: 0, longMs: 0 });

  useEffect(() => {
    const obs = [];
    const watch = (type, cb, opts = {}) => {
      if (!PerformanceObserver.supportedEntryTypes?.includes(type)) return;
      const o = new PerformanceObserver((list) => cb(list.getEntries()));
      o.observe({ type, buffered: true, ...opts });
      obs.push(o);
    };
    watch('largest-contentful-paint', (es) => setV((s) => ({ ...s, lcp: es.at(-1).startTime })));
    watch('layout-shift', (es) => setV((s) => ({ ...s, cls: s.cls + es.filter((e) => !e.hadRecentInput).reduce((a, e) => a + e.value, 0) })));
    watch('event', (es) => setV((s) => ({ ...s, inp: Math.max(s.inp ?? 0, ...es.filter((e) => e.interactionId).map((e) => e.duration)) || s.inp })), { durationThreshold: 16 });
    watch('longtask', (es) => setV((s) => ({ ...s, longTasks: s.longTasks + es.length, longMs: s.longMs + es.reduce((a, e) => a + e.duration, 0) })));
    return () => obs.forEach((o) => o.disconnect());
  }, []);

  const grade = (val, good, poor) => (val == null ? 'info' : val <= good ? 'good' : val <= poor ? 'warning' : 'critical');
  const items = [
    ['LCP', v.lcp == null ? '—' : fmtMs(v.lcp), grade(v.lcp, 2500, 4000)],
    ['CLS', v.cls.toFixed(3), grade(v.cls, 0.1, 0.25)],
    ['INP≈', v.inp == null ? '—' : fmtMs(v.inp), grade(v.inp, 200, 500)],
    ['Long tasks', `${v.longTasks} · ${fmtMs(v.longMs)}`, v.longTasks ? 'warning' : 'good'],
  ];
  return (
    <div className="card" style={{ padding: '10px 12px' }}>
      <div className="small" style={{ fontWeight: 600, marginBottom: 6 }}>This page's vitals</div>
      <div style={{ display: 'grid', gap: 3 }}>
        {items.map(([k, val, g]) => (
          <div key={k} className="row small" style={{ justifyContent: 'space-between', flexWrap: 'nowrap' }}>
            <span className={`status ${g}`}>{k}</span>
            <span className="num">{val}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
