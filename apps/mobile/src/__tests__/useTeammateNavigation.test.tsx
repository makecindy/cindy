// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MobileUser } from '@/auth/AuthContext';
const h = vi.hoisted(() => ({
  disk: new Map<string, string>(), push: vi.fn(), dismissTo: vi.fn(), accountGeneration: 1,
  user: { id: 'account', passportId: 'passport', membershipKind: 'personal', orgId: null } as MobileUser,
  get: vi.fn(), set: vi.fn(),
}));
vi.mock('expo-router', () => ({ useRouter: () => ({ dismissTo: h.dismissTo }) }));
vi.mock('react-native', () => ({ Keyboard: { dismiss() {} } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language: 'en' } }) }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ user: h.user, accountGeneration: h.accountGeneration }) }));
vi.mock('@/utils/useGuardedPush', () => ({ useGuardedPush: () => h.push }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: h.get, setItem: h.set } }));
import { useTeammateNavigation } from '@/session/useTeammateNavigation';
import { homeNavigationOwner } from '@/session/useHomeMode';
import { readHomeNavigationPreferences, saveHomeNavigationPreferences } from '@/session/homeViewPreferenceStore';
import { teammateIdentity } from '@/session/teammateNavigation';
const teammate = { key: 'mac:writer', host: { deviceId: 'mac', deviceName: 'My Mac' }, item: {
  ref: { collectionId: 'teammates', kind: 'bot', id: 'writer' }, revision: '1', display: { title: 'Writer' }, links: [],
} };
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
let result: ReturnType<typeof useTeammateNavigation>;
function Probe() { result = useTeammateNavigation(); return null; }
async function render() { root ??= createRoot(document.createElement('div')); await act(async () => root!.render(createElement(Probe))); }
let serial = 0;
beforeEach(() => {
  vi.clearAllMocks(); h.disk.clear(); h.accountGeneration = ++serial;
  h.user = { id: `account-${serial}`, passportId: 'passport', membershipKind: 'personal', orgId: null } as MobileUser;
  h.get.mockImplementation(async (key: string) => h.disk.get(key) ?? null);
  h.set.mockImplementation(async (key: string, value: string) => { h.disk.set(key, value); });
});
afterEach(() => { act(() => root?.unmount()); root = undefined; vi.useRealTimers(); });
describe('header/home shared navigation', () => {
  it('restores an explicit mode and teammate, and mode changes preserve that identity', async () => {
    const owner = homeNavigationOwner(h.user);
    await saveHomeNavigationPreferences(owner, { mode: 'teammates', lastTeammate: teammateIdentity(teammate) });
    await render(); expect(result.mode).toBe('teammates'); expect(result.lastTeammate?.resourceId).toBe('writer');
    await act(async () => result.chooseMode('tasks'));
    expect(h.dismissTo).toHaveBeenCalledWith('/devices');
    expect(await readHomeNavigationPreferences(owner)).toEqual({ mode: 'tasks', lastTeammate: teammateIdentity(teammate) });
  });
  it('only pushes a resource resolver and records identity; never replaces or resets the current composer', async () => {
    await render(); await act(async () => result.openTeammate(teammate));
    expect(h.push).toHaveBeenCalledExactlyOnceWith({ pathname: '/resources/[collectionId]/[resourceId]', params: {
      collectionId: 'teammates', resourceId: 'writer', resourceKind: 'bot', deviceId: 'mac', deviceName: 'My Mac', title: 'Writer',
    } });
    expect(result.lastTeammate).toEqual(teammateIdentity(teammate));
    expect(result.mode).toBe('teammates'); // An explicit picker selection owns the active mode.
    expect(await readHomeNavigationPreferences(result.owner)).toEqual({
      mode: 'teammates', lastTeammate: teammateIdentity(teammate),
    });
    expect(h.set).toHaveBeenCalledTimes(1);
  });
  it('opens a creation receipt through the canonical resolver with one atomic preference update', async () => {
    await render(); await act(async () => result.openCreatedTeammate(teammate.host, teammate.item.ref));
    expect(h.push).toHaveBeenCalledExactlyOnceWith({ pathname: '/resources/[collectionId]/[resourceId]', params: {
      collectionId: 'teammates', resourceId: 'writer', resourceKind: 'bot', deviceId: 'mac', deviceName: 'My Mac',
    } });
    expect(result.mode).toBe('teammates'); expect(result.lastTeammate).toEqual(teammateIdentity(teammate));
    expect(h.set).toHaveBeenCalledTimes(1);
  });
  it('ignores a stale creation callback after switching accounts', async () => {
    await render(); const oldCreate = result.openCreatedTeammate;
    h.accountGeneration++; h.user = { ...h.user, id: 'new-create-owner' }; await render();
    await act(async () => oldCreate(teammate.host, teammate.item.ref));
    expect(h.set).not.toHaveBeenCalled(); expect(h.push).not.toHaveBeenCalled();
  });
  it('rejects invalid creation receipts without writing preferences or navigating', async () => {
    await render(); await act(async () => result.openCreatedTeammate(teammate.host, { ...teammate.item.ref, kind: 'session' }));
    expect(h.set).not.toHaveBeenCalled(); expect(h.push).not.toHaveBeenCalled();
  });
  it('does not block navigation on disk writes or carry a last teammate into a different membership', async () => {
    await render(); const previousOwner = result.owner;
    let finish!: () => void;
    h.set.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    let selection!: Promise<void>;
    await act(async () => { selection = result.openTeammate(teammate); });
    expect(h.push).toHaveBeenCalledTimes(1);
    h.accountGeneration += 1; h.user = { ...h.user, membershipKind: 'org', orgId: 'different-org' };
    await render();
    expect(result.owner).not.toBe(previousOwner); expect(result.lastTeammate).toBeNull(); expect(result.mode).toBe('tasks');
    await act(async () => { finish(); await selection; });
    expect(h.push).toHaveBeenCalledTimes(1);
    expect(result.lastTeammate).toBeNull();
  });
  it('fences an old selection still waiting for hydration when the account changes', async () => {
    let finish!: (raw: string | null) => void;
    h.get.mockImplementationOnce(() => new Promise<string | null>((resolve) => { finish = resolve; }));
    await render();
    let selection!: Promise<void>;
    await act(async () => { selection = result.openTeammate(teammate); });
    h.accountGeneration += 1; h.user = { ...h.user, id: 'new-owner-during-read' };
    await render();
    await act(async () => { finish(null); await selection; });
    expect(h.push).not.toHaveBeenCalled(); expect(result.lastTeammate).toBeNull();
  });
  it('hydrates a prior identity before applying an explicit mode chosen during the read', async () => {
    let finish!: (raw: string) => void;
    h.get.mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve; }));
    await render();
    let change!: Promise<void>;
    await act(async () => { change = result.setMode('teammates'); });
    await act(async () => { finish(JSON.stringify({ mode: 'tasks', lastTeammate: teammateIdentity(teammate) })); await change; });
    expect(result.mode).toBe('teammates'); expect(result.lastTeammate).toEqual(teammateIdentity(teammate));
  });
  it('does not let a hung preference read blank home forever or a late mode hijack the fallback task list', async () => {
    vi.useFakeTimers();
    let finish!: (raw: string) => void;
    h.get.mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve; }));
    await render(); expect(result.hydrated).toBe(false);
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(result.hydrated).toBe(true); expect(result.mode).toBe('tasks');
    await act(async () => finish(JSON.stringify({ mode: 'teammates', lastTeammate: teammateIdentity(teammate) })));
    expect(result.mode).toBe('tasks'); expect(result.lastTeammate).toEqual(teammateIdentity(teammate));
    expect(h.set).not.toHaveBeenCalled(); expect(h.push).not.toHaveBeenCalled();
  });
  it('fences rapid selections before asynchronous storage so the remembered identity matches the opened route', async () => {
    await render();
    const second = { ...teammate, item: { ...teammate.item, ref: { ...teammate.item.ref, id: 'different' } } };
    await act(async () => Promise.all([result.openTeammate(teammate), result.openTeammate(second)]));
    expect(h.push).toHaveBeenCalledTimes(1); expect(result.lastTeammate?.resourceId).toBe('writer');
  });
  it('surfaces persistence failure without clearing the current chat or claiming the choice was saved', async () => {
    await render(); h.set.mockRejectedValueOnce(new Error('storage full'));
    await act(async () => result.setMode('teammates'));
    expect(result.saveFailed).toBe(true); expect(h.push).not.toHaveBeenCalled();
  });
});
