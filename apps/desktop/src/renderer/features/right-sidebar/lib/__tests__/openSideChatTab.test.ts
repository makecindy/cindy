// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sharedTaskGuestPeer } from '@cindy/device-link';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { __resetTabGroupsForTest } from '../../tabGroups';

const mocks = vi.hoisted(() => ({
  create: vi.fn(), list: vi.fn(), pin: vi.fn(), merge: vi.fn(), add: vi.fn(), patchTab: vi.fn(), getWindow: vi.fn(),
  status: vi.fn(), save: vi.fn(), quote: vi.fn(), discard: vi.fn(), reveal: vi.fn(),
  close: vi.fn(), activate: vi.fn(), cache: vi.fn(), clear: vi.fn(), patch: vi.fn(), info: vi.fn(), error: vi.fn(),
  readBatch: vi.fn(), getDraft: vi.fn(), flushDraft: vi.fn(), draftHasContent: vi.fn(),
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
vi.mock('@/lib/sessionsStore', () => ({ sessionsStore: { findById: () => null } }));
vi.mock('@/lib/composerDraftStore', () => ({
  saveDraft: mocks.save,
  appendQuoteToDraft: mocks.quote,
  discardDraft: mocks.discard,
  clearDraft: mocks.clear,
  getDraft: mocks.getDraft,
  flushDraft: mocks.flushDraft,
  draftHasContent: mocks.draftHasContent,
}));
vi.mock('@/components/chat/useForkAtMessage', () => ({ textToTiptapDoc: (text: string) => ({ type: 'doc', text }) }));
vi.mock('@/lib/sessionService', () => ({ setStatus: mocks.status }));
vi.mock('@/lib/sessionBatchRead', () => ({ readSessionBatch: mocks.readBatch }));
vi.mock('@/lib/toast', () => ({ toast: { error: mocks.error, info: mocks.info } }));
vi.mock('@/i18n', () => ({ default: { t: (key: string) => key } }));
vi.mock('../../store', () => ({
  addTab: mocks.add, closeTab: mocks.close, setActiveTab: mocks.activate, patchTabState: mocks.patchTab,
  ensureHydrated: vi.fn(), getBucket: () => ({ tabs: mocks.tabs, hydrated: mocks.hydrated }),
  subscribe: (listener: (sessionId: string) => void) => {
    mocks.bucketListeners.add(listener); return () => mocks.bucketListeners.delete(listener);
  },
}));
vi.mock('../mergeSidebarWindowBack', () => ({ mergeSidebarWindowBack: mocks.merge }));
vi.mock('../sidebarCommands', () => ({ requestRightSidebarVisibility: mocks.reveal }));

import type { Session } from '@/lib/ccAgent.types';
import {
  __resetPendingSideChatsForTest,
  cancelPendingSideChat,
  getPendingSideChat,
  setPendingSideChatQueuedSend,
} from '../../plugins/side-chat/pendingSideChat';
import {
  openSideChatTab,
  reopenLinkedSideChat,
  restoreSideChatTabs,
  retryPendingSideChatCreation,
  sideChatUnavailableKey,
  watchSideChatTabs,
} from '../openSideChatTab';

// Unit: the user entry must not leave unreachable children or route a remote child locally.
// Existing sidebar openers do not create task branches; minimal failures are a rejected tab write
// and a controller restart with an existing child but an empty local tab bucket.
describe('side chat task entry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetTabGroupsForTest();
    __resetPendingSideChatsForTest();
    window.localStorage.clear();
    setDataOwnerGeneration('owner', 1);
    mocks.created.clear(); mocks.patched.clear(); mocks.remote.clear();
    mocks.bucketListeners.clear(); mocks.hydrated = true;
    mocks.device = null;
    mocks.tabs = [];
    mocks.create.mockResolvedValue({ id: 'child' });
    mocks.list.mockResolvedValue([{ id: 'child' }]);
    mocks.readBatch.mockImplementation(async (ids: string[]) => ids.map(sessionId => ({ sessionId, errorCode: 'NOT_FOUND' })));
    mocks.getWindow.mockResolvedValue({ detached: false });
    mocks.merge.mockResolvedValue(undefined);
    mocks.getDraft.mockReturnValue(undefined);
    mocks.draftHasContent.mockReturnValue(false);
    const subscribe = (listeners: Set<any>) => (listener: any) => {
      listeners.add(listener); return () => listeners.delete(listener);
    };
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
      rightSidebarWindow: { getState: mocks.getWindow },
      localDb: { sessionsPush: { onCreated: subscribe(mocks.created), onPatched: subscribe(mocks.patched) } },
      deviceLink: { onRemotePush: subscribe(mocks.remote) },
    } });
    mocks.add.mockImplementation(async (_parent, kind, state, opts?: { onOptimisticAdd?: (tabId: string) => void }) => {
      const tab = { id: `tab-${mocks.tabs.length}`, kind, state };
      mocks.tabs = [...mocks.tabs, tab];
      opts?.onOptimisticAdd?.(tab.id);
      return tab;
    });
    mocks.patchTab.mockImplementation(async (_parent, tabId, updater: (current: unknown) => unknown) => {
      mocks.tabs = mocks.tabs.map(tab => tab.id === tabId ? { ...tab, state: updater(tab.state) } : tab);
    });
    mocks.close.mockImplementation(async (_parent, id) => { mocks.tabs = mocks.tabs.filter(tab => tab.id !== id); });
    mocks.status.mockResolvedValue(undefined);
  });

  // Unit: opening a side chat must reveal the tab and preserve the draft before
  // host fork settles, then bind the resolved child onto the same tab.
  it('opens the parent sidebar immediately while forking in the background and binds the child', async () => {
    let finishFork!: (child: { id: string }) => void;
    mocks.create.mockReturnValueOnce(new Promise(resolve => { finishFork = resolve; }));
    expect(await openSideChatTab('parent', { prompt: 'follow-up' })).toBe(true);
    expect(mocks.save.mock.invocationCallOrder[0]).toBeLessThan(mocks.add.mock.invocationCallOrder[0]);
    expect(mocks.reveal).toHaveBeenCalledExactlyOnceWith('open', { sessionId: 'parent', userInitiated: true });
    expect(mocks.tabs).toEqual([expect.objectContaining({ id: 'tab-0', state: { sessionId: null, deviceId: null } })]);
    expect(getPendingSideChat('tab-0')).toMatchObject({ status: 'creating', parentSessionId: 'parent' });
    expect(mocks.save).toHaveBeenCalledWith(getPendingSideChat('tab-0')!.draftKey, {
      text: { type: 'doc', text: 'follow-up' },
      attachments: [],
    });
    finishFork({ id: 'child' });
    await vi.waitFor(() => expect(mocks.tabs).toContainEqual(
      expect.objectContaining({ id: 'tab-0', state: { sessionId: 'child', deviceId: null } }),
    ));
    expect(getPendingSideChat('tab-0')).toMatchObject({ status: 'ready', childSession: { id: 'child' } });
  });

  it('pins and caches the remote child before binding its tab while keeping the quote draft', async () => {
    mocks.device = 'execution-host';
    const child = { id: 'child', source: 'side-chat', model: 'test-model', workingDir: '/work' };
    mocks.create.mockResolvedValue(child);
    expect(await openSideChatTab('parent', { quote: 'selected answer' })).toBe(true);
    expect(mocks.create).toHaveBeenCalledWith('parent');
    const draftKey = getPendingSideChat('tab-0')!.draftKey;
    expect(mocks.quote).toHaveBeenCalledWith(draftKey, { text: 'selected answer' });
    await vi.waitFor(() => expect(mocks.tabs).toContainEqual(
      expect.objectContaining({ id: 'tab-0', state: { sessionId: 'child', deviceId: 'execution-host' } }),
    ));
    expect(mocks.pin).toHaveBeenCalledWith('execution-host', 'child');
    expect(mocks.cache).toHaveBeenCalledWith('execution-host', 'Host', [child]);
    expect(mocks.pin.mock.invocationCallOrder[0]).toBeLessThan(mocks.patchTab.mock.invocationCallOrder[0]);
    expect(mocks.cache.mock.invocationCallOrder[0]).toBeLessThan(mocks.patchTab.mock.invocationCallOrder[0]);
  });

  // Unit, #6529: /side used to clear the composer while dropping its files.
  // Preserve image/file metadata without recycling shared parent files when
  // tab persistence or background fork fails.
  it('transfers attachments and preserves them without consuming original files on failure', async () => {
    const attachments = [{ id: 'img', path: '/staged/image.png', category: 'image', annotated: true }] as any;
    expect(await openSideChatTab('parent', { prompt: 'question', attachments })).toBe(true);
    const firstDraftKey = getPendingSideChat('tab-0')!.draftKey;
    expect(mocks.save).toHaveBeenCalledWith(firstDraftKey, { text: { type: 'doc', text: 'question' }, attachments });
    await vi.waitFor(() => expect(mocks.tabs).toContainEqual(
      expect.objectContaining({ id: 'tab-0', state: { sessionId: 'child', deviceId: null } }),
    ));

    mocks.tabs = [];
    mocks.add.mockRejectedValueOnce(new Error('disk full'));
    expect(await openSideChatTab('parent', { prompt: 'question', attachments })).toBe(false);
    expect(mocks.clear).toHaveBeenCalled();
    expect(mocks.discard).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(mocks.status).toHaveBeenCalledWith('child', 'deleted', { kind: 'local' }, undefined, 'side-chat'));
  });

  it('deletes the orphan remote branch when initial tab creation fails', async () => {
    mocks.device = 'execution-host';
    mocks.add.mockRejectedValueOnce(new Error('disk full'));
    expect(await openSideChatTab('parent', { prompt: 'question' })).toBe(false);
    await vi.waitFor(() => {
      expect(mocks.status).toHaveBeenCalledExactlyOnceWith(
        'child', 'deleted', { kind: 'device-link', deviceId: 'execution-host' }, undefined, 'side-chat',
      );
      expect(mocks.patch).toHaveBeenCalledWith('execution-host', 'child', { status: 'deleted' });
    });
    expect(mocks.clear).toHaveBeenCalled();
    expect(mocks.reveal).not.toHaveBeenCalled();
  });

  // Unit, #12799: a failed state write used to expose a ready child and could
  // dispatch the queued send before the tab could be saved. Retry by child id.
  it('keeps the preview pending until binding saves and retries the same fork on failure', async () => {
    let failBinding!: (error: Error) => void;
    mocks.patchTab.mockReturnValueOnce(new Promise((_, reject) => { failBinding = reject; }));
    expect(await openSideChatTab('parent', { prompt: 'keep this' })).toBe(true);
    const draftKey = getPendingSideChat('tab-0')!.draftKey;
    await vi.waitFor(() => expect(mocks.patchTab).toHaveBeenCalledOnce());
    expect(getPendingSideChat('tab-0')).toMatchObject({ status: 'creating', childSession: null });
    failBinding(new Error('tab write rejected'));
    await vi.waitFor(() => expect(getPendingSideChat('tab-0'))
      .toMatchObject({ status: 'failed', childSession: { id: 'child' }, draftKey }));
    expect(mocks.clear).not.toHaveBeenCalled();
    expect(mocks.status).not.toHaveBeenCalled();
    expect(retryPendingSideChatCreation('parent', 'tab-0')).toBe(true);
    await vi.waitFor(() => expect(getPendingSideChat('tab-0'))
      .toMatchObject({ status: 'ready', childSession: { id: 'child' }, draftKey }));
    expect(mocks.create).toHaveBeenCalledOnce();
  });

  // Unit, #12799: close can race the fork or the subsequent tab write. Either
  // way the branch must be reclaimed before it can be used for a send.
  it.each(['fork', 'bind'])('deletes the child if the user closes the pending tab during %s', async phase => {
    let finishFork!: (child: { id: string }) => void;
    let finishBinding!: () => void;
    mocks.create.mockReturnValueOnce(new Promise(resolve => { finishFork = resolve; }));
    if (phase === 'bind') {
      mocks.patchTab.mockReturnValueOnce(new Promise(resolve => { finishBinding = resolve; }));
    }
    expect(await openSideChatTab('parent')).toBe(true);
    const child = { id: 'orphan-child' };
    if (phase === 'bind') {
      finishFork(child);
      await vi.waitFor(() => expect(mocks.patchTab).toHaveBeenCalledOnce());
    }
    cancelPendingSideChat('tab-0');
    mocks.tabs = [];
    if (phase === 'fork') finishFork(child);
    else finishBinding();
    await vi.waitFor(() => expect(mocks.status).toHaveBeenCalledExactlyOnceWith(
      'orphan-child', 'deleted', { kind: 'local' }, undefined, 'side-chat',
    ));
    expect(mocks.patchTab).toHaveBeenCalledTimes(phase === 'bind' ? 1 : 0);
    expect(getPendingSideChat('tab-0')).toBeUndefined();
  });

  // Unit: background fork failure closes an empty pending tab automatically,
  // but keeps the tab retryable when the user already has draft text or a queued send.
  it.each([false, true])('handles background fork failure with userContent=%s', async hasContent => {
    let failFork!: (err: Error) => void;
    mocks.create.mockReturnValueOnce(new Promise((_, reject) => { failFork = reject; }));
    expect(await openSideChatTab('parent')).toBe(true);
    if (hasContent) {
      mocks.draftHasContent.mockReturnValue(true);
      setPendingSideChatQueuedSend('tab-0', true);
    }
    failFork(new Error('[NO_PRIOR_ASSISTANT] wait'));
    await vi.waitFor(() => expect(mocks.error).toHaveBeenCalledWith('chat.sideChat.notReady'));
    if (hasContent) {
      expect(mocks.tabs).toHaveLength(1);
      expect(getPendingSideChat('tab-0')).toMatchObject({ status: 'failed', errorMessage: 'chat.sideChat.notReady' });
      mocks.create.mockResolvedValueOnce({ id: 'retried-child' });
      expect(retryPendingSideChatCreation('parent', 'tab-0')).toBe(true);
      await vi.waitFor(() => expect(mocks.tabs).toContainEqual(
        expect.objectContaining({ id: 'tab-0', state: { sessionId: 'retried-child', deviceId: null } }),
      ));
    } else {
      await vi.waitFor(() => expect(mocks.close).toHaveBeenCalledWith('parent', 'tab-0', { skipBeforeClose: true }));
      expect(mocks.tabs).toEqual([]);
    }
  });

  // Unit merge regression: menu placement must apply synchronously to the
  // optimistic tab, and a concurrent creation push must not duplicate or steal it.
  it.each([false, true])('keeps menu placement when a duplicate restored tab exists=%s', async duplicateRestored => {
    let finishFork!: (child: { id: string }) => void;
    mocks.create.mockReturnValueOnce(new Promise(resolve => { finishFork = resolve; }));
    const adopt = vi.fn();
    const placement = { groupId: 'left' as const, onOptimisticAdd: adopt };
    expect(await openSideChatTab('parent', { placement })).toBe(true);
    expect(mocks.add).toHaveBeenCalledWith(
      'parent',
      'side-chat',
      { sessionId: null, deviceId: null },
      expect.objectContaining({ groupId: 'left' }),
    );
    expect(adopt).toHaveBeenCalledExactlyOnceWith('tab-0');
    expect(mocks.reveal).not.toHaveBeenCalled();
    if (duplicateRestored) {
      mocks.tabs = [...mocks.tabs, { id: 'restored', kind: 'side-chat', state: { sessionId: 'child', deviceId: null } }];
    }
    finishFork({ id: 'child' });
    await vi.waitFor(() => expect(mocks.tabs).toContainEqual(
      expect.objectContaining({ id: 'tab-0', state: { sessionId: 'child', deviceId: null } }),
    ));
    if (duplicateRestored) {
      expect(mocks.close).toHaveBeenCalledWith('parent', 'restored', { skipBeforeClose: true });
    }
    expect(mocks.tabs).toEqual([{ id: 'tab-0', kind: 'side-chat', state: { sessionId: 'child', deviceId: null } }]);
  });

  it('returns a detached sidebar to the main window before creating its independent branch', async () => {
    mocks.getWindow.mockResolvedValue({ detached: true });
    expect(await openSideChatTab('parent')).toBe(true);
    expect(mocks.merge).toHaveBeenCalledWith('parent');
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.merge.mock.invocationCallOrder[0]).toBeLessThan(mocks.create.mock.invocationCallOrder[0]);
    await vi.waitFor(() => expect(mocks.tabs).toContainEqual(
      expect.objectContaining({ id: 'tab-0', state: { sessionId: 'child', deviceId: null } }),
    ));
  });

  // Unit, #9136: the host denies maker:side-chat:v1 / list:v1 to shared-task
  // guests and the UI fell back to the generic "try again" toast. Missed entry
  // gates must answer locally with the real reason and send nothing. Recovery
  // re-checks per read: a watcher can start before the guest origin resolves.
  it('answers shared-task guests locally without asking the host', async () => {
    mocks.device = sharedTaskGuestPeer('task', 'member', 'host');
    expect(await openSideChatTab('parent', { quote: 'selected answer' })).toBe(false);
    expect(mocks.info).toHaveBeenCalledExactlyOnceWith('chat.sideChat.sharedTaskUnavailable');
    await restoreSideChatTabs('parent');
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.list).not.toHaveBeenCalled();
  });

  // Unit, #9136 review: /side shows this reason. An archived main task used to
  // be told to "open from the main task"; a guest whose list snapshot lacks the
  // origin must still be recognised from the caller's resolved device.
  it.each([
    [{ status: 'active' }, undefined, null],
    [{ status: 'active' }, sharedTaskGuestPeer('task', 'member', 'host'), 'chat.sideChat.sharedTaskUnavailable'],
    [{ status: 'archived' }, null, 'chat.sideChat.archivedTask'],
    [{ status: 'active', source: 'review' }, null, 'chat.sideChat.mainTaskOnly'],
  ])('explains why %o on %s cannot open a side chat', (patch, deviceId, expected) => {
    expect(sideChatUnavailableKey({ id: 'parent', ...patch } as Session, deviceId)).toBe(expected);
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

  // Unit: restart reconciliation must distinguish a linked task omitted from the
  // recovery list from a deleted task, and must respect a deliberately closed tab.
  it('keeps an open linked tab after hydration and does not restore a closed one', async () => {
    mocks.tabs = [{ id: 'linked-tab', kind: 'side-chat', state: { sessionId: 'child' } }];
    mocks.list.mockResolvedValue([]);
    mocks.readBatch.mockResolvedValueOnce([{ sessionId: 'child', value: { status: 'active', sideChatPromoted: true } }]);
    await restoreSideChatTabs('parent');
    expect(mocks.tabs.map(tab => tab.id)).toEqual(['linked-tab']);
    mocks.tabs = [];
    await restoreSideChatTabs('parent');
    expect(mocks.tabs).toEqual([]);
    expect(mocks.activate).not.toHaveBeenCalled();
    expect(mocks.reveal).not.toHaveBeenCalled();
  });

  // Unit: the ordinary page must reopen the same hosted child on its parent,
  // even when no renderer-local tab survives from the first visit.
  it.each([null, 'execution-host'])('returns to the same parent and reuses the child on %s', async deviceId => {
    mocks.readBatch.mockResolvedValue([
      { sessionId: 'parent', value: { id: 'parent', status: 'active' } },
      { sessionId: 'child', value: { id: 'child', status: 'active', sideChatPromoted: true, parentSessionId: 'parent' } },
    ]);
    const navigate = vi.fn();
    await reopenLinkedSideChat('parent', 'child', deviceId, navigate);
    await reopenLinkedSideChat('parent', 'child', deviceId, navigate);
    expect(mocks.tabs).toEqual([{ id: 'tab-0', kind: 'side-chat', state: { sessionId: 'child', deviceId } }]);
    expect(mocks.activate).toHaveBeenCalledWith('parent', 'tab-0');
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.readBatch).toHaveBeenCalledWith(['parent', 'child'], deviceId ?? undefined);
    expect(mocks.reveal).toHaveBeenCalledWith('open', { sessionId: 'parent', userInitiated: false });
    expect(navigate).toHaveBeenLastCalledWith(deviceId ? '/cc-agent/parent?device=execution-host' : '/cc-agent/parent');
  });

  it('does not recreate a tag for the archived task', async () => {
    mocks.readBatch.mockResolvedValue([
      { value: { id: 'parent', status: 'active' } },
      { value: { id: 'child', status: 'archived', sideChatPromoted: true, parentSessionId: 'parent' } },
    ]);
    const navigate = vi.fn();
    await expect(reopenLinkedSideChat('parent', 'child', null, navigate)).rejects.toThrow('no longer active');
    expect(mocks.add).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
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

  // Renderer tier: the archived Lead is missing from the ordinary side-chat list.
  // A previously saved tab is still available when it missed the archive push.
  it.each([null, 'execution-host'])('keeps a saved tab for an archived Lead on reload (%s)', async deviceId => {
    mocks.device = deviceId;
    mocks.tabs = [{ id: 'saved', kind: 'side-chat', state: { sessionId: 'child', deviceId } }];
    mocks.list.mockResolvedValue([]);
    mocks.readBatch.mockResolvedValue([{
      sessionId: 'child',
      value: { id: 'child', status: 'archived', sideChatPromoted: true, orcaRole: 'lead' },
    }]);
    await restoreSideChatTabs('parent');
    expect(mocks.readBatch).toHaveBeenCalledWith(['child'], deviceId ?? undefined);
    expect(mocks.tabs.map(tab => tab.id)).toEqual(['saved']);
    expect(mocks.close).not.toHaveBeenCalled();
    expect(mocks.add).not.toHaveBeenCalled();
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

  it('does not duplicate a tab when restore runs while optimistic creation is in flight', async () => {
    let finishFork!: (child: { id: string }) => void;
    mocks.create.mockReturnValueOnce(new Promise(resolve => { finishFork = resolve; }));
    expect(await openSideChatTab('parent')).toBe(true);
    await restoreSideChatTabs('parent');
    expect(mocks.tabs).toHaveLength(1);
    finishFork({ id: 'child' });
    await vi.waitFor(() => expect(mocks.tabs).toEqual([
      { id: 'tab-0', kind: 'side-chat', state: { sessionId: 'child', deviceId: null } },
    ]));
  });

  it('cleans up an orphaned unbound side-chat tab left by a crash while keeping active pending tabs', async () => {
    mocks.tabs = [{ id: 'stale-pending', kind: 'side-chat', state: { sessionId: null, deviceId: null } }];
    mocks.list.mockResolvedValue([]);
    await restoreSideChatTabs('parent');
    expect(mocks.close).toHaveBeenCalledWith('parent', 'stale-pending', { skipBeforeClose: true });
    expect(mocks.tabs).toEqual([]);
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
    await vi.waitFor(() => expect(mocks.tabs).toContainEqual(
      expect.objectContaining({ id: 'tab-0', state: { sessionId: 'child', deviceId: null } }),
    ));
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
