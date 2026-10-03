import { useState, useRef, useId } from 'react';

/*
 * Small dependency-free SVG charts.
 * Color = identity: --slow (orange, slot 2) and --fast (blue, slot 1), fixed for every chart.
 * Legend always present for 2 series, values direct-labelled, hover tooltip on every mark.
 */

function useTip() {
  const [tip, setTip] = useState(null);
  const show = (e, content) => setTip({ x: e.clientX + 12, y: e.clientY + 12, content });
  const hide = () => setTip(null);
  const node = tip && <div className="tip" style={{ left: tip.x, top: tip.y }}>{tip.content}</div>;
  return { show, hide, node };
}

export function Legend({ items = [['slow', 'Problem'], ['fast', 'Optimized']] }) {
  return (
    <div className="legend" aria-hidden="true">
      {items.map(([k, label]) => (
        <span key={k}><span className="swatch" style={{ background: `var(--${k})` }} />{label}</span>
      ))}
    </div>
  );
}

/**
 * Grouped horizontal bars: one row per item, slow and fast bars, shared linear axis.
 * rows: [{ label, slow, fast, slowText?, fastText? }]
 */
export function CompareBars({ rows, format = (v) => v, log = false, ariaLabel = 'Comparison chart' }) {
  const tip = useTip();
  const W = 640, labelW = 190, valueW = 74, barH = 12, gap = 2, rowH = barH * 2 + gap + 16;
  const H = rows.length * rowH + 8;
  const max = Math.max(...rows.flatMap((r) => [r.slow ?? 0, r.fast ?? 0]), 1e-9);
  const plotW = W - labelW - valueW;
  const scale = (v) => {
    if (!v) return 0;
    if (!log) return (v / max) * plotW;
    const lo = Math.log10(Math.max(1e-3, Math.min(...rows.flatMap((r) => [r.slow, r.fast]).filter((x) => x > 0)) / 2));
    return Math.max(2, ((Math.log10(v) - lo) / (Math.log10(max) - lo)) * plotW);
  };
  return (
    <div>
      <Legend />
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={ariaLabel} style={{ marginTop: 8 }}>
        <line x1={labelW} x2={labelW} y1={0} y2={H - 4} stroke="var(--axis)" />
        {rows.map((r, i) => {
          const y = i * rowH + 4;
          return (
            <g key={r.label}>
              <text x={labelW - 10} y={y + barH + 4} textAnchor="end" className="lbl">{truncate(r.label, 28)}</text>
              {[['slow', r.slow, r.slowText], ['fast', r.fast, r.fastText]].map(([k, v, t], j) => {
                const by = y + j * (barH + gap);
                const w = scale(v);
                return (
                  <g key={k} onMouseMove={(e) => tip.show(e, <><b>{r.label}</b><br />{k === 'slow' ? 'Problem' : 'Optimized'}: {format(v)}{t ? ` · ${t}` : ''}</>)} onMouseLeave={tip.hide}>
                    <rect x={labelW} y={by - 3} width={plotW + valueW} height={barH + 4} fill="transparent" />
                    <path d={roundedRight(labelW, by, Math.max(w, 1.5), barH)} fill={`var(--${k})`} />
                    <text x={labelW + w + 6} y={by + barH - 2} className="val">{format(v)}</text>
                  </g>
                );
              })}
            </g>
          );
        })}
      </svg>
      {log && <div className="small muted">Log scale — bars span orders of magnitude.</div>}
      {tip.node}
    </div>
  );
}

/** Line chart for growth curves. series: [{ key:'slow'|'fast', label, points:[{x,y}] }] */
export function LineChart({ series, xLabel, yFormat = (v) => v, xFormat = (v) => v, height = 240 }) {
  const tip = useTip();
  const ref = useRef(null);
  const [hover, setHover] = useState(null);
  const W = 640, H = height, m = { l: 56, r: 64, t: 12, b: 34 };
  const xs = [...new Set(series.flatMap((s) => s.points.map((p) => p.x)))].sort((a, b) => a - b);
  const yMax = niceMax(Math.max(...series.flatMap((s) => s.points.map((p) => p.y ?? 0)), 1e-9));
  const x = (v) => m.l + ((v - xs[0]) / Math.max(1, xs.at(-1) - xs[0])) * (W - m.l - m.r);
  const y = (v) => H - m.b - (v / yMax) * (H - m.t - m.b);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * yMax);

  const onMove = (e) => {
    const box = ref.current.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * W;
    const nearest = xs.reduce((a, b) => (Math.abs(x(b) - px) < Math.abs(x(a) - px) ? b : a), xs[0]);
    setHover(nearest);
    tip.show(e, (
      <>
        <b>{xLabel} = {xFormat(nearest)}</b>
        {series.map((s) => {
          const p = s.points.find((q) => q.x === nearest);
          return <div key={s.key}><span className="swatch" style={{ background: `var(--${s.key})` }} /> {s.label}: {p?.y == null ? 'skipped (too slow)' : yFormat(p.y)}</div>;
        })}
      </>
    ));
  };

  return (
    <div>
      <Legend items={series.map((s) => [s.key, s.label])} />
      <svg ref={ref} className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Line chart of time vs ${xLabel}`} onMouseMove={onMove} onMouseLeave={() => (setHover(null), tip.hide())} style={{ marginTop: 8 }}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={m.l} x2={W - m.r} y1={y(t)} y2={y(t)} stroke={t === 0 ? 'var(--axis)' : 'var(--grid)'} />
            <text x={m.l - 8} y={y(t) + 4} textAnchor="end">{yFormat(t)}</text>
          </g>
        ))}
        {xs.map((v) => <text key={v} x={x(v)} y={H - m.b + 16} textAnchor="middle">{xFormat(v)}</text>)}
        <text x={(W - m.r + m.l) / 2} y={H - 4} textAnchor="middle">{xLabel}</text>
        {hover != null && <line x1={x(hover)} x2={x(hover)} y1={m.t} y2={H - m.b} stroke="var(--axis)" />}
        {series.map((s) => {
          const pts = s.points.filter((p) => p.y != null);
          if (!pts.length) return null;
          const last = pts.at(-1);
          return (
            <g key={s.key}>
              <path d={pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.x)},${y(p.y)}`).join('')} fill="none" stroke={`var(--${s.key})`} strokeWidth="2" strokeLinejoin="round" />
              {pts.map((p) => <circle key={p.x} cx={x(p.x)} cy={y(p.y)} r={hover === p.x ? 5 : 4} fill={`var(--${s.key})`} stroke="var(--surface)" strokeWidth="2" />)}
              <text x={x(last.x) + 8} y={y(last.y) + 4} className="val">{yFormat(last.y)}</text>
            </g>
          );
        })}
      </svg>
      {tip.node}
    </div>
  );
}

/** Single-series column chart (histograms, per-request series). */
export function Columns({ data, color = 'fast', yFormat = (v) => v, height = 160, ariaLabel }) {
  const tip = useTip();
  const id = useId();
  const W = 640, H = height, m = { l: 44, r: 8, t: 14, b: 26 };
  const max = niceMax(Math.max(...data.map((d) => d.value), 1e-9));
  const bw = (W - m.l - m.r) / data.length;
  const y = (v) => H - m.b - (v / max) * (H - m.t - m.b);
  return (
    <div>
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={ariaLabel} id={id}>
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={m.l} x2={W - m.r} y1={y(f * max)} y2={y(f * max)} stroke={f === 0 ? 'var(--axis)' : 'var(--grid)'} />
            <text x={m.l - 6} y={y(f * max) + 4} textAnchor="end">{yFormat(f * max)}</text>
          </g>
        ))}
        {data.map((d, i) => {
          const bx = m.l + i * bw + 1;
          const h = Math.max(d.value ? 2 : 0, H - m.b - y(d.value));
          const c = d.color ?? color;
          return (
            <g key={i} onMouseMove={(e) => tip.show(e, <><b>{d.label}</b>: {yFormat(d.value)}{d.note ? ` · ${d.note}` : ''}</>)} onMouseLeave={tip.hide}>
              <rect x={m.l + i * bw} y={m.t} width={bw} height={H - m.t - m.b} fill="transparent" />
              <path d={roundedTop(bx, H - m.b - h, Math.max(1, bw - 2), h)} fill={`var(--${c})`} />
              {data.length <= 16 && <text x={bx + (bw - 2) / 2} y={H - m.b + 15} textAnchor="middle">{d.label}</text>}
            </g>
          );
        })}
      </svg>
      {tip.node}
    </div>
  );
}

function roundedRight(x, y, w, h, r = 4) {
  r = Math.min(r, w, h / 2);
  return `M${x},${y}h${w - r}a${r},${r} 0 0 1 ${r},${r}v${h - 2 * r}a${r},${r} 0 0 1 -${r},${r}h-${w - r}z`;
}
function roundedTop(x, y, w, h, r = 4) {
  if (h <= 0) return '';
  r = Math.min(r, w / 2, h);
  return `M${x},${y + h}v-${h - r}a${r},${r} 0 0 1 ${r},-${r}h${w - 2 * r}a${r},${r} 0 0 1 ${r},${r}v${h - r}z`;
}
function niceMax(v) {
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((k) => k * p).find((c) => c >= v);
}
function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
