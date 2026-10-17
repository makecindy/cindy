// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BotGroupChangedPayload, BotGroupSummary } from '../../../../shared/botGroupChat';
import { getBotGroupListSnapshot, resetBotGroupStoreForTests, startBotGroupSync, subscribeBotGroups } from '../botGroupStore';

vi.mock('@/contexts/dataOwnerGeneration', () => ({
  getDataOwnerGeneration: () => 1,
  isDataOwnerGenerationCurrent: () => true,
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
});
