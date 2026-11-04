// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { AppWindowSync } from '@/components/layout/AppWindowSync';

import type { BotGroupChangedPayload, BotGroupSummary } from '../../../../shared/botGroupChat';
import { getBotGroupListSnapshot, refreshBotGroups, resetBotGroupStoreForTests, startBotGroupSync, subscribeBotGroups, useBotGroupList } from '../botGroupStore';
import { getAllDraftAttachmentUrls, getDraft, saveDraft } from '@/lib/composerDraftStore';
import { botGroupThreadDraftKey } from '../botGroupAttachments';
import { botGroupReadKey, getBotLastReadAt, isBotGroupUnread, markBotRead, resetBotReadStateForTests, setBotReadStateOwner } from '../botReadState';

const dataOwner = vi.hoisted(() => ({ generation: 1, dataOwnerId: 'owner' }));
vi.mock('@/contexts/dataOwnerGeneration', () => ({
  getDataOwnerGeneration: () => ({ dataOwnerId: dataOwner.dataOwnerId, generation: dataOwner.generation }),
  isDataOwnerGenerationCurrent: (owner: { generation: number }) => owner.generation === dataOwner.generation,
  isDataOwnerPushCurrent: (stamp?: { ownerGeneration: number }) => !stamp || stamp.ownerGeneration === dataOwner.generation,
}));
// Keep the production window -> unread sync -> group store mount chain. The
// badge and unrelated roster sources are isolated; no manual refresh starts it.
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({}) }));
vi.mock('@/components/layout/AppBadgeAttentionSync', () => ({ AppBadgeAttentionSync: () => null }));
vi.mock('../useRemoteBots', () => ({ useRemoteBotSync: () => {} }));
vi.mock('../botGroupOutbox', () => ({ startBotGroupOutbox: () => () => {} }));
vi.mock('../botStore', () => ({ useBotProfiles: () => bots, refreshBotProfiles: () => {} }));
vi.mock('@/lib/makerChatStore', () => ({ makerChatStore: {
  subscribeAll: () => () => {}, getRunningSnapshot: () => running,
} }));
const bots: never[] = [];
const running = new Map();

const summary = (name: string): BotGroupSummary => ({
  id: 'g1', name, replyMode: 'all', speakingMode: 'auto', members: [], organizerBotId: null, projectDir: null,
  lastMessage: null, speakingBotIds: [], planningBotId: null, openPlan: null, createdAt: 1, updatedAt: 1,
});

let push: (payload: BotGroupChangedPayload, stamp?: unknown) => void = () => {};
const listBotGroups = vi.fn();
const chatDisplayCache = vi.fn();
const unsubscribePush = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  dataOwner.generation = 1;
  dataOwner.dataOwnerId = 'owner';
  window.history.replaceState(null, '', '/');
  unsubscribePush.mockClear();
  resetBotGroupStoreForTests();
  listBotGroups.mockReset().mockResolvedValue({ ok: true, groups: [summary('周末出游')] });
  chatDisplayCache.mockReset().mockResolvedValue(null);
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { maker: { listBotGroups, chatDisplayCache, onBotGroupChanged: (cb: typeof push) => { push = cb; return unsubscribePush; } } },
  });
});

afterEach(() => {
  cleanup();
  resetBotGroupStoreForTests();
  vi.useRealTimers();
});

describe('group list mirror', () => {
  // Unit / review4463310770: existing multi-window coverage seeded from main.
  // The actual secondary mount alone must establish a local group's baseline
  // at100, keep reply200 unread, and carry that mark through main's return.
  it('seeds a first-discovered local group in the only active secondary mirror', async () => {
    window.localStorage.clear(); resetBotReadStateForTests(); setBotReadStateOwner('owner');
    window.history.replaceState(null, '', '/?secondaryWindow=1');
    const first = { ...summary('Local group'), lastReplyAt: 100 };
    listBotGroups.mockResolvedValue({ ok: true, groups: [first] });
    const secondary = render(createElement(AppWindowSync));
    try {
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(getBotLastReadAt(botGroupReadKey('g1'))).toBe(100);
      expect(isBotGroupUnread(getBotGroupListSnapshot().groups[0])).toBe(false);
      const reply = { ...first, lastReplyAt: 200 };
      listBotGroups.mockResolvedValue({ ok: true, groups: [reply] });
      act(() => push({ groupId: 'g1', change: 'messages' }));
      await act(() => vi.advanceTimersByTimeAsync(300));
      expect(isBotGroupUnread(getBotGroupListSnapshot().groups[0])).toBe(true);
      secondary.unmount(); resetBotGroupStoreForTests();
      resetBotReadStateForTests(); setBotReadStateOwner('owner');
      window.history.replaceState(null, '', '/');
      render(createElement(AppWindowSync));
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(getBotLastReadAt(botGroupReadKey('g1'))).toBe(100);
      expect(isBotGroupUnread(getBotGroupListSnapshot().groups[0])).toBe(true);
    } finally { cleanup(); resetBotReadStateForTests(); window.localStorage.clear(); }
  });

  // Regression: task menu -> open in new window previously never started the
  // mirror. Existing store-only tests acquired it manually and missed the mount
  // guard. Unit tier, real hooks/store + in-memory IPC; no Electron/user data.
  it('loads and updates groups in a secondary window, then releases its subscription', async () => {
    window.history.replaceState(null, '', '/?secondaryWindow=1');
    function GroupList() {
      return useBotGroupList().groups.filter(group => !group.archived).map(group => group.name).join(',');
    }
    const view = render(createElement('div', null, createElement(AppWindowSync), createElement(GroupList)));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByText('周末出游')).toBeTruthy();
    expect(listBotGroups).toHaveBeenCalledTimes(1);
    for (const [change, groups, text] of [
      ['created', [summary('周末出游'), { ...summary('新群'), id: 'g2' }], '周末出游,新群'],
      ['updated', [summary('读书会')], '读书会'],
      ['updated', [{ ...summary('读书会'), archived: true }], ''],
    ] as const) {
      listBotGroups.mockResolvedValue({ ok: true, groups });
      act(() => push({ groupId: 'g1', change }));
      await act(() => vi.advanceTimersByTimeAsync(300));
      expect(view.container.textContent).toBe(text);
    }
    act(() => push({ groupId: 'g1', change: 'updated' }));
    view.unmount();
    expect(unsubscribePush).toHaveBeenCalledTimes(1);
    const reads = listBotGroups.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(listBotGroups).toHaveBeenCalledTimes(reads);
  });

  it('clears the secondary window on owner change and ignores old list responses and pushes', async () => {
    window.history.replaceState(null, '', '/?secondaryWindow=1');
    const view = render(createElement(AppWindowSync));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(getBotGroupListSnapshot().groups[0]?.name).toBe('周末出游');
    let finishOld!: (result: unknown) => void;
    listBotGroups.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }));
    act(() => push({ groupId: 'g1', change: 'updated' }));
    await act(() => vi.advanceTimersByTimeAsync(300));
    const oldPush = push;
    let finishNew!: (result: unknown) => void;
    listBotGroups.mockImplementationOnce(() => new Promise(resolve => { finishNew = resolve; }));
    dataOwner.generation = 2;
    dataOwner.dataOwnerId = 'other-owner';
    view.rerender(createElement(AppWindowSync));
    expect(getBotGroupListSnapshot().groups).toEqual([]);
    await act(async () => finishOld({ ok: true, groups: [summary('旧账号')] }));
    expect(getBotGroupListSnapshot().groups).toEqual([]);
    act(() => oldPush({ groupId: 'g1', change: 'updated' }, { ownerGeneration: 1 }));
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(listBotGroups).toHaveBeenCalledTimes(3);
    await act(async () => finishNew({ ok: true, groups: [summary('新账号')] }));
    expect(getBotGroupListSnapshot().groups[0]?.name).toBe('新账号');
  });

  // Unit / review4456776776: the real window mount must keep a secondary
  // pre-create response from overwriting a newer owner-scoped display cache.
  it('keeps the main group cache through a late secondary list, visibility push and failed follow-up', async () => {
    const old = summary('Old group');
    const created = { ...summary('New group'), id: 'g2' };
    let saved: readonly BotGroupSummary[] = [];
    chatDisplayCache.mockImplementation(async input => {
      if (input.action === 'write') saved = structuredClone(input.value);
      return input.action === 'read' ? structuredClone(saved) : null;
    });
    listBotGroups.mockResolvedValue({ ok: true, groups: [old] });
    const main = render(createElement(AppWindowSync));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(saved).toEqual([old]); // The main mount still owns persistence.
    main.unmount();
    resetBotGroupStoreForTests();
    window.history.replaceState(null, '', '/?secondaryWindow=1');
    let finish!: (value: unknown) => void;
    listBotGroups.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const secondary = render(createElement(AppWindowSync));
    await act(() => vi.advanceTimersByTimeAsync(0));
    // Simulate Main's post-create IPC cache write while this renderer's
    // pre-create list is pending. IPC is the only boundary substituted here.
    saved = [old, created];
    listBotGroups.mockRejectedValue(new Error('connection dropped'));
    act(() => push({ groupId: 'g2', change: 'created' }));
    await act(() => vi.advanceTimersByTimeAsync(300));
    await act(async () => finish({ ok: true, groups: [old] }));
    expect(getBotGroupListSnapshot().groups).toEqual([old]);
    expect(saved).toEqual([old, created]);
    // Main has also processed this personal visibility push first. Its cached
    // new group must survive the secondary's immediate persistList path.
    saved = [created];
    act(() => push({ groupId: 'g1', change: 'list', listState: { hidden: true, revision: 1 } }));
    expect(getBotGroupListSnapshot().groups).toEqual([]);
    expect(saved).toEqual([created]);
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(saved).toEqual([created]);
    secondary.unmount();
    resetBotGroupStoreForTests();
    window.history.replaceState(null, '', '/');
    render(createElement(AppWindowSync));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(getBotGroupListSnapshot().groups).toEqual([created]);
  });

  // Unit / review4457346603: a stale secondary list or visibility push must not
  // delete a newer group's shared read mark and silently read its next reply.
  it.each(['list', 'visibility'] as const)('preserves group read marks after a stale secondary %s', async boundary => {
    for (const key of Object.keys(window.localStorage)) {
      if (key.startsWith('cindy.bots.readState.v1.')) window.localStorage.removeItem(key);
    }
    resetBotReadStateForTests();
    setBotReadStateOwner('owner');
    markBotRead(botGroupReadKey('g1'), 50);
    const created = { ...summary('New group'), id: 'g2', lastReplyAt: 200 };
    window.history.replaceState(null, '', '/?secondaryWindow=1');
    let finish!: (value: unknown) => void;
    listBotGroups.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const secondary = render(createElement(AppWindowSync));
    try {
      await act(() => vi.advanceTimersByTimeAsync(0));
      if (boundary === 'list') markBotRead(botGroupReadKey('g2'), 100);
      await act(async () => finish({ ok: true, groups: [summary('Old group')] }));
      if (boundary === 'visibility') {
        // Main learns about the new group after this renderer's old list settled.
        markBotRead(botGroupReadKey('g2'), 100);
        act(() => push({ groupId: 'g1', change: 'list', listState: { hidden: true, revision: 1 } }));
      }
      expect(getBotLastReadAt(botGroupReadKey('g2'))).toBe(100);
      secondary.unmount();
      resetBotGroupStoreForTests();
      window.history.replaceState(null, '', '/');
      listBotGroups.mockResolvedValue({ ok: true, groups: [created] });
      render(createElement(AppWindowSync));
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(isBotGroupUnread(getBotGroupListSnapshot().groups[0])).toBe(true);
      expect(getBotLastReadAt(botGroupReadKey('g1'))).toBeNull(); // Main still prunes.
      act(() => { markBotRead(botGroupReadKey('g2'), 200); });
      expect(isBotGroupUnread(created)).toBe(false);
    } finally {
      cleanup(); resetBotReadStateForTests();
      for (const key of Object.keys(window.localStorage)) {
        if (key.startsWith('cindy.bots.readState.v1.')) window.localStorage.removeItem(key);
      }
    }
  });

  // #8084: a deletion observed while a different room is open must also release thread media.
  // Unit: real sync push entry, without mounting the deleted group's chat view.
  it.each(['deleted', 'hidden'] as const)('discards closed thread drafts on an authoritative %s push', async boundary => {
    const scope = botGroupThreadDraftKey('g1', 'closed-root');
    const url = 'cindy-media://blobs/closed-thread.png';
    saveDraft(scope, { text: null, attachments: [{ id: 'closed-photo', name: 'photo.png', ext: '.png',
      category: 'image', mimeType: 'image/png', size: 12, path: '', url }] });
    const stop = startBotGroupSync();
    await vi.advanceTimersByTimeAsync(0);
    push(boundary === 'deleted' ? { groupId: 'g1', change: 'deleted' }
      : { groupId: 'g1', change: 'list', listState: { hidden: true, revision: 1 } });
    expect(getDraft(scope)).toBeUndefined();
    expect(getAllDraftAttachmentUrls()).not.toContain(url);
    stop();
  });

  // Integration tier: disk and server can resolve in either order at cold startup.
  it('shows saved groups during a pending refresh and does not resurrect a fresh deletion', async () => {
    let finish!: (value: unknown) => void;
    listBotGroups.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    chatDisplayCache.mockResolvedValueOnce([summary('Saved group')]);
    refreshBotGroups();
    await vi.advanceTimersByTimeAsync(0);
    expect(getBotGroupListSnapshot().groups[0]?.name).toBe('Saved group');
    finish({ ok: true, groups: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(getBotGroupListSnapshot().groups).toEqual([]);
    resetBotGroupStoreForTests();
    let disk!: (value: unknown) => void;
    chatDisplayCache.mockImplementationOnce(() => new Promise(resolve => { disk = resolve; }));
    listBotGroups.mockResolvedValueOnce({ ok: true, groups: [] });
    refreshBotGroups();
    await vi.advanceTimersByTimeAsync(0);
    disk([summary('Deleted group')]);
    await vi.advanceTimersByTimeAsync(0);
    expect(getBotGroupListSnapshot().groups).toEqual([]);
  });
  // Unit regression: the public sync entry must recover a completed companion's
  // sidebar state after its final push triggers a failed read. Previously only
  // successful push bursts were covered; no later push should be required.
  it.each(['response', 'exception'])('recovers a stale running row after a failed %s without another push', async failure => {
    const running: BotGroupSummary = { ...summary('工作测试群'), speakingBotIds: ['Lucky'],
      openPlan: { id: 'plan', status: 'running', currentStep: 3, stepCount: 4, currentBotName: 'Lucky', currentStepStatus: 'running' } };
    listBotGroups.mockResolvedValueOnce({ ok: true, groups: [running] });
    const stop = startBotGroupSync();
    await vi.advanceTimersByTimeAsync(0);
    if (failure === 'response') listBotGroups.mockResolvedValueOnce({ ok: false });
    else listBotGroups.mockRejectedValueOnce(new Error('disconnected'));
    push({ groupId: 'g1', change: 'messages' });
    await vi.advanceTimersByTimeAsync(300);
    expect(getBotGroupListSnapshot().groups[0]!.speakingBotIds).toEqual(['Lucky']);
    listBotGroups.mockResolvedValue({ ok: true, groups: [{ ...running, speakingBotIds: [], openPlan: null }] });
    await vi.advanceTimersByTimeAsync(1000);
    expect(getBotGroupListSnapshot().groups[0]!.speakingBotIds).toEqual([]);
    expect(getBotGroupListSnapshot().groups[0]!.openPlan).toBeNull();
    expect(listBotGroups).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(60000);
    expect(listBotGroups).toHaveBeenCalledTimes(3);
    stop();
  });

  it('reads once per burst of pushes and keeps the snapshot when nothing changed', async () => {
    const stop = startBotGroupSync();
    await vi.runAllTimersAsync();
    expect(listBotGroups).toHaveBeenCalledTimes(1);
    const first = getBotGroupListSnapshot();
    const listener = vi.fn();
    const unsubscribe = subscribeBotGroups(listener);
    for (let index = 0; index < 5; index += 1) push({ groupId: 'g1', change: 'messages' });
    expect(listBotGroups).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(300);
    expect(listBotGroups).toHaveBeenCalledTimes(2);
    // Same list: no re-render for the sidebar or the Dock badge.
    expect(listener).not.toHaveBeenCalled();
    expect(getBotGroupListSnapshot()).toBe(first);
    listBotGroups.mockResolvedValue({ ok: true, groups: [summary('读书会')] });
    push({ groupId: 'g1', change: 'updated' });
    await vi.advanceTimersByTimeAsync(300);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getBotGroupListSnapshot().groups[0]!.name).toBe('读书会');
    unsubscribe();
    stop();
  });

  it('backs off repeated failures and resets the delay after an unchanged successful read', async () => {
    const stop = startBotGroupSync();
    await vi.advanceTimersByTimeAsync(0);
    listBotGroups.mockResolvedValue({ ok: false });
    push({ groupId: 'g1', change: 'plan' });
    await vi.advanceTimersByTimeAsync(300);
    for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
      const calls = listBotGroups.mock.calls.length;
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(listBotGroups).toHaveBeenCalledTimes(calls);
      await vi.advanceTimersByTimeAsync(1);
      expect(listBotGroups).toHaveBeenCalledTimes(calls + 1);
    }
    listBotGroups.mockResolvedValue({ ok: true, groups: [summary('周末出游')] });
    await vi.advanceTimersByTimeAsync(30000);
    const recovered = getBotGroupListSnapshot();
    listBotGroups.mockRejectedValueOnce(new Error('disconnected again'));
    refreshBotGroups();
    await vi.advanceTimersByTimeAsync(0);
    const calls = listBotGroups.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(listBotGroups).toHaveBeenCalledTimes(calls + 1);
    expect(getBotGroupListSnapshot().groups).toEqual(recovered.groups);
    stop();
  });

  it('lets a new push recover immediately and cancels the pending retry', async () => {
    listBotGroups.mockResolvedValueOnce({ ok: false });
    const stop = startBotGroupSync();
    await vi.advanceTimersByTimeAsync(0);
    push({ groupId: 'g1', change: 'messages' });
    await vi.advanceTimersByTimeAsync(300);
    expect(getBotGroupListSnapshot().groups[0]!.name).toBe('周末出游');
    await vi.advanceTimersByTimeAsync(60000);
    expect(listBotGroups).toHaveBeenCalledTimes(2);
    stop();
  });

  it('coalesces pushes during a retry and never overlaps list requests', async () => {
    let finish!: (result: unknown) => void;
    listBotGroups.mockResolvedValueOnce({ ok: false })
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const stop = startBotGroupSync();
    await vi.advanceTimersByTimeAsync(1000);
    for (let i = 0; i < 5; i++) push({ groupId: 'g1', change: 'messages' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(listBotGroups).toHaveBeenCalledTimes(2);
    finish({ ok: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(getBotGroupListSnapshot().groups[0]!.name).toBe('周末出游');
    await vi.advanceTimersByTimeAsync(60000);
    expect(listBotGroups).toHaveBeenCalledTimes(3);
    stop();
  });

  it.each(['pending retry', 'in-flight failure'])('stops retrying after the last surface unmounts (%s)', async stage => {
    let fail!: (error: Error) => void;
    if (stage === 'in-flight failure') listBotGroups.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    else listBotGroups.mockResolvedValueOnce({ ok: false });
    const stop = startBotGroupSync();
    await vi.advanceTimersByTimeAsync(0);
    stop();
    if (stage === 'in-flight failure') fail(new Error('disconnected'));
    await vi.advanceTimersByTimeAsync(60000);
    expect(listBotGroups).toHaveBeenCalledTimes(1);
    expect(getBotGroupListSnapshot().groups).toEqual([]);
  });

  it('keeps the shared retry until the last surface unmounts', async () => {
    listBotGroups.mockResolvedValue({ ok: false });
    const stopFirst = startBotGroupSync();
    await vi.advanceTimersByTimeAsync(0);
    const stopSecond = startBotGroupSync();
    await vi.advanceTimersByTimeAsync(0);
    stopFirst();
    listBotGroups.mockResolvedValue({ ok: true, groups: [summary('已恢复')] });
    await vi.advanceTimersByTimeAsync(2000);
    expect(getBotGroupListSnapshot().groups[0]!.name).toBe('已恢复');
    stopSecond();
  });

  it.each(['pending retry', 'in-flight failure'])('discards old-owner retries and late failures (%s)', async stage => {
    let fail!: (error: Error) => void;
    if (stage === 'in-flight failure') listBotGroups.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    else listBotGroups.mockResolvedValueOnce({ ok: false });
    const stop = startBotGroupSync();
    await vi.advanceTimersByTimeAsync(0);
    dataOwner.generation = 2;
    if (stage === 'in-flight failure') fail(new Error('old owner disconnected'));
    await vi.advanceTimersByTimeAsync(60000);
    expect(listBotGroups).toHaveBeenCalledTimes(1);
    expect(getBotGroupListSnapshot().groups).toEqual([]);
    refreshBotGroups();
    await vi.advanceTimersByTimeAsync(0);
    expect(getBotGroupListSnapshot().groups[0]!.name).toBe('周末出游');
    stop();
  });
});
