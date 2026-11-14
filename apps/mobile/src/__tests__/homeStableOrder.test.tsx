// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HomeViewSession } from '@/session/homeViewSession';
import { useStableHomeSections, type HomeDisplayOrder } from '@/session/homeStableOrder';
import { buildHomeSections, type HomeSection } from '@/session/homeSections';
import type { MobileHomePresentation, MobileHomeProjectGroup } from '@/session/mobileHome';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }));

// Minimal presentation fields consumed by the production section builder.
function projects(...ids: string[]): HomeSection[] {
  return buildHomeSections({ pinned: [], chats: [], projects: ids.map((id, index) => ({
    key: id, title: id, sessions: [], latestActivityAt: `2026-11-${20 - index}T00:00:00Z`,
  } as unknown as MobileHomeProjectGroup)) } as unknown as MobileHomePresentation, true, false);
}
let root: Root;
afterEach(() => { if (root) act(() => root.unmount()); });

function setup(seed: HomeDisplayOrder | null = null) {
  const node = document.createElement('div');
  root = createRoot(node);
  let result: HomeSection[] = [];
  let input = { sections: projects('a', 'b'), scope: 'all', revision: 0, ready: true, settled: false, visible: true,
    session: new HomeViewSession(), seed, onCommit: vi.fn() };
  function View() { result = useStableHomeSections(input); return null; }
  const render = (patch: Partial<typeof input> = {}) => { input = { ...input, ...patch }; act(() => root.render(<View />)); };
  const remount = () => {
    act(() => root.unmount());
    root = createRoot(node);
    render();
  };
  render();
  return { render, remount, keys: () => result.find(s => s.key === 'main')?.data.map(row => row.key) ?? [],
    result: () => result, input: () => input };
}
const keys = (...ids: string[]) => projects(...ids)[0].data.map(row => row.key);

describe('Home display order during incremental loading', () => {
  it('restores cached order, keeps positions across activity/host-order updates and appends discoveries with fresh data', () => {
    const app = setup({ scope: 'all', keys: keys('b', 'a') });
    expect(app.keys()).toEqual(keys('b', 'a'));
    const latest = projects('c', 'a', 'b');
    app.render({ sections: latest });
    expect(app.keys()).toEqual(keys('b', 'a', 'c'));
    expect(app.result()[0].data[0]).toBe(latest[0].data[2]);
    app.render({ sections: projects('c', 'b') });
    expect(app.keys()).toEqual(keys('b', 'c')); // confirmed removal is not resurrected
  });

  it('waits for startup preferences and cache before committing the first order', () => {
    const app = setup();
    const session = new HomeViewSession();
    app.render({ session, ready: false });
    expect(app.keys()).toEqual([]);
    expect(session.has('displayOrder')).toBe(false);
    app.render({ ready: true, seed: { scope: 'all', keys: keys('b', 'a') } });
    expect(app.keys()).toEqual(keys('b', 'a'));
  });

  it('does not erase the cached order while the device projection is still empty', () => {
    const app = setup();
    app.render({ session: new HomeViewSession(), sections: [], seed: { scope: 'all', keys: keys('b', 'a') } });
    app.render({ sections: projects('a', 'b') });
    expect(app.keys()).toEqual(keys('b', 'a'));
    app.render({ sections: [], settled: true });
    app.render({ sections: projects('a', 'b') });
    expect(app.keys()).toEqual(keys('a', 'b'));
  });

  it('uses current sort once on refresh/manual reorder and once on returning to the list', () => {
    const app = setup();
    app.render({ sections: projects('b', 'a') });
    expect(app.keys()).toEqual(keys('a', 'b'));
    app.render({ revision: 1 });
    expect(app.keys()).toEqual(keys('b', 'a'));
    app.render({ visible: false, sections: projects('a', 'b') });
    app.render({ visible: true });
    expect(app.keys()).toEqual(keys('a', 'b'));
    app.render({ sections: projects('b', 'a') });
    expect(app.keys()).toEqual(keys('a', 'b'));
  });

  it('isolates device/filter scopes and account view sessions; late seeds cannot displace visible rows', () => {
    const app = setup();
    app.render({ sections: projects('b', 'a'), seed: { scope: 'all', keys: keys('b', 'a') } });
    expect(app.keys()).toEqual(keys('a', 'b'));
    app.render({ scope: 'computer-b' });
    expect(app.keys()).toEqual(keys('b', 'a'));
    app.render({ session: new HomeViewSession(), sections: projects('a', 'b'), seed: null });
    expect(app.keys()).toEqual(keys('a', 'b'));
  });

  it('applies current candidates after a drawer unmount/remount, but restores a cold-start seed', () => {
    const app = setup({ scope: 'all', keys: keys('b', 'a') });
    expect(app.keys()).toEqual(keys('b', 'a'));
    app.remount();
    expect(app.keys()).toEqual(keys('a', 'b'));
    app.render({ sections: projects('b', 'a') });
    expect(app.keys()).toEqual(keys('a', 'b'));
    app.render({ sections: [] });
    app.remount();
    app.render({ sections: projects('a', 'b') });
    expect(app.keys()).toEqual(keys('a', 'b')); // an empty warm mount must not revive the disk seed
  });

  it('keeps pinned sections independent and does not persist again on content-only updates', () => {
    const app = setup();
    const onCommit = app.input().onCommit;
    const pinned = { key: 'pinned', title: 'Pinned', data: [] };
    app.render({ sections: [pinned, ...projects('b', 'a')] });
    expect(app.result()[0]).toBe(pinned);
    expect(app.keys()).toEqual(keys('a', 'b'));
    expect(onCommit).toHaveBeenCalledTimes(1);
  });
});
