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

  it('aggregates every receiver of one V1 spawn into a single shared card', () => {
    // 同一次 spawnAgent 扇出多个 receiverThreadIds,但它们共用一张卡:计数必须挂在
    // taskId 上按线程分量累计,否则后到的快照会把先到的覆盖成更小值(用量回退)。
    const tracker = createSubagentLiveCardTracker({ now: () => 0 });
    tracker.noteSpawnItem(v1SpawnItem('card-v1', ['t-a', 't-b']));

    expect(tracker.handleDescendantNotification('t-a', 'item/started', toolItem('x-1'))).toMatchObject({
      taskId: 'card-v1',
      toolUses: 1,
    });
    // 第二个 receiver 的工具调用是累加,不是覆盖。
    expect(tracker.handleDescendantNotification('t-b', 'item/started', toolItem('x-2'))).toMatchObject({
      taskId: 'card-v1',
      toolUses: 2,
    });

    // token 是各线程累计快照之和;同线程再报只覆盖自己那份,不重复相加。
    expect(
      tracker.handleDescendantNotification('t-a', 'thread/tokenUsage/updated', {
        tokenUsage: { total: { totalTokens: 100 } },
      })?.totalTokens,
    ).toBe(100);
    expect(
      tracker.handleDescendantNotification('t-b', 'thread/tokenUsage/updated', {
        tokenUsage: { total: { totalTokens: 40 } },
      })?.totalTokens,
    ).toBe(140);
    expect(
      tracker.handleDescendantNotification('t-a', 'thread/tokenUsage/updated', {
        tokenUsage: { total: { totalTokens: 130 } },
      })?.totalTokens,
    ).toBe(170);
  });

  it('keeps a multi-receiver card running until every receiver is terminal', () => {
    const tracker = createSubagentLiveCardTracker({ now: () => 0 });
    tracker.noteSpawnItem(v1SpawnItem('card-v1', ['t-a', 't-b']));

    // sibling 先收口不得把整张卡误报成完成。
    expect(
      tracker.handleDescendantNotification('t-a', 'turn/completed', { turn: { status: 'completed' } })?.status,
    ).toBe('running');
    expect(
      tracker.handleDescendantNotification('t-b', 'turn/completed', { turn: { status: 'completed' } })?.status,
    ).toBe('completed');
  });

  it('reports the worst terminal outcome across receivers, regardless of arrival order', () => {
    const tracker = createSubagentLiveCardTracker({ now: () => 0 });
    tracker.noteSpawnItem(v1SpawnItem('card-v1', ['t-a', 't-b', 't-c']));
    tracker.handleDescendantNotification('t-c', 'turn/completed', { turn: { status: 'interrupted' } });
    tracker.handleDescendantNotification('t-a', 'turn/completed', { turn: { status: 'completed' } });
    // failed 最后到也必须胜出(stopped / completed 不得掩盖失败)。
    expect(
      tracker.handleDescendantNotification('t-b', 'turn/completed', { turn: { status: 'failed' } })?.status,
    ).toBe('failed');
  });

  it('replays child notifications that arrived before the spawn item was registered', () => {
    // 乱序:子线程 thread/started 已建立 lineage,但父线程的 spawn item 还没被处理。
    // 这些通知此前会被直接丢弃 —— 首个工具调用 / 初始 token / 甚至终态永久缺失。
    const tracker = createSubagentLiveCardTracker({ now: () => 0 });

    expect(tracker.handleDescendantNotification('t-child', 'item/started', toolItem('x-1'))).toBeNull();
    expect(
      tracker.handleDescendantNotification('t-child', 'thread/tokenUsage/updated', {
        tokenUsage: { total: { totalTokens: 500 } },
      }),
    ).toBeNull();

    const replayed = tracker.noteSpawnItem(v2SpawnItem('card-1', 't-child', '/root/scout'));
    expect(replayed).toMatchObject({
      taskId: 'card-1',
      agentPath: '/root/scout',
      status: 'running',
      toolUses: 1,
      totalTokens: 500,
    });
    // 重放后继续增量,不重复计数。
    expect(tracker.handleDescendantNotification('t-child', 'item/completed', toolItem('x-1'))).toBeNull();
    expect(tracker.handleDescendantNotification('t-child', 'item/started', toolItem('x-2'))?.toolUses).toBe(2);
  });

  it('replays an early terminal notification instead of leaving the card stuck running', () => {
    const tracker = createSubagentLiveCardTracker({ now: () => 0 });
    tracker.handleDescendantNotification('t-child', 'turn/completed', { turn: { status: 'failed' } });
    expect(tracker.noteSpawnItem(v2SpawnItem('card-1', 't-child'))?.status).toBe('failed');
  });

  it('re-asserts the live aggregate when the same spawn is noted again (V1 completed phase)', () => {
    // V1 的 spawn 是 collabAgentToolCall:translator 在 completed phase 会无条件推一帧
    // status=completed(spawn 工具调用自己收口,不代表子代理跑完)。noteSpawnItem 必须回传
    // 当前聚合快照,让调用方在 translator 之后把真实状态重新声明一次 —— 否则仍在跑的子线程
    // 被提前标成完成,先到的 failed/stopped 也会被抹掉。
    const tracker = createSubagentLiveCardTracker({ now: () => 0 });
    tracker.noteSpawnItem(v1SpawnItem('card-v1', ['t-a', 't-b']));
    tracker.handleDescendantNotification('t-a', 'item/started', toolItem('x-1'));
    tracker.handleDescendantNotification('t-a', 'thread/tokenUsage/updated', {
      tokenUsage: { total: { totalTokens: 700 } },
    });

    // 同一 spawn 再次登记(completed phase):计数不清零,且回传真实的 running 聚合。
    const reasserted = tracker.noteSpawnItem(v1SpawnItem('card-v1', ['t-a', 't-b']));
    expect(reasserted).toMatchObject({
      taskId: 'card-v1',
      status: 'running',
      toolUses: 1,
      totalTokens: 700,
    });

    // 已收到的失败终态同样不得被合成的 completed 抹掉。
    tracker.handleDescendantNotification('t-a', 'turn/completed', { turn: { status: 'failed' } });
    tracker.handleDescendantNotification('t-b', 'turn/completed', { turn: { status: 'completed' } });
    expect(tracker.noteSpawnItem(v1SpawnItem('card-v1', ['t-a', 't-b']))?.status).toBe('failed');
  });

  it('returns null for a fresh spawn with nothing buffered, and for non-spawn items', () => {
    const tracker = createSubagentLiveCardTracker({ now: () => 0 });
    // 全新 spawn 且无早到通知:没有需要重新声明的状态,不发多余帧。
    expect(tracker.noteSpawnItem(v2SpawnItem('card-1', 't-child'))).toBeNull();
    expect(tracker.noteSpawnItem({ type: 'commandExecution', id: 'x' })).toBeNull();
  });

  it('does not buffer notifications it would never consume', () => {
    // 缓冲只为我们真正消费的 method 服务,别给无关线程攒垃圾。
    const tracker = createSubagentLiveCardTracker({ now: () => 0 });
    tracker.handleDescendantNotification('t-child', 'thread/status/changed', { status: 'idle' });
    expect(tracker.noteSpawnItem(v2SpawnItem('card-1', 't-child'))).toBeNull();
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
    const tracker = createSubagentLiveCardTracker({ now: () => 0, maxTrackedCards: 2 });
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

  it('folds nested subagents into the ancestor card via lineage', () => {
    // 孙线程的 spawn item 只出现在**子线程自己**的事件流里,主线程的 itemStarted 看不到,
    // 所以 noteSpawnItem 不可能登记它。必须靠血缘并入父线程所属的卡,否则孙线程的工具调用
    // 与 token 全部落进 pending 且再无登记路径可重放。
    const tracker = createSubagentLiveCardTracker({ now: () => 0 });
    tracker.noteSpawnItem(v2SpawnItem('card-1', 't-child', '/root/scout'));

    // 子 → 孙
    expect(tracker.noteDescendantThread('t-grand', 't-child')).toBeNull();
    expect(tracker.handleDescendantNotification('t-grand', 'item/started', toolItem('g-1'))).toMatchObject({
      taskId: 'card-1',
      toolUses: 1,
    });
    // 孙 → 曾孙:任意深度都归到同一张根卡。
    tracker.noteDescendantThread('t-great', 't-grand');
    expect(tracker.handleDescendantNotification('t-great', 'item/started', toolItem('gg-1'))?.toolUses).toBe(2);

    // token 按线程分量求和(子 + 孙各自的累计快照)。
    tracker.handleDescendantNotification('t-child', 'thread/tokenUsage/updated', {
      tokenUsage: { total: { totalTokens: 100 } },
    });
    expect(
      tracker.handleDescendantNotification('t-grand', 'thread/tokenUsage/updated', {
        tokenUsage: { total: { totalTokens: 30 } },
      })?.totalTokens,
    ).toBe(130);

    // 只有全部代际终态后卡片才收口。
    tracker.handleDescendantNotification('t-child', 'turn/completed', { turn: { status: 'completed' } });
    tracker.handleDescendantNotification('t-grand', 'turn/completed', { turn: { status: 'completed' } });
    expect(
      tracker.handleDescendantNotification('t-great', 'turn/completed', { turn: { status: 'failed' } })?.status,
    ).toBe('failed');
  });

  it('replays a nested thread\'s notifications buffered before its lineage was known', () => {
    const tracker = createSubagentLiveCardTracker({ now: () => 0 });
    tracker.noteSpawnItem(v2SpawnItem('card-1', 't-child'));

    // 孙线程通知先到(血缘还没建立)→ 缓冲,不产帧。
    expect(tracker.handleDescendantNotification('t-grand', 'item/started', toolItem('g-1'))).toBeNull();
    expect(
      tracker.handleDescendantNotification('t-grand', 'turn/completed', { turn: { status: 'failed' } }),
    ).toBeNull();

    // 血缘建立时重放:工具数与终态都补回来(否则卡片会永久停在 running)。
    const replayed = tracker.noteDescendantThread('t-grand', 't-child');
    expect(replayed).toMatchObject({ taskId: 'card-1', toolUses: 1 });
    // 子线程仍在跑 → 整卡仍 running;孙的 failed 已记在它自己那份状态里。
    expect(replayed?.status).toBe('running');
    expect(
      tracker.handleDescendantNotification('t-child', 'turn/completed', { turn: { status: 'completed' } })?.status,
    ).toBe('failed');
  });

  it('ignores lineage for threads unrelated to any subagent card', () => {
    const tracker = createSubagentLiveCardTracker({ now: () => 0 });
    // 父线程不属于任何卡(例如主线程的后代未经 spawn 登记)→ 无副作用。
    expect(tracker.noteDescendantThread('t-x', 't-unknown')).toBeNull();
    expect(tracker.noteDescendantThread('', 't-child')).toBeNull();
    expect(tracker.noteDescendantThread('t-same', 't-same')).toBeNull();
    expect(tracker.size).toBe(0);
  });

  it('clear() drops all tracking (session close)', () => {
    const tracker = createSubagentLiveCardTracker({ now: () => 0 });
    tracker.noteSpawnItem(v2SpawnItem('card-1', 't-child'));
    tracker.clear();
    expect(tracker.size).toBe(0);
    expect(tracker.handleDescendantNotification('t-child', 'item/started', toolItem('x-1'))).toBeNull();
  });
});
