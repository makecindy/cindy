// @vitest-environment jsdom
import { act, createContext, useContext, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ starts: 0, stops: 0, instances: 0 }));
const Focus = createContext(true);
vi.mock('expo-router', () => ({ useIsFocused: () => useContext(Focus) }));
vi.mock('@/session/remoteSessionStore', () => ({ RemoteSessionStoreSubscriptionGate: ({ children }: any) => children }));
vi.mock('@/session/useTeammateRoster', () => ({ useTeammateRoster: (enabled: boolean) => {
  const [identity] = useState(() => ++h.instances);
  useEffect(() => {
    if (!enabled) return;
    h.starts++;
    return () => { h.stops++; };
  }, [enabled]);
  return { identity, groupTargets: [] };
} }));
vi.mock('@/session/useBotGroupRoster', () => ({ useBotGroupRoster: () => {
  const [items] = useState(() => [{ id: 'verified-room' }]);
  return { items };
} }));
import { HomeRosterProvider, HomeRosterStoreProvider, useHomeRoster } from '@/session/HomeRosterContext';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const values = new Map<string, ReturnType<typeof useHomeRoster>>();
function Read({ id }: { id: string }) { values.set(id, useHomeRoster()); return null; }
function Home({ id, focused }: { id: string; focused: boolean }) {
  return <Focus.Provider value={focused}><HomeRosterProvider><Read id={id} /></HomeRosterProvider></Focus.Provider>;
}
const roots: ReturnType<typeof createRoot>[] = [];
afterEach(() => { act(() => roots.splice(0).forEach(root => root.unmount())); h.starts = h.stops = h.instances = 0; values.clear(); });

it('keeps verified roster data and one subscription through private/group/native-screen handoffs', () => {
  const root = createRoot(document.createElement('div')); roots.push(root);
  const render = (selected: string, account = 'one') => act(() => root.render(
    <HomeRosterStoreProvider key={account}>
      <Home id="home" focused={selected === 'home'} />
      {selected !== 'home' && <Home key={selected} id={selected} focused />}
    </HomeRosterStoreProvider>,
  ));
  render('home');
  const original = values.get('home')!;
  for (let i = 0; i < 10; i++) {
    render('private');
    expect(values.get('private')!.roster).toEqual(original.roster);
    expect(values.get('private')!.groups.items).toBe(original.groups.items);
    render('group');
    expect(values.get('group')!.groups.items).toBe(original.groups.items);
  }
  expect(h.instances).toBe(1);
  expect(h.starts).toBe(1);
  expect(h.stops).toBe(0);
  render('group', 'other-account');
  expect(h.instances).toBe(2);
  expect(values.get('group')!.groups.items).not.toBe(original.groups.items);
  expect(h.stops).toBe(1);
});

it('pauses with no visible Home and resumes with the same data; standalone Homes still work', () => {
  const root = createRoot(document.createElement('div')); roots.push(root);
  const render = (focused: boolean) => act(() => root.render(
    <HomeRosterStoreProvider><Home id="drawer" focused={focused} /></HomeRosterStoreProvider>,
  ));
  render(true);
  const original = values.get('drawer')!.groups.items;
  render(false);
  expect(h.stops).toBe(1);
  expect(values.get('drawer')!.groups.items).toBe(original);
  render(true);
  expect(h.starts).toBe(2);
  expect(h.instances).toBe(1);
  act(() => root.render(<Home id="standalone" focused />));
  expect(values.get('standalone')).not.toBeNull();
  expect(h.instances).toBe(2);
});
