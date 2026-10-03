/**
 * fetch wrapper that also returns what the network and server reported:
 * client-side elapsed time, Server-Timing, wire vs raw bytes, query count, cache status.
 */
export async function api(path, { method = 'GET', body, headers } = {}) {
  const t0 = performance.now();
  const res = await fetch(path, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const clientMs = performance.now() - t0;
  const data = text ? JSON.parse(text) : null;
  if (!res.ok && res.status !== 304) throw new Error(data?.error ?? `HTTP ${res.status}`);
  return {
    data,
    status: res.status,
    meta: {
      clientMs: Math.round(clientMs * 10) / 10,
      serverTiming: parseServerTiming(res.headers.get('server-timing')),
      rawBytes: Number(res.headers.get('x-raw-bytes') ?? text.length),
      wireBytes: Number(res.headers.get('x-wire-bytes') ?? text.length),
      queries: Number(res.headers.get('x-db-queries') ?? 0),
      cache: res.headers.get('x-cache'),
      encoding: res.headers.get('content-encoding'),
      etag: res.headers.get('etag'),
    },
  };
}

export const getJson = async (path) => (await api(path)).data;
export const postJson = async (path, body) => (await api(path, { method: 'POST', body })).data;

function parseServerTiming(h) {
  if (!h) return {};
  return Object.fromEntries(
    h.split(',').map((part) => {
      const [name, ...attrs] = part.trim().split(';');
      const dur = attrs.find((a) => a.startsWith('dur='));
      return [name, Number(dur?.slice(4) ?? 0)];
    }),
  );
}

export const fmtMs = (ms) => (ms == null ? '—' : ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : ms >= 10 ? `${Math.round(ms)} ms` : `${ms.toFixed(ms < 1 ? 2 : 1)} ms`);
export const fmtBytes = (b) => (b == null ? '—' : b >= 1048576 ? `${(b / 1048576).toFixed(2)} MB` : b >= 1024 ? `${(b / 1024).toFixed(1)} KB` : `${b} B`);
export const fmtX = (x) => (x >= 100 ? `${Math.round(x)}×` : `${x.toFixed(1)}×`);
