import { useCallback, useRef, useState } from 'react';

/** Async action state with stale-response protection (last call wins). */
export function useAsync(fn) {
  const [state, setState] = useState({ loading: false, data: null, error: null });
  const seq = useRef(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const run = useCallback(async (...args) => {
    const id = ++seq.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await fnRef.current(...args);
      if (id === seq.current) setState({ loading: false, data, error: null });
      return data;
    } catch (error) {
      if (id === seq.current) setState((s) => ({ ...s, loading: false, error }));
    }
  }, []);
  return [state, run];
}

export function PageHead({ kicker, title, children }) {
  return (
    <header className="page-head">
      {kicker && <div className="small muted" style={{ fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em' }}>{kicker}</div>}
      <h1>{title}</h1>
      {children && <p>{children}</p>}
    </header>
  );
}

export function Stat({ label, value, sub, swatch }) {
  return (
    <div className="card stat">
      <div className="label">
        {swatch && <span className="swatch" style={{ background: `var(--${swatch})` }} />}
        {label}
      </div>
      <div className="value">{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}

export function Seg({ value, onChange, options, label }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => {
        const v = typeof o === 'string' ? o : o.value;
        return (
          <button key={v} type="button" aria-pressed={value === v} onClick={() => onChange(v)}>
            {typeof o === 'string' ? o : o.label}
          </button>
        );
      })}
    </div>
  );
}

export function ErrorText({ error }) {
  return error ? <div className="err" role="alert">{String(error.message ?? error)}</div> : null;
}

export function Code({ children, title }) {
  return (
    <div>
      {title && <div className="small muted" style={{ marginBottom: 4, fontWeight: 600 }}>{title}</div>}
      <pre className="code"><code>{children}</code></pre>
    </div>
  );
}

/** Side-by-side "the problem / the fix" snippet pair. */
export function BeforeAfter({ before, after, beforeTitle = 'The problem', afterTitle = 'The fix' }) {
  return (
    <div className="grid g2">
      <div className="card">
        <h3 className="row"><span className="swatch" style={{ background: 'var(--slow)' }} />{beforeTitle}</h3>
        <pre className="code"><code>{before}</code></pre>
      </div>
      <div className="card">
        <h3 className="row"><span className="swatch" style={{ background: 'var(--fast)' }} />{afterTitle}</h3>
        <pre className="code"><code>{after}</code></pre>
      </div>
    </div>
  );
}

export function PlanView({ plan }) {
  if (!plan?.length) return null;
  return (
    <div className="plan">
      {plan.map((p, i) => {
        const cls = /^SCAN|TEMP B-TREE|AUTOMATIC/.test(p.detail) ? 'scan' : /USING (COVERING )?INDEX|PRIMARY KEY/.test(p.detail) ? 'seek' : '';
        return (
          <div key={i} style={{ paddingLeft: p.depth * 16 }}>
            {p.depth > 0 ? '└ ' : ''}
            <span className={cls}>{p.detail}</span>
          </div>
        );
      })}
    </div>
  );
}

export function Skeleton({ h = 120 }) {
  return <div className="skeleton" style={{ minHeight: h }} aria-hidden="true" />;
}
