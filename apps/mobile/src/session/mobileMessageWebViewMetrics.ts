export type MobileMessageWebViewKind = 'mermaid' | 'math' | 'media' | 'composer';

export interface MobileMessageWebViewMetrics {
  mounted: number;
  mountedByKind: Record<MobileMessageWebViewKind, number>;
  mounts: number;
  unmounts: number;
}

const mounted = new Map<string, MobileMessageWebViewKind>();
const mountCounts: Record<MobileMessageWebViewKind, number> = {
  mermaid: 0,
  math: 0,
  media: 0,
  composer: 0,
};
const unmountCounts: Record<MobileMessageWebViewKind, number> = {
  mermaid: 0,
  math: 0,
  media: 0,
  composer: 0,
};
let sequence = 0;

/** Register one native WebView while it is mounted and return its idempotent cleanup. */
export function registerMobileMessageWebView(kind: MobileMessageWebViewKind): () => void {
  const id = `${kind}:${++sequence}`;
  mounted.set(id, kind);
  mountCounts[kind] += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (mounted.delete(id)) unmountCounts[kind] += 1;
  };
}

export function getMobileMessageWebViewMetrics(): MobileMessageWebViewMetrics {
  const mountedByKind: Record<MobileMessageWebViewKind, number> = {
    mermaid: 0,
    math: 0,
    media: 0,
    composer: 0,
  };
  for (const kind of mounted.values()) mountedByKind[kind] += 1;
  return {
    mounted: mounted.size,
    mountedByKind,
    mounts: Object.values(mountCounts).reduce((total, count) => total + count, 0),
    unmounts: Object.values(unmountCounts).reduce((total, count) => total + count, 0),
  };
}

/** Test-only reset; production callers should only read the snapshot. */
export function resetMobileMessageWebViewMetrics(): void {
  mounted.clear();
  for (const kind of Object.keys(mountCounts) as MobileMessageWebViewKind[]) {
    mountCounts[kind] = 0;
    unmountCounts[kind] = 0;
  }
  sequence = 0;
}
