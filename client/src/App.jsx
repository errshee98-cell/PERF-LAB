import { lazy, Suspense, useEffect, useState } from 'react';
import { Vitals } from './components/Vitals.jsx';
import { Skeleton } from './components/ui.jsx';

// Route-level code splitting: each lab is its own chunk, loaded on first visit
// and prefetched on hover so navigation still feels instant.
const LABS = [
  { id: 'overview', label: 'Overview', load: () => import('./labs/Overview.jsx') },
  { id: 'n-plus-one', label: 'N+1 queries', load: () => import('./labs/NPlusOne.jsx') },
  { id: 'indexing', label: 'Database indexes', load: () => import('./labs/Indexing.jsx') },
  { id: 'algorithms', label: 'Slow algorithms', load: () => import('./labs/Algorithms.jsx') },
  { id: 'caching', label: 'Caching', load: () => import('./labs/Caching.jsx') },
  { id: 'payload', label: 'Payload & network', load: () => import('./labs/Payload.jsx') },
  { id: 'rendering', label: 'React rendering', load: () => import('./labs/Rendering.jsx') },
  { id: 'load-test', label: 'Load testing', load: () => import('./labs/LoadTest.jsx') },
].map((l) => ({ ...l, Component: lazy(l.load) }));

const current = () => {
  const id = location.hash.replace('#/', '');
  return LABS.some((l) => l.id === id) ? id : 'overview';
};

export default function App() {
  const [route, setRoute] = useState(current);
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem('theme') ?? 'auto'; } catch { return 'auto'; }
  });

  useEffect(() => {
    const on = () => setRoute(current());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);

  useEffect(() => {
    if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('theme', theme); } catch { /* private mode */ }
  }, [theme]);

  const lab = LABS.find((l) => l.id === route);

  return (
    <div className="shell">
      <nav className="side" aria-label="Labs">
        <div className="brand">
          <svg viewBox="0 0 32 32" aria-hidden="true"><path d="M18 2 6 18h8l-2 12 12-16h-8z" /></svg>
          Perf Lab
        </div>
        {LABS.map((l, i) => (
          <button
            key={l.id}
            className="nav-btn"
            aria-current={route === l.id ? 'page' : undefined}
            onMouseEnter={l.load}
            onFocus={l.load}
            onClick={() => (location.hash = `#/${l.id}`)}
          >
            <span className="n">{i ? i : '◆'}</span>
            {l.label}
          </button>
        ))}
        <div className="side-foot">
          <Vitals />
          <label className="field">
            Theme
            <select value={theme} onChange={(e) => setTheme(e.target.value)}>
              <option value="auto">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>
        </div>
      </nav>
      <main className="main">
        <Suspense fallback={<div className="stack"><Skeleton h={60} /><Skeleton h={260} /></div>}>
          <lab.Component />
        </Suspense>
      </main>
    </div>
  );
}
