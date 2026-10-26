// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BotGroupChangedPayload, BotGroupSummary } from '../../../../shared/botGroupChat';
import { getBotGroupListSnapshot, refreshBotGroups, resetBotGroupStoreForTests, startBotGroupSync, subscribeBotGroups } from '../botGroupStore';

const dataOwner = vi.hoisted(() => ({ generation: 1 }));
vi.mock('@/contexts/dataOwnerGeneration', () => ({
  getDataOwnerGeneration: () => dataOwner.generation,
  isDataOwnerGenerationCurrent: (owner: number) => owner === dataOwner.generation,
  isDataOwnerPushCurrent: () => true,
}));

const summary = (name: string): BotGroupSummary => ({
  id: 'g1', name, replyMode: 'all', speakingMode: 'auto', members: [], organizerBotId: null, projectDir: null,
  lastMessage: null, speakingBotIds: [], planningBotId: null, openPlan: null, createdAt: 1, updatedAt: 1,
});

let push: (payload: BotGroupChangedPayload, stamp?: unknown) => void = () => {};
const listBotGroups = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  dataOwner.generation = 1;
  resetBotGroupStoreForTests();
  listBotGroups.mockReset().mockResolvedValue({ ok: true, groups: [summary('周末出游')] });
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { maker: { listBotGroups, onBotGroupChanged: (cb: typeof push) => { push = cb; return () => {}; } } },
  });
});

afterEach(() => {
  resetBotGroupStoreForTests();
  vi.useRealTimers();
});

describe('group list mirror', () => {
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
