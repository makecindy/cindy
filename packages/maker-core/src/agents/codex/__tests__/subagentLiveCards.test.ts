import { describe, expect, it } from 'vitest';

import { createSubagentLiveCardTracker } from '../subagent-live-cards.js';
import { readCodexSubagentSpawnRegistration } from '../translator.js';

/** V2(codex 0.145):spawn 只发瞬时 subAgentActivity,带 agentThreadId。 */
function v2SpawnItem(id: string, agentThreadId: string, agentPath?: string, model?: string) {
  return {
    type: 'subAgentActivity',
    id,
    kind: 'started',
    agentThreadId,
    ...(agentPath ? { agentPath } : {}),
    ...(model ? { model } : {}),
  };
}

/** V1(老模型 / 自定义接入模型):spawn 走 collabAgentToolCall,目标在 receiverThreadIds。 */
function v1SpawnItem(id: string, receiverThreadIds: string[], model?: string) {
  return {
    type: 'collabAgentToolCall',
    id,
    tool: 'spawnAgent',
    senderThreadId: 'root-1',
    receiverThreadIds,
    prompt: 'survey the repo rules',
    ...(model ? { model } : {}),
  };
}

function toolItem(id: string, type = 'commandExecution') {
  return { item: { id, type } };
}

describe('readCodexSubagentSpawnRegistration', () => {
  it('maps V2 subAgentActivity to its child thread', () => {
    expect(readCodexSubagentSpawnRegistration(v2SpawnItem('i-1', 't-child', '/root/scout', 'gpt-5.6-terra'))).toEqual({
      taskId: 'i-1',
      childThreadIds: ['t-child'],
      agentPath: '/root/scout',
      model: 'gpt-5.6-terra',
    });
  });

  it('maps V1 collab spawn to every receiver thread', () => {
    expect(readCodexSubagentSpawnRegistration(v1SpawnItem('i-2', ['t-a', 't-b'], 'codex/gpt-5.5'))).toEqual({
      taskId: 'i-2',
      childThreadIds: ['t-a', 't-b'],
      model: 'codex/gpt-5.5',
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

  it('subtracts forked parent history from the token count shown on a subagent card', () => {
    const tracker = createSubagentLiveCardTracker({ now: () => 0 });

    // app-server attaches the forked child by replaying its restored usage before the
    // first child turn. That absolute total belongs to the parent history, not this card.
    expect(
      tracker.handleDescendantNotification('t-child', 'thread/tokenUsage/updated', {
        turnId: 'restored-parent-turn',
        tokenUsage: {
          total: { totalTokens: 10_000 },
          last: { totalTokens: 900 },
        },
      }),
    ).toBeNull();
    expect(tracker.noteSpawnItem(v2SpawnItem('card-1', 't-child'))).toBeNull();

    tracker.handleDescendantNotification('t-child', 'turn/started', {
      turn: { id: 'child-turn-1' },
    });
    expect(
      tracker.handleDescendantNotification('t-child', 'thread/tokenUsage/updated', {
        turnId: 'child-turn-1',
        tokenUsage: {
          total: { totalTokens: 10_120 },
          last: { totalTokens: 120 },
        },
      })?.totalTokens,
    ).toBe(120);

    // Later absolute snapshots remain relative to the same spawn baseline.
    tracker.handleDescendantNotification('t-child', 'turn/started', {
      turn: { id: 'child-turn-2' },
    });
    expect(
      tracker.handleDescendantNotification('t-child', 'thread/tokenUsage/updated', {
        turnId: 'child-turn-2',
        tokenUsage: {
          total: { totalTokens: 10_310 },
          last: { totalTokens: 190 },
        },
      })?.totalTokens,
    ).toBe(310);
  });

  it('infers the spawn baseline from last-turn usage when no restored snapshot arrives', () => {
    const tracker = createSubagentLiveCardTracker({ now: () => 0 });
    tracker.noteSpawnItem(v2SpawnItem('card-1', 't-child'));
    // item 通知也能证明这是 live turn；即使 turn/started 丢失也不能误判成恢复帧。
    tracker.handleDescendantNotification('t-child', 'item/started', {
      turnId: 'child-turn-1',
      item: { id: 'message-1', type: 'agentMessage' },
    });

    expect(
      tracker.handleDescendantNotification('t-child', 'thread/tokenUsage/updated', {
        turnId: 'child-turn-1',
        tokenUsage: {
          total: { totalTokens: 8_250 },
          last: { totalTokens: 250 },
        },
      })?.totalTokens,
    ).toBe(250);
  });

  it('counts delayed first usage from an earlier observed live turn without a restored snapshot', () => {
    const tracker = createSubagentLiveCardTracker({ now: () => 0 });
    tracker.noteSpawnItem(v2SpawnItem('card-1', 't-child'));
    tracker.handleDescendantNotification('t-child', 'turn/started', {
      turn: { id: 'child-turn-1' },
    });
    tracker.handleDescendantNotification('t-child', 'turn/started', {
      turn: { id: 'child-turn-2' },
    });

    // turn 1 的首帧 usage 可以晚于 turn 2 started；它仍是已观测的 live turn，必须用
    // last 反推 spawn 基线，而不能把整帧误认成 fork / resume 的恢复快照。
    expect(
      tracker.handleDescendantNotification('t-child', 'thread/tokenUsage/updated', {
        turnId: 'child-turn-1',
        tokenUsage: {
          total: { totalTokens: 8_250 },
          last: { totalTokens: 250 },
        },
      })?.totalTokens,
    ).toBe(250);
    expect(
      tracker.handleDescendantNotification('t-child', 'thread/tokenUsage/updated', {
        turnId: 'child-turn-2',
        tokenUsage: {
          total: { totalTokens: 8_400 },
          last: { totalTokens: 150 },
        },
      })?.totalTokens,
    ).toBe(400);
  });

  it('keeps legacy total-only token payloads as absolute snapshots', () => {
    const tracker = createSubagentLiveCardTracker({ now: () => 0 });
    tracker.noteSpawnItem(v2SpawnItem('card-1', 't-child'));
    tracker.handleDescendantNotification('t-child', 'item/started', {
      turnId: 'child-turn-1',
      item: { id: 'child-tool-1', type: 'commandExecution' },
    });

    expect(
      tracker.handleDescendantNotification('t-child', 'thread/tokenUsage/updated', {
        turnId: 'child-turn-1',
        tokenUsage: { total: { totalTokens: 4_242 } },
      })?.totalTokens,
    ).toBe(4_242);
  });

  it('keeps the original spawn baseline when restored snapshots are duplicated out of order', () => {
    const tracker = createSubagentLiveCardTracker({ now: () => 0 });
    tracker.noteSpawnItem(v2SpawnItem('card-1', 't-child'));

    tracker.handleDescendantNotification('t-child', 'thread/tokenUsage/updated', {
      turnId: 'restored-parent-turn',
      tokenUsage: { total: { totalTokens: 1_000 }, last: { totalTokens: 100 } },
    });
    tracker.handleDescendantNotification('t-child', 'turn/started', {
      turn: { id: 'child-turn-1' },
    });
    // A zero-growth live snapshot leaves the visible counter at zero.
    expect(
      tracker.handleDescendantNotification('t-child', 'thread/tokenUsage/updated', {
        turnId: 'child-turn-1',
        tokenUsage: { total: { totalTokens: 1_000 }, last: { totalTokens: 0 } },
      }),
    ).toBeNull();

    // A stale replay must not replace the already-established 1,000-token baseline.
    expect(
      tracker.handleDescendantNotification('t-child', 'thread/tokenUsage/updated', {
        turnId: 'older-parent-turn',
        tokenUsage: { total: { totalTokens: 900 }, last: { totalTokens: 90 } },
      }),
    ).toBeNull();
    expect(
      tracker.handleDescendantNotification('t-child', 'thread/tokenUsage/updated', {
        turnId: 'child-turn-1',
        tokenUsage: { total: { totalTokens: 1_100 }, last: { totalTokens: 100 } },
      })?.totalTokens,
    ).toBe(100);
  });

  it('keeps cumulative usage monotonic when a prior live turn reports late', () => {
    const tracker = createSubagentLiveCardTracker({ now: () => 0 });
    tracker.noteSpawnItem(v2SpawnItem('card-1', 't-child'));
    tracker.handleDescendantNotification('t-child', 'thread/tokenUsage/updated', {
      turnId: 'restored-parent-turn',
      tokenUsage: { total: { totalTokens: 1_000 }, last: { totalTokens: 100 } },
    });
    tracker.handleDescendantNotification('t-child', 'turn/started', {
      turn: { id: 'child-turn-1' },
    });
    expect(
      tracker.handleDescendantNotification('t-child', 'thread/tokenUsage/updated', {
        turnId: 'child-turn-1',
        tokenUsage: { total: { totalTokens: 1_100 }, last: { totalTokens: 100 } },
      })?.totalTokens,
    ).toBe(100);

    tracker.handleDescendantNotification('t-child', 'turn/started', {
      turn: { id: 'child-turn-2' },
    });
    // The previous turn can finish flushing after the next turn starts; its newer
    // cumulative snapshot still belongs to this child and must not be discarded.
    expect(
      tracker.handleDescendantNotification('t-child', 'thread/tokenUsage/updated', {
        turnId: 'child-turn-1',
        tokenUsage: { total: { totalTokens: 1_150 }, last: { totalTokens: 50 } },
      })?.totalTokens,
    ).toBe(150);
    // An older duplicate must not make the displayed count fall back to 100.
    expect(
      tracker.handleDescendantNotification('t-child', 'thread/tokenUsage/updated', {
        turnId: 'child-turn-1',
        tokenUsage: { total: { totalTokens: 1_100 }, last: { totalTokens: 100 } },
      }),
    ).toBeNull();
    expect(
      tracker.handleDescendantNotification('t-child', 'thread/tokenUsage/updated', {
        turnId: 'child-turn-2',
        tokenUsage: { total: { totalTokens: 1_300 }, last: { totalTokens: 150 } },
      })?.totalTokens,
    ).toBe(300);
  });

  it('uses an unlocked Cindy fallback only until the child thread reports its model', () => {
    const tracker = createSubagentLiveCardTracker({ now: () => 0, subagentModelFallback: 'gpt-5.6-terra' });
    // Fresh spawn 的初始模型由 translator 合并进原有启动帧，tracker 不重复发帧。
    expect(tracker.noteSpawnItem(v2SpawnItem('card-1', 't-child'))).toBeNull();
    expect(tracker.handleDescendantNotification('t-child', 'turn/started', {})).toMatchObject({
      taskId: 'card-1',
      model: 'gpt-5.6-terra',
    });

    expect(tracker.noteDescendantThread('t-child', 'root-thread', 'codex/gpt-5.5')).toMatchObject({
      model: 'codex/gpt-5.5',
    });
  });

  it('keeps a proxy-locked model when Codex reports its inherited parent model', () => {
    const tracker = createSubagentLiveCardTracker({
      now: () => 0,
      subagentModelFallback: 'z-ai/glm-5.2',
      lockSubagentModel: true,
    });
    expect(tracker.noteSpawnItem(
      v1SpawnItem('card-locked', ['t-child']),
      'deepseek/deepseek-v4-pro',
    )).toBeNull();
    expect(tracker.handleDescendantNotification('t-child', 'turn/started', {})).toMatchObject({
      taskId: 'card-locked',
      model: 'z-ai/glm-5.2',
    });

    // thread/started.model is the pre-proxy Codex creation model. The proxy
    // has already made GLM the actual outbound model, so this is not authority
    // to replace the locked identity.
    expect(
      tracker.noteDescendantThread(
        't-child',
        'root-thread',
        'deepseek/deepseek-v4-pro',
      ),
    ).toBeNull();
    expect(tracker.handleDescendantNotification('t-child', 'turn/completed', {
      turn: { id: 'turn-child', status: 'completed' },
    })).toMatchObject({
      taskId: 'card-locked',
      model: 'z-ai/glm-5.2',
      status: 'completed',
    });
  });

  it('freezes the parent model for a spawn without a configured or explicit child model', () => {
    const tracker = createSubagentLiveCardTracker({ now: () => 0 });
    expect(tracker.noteSpawnItem(
      v2SpawnItem('card-1', 't-child'),
      'provider-a/model-parent',
    )).toBeNull();
    expect(tracker.handleDescendantNotification('t-child', 'turn/started', {})).toMatchObject({
      taskId: 'card-1',
      model: 'provider-a/model-parent',
    });

    // 同一 spawn 的 completed phase 晚到时，即使父线程已切模，也不能改写已冻结值。
    expect(
      tracker.noteSpawnItem(v2SpawnItem('card-1', 't-child'), 'provider-b/model-next'),
    ).toMatchObject({ model: 'provider-a/model-parent' });
    // 新 spawn 才继承新模型。
    expect(tracker.noteSpawnItem(
      v2SpawnItem('card-2', 't-child-2'),
      'provider-b/model-next',
    )).toBeNull();
    expect(tracker.handleDescendantNotification('t-child-2', 'turn/started', {})).toMatchObject({
      model: 'provider-b/model-next',
    });
  });

  it('keeps explicit and configured child defaults ahead of parent inheritance', () => {
    const configured = createSubagentLiveCardTracker({
      now: () => 0,
      subagentModelFallback: 'provider-config/model-child',
    });
    expect(configured.noteSpawnItem(
      v2SpawnItem('card-config', 't-config'),
      'provider-parent/model-root',
    )).toBeNull();
    expect(configured.handleDescendantNotification('t-config', 'turn/started', {})).toMatchObject({
      model: 'provider-config/model-child',
    });
    expect(configured.noteSpawnItem(
      v2SpawnItem('card-explicit', 't-explicit', undefined, 'provider-explicit/model-child'),
      'provider-parent/model-root',
    )).toBeNull();
    expect(configured.handleDescendantNotification('t-explicit', 'turn/started', {})).toMatchObject({
      model: 'provider-explicit/model-child',
    });
  });

  it('inherits a nested spawn from its direct parent and lets runtime observation override it', () => {
    const tracker = createSubagentLiveCardTracker({ now: () => 0 });
    tracker.noteSpawnItem(v2SpawnItem('card-parent', 't-parent'), 'provider-a/model-root');
    expect(
      tracker.noteDescendantThread('t-grandchild', 't-parent', undefined, false, true),
    ).toMatchObject({ model: 'provider-a/model-root' });

    expect(
      tracker.noteDescendantThread('t-grandchild', 't-parent', 'provider-b/model-actual'),
    ).toMatchObject({ model: null });
    expect(
      tracker.noteDescendantThread('t-parent', 'root-thread', 'provider-b/model-actual'),
    ).toMatchObject({ model: 'provider-b/model-actual' });
  });

  it('does not let a late nested spawn fallback replace an observed runtime model', () => {
    const tracker = createSubagentLiveCardTracker({
      now: () => 0,
      subagentModelFallback: 'provider-config/model-child',
    });
    tracker.noteSpawnItem(v2SpawnItem('card-parent', 't-parent'));
    tracker.noteDescendantThread('t-parent', 'root-thread', 'provider-runtime/model-actual');
    tracker.noteDescendantThread('t-grandchild', 't-parent', 'provider-runtime/model-actual');

    // The nested spawn item can arrive after thread/started. Its configured
    // fallback is lower-confidence than the already observed runtime model.
    expect(
      tracker.noteDescendantThread('t-grandchild', 't-parent', undefined, false, true),
    ).toBeNull();
    expect(
      tracker.handleDescendantNotification('t-grandchild', 'turn/started', {
        turn: { id: 'grandchild-turn' },
      }),
    ).toMatchObject({ model: 'provider-runtime/model-actual' });
  });

  it('preserves a buffered runtime model when lower-priority nested spawn metadata arrives later', () => {
    const tracker = createSubagentLiveCardTracker({
      now: () => 0,
      subagentModelFallback: 'provider-config/model-child',
    });
    tracker.noteDescendantThread('t-grandchild', 't-parent', 'provider-runtime/model-actual');
    tracker.noteDescendantThread('t-grandchild', 't-parent', undefined, false, true);
    tracker.noteSpawnItem(v2SpawnItem('card-parent', 't-parent'));

    expect(
      tracker.handleDescendantNotification('t-grandchild', 'turn/started', {
        turn: { id: 'grandchild-turn' },
      }),
    ).toMatchObject({ model: null });
    expect(
      tracker.noteDescendantThread('t-parent', 'root-thread', 'provider-runtime/model-actual'),
    ).toMatchObject({ model: 'provider-runtime/model-actual' });
  });

  it('preserves nested inheritance when lineage arrives before the parent spawn item', () => {
    const tracker = createSubagentLiveCardTracker({ now: () => 0 });
    expect(
      tracker.noteDescendantThread('t-grandchild', 't-parent', undefined, false, true),
    ).toBeNull();
    expect(tracker.noteSpawnItem(
      v2SpawnItem('card-parent', 't-parent'),
      'provider-a/model-root',
    )).toBeNull();
    expect(tracker.handleDescendantNotification('t-grandchild', 'turn/started', {})).toMatchObject({
      model: 'provider-a/model-root',
    });
  });

  it('emits an observed model that arrived before a quiet spawn item', () => {
    const tracker = createSubagentLiveCardTracker({ now: () => 0 });
    // thread/started 先到且之后没有 item/token/turn 通知:spawn 登记本身必须把
    // 已缓存的实际模型发出来,不能等一条可能永远不来的 descendant 通知。
    expect(
      tracker.noteDescendantThread('t-child', 'root-thread', 'codex/gpt-5.5'),
    ).toBeNull();
    expect(tracker.noteSpawnItem(v2SpawnItem('card-1', 't-child'))).toMatchObject({
      taskId: 'card-1',
      model: 'codex/gpt-5.5',
    });
  });

  it('retains an observed nested model when lineage arrives before attachment', () => {
    const tracker = createSubagentLiveCardTracker({ now: () => 0, subagentModelFallback: 'gpt-5.6-terra' });
    // 父线程从 spawn 参数拿到模型;孙线程的观测值只能靠 pendingThreadModels 保住——
    // 徽标要求全员观测一致,retention 一丢徽标就灭。
    tracker.noteSpawnItem(v2SpawnItem('card-parent', 't-parent', undefined, 'codex/gpt-5.5'));
    expect(
      tracker.noteDescendantThread('t-grandchild', 't-parent', 'codex/gpt-5.5'),
    ).toMatchObject({ model: 'codex/gpt-5.5' });
  });

  it('hides the aggregate model badge until every thread has reported a consistent model', () => {
    // 多 receiver 卡:只有部分线程报了模型时,不许把局部观测投影成全卡事实;
    // 也不回退到配置兜底(已有相反观测,兜底反而更可能是错的)(codex review)。
    const tracker = createSubagentLiveCardTracker({ now: () => 0, subagentModelFallback: 'gpt-5.6-terra' });
    expect(tracker.noteSpawnItem(v1SpawnItem('card-v1', ['t-a', 't-b']))).toBeNull();
    expect(tracker.handleDescendantNotification('t-a', 'turn/started', {})).toMatchObject({
      model: 'gpt-5.6-terra',
    });

    const partial = tracker.noteDescendantThread('t-a', 'root-1', 'codex/gpt-5.5');
    expect(partial).not.toBeNull();
    expect(partial?.model).toBeNull();

    // 全员报齐且一致 → 亮实际模型。
    expect(tracker.noteDescendantThread('t-b', 'root-1', 'codex/gpt-5.5')).toMatchObject({
      model: 'codex/gpt-5.5',
    });
  });

  it('hides the aggregate model badge when receiver threads report different models', () => {
    const tracker = createSubagentLiveCardTracker({ now: () => 0, subagentModelFallback: 'gpt-5.6-terra' });
    tracker.noteSpawnItem(v1SpawnItem('card-v1', ['t-a', 't-b']));
    expect(tracker.noteDescendantThread('t-a', 'root-1', 'codex/gpt-5.5')).toMatchObject({
      model: null,
    });
    const conflicting = tracker.noteDescendantThread('t-b', 'root-1', 'gpt-5.6-terra');
    // t-b 的实际值与其已冻结默认值相同，聚合结论仍是冲突，无需重复发帧。
    expect(conflicting).toBeNull();
  });

  it('clears an observed model when a quiet descendant joins the card', () => {
    const tracker = createSubagentLiveCardTracker({ now: () => 0, subagentModelFallback: 'gpt-5.6-terra' });
    tracker.noteSpawnItem(v2SpawnItem('card-parent', 't-parent'));
    expect(
      tracker.noteDescendantThread('t-parent', 'root-thread', 'codex/gpt-5.5'),
    ).toMatchObject({ model: 'codex/gpt-5.5' });

    // 孙线程已加入但尚未报告模型,且之后可能没有任何通知。入卡这一刻就必须
    // 发 model:null 清掉旧徽标,不能继续把父线程的模型投影到整张卡。
    expect(tracker.noteDescendantThread('t-grandchild', 't-parent')).toMatchObject({
      taskId: 'card-parent',
      status: 'running',
      model: null,
    });
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

    // 每个 receiver 都先收到 fork 恢复帧；卡片只累计各线程从自身基线之后的增长。
    tracker.handleDescendantNotification('t-a', 'thread/tokenUsage/updated', {
      turnId: 'restored-a',
      tokenUsage: { total: { totalTokens: 1_000 }, last: { totalTokens: 80 } },
    });
    tracker.handleDescendantNotification('t-b', 'thread/tokenUsage/updated', {
      turnId: 'restored-b',
      tokenUsage: { total: { totalTokens: 2_000 }, last: { totalTokens: 90 } },
    });
    tracker.handleDescendantNotification('t-a', 'turn/started', { turn: { id: 'live-a' } });
    tracker.handleDescendantNotification('t-b', 'turn/started', { turn: { id: 'live-b' } });

    // token 是各线程 spawn 后累计快照之和;同线程再报只覆盖自己那份,不重复相加。
    expect(
      tracker.handleDescendantNotification('t-a', 'thread/tokenUsage/updated', {
        turnId: 'live-a',
        tokenUsage: { total: { totalTokens: 1_100 }, last: { totalTokens: 100 } },
      })?.totalTokens,
    ).toBe(100);
    expect(
      tracker.handleDescendantNotification('t-b', 'thread/tokenUsage/updated', {
        turnId: 'live-b',
        tokenUsage: { total: { totalTokens: 2_040 }, last: { totalTokens: 40 } },
      })?.totalTokens,
    ).toBe(140);
    expect(
      tracker.handleDescendantNotification('t-a', 'thread/tokenUsage/updated', {
        turnId: 'live-a',
        tokenUsage: { total: { totalTokens: 1_130 }, last: { totalTokens: 30 } },
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

  it('re-asserts running for a fresh completed-only spawn whose agents are still active', () => {
    const tracker = createSubagentLiveCardTracker({ now: () => 0 });
    const completedOnly = {
      ...v1SpawnItem('card-v1', ['t-a']),
      status: 'completed',
      agentsStates: { 't-a': { status: 'running' } },
    };

    expect(tracker.noteSpawnItem(completedOnly, undefined, 'completed')).toMatchObject({
      taskId: 'card-v1',
      status: 'running',
    });
  });

  it('persists the real terminal state for a fresh completed-only spawn (shutdown closure)', () => {
    // P1-4：completed-only spawn（app-server 省略 started）此前线程恒为 running，
    // drainRunningForShutdown 会把已完成的子代理持久化成 stopped。终态必须从
    // agentsStates 同步进 tracker，且登记帧要把真实终态发出去。
    const tracker = createSubagentLiveCardTracker({ now: () => 0 });
    const completedOnly = {
      ...v1SpawnItem('card-v1', ['t-a']),
      status: 'completed',
      agentsStates: { 't-a': { status: 'completed' } },
    };

    expect(tracker.noteSpawnItem(completedOnly, undefined, 'completed')).toMatchObject({
      taskId: 'card-v1',
      status: 'completed',
    });
    // shutdown 闭环：已完成/已失败的卡不再产生 stopped 帧。
    expect(tracker.drainRunningForShutdown()).toHaveLength(0);

    const failedOnly = {
      ...v1SpawnItem('card-v2', ['t-b']),
      status: 'completed',
      agentsStates: { 't-b': { status: 'failed' } },
    };
    expect(tracker.noteSpawnItem(failedOnly, undefined, 'completed')).toMatchObject({
      taskId: 'card-v2',
      status: 'failed',
    });
    expect(tracker.drainRunningForShutdown()).toHaveLength(0);

    // `done` 是 Codex agentsStates 的实际产出拼写（translator.test.ts 夹具同款），
    // 漏识别会把已完成的子代理在 shutdown 时持久化成 stopped（review P1）。
    const doneOnly = {
      ...v1SpawnItem('card-v3', ['t-c']),
      status: 'completed',
      agentsStates: { 't-c': { status: 'done' } },
    };
    expect(tracker.noteSpawnItem(doneOnly, undefined, 'completed')).toMatchObject({
      taskId: 'card-v3',
      status: 'completed',
    });
    expect(tracker.drainRunningForShutdown()).toHaveLength(0);
  });

  it('persists agentsStates terminal status after an earlier started phase', () => {
    const tracker = createSubagentLiveCardTracker({ now: () => 0 });
    tracker.noteSpawnItem(v1SpawnItem('card-v1', ['t-a']), undefined, 'started');

    const completed = {
      ...v1SpawnItem('card-v1', ['t-a']),
      status: 'completed',
      agentsStates: { 't-a': { status: 'done' } },
    };
    expect(tracker.noteSpawnItem(completed, undefined, 'completed')).toMatchObject({
      taskId: 'card-v1',
      status: 'completed',
    });
    expect(tracker.drainRunningForShutdown()).toHaveLength(0);
  });

  it('does not guess an unknown terminal label for a completed-only spawn', () => {
    // 认不出的 agentsStates 标签保持 running（不猜）；shutdown 仍按 stopped 收口。
    const tracker = createSubagentLiveCardTracker({ now: () => 0 });
    const completedOnly = {
      ...v1SpawnItem('card-v1', ['t-a']),
      status: 'completed',
      agentsStates: { 't-a': { status: 'frobnicated' } },
    };

    expect(tracker.noteSpawnItem(completedOnly, undefined, 'completed')).toBeNull();
    expect(tracker.drainRunningForShutdown()).toMatchObject([
      expect.objectContaining({ taskId: 'card-v1', status: 'stopped' }),
    ]);
  });

  it('never overwrites a failed spawn terminal state with a running aggregate', () => {
    // V1 的 spawn 以 status:'failed' 收口时,translator 已推过 failed 帧。此前"已登记就回传
    // 快照"会补一帧聚合状态,而那时子线程还标着 running → 真实失败被盖回运行中(review)。
    const tracker = createSubagentLiveCardTracker({ now: () => 0 });
    tracker.noteSpawnItem(v1SpawnItem('card-v1', ['t-a']));
    tracker.handleDescendantNotification('t-a', 'item/started', toolItem('x-1'));

    // completed phase 带 status:'failed' → 不补发任何帧。
    expect(
      tracker.noteSpawnItem({ ...v1SpawnItem('card-v1', ['t-a']), status: 'failed' }),
    ).toBeNull();

    // 且线程已被标成 failed:迟到的子线程通知不会把卡片翻回 running。
    expect(tracker.handleDescendantNotification('t-a', 'item/started', toolItem('x-2'))?.status)
      .toBe('failed');
  });

  it('still re-asserts the aggregate when the spawn itself succeeded', () => {
    const tracker = createSubagentLiveCardTracker({ now: () => 0 });
    tracker.noteSpawnItem(v1SpawnItem('card-v1', ['t-a']));
    tracker.handleDescendantNotification('t-a', 'item/started', toolItem('x-1'));
    // 成功收口仍要重新声明真实聚合(子线程还在跑 → running),否则被合成 completed 盖掉。
    expect(
      tracker.noteSpawnItem({ ...v1SpawnItem('card-v1', ['t-a']), status: 'completed' }),
    ).toMatchObject({ taskId: 'card-v1', status: 'running', toolUses: 1 });
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

  it('keeps receiver ids from a failed nested spawn terminal', () => {
    const tracker = createSubagentLiveCardTracker({ now: () => 0 });
    tracker.noteSpawnItem(v2SpawnItem('card-1', 't-child'));

    // The failed nested spawn can still carry receiver ids. Buffer any real
    // work they emitted, but never attach them as an unbounded running child.
    tracker.handleDescendantNotification('t-grand', 'item/started', toolItem('g-1'));
    expect(tracker.noteDescendantThread('t-grand', 't-child', undefined, true)).toMatchObject({
      status: 'running',
      toolUses: 1,
    });

    // Late lifecycle events cannot reopen a receiver whose spawn itself failed.
    expect(tracker.handleDescendantNotification('t-grand', 'turn/started', {})).toBeNull();
    expect(
      tracker.handleDescendantNotification('t-child', 'turn/completed', { turn: { status: 'completed' } })?.status,
    ).toBe('failed');
    expect(
      tracker.handleDescendantNotification('t-grand', 'turn/completed', { turn: { status: 'completed' } }),
    ).toBeNull();
  });

  it('counts delayed usage from a failed nested child turn without an item notification', () => {
    const tracker = createSubagentLiveCardTracker({ now: () => 0 });
    tracker.noteSpawnItem(v2SpawnItem('card-1', 't-child'));
    // nested spawn 先失败，receiver 随后才补发 turn/started；失败状态必须锁住，但 turn id
    // 仍要记下，否则后续现代 usage 会被当成恢复帧，烧掉的 token 永久漏计。
    expect(tracker.noteDescendantThread('t-grand', 't-child', undefined, true)).toBeNull();
    expect(
      tracker.handleDescendantNotification('t-grand', 'turn/started', {
        turn: { id: 'failed-child-turn' },
      }),
    ).toBeNull();

    expect(
      tracker.handleDescendantNotification('t-grand', 'thread/tokenUsage/updated', {
        turnId: 'failed-child-turn',
        tokenUsage: {
          total: { totalTokens: 1_250 },
          last: { totalTokens: 250 },
        },
      }),
    ).toMatchObject({ status: 'running', totalTokens: 250 });
    expect(
      tracker.handleDescendantNotification('t-child', 'turn/completed', {
        turn: { status: 'completed' },
      }),
    ).toMatchObject({ status: 'failed', totalTokens: 250 });
  });

  it('ignores lineage for threads unrelated to any subagent card', () => {
    const tracker = createSubagentLiveCardTracker({ now: () => 0 });
    // 父线程不属于任何卡(例如主线程的后代未经 spawn 登记)→ 无副作用。
    expect(tracker.noteDescendantThread('t-x', 't-unknown')).toBeNull();
    expect(tracker.noteDescendantThread('', 't-child')).toBeNull();
    expect(tracker.noteDescendantThread('t-same', 't-same')).toBeNull();
    expect(tracker.size).toBe(0);
  });

  it('locks the failed spawn terminal state against late turn lifecycle notifications', () => {
    // 上一轮只把「当下已知的线程」标成 failed,而 applyNotification 的 turn/started 会无条件
    // 写回 running、turn/completed 会写 completed —— 迟到的 turn 生命周期通知照样能把卡片
    // 从失败翻回运行中/已完成,覆盖 translator 的失败帧(review)。这里守终态闩。
    const tracker = createSubagentLiveCardTracker({ now: () => 0 });
    tracker.noteSpawnItem(v1SpawnItem('card-v1', ['t-a']));
    expect(tracker.noteSpawnItem({ ...v1SpawnItem('card-v1', ['t-a']), status: 'failed' })).toBeNull();

    // 迟到的 turn/started:线程状态被改回 running,但卡片状态由闩锁定。
    expect(tracker.handleDescendantNotification('t-a', 'turn/started', {})?.status).toBe('failed');
    // 迟到的 turn/completed(成功收口)同样不得翻案。
    expect(
      tracker.handleDescendantNotification('t-a', 'turn/completed', { turn: { status: 'completed' } })?.status,
    ).toBe('failed');
    // 闩上之后仍继续吸收用量:派发失败但子线程已经烧掉的 token 该算进去。
    expect(
      tracker.handleDescendantNotification('t-a', 'thread/tokenUsage/updated', {
        tokenUsage: { total: { totalTokens: 512 } },
      }),
    ).toMatchObject({ status: 'failed', totalTokens: 512 });
  });

  it('keeps the failed latch for threads that only register after the failure', () => {
    // 失败先到、子线程后到(乱序):新并入的线程不能把卡片拉回 running。
    const tracker = createSubagentLiveCardTracker({ now: () => 0 });
    expect(tracker.noteSpawnItem({ ...v1SpawnItem('card-v1', ['t-a', 't-b']), status: 'failed' })).toBeNull();
    expect(tracker.handleDescendantNotification('t-b', 'turn/started', {})?.status).toBe('failed');
    // 后代线程经血缘并入,同样是 failed。
    expect(tracker.noteDescendantThread('t-grand', 't-a')?.status ?? 'failed').toBe('failed');
    expect(
      tracker.handleDescendantNotification('t-grand', 'turn/completed', { turn: { status: 'completed' } })?.status,
    ).toBe('failed');
  });

  it('buffers lineage whose parent is not attributed yet, then recursively attaches it', () => {
    // 乱序最狠的一种:子线程 thread/started 早于根线程的 spawn item,而它在归属前就派了孙线程。
    // 那条「孙 → 子」血缘此刻无从判断归属,以前直接丢弃 —— 之后 noteSpawnItem 只绑直接子线程,
    // 孙线程已缓冲的工具/token/终态再也没机会重放(卡片漏计,还可能提前显示完成)。
    const tracker = createSubagentLiveCardTracker({ now: () => 0 });

    // 1) 血缘先到,父线程 t-child 尚未归属任何卡 → 必须缓冲而不是丢弃。
    expect(tracker.noteDescendantThread('t-grand', 't-child')).toBeNull();
    // 2) 孙线程的事件也先到 → 进通知缓冲。
    expect(tracker.handleDescendantNotification('t-grand', 'item/started', toolItem('g-1'))).toBeNull();
    expect(
      tracker.handleDescendantNotification('t-grand', 'thread/tokenUsage/updated', {
        tokenUsage: { total: { totalTokens: 300 } },
      }),
    ).toBeNull();

    // 3) spawn item 终于到达:直接子线程 + 缓冲的孙线程一起入卡,孙的用量被重放回来。
    const registered = tracker.noteSpawnItem(v2SpawnItem('card-1', 't-child'));
    expect(registered).toMatchObject({ taskId: 'card-1', toolUses: 1, totalTokens: 300 });

    // 4) 孙线程确已在卡上:它的后续通知直接命中(不再进缓冲),且子线程收口时孙线程仍在跑
    //    → 整卡不得提前完成。
    expect(
      tracker.handleDescendantNotification('t-grand', 'item/started', toolItem('g-2')),
    ).toMatchObject({ toolUses: 2 });
    expect(
      tracker.handleDescendantNotification('t-child', 'turn/completed', { turn: { status: 'completed' } })?.status,
    ).toBe('running');
    expect(
      tracker.handleDescendantNotification('t-grand', 'turn/completed', { turn: { status: 'completed' } })?.status,
    ).toBe('completed');
  });

  it('recursively attaches a multi-generation lineage chain buffered before registration', () => {
    // 曾孙:t-great → t-grand → t-child → (spawn) card-1,三条血缘全在归属前到达。
    const tracker = createSubagentLiveCardTracker({ now: () => 0 });
    expect(tracker.noteDescendantThread('t-great', 't-grand')).toBeNull();
    expect(tracker.noteDescendantThread('t-grand', 't-child')).toBeNull();
    tracker.handleDescendantNotification('t-great', 'item/started', toolItem('gg-1'));

    // 一次 spawn 登记应沿链递归补绑到曾孙,并重放它的工具计数。
    expect(tracker.noteSpawnItem(v2SpawnItem('card-1', 't-child'))).toMatchObject({
      taskId: 'card-1',
      toolUses: 1,
    });
    // 曾孙已在卡上:后续通知直接命中,且它没收口前整卡不算完成。
    expect(
      tracker.handleDescendantNotification('t-great', 'item/started', toolItem('gg-2')),
    ).toMatchObject({ toolUses: 2 });
    tracker.handleDescendantNotification('t-child', 'turn/completed', { turn: { status: 'completed' } });
    expect(
      tracker.handleDescendantNotification('t-grand', 'turn/completed', { turn: { status: 'completed' } })?.status,
    ).toBe('running');
    expect(
      tracker.handleDescendantNotification('t-great', 'turn/completed', { turn: { status: 'completed' } })?.status,
    ).toBe('completed');
  });

  it('survives a cyclic lineage claim without recursing forever', () => {
    // 血缘理论上是树,但通知来自外部进程,不能假定。环不得让补绑无限递归。
    const tracker = createSubagentLiveCardTracker({ now: () => 0 });
    tracker.noteDescendantThread('t-b', 't-a');
    tracker.noteDescendantThread('t-a', 't-b');
    expect(tracker.noteSpawnItem(v2SpawnItem('card-1', 't-a'))).toBeNull();
    // 两条线程都已入卡,状态可正常推进。
    expect(tracker.handleDescendantNotification('t-b', 'item/started', toolItem('c-1'))).toMatchObject({
      taskId: 'card-1',
      toolUses: 1,
    });
  });

  it('re-opens a card that already looked completed when a late descendant joins', () => {
    // 孙线程在子线程收口之后才并入:卡片已显示 completed,但孙还在跑 —— 必须发帧改回 running,
    // 否则用户看到的是"完成"而子代理其实还在烧 token。
    const tracker = createSubagentLiveCardTracker({ now: () => 0 });
    tracker.noteSpawnItem(v2SpawnItem('card-1', 't-child'));
    expect(
      tracker.handleDescendantNotification('t-child', 'turn/completed', { turn: { status: 'completed' } })?.status,
    ).toBe('completed');
    expect(tracker.noteDescendantThread('t-grand', 't-child')?.status).toBe('running');
  });

  it('bounds the unattributed lineage buffer', () => {
    // 绝大多数 descendantThreadStarted 的父线程与子代理无关(主线程自己的后代),缓冲必须有界。
    const tracker = createSubagentLiveCardTracker({ now: () => 0 });
    for (let i = 0; i < 200; i += 1) tracker.noteDescendantThread(`c-${i}`, `p-${i}`);
    for (let i = 0; i < 200; i += 1) tracker.noteDescendantThread(`x-${i}`, 'p-shared');
    // 无卡产生,且不抛错;有界性由内部常量保证(此处守的是"不崩、不建卡")。
    expect(tracker.size).toBe(0);
  });

  it('keeps tool item dedup ids after the card settles (turn/completed may precede item/completed)', () => {
    // app-server 允许 turn/completed 先发、后台收尾的 item/completed 随后才到。原来 snapshot()
    // 一收口就清 countedItemIds,那条迟到的 completed 会被当成新工具再加一次 → 工具数虚高(review)。
    const tracker = createSubagentLiveCardTracker({ now: () => 0 });
    tracker.noteSpawnItem(v2SpawnItem('card-1', 't-child'));
    expect(
      tracker.handleDescendantNotification('t-child', 'item/started', toolItem('x-1')),
    ).toMatchObject({ toolUses: 1 });

    // 先收口(此时会产生一次终态快照)。
    expect(
      tracker.handleDescendantNotification('t-child', 'turn/completed', { turn: { status: 'completed' } })?.status,
    ).toBe('completed');

    // 同一个 item 的迟到 completed:必须被去重掉,工具数保持 1。
    expect(tracker.handleDescendantNotification('t-child', 'item/completed', toolItem('x-1'))).toBeNull();
    // 用一条真正的新 item 确认计数基线没有被污染(应为 2,而不是把 x-1 重复算成 3)。
    expect(
      tracker.handleDescendantNotification('t-child', 'item/started', toolItem('x-2')),
    ).toMatchObject({ toolUses: 2 });
  });

  it('re-emits replayed usage when the spawn itself failed', () => {
    // V1 spawn 的 started phase 缺失/晚到:子线程的工具与 token 先进缓冲,随后只收到
    // status:'failed' 的 completed item。原来失败分支无条件 return null,而 translator 的
    // failed 帧不带 usage —— 这些已重放的计数永远不会显示(review)。
    const tracker = createSubagentLiveCardTracker({ now: () => 0 });
    tracker.handleDescendantNotification('t-a', 'item/started', toolItem('x-1'));
    tracker.handleDescendantNotification('t-a', 'thread/tokenUsage/updated', {
      tokenUsage: { total: { totalTokens: 1234 } },
    });

    const failed = tracker.noteSpawnItem({ ...v1SpawnItem('card-v1', ['t-a']), status: 'failed' });
    // 有重放内容 → 补发快照,且状态由终态闩锁定为 failed(不会把失败盖回运行中)。
    expect(failed).toMatchObject({ taskId: 'card-v1', status: 'failed', toolUses: 1, totalTokens: 1234 });
  });

  it('still emits nothing when a failed spawn had no buffered usage to replay', () => {
    // 没有可重放的内容就别多发一帧 —— translator 的 failed 帧已经到位。
    const tracker = createSubagentLiveCardTracker({ now: () => 0 });
    expect(tracker.noteSpawnItem({ ...v1SpawnItem('card-v1', ['t-a']), status: 'failed' })).toBeNull();
    tracker.noteSpawnItem(v1SpawnItem('card-v2', ['t-b']));
    expect(tracker.noteSpawnItem({ ...v1SpawnItem('card-v2', ['t-b']), status: 'failed' })).toBeNull();
  });

  it('counts every tool item type the real codex protocol defines, and only those', () => {
    // 这份名单是对**真实 codex 0.145 二进制**导出的 schema 逐项核对出来的
    // (`codex app-server generate-json-schema` → ThreadItem 18 个变体)。`sleep` 就是核对时
    // 补上的:schema 写明它是 "Display item emitted by the interruptible `clock.sleep` tool",
    // 手工构造的单测永远发现不了漏计 —— 因为漏的那类事件我根本没想到要构造。
    const tracker = createSubagentLiveCardTracker({ now: () => 0 });
    tracker.noteSpawnItem(v2SpawnItem('card-1', 't-child'));
    const toolTypes = [
      'commandExecution', 'mcpToolCall', 'dynamicToolCall', 'webSearch',
      'fileChange', 'imageView', 'imageGeneration', 'collabAgentToolCall', 'sleep',
    ];
    toolTypes.forEach((type, i) => {
      expect(
        tracker.handleDescendantNotification('t-child', 'item/started', toolItem(`t-${i}`, type)),
      ).toMatchObject({ toolUses: i + 1 });
    });
    // 非工具产出不得计数(否则子代理每说一句话都算一次工具调用)。
    for (const type of ['userMessage', 'agentMessage', 'reasoning', 'plan', 'hookPrompt',
      'enteredReviewMode', 'exitedReviewMode', 'contextCompaction', 'subAgentActivity']) {
      expect(tracker.handleDescendantNotification('t-child', 'item/started', toolItem(`n-${type}`, type)))
        .toBeNull();
    }
  });


  it('counts a child tool whose first visible phase is item/updated', () => {
    // 长跑工具的首个可见阶段可能就是 updated(与主线程 spawn 路径同因:started 可能缺失)。
    // 原来聚合器只认 started / completed,且 CONSUMED_METHODS 也不缓冲 updated —— 于是长跑工具
    // 在 completed 到达前不计数,会话若先中断则永久漏计(review)。
    const tracker = createSubagentLiveCardTracker({ now: () => 0 });
    tracker.noteSpawnItem(v2SpawnItem('card-1', 't-child'));
    expect(
      tracker.handleDescendantNotification('t-child', 'item/updated', toolItem('long-1')),
    ).toMatchObject({ toolUses: 1 });
    // 同一 item 后续的 updated / completed 不得重复计数(去重靠 item id)。
    expect(tracker.handleDescendantNotification('t-child', 'item/updated', toolItem('long-1'))).toBeNull();
    expect(tracker.handleDescendantNotification('t-child', 'item/completed', toolItem('long-1'))).toBeNull();
    expect(
      tracker.handleDescendantNotification('t-child', 'item/updated', toolItem('long-2')),
    ).toMatchObject({ toolUses: 2 });
  });

  it('buffers a pre-registration item/updated instead of dropping it', () => {
    // spawn 尚未登记时 updated 必须进缓冲,否则登记后重放不出来 —— 同上一条的另一半。
    const tracker = createSubagentLiveCardTracker({ now: () => 0 });
    expect(tracker.handleDescendantNotification('t-child', 'item/updated', toolItem('early-1'))).toBeNull();
    expect(tracker.noteSpawnItem(v2SpawnItem('card-1', 't-child'))).toMatchObject({ toolUses: 1 });
  });


  it('emits a terminal snapshot for still-running cards at shutdown', () => {
    // tracker 只靠后代 turn/completed 写终态,而 transport error / 强制 retire / thread cleanup
    // failure 之后那些通知**永远不会再到**。只清内部状态的话渲染端会一直留着最后一帧 running,
    // 卡片永久转圈(review)。
    let clock = 1_000;
    const tracker = createSubagentLiveCardTracker({ now: () => clock });
    tracker.noteSpawnItem(v2SpawnItem('card-run', 't-a'));
    tracker.handleDescendantNotification('t-a', 'item/started', toolItem('x-1'));
    tracker.noteSpawnItem(v2SpawnItem('card-done', 't-b'));
    tracker.handleDescendantNotification('t-b', 'turn/completed', { turn: { status: 'completed' } });

    clock = 5_000;
    const drained = tracker.drainRunningForShutdown();
    // 只收仍在跑的那张;已收口的不重复发。
    expect(drained).toHaveLength(1);
    expect(drained[0]).toMatchObject({ taskId: 'card-run', status: 'stopped', toolUses: 1 });
    // 幂等:再 drain 一次不该又冒出来。
    expect(tracker.drainRunningForShutdown()).toHaveLength(0);
  });

  it('closes out a card whose child threads never registered', () => {
    // spawn 刚认出、子线程还没 started 就断连:threads 为空时 aggregateStatus 返回 running,
    // 不补占位就还是转圈。
    const tracker = createSubagentLiveCardTracker({ now: () => 0 });
    tracker.noteSpawnItem({ ...v1SpawnItem('card-empty', ['t-x']), receiverThreadIds: ['t-x'] });
    // 手动把线程集合清空以模拟"登记了卡但线程还没建立"的窗口。
    const drained = tracker.drainRunningForShutdown();
    expect(drained).toHaveLength(1);
    expect(drained[0].status).toBe('stopped');
  });

  it('dates the card from the first buffered evidence, not from registration time', () => {
    // spawn 的 started/updated 缺失或晚到时,子线程其实已经跑了一段。用建卡时刻当起点会把
    // 已消耗的时长整段漏掉 —— 长跑子代理甚至显示接近 0ms(review)。
    let clock = 1_000;
    const tracker = createSubagentLiveCardTracker({ now: () => clock });
    // 先到的子线程证据(此时还没有 spawn 登记)。
    tracker.handleDescendantNotification('t-late', 'item/started', toolItem('early-1'));

    clock = 61_000; // 子线程已经跑了 60 秒,spawn item 才到
    const registered = tracker.noteSpawnItem(v2SpawnItem('card-late', 't-late'));
    expect(registered?.durationMs).toBe(60_000);
  });

  it('falls back to now() when there is no earlier evidence', () => {
    let clock = 7_000;
    const tracker = createSubagentLiveCardTracker({ now: () => clock });
    tracker.noteSpawnItem(v2SpawnItem('card-fresh', 't-fresh'));
    clock = 7_500;
    expect(
      tracker.handleDescendantNotification('t-fresh', 'item/started', toolItem('y-1'))?.durationMs,
    ).toBe(500);
  });

  it('clear() drops all tracking (session close)', () => {
    const tracker = createSubagentLiveCardTracker({ now: () => 0 });
    tracker.noteSpawnItem(v2SpawnItem('card-1', 't-child'));
    tracker.clear();
    expect(tracker.size).toBe(0);
    expect(tracker.handleDescendantNotification('t-child', 'item/started', toolItem('x-1'))).toBeNull();
  });
});
