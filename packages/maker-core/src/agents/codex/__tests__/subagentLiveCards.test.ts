import { describe, expect, it } from 'vitest';

import { createSubagentLiveCardTracker } from '../subagent-live-cards.js';
import { readCodexSubagentSpawnRegistration } from '../translator.js';

/** V2(codex 0.145):spawn 只发瞬时 subAgentActivity,带 agentThreadId。 */
function v2SpawnItem(id: string, agentThreadId: string, agentPath?: string) {
  return {
    type: 'subAgentActivity',
    id,
    kind: 'started',
    agentThreadId,
    ...(agentPath ? { agentPath } : {}),
  };
}

/** V1(老模型 / 自定义接入模型):spawn 走 collabAgentToolCall,目标在 receiverThreadIds。 */
function v1SpawnItem(id: string, receiverThreadIds: string[]) {
  return {
    type: 'collabAgentToolCall',
    id,
    tool: 'spawnAgent',
    senderThreadId: 'root-1',
    receiverThreadIds,
    prompt: 'survey the repo rules',
  };
}

function toolItem(id: string, type = 'commandExecution') {
  return { item: { id, type } };
}

describe('readCodexSubagentSpawnRegistration', () => {
  it('maps V2 subAgentActivity to its child thread', () => {
    expect(readCodexSubagentSpawnRegistration(v2SpawnItem('i-1', 't-child', '/root/scout'))).toEqual({
      taskId: 'i-1',
      childThreadIds: ['t-child'],
      agentPath: '/root/scout',
    });
  });

  it('maps V1 collab spawn to every receiver thread', () => {
    expect(readCodexSubagentSpawnRegistration(v1SpawnItem('i-2', ['t-a', 't-b']))).toEqual({
      taskId: 'i-2',
      childThreadIds: ['t-a', 't-b'],
    });
  });

  it('ignores non-spawn collab tools and non-started activity', () => {
    expect(
      readCodexSubagentSpawnRegistration({
        type: 'collabAgentToolCall',
        id: 'i-3',
        tool: 'wait',
        receiverThreadIds: ['t-a'],
      }),
    ).toBeNull();
    // interacted / interrupted 是 followup·中断的伴生事件,不是新子代理启动。
    expect(
      readCodexSubagentSpawnRegistration({ ...v2SpawnItem('i-4', 't-c'), kind: 'interacted' }),
    ).toBeNull();
    expect(readCodexSubagentSpawnRegistration({ type: 'commandExecution', id: 'i-5' })).toBeNull();
    expect(readCodexSubagentSpawnRegistration(null)).toBeNull();
  });

  it('ignores spawn items without any resolvable child thread', () => {
    // 拿不到子线程 id 就无法把实时事件归到卡上,不能瞎登记。
    expect(readCodexSubagentSpawnRegistration({ type: 'subAgentActivity', id: 'i-6', kind: 'started' })).toBeNull();
    expect(readCodexSubagentSpawnRegistration({ ...v1SpawnItem('i-7', []) })).toBeNull();
  });
});

describe('createSubagentLiveCardTracker', () => {
  it('aggregates tokens / tool uses / duration onto the spawn card taskId', () => {
    let clock = 1_000;
    const tracker = createSubagentLiveCardTracker({ now: () => clock });
    tracker.noteSpawnItem(v2SpawnItem('card-1', 't-child', '/root/scout'));

    clock = 3_500;
    const afterTool = tracker.handleDescendantNotification('t-child', 'item/started', toolItem('x-1'));
    expect(afterTool).toEqual({
      taskId: 'card-1',
      status: 'running',
      agentPath: '/root/scout',
      totalTokens: 0,
      toolUses: 1,
      durationMs: 2_500,
    });

    const afterUsage = tracker.handleDescendantNotification('t-child', 'thread/tokenUsage/updated', {
      tokenUsage: { total: { totalTokens: 12_345 } },
    });
    expect(afterUsage?.totalTokens).toBe(12_345);
    expect(afterUsage?.toolUses).toBe(1);
  });

  it('counts a tool item once even when both phases arrive', () => {
    const tracker = createSubagentLiveCardTracker({ now: () => 0 });
    tracker.noteSpawnItem(v2SpawnItem('card-1', 't-child'));
    expect(tracker.handleDescendantNotification('t-child', 'item/started', toolItem('x-1'))?.toolUses).toBe(1);
    // 同 id 的 completed 不再计数(重复计数会让工具数虚高一倍)。
    expect(tracker.handleDescendantNotification('t-child', 'item/completed', toolItem('x-1'))).toBeNull();
    // 只发 completed 的 item(如 imageView)仍要计入。
    expect(
      tracker.handleDescendantNotification('t-child', 'item/completed', toolItem('x-2', 'imageView'))?.toolUses,
    ).toBe(2);
  });

  it('does not count non-tool items as tool uses', () => {
    const tracker = createSubagentLiveCardTracker({ now: () => 0 });
    tracker.noteSpawnItem(v2SpawnItem('card-1', 't-child'));
    for (const type of ['agentMessage', 'reasoning', 'plan', 'userMessage', 'subAgentActivity']) {
      expect(tracker.handleDescendantNotification('t-child', 'item/started', toolItem(`x-${type}`, type))).toBeNull();
    }
  });

  it('maps turn status onto the card status', () => {
    const tracker = createSubagentLiveCardTracker({ now: () => 0 });
    tracker.noteSpawnItem(v2SpawnItem('card-1', 't-child'));

    expect(
      tracker.handleDescendantNotification('t-child', 'turn/completed', { turn: { status: 'completed' } })?.status,
    ).toBe('completed');
    expect(
      tracker.handleDescendantNotification('t-child', 'turn/completed', { turn: { status: 'failed' } })?.status,
    ).toBe('failed');
    expect(
      tracker.handleDescendantNotification('t-child', 'turn/completed', { turn: { status: 'interrupted' } })?.status,
    ).toBe('stopped');
    // followup 让同一子代理重新开跑 → 卡片回到 running。
    expect(tracker.handleDescendantNotification('t-child', 'turn/started', { turn: { id: 'tr-2' } })?.status)
      .toBe('running');
  });

  it('tracks V1 spawns that fan out to several child threads', () => {
    const tracker = createSubagentLiveCardTracker({ now: () => 0 });
    tracker.noteSpawnItem(v1SpawnItem('card-v1', ['t-a', 't-b']));
    expect(tracker.handleDescendantNotification('t-a', 'item/started', toolItem('x-1'))?.taskId).toBe('card-v1');
    expect(tracker.handleDescendantNotification('t-b', 'item/started', toolItem('x-2'))?.taskId).toBe('card-v1');
  });

  it('ignores unknown threads, unknown methods and malformed payloads', () => {
    const tracker = createSubagentLiveCardTracker({ now: () => 0 });
    tracker.noteSpawnItem(v2SpawnItem('card-1', 't-child'));
    expect(tracker.handleDescendantNotification('t-other', 'item/started', toolItem('x-1'))).toBeNull();
    expect(tracker.handleDescendantNotification('t-child', 'thread/status/changed', {})).toBeNull();
    expect(tracker.handleDescendantNotification('t-child', 'thread/tokenUsage/updated', {})).toBeNull();
    expect(
      tracker.handleDescendantNotification('t-child', 'thread/tokenUsage/updated', {
        tokenUsage: { total: { totalTokens: Number.NaN } },
      }),
    ).toBeNull();
    expect(tracker.handleDescendantNotification('t-child', 'item/started', { item: { type: 'commandExecution' } }))
      .toBeNull();
  });

  it('keeps counters across both spawn phases but rebinds on re-spawn', () => {
    const tracker = createSubagentLiveCardTracker({ now: () => 0 });
    tracker.noteSpawnItem(v2SpawnItem('card-1', 't-child'));
    tracker.handleDescendantNotification('t-child', 'item/started', toolItem('x-1'));
    // 同一 spawn 的 completed phase 再次登记不得清零计数。
    tracker.noteSpawnItem(v2SpawnItem('card-1', 't-child'));
    expect(tracker.handleDescendantNotification('t-child', 'item/started', toolItem('x-2'))?.toolUses).toBe(2);

    // 换成新卡(resume/再 spawn 同线程)则重新起算,避免把上一张卡的用量算进新卡。
    tracker.noteSpawnItem(v2SpawnItem('card-2', 't-child'));
    const rebound = tracker.handleDescendantNotification('t-child', 'item/started', toolItem('x-3'));
    expect(rebound?.taskId).toBe('card-2');
    expect(rebound?.toolUses).toBe(1);
  });

  it('bounds tracked threads, evicting settled cards first', () => {
    const tracker = createSubagentLiveCardTracker({ now: () => 0, maxTrackedThreads: 2 });
    tracker.noteSpawnItem(v2SpawnItem('card-1', 't-done'));
    tracker.handleDescendantNotification('t-done', 'turn/completed', { turn: { status: 'completed' } });
    tracker.noteSpawnItem(v2SpawnItem('card-2', 't-live'));
    tracker.noteSpawnItem(v2SpawnItem('card-3', 't-new'));

    expect(tracker.size).toBe(2);
    // 已收口的先被淘汰,仍在跑的子代理卡不掉线。
    expect(tracker.handleDescendantNotification('t-done', 'item/started', toolItem('x-1'))).toBeNull();
    expect(tracker.handleDescendantNotification('t-live', 'item/started', toolItem('x-2'))?.taskId).toBe('card-2');
    expect(tracker.handleDescendantNotification('t-new', 'item/started', toolItem('x-3'))?.taskId).toBe('card-3');
  });

  it('clear() drops all tracking (session close)', () => {
    const tracker = createSubagentLiveCardTracker({ now: () => 0 });
    tracker.noteSpawnItem(v2SpawnItem('card-1', 't-child'));
    tracker.clear();
    expect(tracker.size).toBe(0);
    expect(tracker.handleDescendantNotification('t-child', 'item/started', toolItem('x-1'))).toBeNull();
  });
});
