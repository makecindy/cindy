// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  path: '/', resourceKind: undefined as string | undefined,
  auth: { initialized: true, isAuthenticated: true },
  storage: new Map<string, string>(), get: vi.fn(), tasks: vi.fn(), collectionAvailable: true,
}));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {
  getItem: h.get,
  setItem: async (key: string, value: string) => { h.storage.set(key, value); },
} }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => h.auth }));
vi.mock('expo-router', () => ({
  usePathname: () => h.path,
  useGlobalSearchParams: () => ({ resourceKind: h.resourceKind }),
  Redirect: ({ href }: { href: unknown }) => <output data-target>{JSON.stringify(href)}</output>,
}));
vi.mock('../../app/devices', () => ({ default: () => { h.tasks(); return <div>tasks</div>; } }));
vi.mock('@/device-link/remoteResourceCache', () => ({
  readRemoteResourceSnapshot: async (userId: string) => ({ home: h.collectionAvailable ? [{
    id: 'teammates', resourceKind: 'bot', title: 'Teammates',
    targets: [{ deviceId: `${userId}-host`, deviceName: 'Computer' }],
  }] : [] }),
}));

import { HomeEntryProvider, useHomeEntry } from '@/session/HomeEntryProvider';
import { readHomeEntry, saveHomeEntry } from '@/session/homeEntryPreference';
import { getMobileAuthOwner, setMobileAuthOwner, __testing as ownerTesting } from '@/auth/authOwnerGeneration';
import IndexScreen from '../../app/index';

let root: Root;
let host: HTMLDivElement;
function Screen() {
  const entry = useHomeEntry();
  return <><output data-ready>{String(entry.ready)}</output>{h.path === '/' ? <IndexScreen /> : <div>{h.path}</div>}</>;
}
async function render() {
  await act(async () => { root.render(<StrictMode><HomeEntryProvider><Screen /></HomeEntryProvider></StrictMode>); });
}
async function navigate(path: string, resourceKind?: string) {
  h.path = path; h.resourceKind = resourceKind; await render();
}
async function restart() {
  await act(async () => root.unmount());
  root = createRoot(host); h.path = '/'; h.resourceKind = undefined; await render();
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  h.path = '/'; h.resourceKind = undefined; h.auth = { initialized: true, isAuthenticated: true };
  h.collectionAvailable = true;
  h.storage.clear(); h.tasks.mockClear(); h.get.mockReset();
  h.get.mockImplementation(async (key: string) => h.storage.get(key) ?? null);
  ownerTesting.reset(); setMobileAuthOwner('a', 'global');
  host = document.createElement('div'); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); });

describe('mobile startup entry', () => {
  it('reopens the partner list after closing a partner chat, with no task screen flash', async () => {
    await render();
    await navigate('/resources/teammates');
    await navigate('/sessions/private-chat', 'bot');
    h.tasks.mockClear();
    await restart();
    const target = JSON.parse(host.querySelector('[data-target]')!.textContent!);
    expect(target.pathname).toBe('/resources/[collectionId]');
    expect(target.params.collectionId).toBe('teammates');
    expect(target.params.targets).toContain('a-host');
    expect(h.tasks).not.toHaveBeenCalled();
    expect([...h.storage.values()]).toEqual(['bots']);
    // Completing the redirect, then pressing Back, is explicit navigation to tasks.
    await navigate('/resources/teammates');
    await navigate('/');
    expect(host.textContent).toContain('tasks');
    await restart();
    expect(host.querySelector('[data-target]')).toBeNull();
  });
  it.each([null, 'tasks', 'invalid'])('keeps the existing home for stored value %s', async (value) => {
    if (value) h.storage.set('cindy.homeEntry.v1.' + getMobileAuthOwner().accountKey, value);
    await render();
    expect(host.textContent).toContain('tasks');
    expect(host.querySelector('[data-target]')).toBeNull();
  });
  it('waits for hydration instead of mounting the task screen first', async () => {
    let resolve!: (value: string) => void;
    h.get.mockImplementation(() => new Promise<string>((done) => { resolve = done; }));
    await render();
    expect(host.querySelector('[data-ready]')?.textContent).toBe('false');
    expect(h.tasks).not.toHaveBeenCalled();
    await act(async () => { resolve('bots'); });
    expect(host.querySelector('[data-target]')).not.toBeNull();
    expect(h.tasks).not.toHaveBeenCalled();
  });
  it.each(['/sessions/linked-task', '/resources/teammates/linked-bot', '/settings'])('preserves explicit cold-start destination %s', async (path) => {
    await saveHomeEntry(getMobileAuthOwner().accountKey, 'bots');
    await navigate(path);
    expect(host.querySelector('[data-target]')).toBeNull();
    expect(host.textContent).toContain(path);
    await navigate('/');
    expect(host.textContent).toContain('tasks');
  });
  it('does not reclaim home after an explicit navigation during an outstanding read', async () => {
    const pending: Array<(value: string) => void> = [];
    h.get.mockImplementation(() => new Promise<string>((done) => pending.push(done)));
    await render();
    await navigate('/sessions/notification-target');
    await navigate('/');
    await act(async () => { pending.forEach((resolve) => resolve('bots')); });
    expect(host.querySelector('[data-target]')).toBeNull();
    expect(host.textContent).toContain('tasks');
  });
  it('discards a late old-account read and does not copy the inherited route on switch', async () => {
    const accountA = getMobileAuthOwner().accountKey;
    await saveHomeEntry(accountA, 'bots');
    await navigate('/resources/teammates');
    await act(async () => setMobileAuthOwner('b', 'global'));
    await render();
    expect(await readHomeEntry(getMobileAuthOwner().accountKey, 'b')).toBeNull();
    await navigate('/');
    expect(host.textContent).toContain('tasks');
    await act(async () => { h.auth.isAuthenticated = false; setMobileAuthOwner(null); });
    await render();
    expect(host.querySelector('[data-target]')?.textContent).toContain('/login');
    expect(await readHomeEntry(accountA, 'a')).not.toBeNull();
  });
  it('ignores an in-flight restore after switching account or realm', async () => {
    const pending: Array<(value: string | null) => void> = [];
    h.get.mockImplementation(() => new Promise<string | null>((done) => pending.push(done)));
    await render();
    await act(async () => setMobileAuthOwner('a', 'cn'));
    await render();
    const latest = pending.pop()!;
    await act(async () => { latest(null); });
    expect(host.textContent).toContain('tasks');
    await act(async () => { pending.forEach((resolve) => resolve('bots')); });
    expect(host.querySelector('[data-target]')).toBeNull();
  });
  it('uses the default when storage fails', async () => {
    h.get.mockRejectedValue(new Error('unavailable'));
    await render();
    expect(host.textContent).toContain('tasks');
  });
  it('uses normal discovery after account cleanup removed the cached partner hosts', async () => {
    await saveHomeEntry(getMobileAuthOwner().accountKey, 'bots');
    h.collectionAvailable = false;
    await render();
    expect(host.querySelector('[data-target]')).toBeNull();
    expect(host.textContent).toContain('tasks');
  });
  it('preserves a notification target after restoration has finished', async () => {
    await saveHomeEntry(getMobileAuthOwner().accountKey, 'bots');
    await render();
    await navigate('/resources/teammates');
    await navigate('/sessions/notification-target');
    expect(host.querySelector('[data-target]')).toBeNull();
    expect(host.textContent).toContain('/sessions/notification-target');
  });
});
