// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { __resetTabGroupsForTest, getTabGroup } from '../../tabGroups';

const mocks = vi.hoisted(() => ({
  create: vi.fn(), list: vi.fn(), pin: vi.fn(), merge: vi.fn(), add: vi.fn(), getWindow: vi.fn(),
  status: vi.fn(), save: vi.fn(), quote: vi.fn(), discard: vi.fn(), reveal: vi.fn(),
  close: vi.fn(), activate: vi.fn(), cache: vi.fn(), clear: vi.fn(), patch: vi.fn(),
  device: null as string | null, tabs: [] as Array<{ id: string; kind: string; state: unknown }>,
  created: new Set<(payload: any, stamp?: any) => void>(),
  patched: new Set<(payload: any, stamp?: any) => void>(),
  remote: new Set<(push: any, stamp?: any) => void>(),
  bucketListeners: new Set<(sessionId: string) => void>(),
  hydrated: true,
}));
vi.mock('@/lib/makerTransport', () => ({ makerApiForSticky: () => ({ createSideChat: mocks.create, listSideChats: mocks.list }) }));
vi.mock('@/features/device-link/stickySessionOrigin', () => ({ getStickySessionDeviceId: () => mocks.device }));
vi.mock('@/features/device-link/remoteProjectsStore', () => ({ remoteProjectsStore: { pinSessionOrigin: mocks.pin, mergeDeviceSessions: mocks.cache, applyPatch: mocks.patch, getDeviceName: () => 'Host' } }));
vi.mock('@/lib/composerDraftStore', () => ({ saveDraft: mocks.save, appendQuoteToDraft: mocks.quote, discardDraft: mocks.discard, clearDraft: mocks.clear }));
vi.mock('@/components/chat/useForkAtMessage', () => ({ textToTiptapDoc: (text: string) => ({ type: 'doc', text }) }));
vi.mock('@/lib/sessionService', () => ({ setStatus: mocks.status }));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/i18n', () => ({ default: { t: (key: string) => key } }));
vi.mock('../../store', () => ({
  addTab: mocks.add, closeTab: mocks.close, setActiveTab: mocks.activate,
  ensureHydrated: vi.fn(), getBucket: () => ({ tabs: mocks.tabs, hydrated: mocks.hydrated }),
  subscribe: (listener: (sessionId: string) => void) => {
    mocks.bucketListeners.add(listener); return () => mocks.bucketListeners.delete(listener);
  },
}));
vi.mock('../mergeSidebarWindowBack', () => ({ mergeSidebarWindowBack: mocks.merge }));
vi.mock('../sidebarCommands', () => ({ requestRightSidebarVisibility: mocks.reveal }));

import { openSideChatTab, restoreSideChatTabs, watchSideChatTabs } from '../openSideChatTab';

// Unit: the user entry must not leave unreachable children or route a remote child locally.
// Existing sidebar openers do not create task branches; minimal failures are a rejected tab write
// and a controller restart with an existing child but an empty local tab bucket.
describe('side chat task entry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetTabGroupsForTest();
    window.localStorage.clear();
    setDataOwnerGeneration('owner', 1);
    mocks.created.clear(); mocks.patched.clear(); mocks.remote.clear();
    mocks.bucketListeners.clear(); mocks.hydrated = true;
    mocks.device = null;
    mocks.tabs = [];
    mocks.create.mockResolvedValue({ id: 'child' });
    mocks.list.mockResolvedValue([{ id: 'child' }]);
    mocks.getWindow.mockResolvedValue({ detached: false });
    mocks.merge.mockResolvedValue(undefined);
    const subscribe = (listeners: Set<any>) => (listener: any) => {
      listeners.add(listener); return () => listeners.delete(listener);
    };
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
      rightSidebarWindow: { getState: mocks.getWindow },
      localDb: { sessionsPush: { onCreated: subscribe(mocks.created), onPatched: subscribe(mocks.patched) } },
      deviceLink: { onRemotePush: subscribe(mocks.remote) },
    } });
    mocks.add.mockImplementation(async (_parent, kind, state) => {
      const tab = { id: `tab-${mocks.tabs.length}`, kind, state };
      mocks.tabs = [...mocks.tabs, tab];
      return tab;
    });
    mocks.close.mockImplementation(async (_parent, id) => { mocks.tabs = mocks.tabs.filter(tab => tab.id !== id); });
    mocks.status.mockResolvedValue(undefined);
  });

  // The draft must exist before the embedded editor appears; opening a follow-up
  // keeps the main task visible instead of navigating away (2026-10-25 regression).
  it('opens the parent sidebar after preserving the branch entry and draft', async () => {
    expect(await openSideChatTab('parent', { prompt: 'follow-up' })).toBe(true);
    expect(mocks.save.mock.invocationCallOrder[0]).toBeLessThan(mocks.add.mock.invocationCallOrder[0]);
    expect(mocks.tabs).toContainEqual(expect.objectContaining({ state: { sessionId: 'child', deviceId: null } }));
    expect(mocks.reveal).toHaveBeenCalledExactlyOnceWith('open', { sessionId: 'parent', userInitiated: true });
  });

  it('pins the remote child before exposing its quote and editor', async () => {
    mocks.device = 'execution-host';
    expect(await openSideChatTab('parent', { quote: 'selected answer' })).toBe(true);
    expect(mocks.create).toHaveBeenCalledWith('parent');
    expect(mocks.pin).toHaveBeenCalledWith('execution-host', 'child');
    expect(mocks.quote).toHaveBeenCalledWith('child', { text: 'selected answer' });
    expect(mocks.add).toHaveBeenCalledWith('parent', 'side-chat', { sessionId: 'child', deviceId: 'execution-host' }, undefined);
    expect(mocks.pin.mock.invocationCallOrder[0]).toBeLessThan(mocks.add.mock.invocationCallOrder[0]);
  });

  // Unit, #6529: hidden children do not arrive in ordinary task lists. The create
  // result must supply metadata before the embedded editor can read/send remotely.
  it('caches remote metadata before opening the embedded task', async () => {
    mocks.device = 'execution-host';
    const child = { id: 'child', source: 'side-chat', model: 'test-model', workingDir: '/work' };
    mocks.create.mockResolvedValue(child);
    expect(await openSideChatTab('parent')).toBe(true);
    expect(mocks.cache).toHaveBeenCalledWith('execution-host', 'Host', [child]);
    expect(mocks.cache.mock.invocationCallOrder[0]).toBeLessThan(mocks.add.mock.invocationCallOrder[0]);
  });

  // Unit, #6529: /side used to clear the composer while dropping its files.
  // Preserve image/file metadata and return rejection without recycling the
  // shared original attachment when child creation or tab persistence fails.
  it('transfers attachments and reports failures without consuming the original files', async () => {
    const attachments = [{ id: 'img', path: '/staged/image.png', category: 'image', annotated: true }] as any;
    expect(await openSideChatTab('parent', { prompt: 'question', attachments })).toBe(true);
    expect(mocks.save).toHaveBeenCalledWith('child', { text: { type: 'doc', text: 'question' }, attachments });
    mocks.tabs = [];
    mocks.add.mockRejectedValueOnce(new Error('disk full'));
    expect(await openSideChatTab('parent', { prompt: 'question', attachments })).toBe(false);
    expect(mocks.clear).toHaveBeenCalledWith('child');
    expect(mocks.discard).not.toHaveBeenCalled();
    mocks.create.mockRejectedValueOnce(new Error('NO_PRIOR_ASSISTANT'));
    expect(await openSideChatTab('parent', { prompt: 'question', attachments })).toBe(false);
  });

  it('deletes only the new remote branch if its tab cannot be opened', async () => {
    mocks.device = 'execution-host';
    mocks.add.mockRejectedValueOnce(new Error('disk full'));
    expect(await openSideChatTab('parent', { prompt: 'question' })).toBe(false);
    expect(mocks.status).toHaveBeenCalledExactlyOnceWith('child', 'deleted', { kind: 'device-link', deviceId: 'execution-host' });
    expect(mocks.patch).toHaveBeenCalledWith('execution-host', 'child', { status: 'deleted' });
    expect(mocks.clear).toHaveBeenCalledWith('child');
    expect(mocks.reveal).not.toHaveBeenCalled();
  });

  // Unit merge regression: a creation push can restore the child before the menu
  // finishes. Its tab must still enter the clicked group / popout host, without
  // revealing the main right sidebar. Existing tests only opened the default host.
  it.each([false, true])('keeps menu placement when the creation push wins=%s', async restored => {
    if (restored) mocks.tabs = [{ id: 'restored', kind: 'side-chat', state: { sessionId: 'child' } }];
    const adopt = vi.fn();
    const placement = { groupId: 'left' as const, onOptimisticAdd: adopt };
    expect(await openSideChatTab('parent', { placement })).toBe(true);
    if (restored) {
      expect(getTabGroup('restored')).toBe('left');
      expect(adopt).toHaveBeenCalledWith('restored');
      expect(mocks.activate).toHaveBeenCalledWith('parent', 'restored');
      expect(mocks.add).not.toHaveBeenCalled();
    } else {
      expect(mocks.add).toHaveBeenCalledWith('parent', 'side-chat', { sessionId: 'child', deviceId: null }, placement);
    }
    expect(mocks.reveal).not.toHaveBeenCalled();
  });

  it('returns a detached sidebar to the main window before creating its independent branch', async () => {
    mocks.getWindow.mockResolvedValue({ detached: true });
    expect(await openSideChatTab('parent')).toBe(true);
    expect(mocks.merge).toHaveBeenCalledWith('parent');
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.merge.mock.invocationCallOrder[0]).toBeLessThan(mocks.create.mock.invocationCallOrder[0]);
  });

  it('recovers remote branches after restart without stealing the active tab', async () => {
    mocks.device = 'execution-host';
    await Promise.all([restoreSideChatTabs('parent'), restoreSideChatTabs('parent')]);
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(mocks.add).toHaveBeenCalledExactlyOnceWith('parent', 'side-chat', { sessionId: 'child', deviceId: 'execution-host' }, { activate: false });
    expect(mocks.reveal).not.toHaveBeenCalled();
    mocks.tabs = [{ id: 'tab', kind: 'side-chat', state: { sessionId: 'child' } }];
    await restoreSideChatTabs('parent');
    expect(mocks.add).toHaveBeenCalledTimes(1);
  });

  it('does not duplicate a detached window tab when the main window has an empty projection', async () => {
    mocks.device = 'execution-host';
    mocks.getWindow.mockResolvedValue({ detached: true });
    await restoreSideChatTabs('parent');
    expect(mocks.add).not.toHaveBeenCalled();
    mocks.getWindow.mockResolvedValueOnce({ detached: false }).mockResolvedValueOnce({ detached: true });
    await restoreSideChatTabs('parent');
    expect(mocks.add).not.toHaveBeenCalled();
  });

  // Regression: a phone-created child has no local sidebar row. Durable local
  // tabs alone cannot discover it; restoring the parent must query the host.
  it('discovers a phone-created branch on the execution computer', async () => {
    await restoreSideChatTabs('parent');
    expect(mocks.list).toHaveBeenCalledWith('parent');
    expect(mocks.add).toHaveBeenCalledExactlyOnceWith('parent', 'side-chat',
      { sessionId: 'child', deviceId: null }, { activate: false });
  });

  it.each([null, 'execution-host'])('updates the open parent on creation pushes, scoped to its host (%s)', async device => {
    mocks.device = device;
    mocks.list.mockResolvedValue([]);
    const stop = watchSideChatTabs('parent');
    try {
      await restoreSideChatTabs('parent');
      mocks.list.mockResolvedValue([{ id: 'unknown-child' }]);
      mocks.remote.forEach(fn => fn({ deviceId: 'other-host', channel: 'local-db:sessions:created', payload: { sessionId: 'other' } }));
      mocks.created.forEach(fn => fn({ sessionId: 'old-owner-child' }, { dataOwnerId: 'old-owner', ownerGeneration: 1 }));
      await Promise.resolve();
      expect(mocks.list).toHaveBeenCalledTimes(1);
      if (device) mocks.remote.forEach(fn => fn({ deviceId: device, channel: 'local-db:sessions:created', payload: { sessionId: 'unknown-child' } }));
      else mocks.created.forEach(fn => fn({ sessionId: 'unknown-child' }));
      await vi.waitFor(() => expect(mocks.tabs).toEqual([
        { id: 'tab-0', kind: 'side-chat', state: { sessionId: 'unknown-child', deviceId: device } },
      ]));
      expect(mocks.reveal).not.toHaveBeenCalled();
    } finally { stop(); }
    expect(mocks.created.size + mocks.patched.size + mocks.remote.size).toBe(0);
  });

  it('removes a stale tab from the host list without deleting or confirming the branch again', async () => {
    mocks.tabs = [
      { id: 'gone', kind: 'side-chat', state: { sessionId: 'deleted-child' } },
      { id: 'files', kind: 'file-browser', state: {} },
    ];
    mocks.list.mockResolvedValue([]);
    await restoreSideChatTabs('parent');
    expect(mocks.tabs.map(tab => tab.id)).toEqual(['files']);
    expect(mocks.close).toHaveBeenCalledExactlyOnceWith('parent', 'gone', { skipBeforeClose: true });
    expect(mocks.status).not.toHaveBeenCalled();
  });

  it('discards an older list and reads again when a deletion arrives during recovery', async () => {
    let finish!: (value: { id: string }[]) => void;
    mocks.list.mockReturnValueOnce(new Promise(resolve => { finish = resolve; })).mockResolvedValue([]);
    const first = restoreSideChatTabs('parent');
    await vi.waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(1));
    const next = restoreSideChatTabs('parent');
    finish([{ id: 'deleted-child' }]);
    await Promise.all([first, next]);
    expect(mocks.list).toHaveBeenCalledTimes(2);
    expect(mocks.tabs).toEqual([]);
  });

  it('does not duplicate a tab restored before its create reply', async () => {
    mocks.create.mockImplementationOnce(async () => {
      await restoreSideChatTabs('parent');
      return { id: 'child' };
    });
    expect(await openSideChatTab('parent')).toBe(true);
    expect(mocks.tabs).toHaveLength(1);
    expect(mocks.activate).toHaveBeenCalledWith('parent', 'tab-0');
  });

  it.each(['unmount', 'owner change'])('does not apply a late list after %s', async boundary => {
    let finish!: (value: { id: string }[]) => void;
    mocks.list.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const stop = watchSideChatTabs('parent');
    await vi.waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(1));
    try {
      if (boundary === 'unmount') stop();
      else setDataOwnerGeneration('other-owner', 2);
      finish([{ id: 'late-child' }]);
      await vi.waitFor(() => expect(mocks.getWindow).toHaveBeenCalledTimes(2));
      expect(mocks.tabs).toEqual([]);
    } finally { stop(); }
  });

  it('does not remove a new user-created tab absent from an older list snapshot', async () => {
    let finish!: (value: { id: string }[]) => void;
    mocks.list.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const restoring = restoreSideChatTabs('parent');
    await vi.waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(1));
    expect(await openSideChatTab('parent')).toBe(true);
    finish([]);
    await restoring;
    expect(mocks.tabs).toHaveLength(1);
    expect(mocks.close).not.toHaveBeenCalled();
  });

  // Unit regression: detached broadcasts are intentionally ignored. The existing
  // push tests never transferred the tab bucket back to the main window.
  it.each([null, 'execution-host'])('reconciles missed branches after the handoff bucket is hydrated (%s)', async device => {
    mocks.device = device;
    mocks.list.mockResolvedValue([]);
    const stop = watchSideChatTabs('parent');
    try {
      await restoreSideChatTabs('parent');
      mocks.getWindow.mockResolvedValue({ detached: true });
      mocks.hydrated = false;
      mocks.bucketListeners.forEach(fn => fn('parent'));
      mocks.list.mockResolvedValue([{ id: 'phone-child' }]);
      mocks.created.forEach(fn => fn({ sessionId: 'phone-child' }));
      mocks.remote.forEach(fn => fn({ deviceId: device, channel: 'local-db:sessions:created' }));
      await restoreSideChatTabs('parent');
      expect(mocks.list).toHaveBeenCalledTimes(1);
      mocks.getWindow.mockResolvedValue({ detached: false });
      // MainLayout resets the cache then hydrates either the persisted tab list
      // or the remote window's handed-off snapshot.
      mocks.tabs = [{ id: 'old-tab', kind: 'side-chat', state: { sessionId: 'deleted-child' } }];
      mocks.hydrated = true;
      mocks.bucketListeners.forEach(fn => fn('parent'));
      await vi.waitFor(() => expect(mocks.tabs.map(tab => (tab.state as any).sessionId)).toEqual(['phone-child']));
      const reads = mocks.list.mock.calls.length;
      mocks.bucketListeners.forEach(fn => fn('parent'));
      await Promise.resolve();
      expect(mocks.list).toHaveBeenCalledTimes(reads);
      expect(mocks.reveal).not.toHaveBeenCalled();
    } finally { stop(); }
    expect(mocks.bucketListeners.size).toBe(0);
  });
});
