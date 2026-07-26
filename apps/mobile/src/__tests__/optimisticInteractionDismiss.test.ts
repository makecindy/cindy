/**
 * 交互卡乐观 dismiss(批准 / 拒绝点击即撤卡)的 store 行为:
 *  - beginOptimisticInteractionDismiss:当帧撤卡 + 登记在途抑制;
 *  - 抑制窗口内权威流(push 重放 applyInteractionRequest / 全量快照
 *    setPendingInteractions)不得把同一张卡灌回来(防「闪回」);
 *  - settle confirmed:仅解除抑制(权威流不会再带来这张卡);
 *  - settle restore:解除抑制并复原原卡(真失败,供用户重试)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { remoteSessionStore } from '@/session/remoteSessionStore';
import type { PendingInteraction } from '@/session/types';

function interaction(requestId: string): PendingInteraction {
  return { request: { kind: 'permission', requestId, title: `req-${requestId}` } };
}

function pluginSetup(requestId: string, revision: number): PendingInteraction {
  return { request: { kind: 'plugin_setup', requestId, revision } };
}

describe('optimistic interaction dismiss', () => {
  beforeEach(() => {
    remoteSessionStore.clear();
  });

  it('begin 当帧撤卡,权威快照与 push 重放在确认前都不能复活它', () => {
    remoteSessionStore.setPendingInteractions('s1', [interaction('r1'), interaction('r2')]);
    remoteSessionStore.beginOptimisticInteractionDismiss('s1', 'r1');
    expect(remoteSessionStore.getPendingInteractions('s1').map((i) => i.request.requestId)).toEqual(['r2']);

    // push 重放(reseed / 迟到事件)带回同一张卡:被抑制。
    remoteSessionStore.applyInteractionRequest('s1', interaction('r1'));
    expect(remoteSessionStore.getPendingInteractions('s1').map((i) => i.request.requestId)).toEqual(['r2']);

    // 全量快照仍含这张卡(被控端还没处理完):同样被过滤,其余照常落地。
    remoteSessionStore.setPendingInteractions('s1', [interaction('r1'), interaction('r2'), interaction('r3')]);
    expect(remoteSessionStore.getPendingInteractions('s1').map((i) => i.request.requestId)).toEqual(['r2', 'r3']);
  });

  it('被抑制的 push 重放不能 finalize 当前 assistant 流', () => {
    vi.useFakeTimers();
    try {
      remoteSessionStore.applyRemotePush('dev-1', 'maker:event', {
        sessionId: 's1',
        event: { type: 'text', data: { text: 'hello', isFinal: false } },
      });
      vi.runOnlyPendingTimers();

      remoteSessionStore.setPendingInteractions('s1', [interaction('r1')]);
      remoteSessionStore.beginOptimisticInteractionDismiss('s1', 'r1');
      remoteSessionStore.applyInteractionRequest('s1', interaction('r1'));

      expect(remoteSessionStore.getMessages('s1')).toMatchObject([{
        content: 'hello',
        agentMeta: { isStreaming: true },
      }]);

      remoteSessionStore.applyRemotePush('dev-1', 'maker:event', {
        sessionId: 's1',
        event: { type: 'text', data: { text: ' world', isFinal: false } },
      });
      vi.runOnlyPendingTimers();

      expect(remoteSessionStore.getMessages('s1')).toMatchObject([{
        content: 'hello world',
        agentMeta: { isStreaming: true },
      }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('settle confirmed 转延长抑制:早发晚到的旧快照(仍含该卡)被滤,不闪回', () => {
    remoteSessionStore.setPendingInteractions('s1', [interaction('r1')]);
    remoteSessionStore.beginOptimisticInteractionDismiss('s1', 'r1');
    remoteSessionStore.settleOptimisticInteractionDismiss('s1', 'r1', { kind: 'confirmed' });
    expect(remoteSessionStore.getPendingInteractions('s1')).toEqual([]);

    // resolve 前发出、resolve 后才返回的慢权威快照:仍含已解决的卡 → 被滤。
    remoteSessionStore.setPendingInteractions('s1', [interaction('r1'), interaction('r2')]);
    expect(remoteSessionStore.getPendingInteractions('s1').map((i) => i.request.requestId)).toEqual(['r2']);
    // push 单卡重放同样被滤。
    remoteSessionStore.applyInteractionRequest('s1', interaction('r1'));
    expect(remoteSessionStore.getPendingInteractions('s1').map((i) => i.request.requestId)).toEqual(['r2']);
  });

  it('延长抑制按「缺席即过期」回收:一轮不含该卡的快照后,同 id 新请求可正常写入', () => {
    remoteSessionStore.setPendingInteractions('s1', [interaction('r1')]);
    remoteSessionStore.beginOptimisticInteractionDismiss('s1', 'r1');
    remoteSessionStore.settleOptimisticInteractionDismiss('s1', 'r1', { kind: 'confirmed' });

    // 被控端确认后的新快照不再含 r1 → 延长抑制条目自然过期。
    remoteSessionStore.setPendingInteractions('s1', [interaction('r2')]);
    // 之后同 id 的新请求(如 agent 再次发起同名审批)不受历史影响。
    remoteSessionStore.applyInteractionRequest('s1', interaction('r1'));
    expect(remoteSessionStore.getPendingInteractions('s1').map((i) => i.request.requestId).sort()).toEqual(['r1', 'r2']);
  });

  it('interaction-dismissed push 不提前回收:push 之后晚到的在途旧快照仍被滤', () => {
    remoteSessionStore.setPendingInteractions('s1', [interaction('r1')]);
    remoteSessionStore.beginOptimisticInteractionDismiss('s1', 'r1');
    remoteSessionStore.settleOptimisticInteractionDismiss('s1', 'r1', { kind: 'confirmed' });
    remoteSessionStore.applyRemotePush('dev-1', 'maker:interaction-dismissed', { sessionId: 's1', requestId: 'r1' });

    // 决定提交前发出的 getPendingInteractions 旧快照晚于 push 返回(仍含已解决的卡):
    // 若 push 提前回收了抑制条目,这里会闪回(codex review P2)。
    remoteSessionStore.setPendingInteractions('s1', [interaction('r1'), interaction('r2')]);
    expect(remoteSessionStore.getPendingInteractions('s1').map((i) => i.request.requestId)).toEqual(['r2']);

    // 之后一轮不含 r1 的快照到达 → 条目按「缺席即过期」正常回收,同 id 新请求不受影响。
    remoteSessionStore.setPendingInteractions('s1', [interaction('r2')]);
    remoteSessionStore.applyInteractionRequest('s1', interaction('r1'));
    expect(remoteSessionStore.getPendingInteractions('s1').map((i) => i.request.requestId).sort()).toEqual(['r1', 'r2']);
  });

  it('settle restore 复原原卡供重试', () => {
    const original = interaction('r1');
    remoteSessionStore.setPendingInteractions('s1', [original]);
    remoteSessionStore.beginOptimisticInteractionDismiss('s1', 'r1');
    expect(remoteSessionStore.getPendingInteractions('s1')).toEqual([]);

    remoteSessionStore.settleOptimisticInteractionDismiss('s1', 'r1', { kind: 'restore', item: original });
    expect(remoteSessionStore.getPendingInteractions('s1').map((i) => i.request.requestId)).toEqual(['r1']);
  });

  it('非乐观提交把 revision 下限抬过本次决定:旧快照被滤,被控端推进后的新 revision 放行', () => {
    remoteSessionStore.setPendingInteractions('s1', [pluginSetup('setup-1', 3)]);
    // 取消命令已被接受(卡不撤,等被控端 dismiss push);下限抬到 4。
    remoteSessionStore.markInteractionRevisionResolved('s1', 'setup-1', 3);
    remoteSessionStore.applyRemotePush('dev-1', 'maker:interaction-dismissed', { sessionId: 's1', requestId: 'setup-1' });
    expect(remoteSessionStore.getPendingInteractions('s1')).toEqual([]);

    // 取消前发出、dismiss push 之后才返回的旧快照(revision ≤ 3):被滤,不闪回。
    remoteSessionStore.setPendingInteractions('s1', [pluginSetup('setup-1', 3), interaction('r2')]);
    expect(remoteSessionStore.getPendingInteractions('s1').map((i) => i.request.requestId)).toEqual(['r2']);
    remoteSessionStore.applyInteractionRequest('s1', pluginSetup('setup-1', 2));
    expect(remoteSessionStore.getPendingInteractions('s1').map((i) => i.request.requestId)).toEqual(['r2']);

    // 取消未生效(expectedRevision 对不上 → 被控端重新体检并推更高 revision):
    // 卡必须能回来,否则用户面对的是一张永久隐身的幽灵卡。
    remoteSessionStore.applyInteractionRequest('s1', pluginSetup('setup-1', 4));
    expect(remoteSessionStore.getPendingInteractions('s1').map((i) => i.request.requestId).sort())
      .toEqual(['r2', 'setup-1']);
  });

  it('revision 下限只升不降:缺席一轮快照后,更旧的 revision 仍拿不回覆盖权', () => {
    remoteSessionStore.setPendingInteractions('s1', [pluginSetup('setup-1', 3)]);
    remoteSessionStore.markInteractionRevisionResolved('s1', 'setup-1', 3);
    // 一轮不含该卡的快照到达(被控端已移除)。曾经在这里回收下限,于是更晚到的旧
    // 快照又能把已取消的卡写回来(#530 review)——下限现在不因缺席回落。
    remoteSessionStore.setPendingInteractions('s1', []);
    remoteSessionStore.applyInteractionRequest('s1', pluginSetup('setup-1', 3));
    expect(remoteSessionStore.getPendingInteractions('s1')).toEqual([]);
  });

  it('被接受的快照抬高下限:晚到的旧 revision 不能把新卡换回旧卡', () => {
    // 弱网乱序:先到的新 push 已经把卡推进到 revision 6。
    remoteSessionStore.applyInteractionRequest('s1', pluginSetup('setup-1', 6));
    expect(remoteSessionStore.getPendingInteractions('s1').map((i) => i.request.revision)).toEqual([6]);

    // 更早发出的 getPendingInteractions 响应(revision 4)晚到:dedupe 只按 requestId,
    // 不挡就会把 UI 回退到 revision 4,取消时还会发过期的 expectedRevision。
    remoteSessionStore.setPendingInteractions('s1', [pluginSetup('setup-1', 4)]);
    expect(remoteSessionStore.getPendingInteractions('s1').map((i) => i.request.revision)).toEqual([6]);
    remoteSessionStore.applyInteractionRequest('s1', pluginSetup('setup-1', 4));
    expect(remoteSessionStore.getPendingInteractions('s1').map((i) => i.request.revision)).toEqual([6]);

    // 真正更新的快照仍可落地。
    remoteSessionStore.setPendingInteractions('s1', [pluginSetup('setup-1', 7)]);
    expect(remoteSessionStore.getPendingInteractions('s1').map((i) => i.request.revision)).toEqual([7]);
  });

  it('抬高下限时把已经躺在列表里的过期版本一起清掉', () => {
    // dismiss push 早于 resolve promise 落定:一份在途旧快照先把 revision 3 填回列表。
    remoteSessionStore.setPendingInteractions('s1', [pluginSetup('setup-1', 3), interaction('r2')]);
    // 此时才收口。只登记下限不清列表的话,这张过期卡会继续显示,而对它点取消只是
    // 「看起来成功」的 no-op(被控端已 complete)。
    remoteSessionStore.markInteractionRevisionResolved('s1', 'setup-1', 3);
    expect(remoteSessionStore.getPendingInteractions('s1').map((i) => i.request.requestId)).toEqual(['r2']);

    // 被控端确实推进(取消未生效)时,更高 revision 仍能把卡带回来。
    remoteSessionStore.applyInteractionRequest('s1', pluginSetup('setup-1', 4));
    expect(remoteSessionStore.getPendingInteractions('s1').map((i) => i.request.requestId).sort())
      .toEqual(['r2', 'setup-1']);
  });

  it('连 revision 都没有的快照不能覆盖已进入 revision 语义的那份', () => {
    remoteSessionStore.applyInteractionRequest('s1', pluginSetup('setup-1', 5));
    // 旧被控端 / 非法快照(缺 revision):不得把内容换回去,否则取消又会发过期的
    // expectedRevision。
    const withoutRevision: PendingInteraction = { request: { kind: 'plugin_setup', requestId: 'setup-1' } };
    remoteSessionStore.applyInteractionRequest('s1', withoutRevision);
    expect(remoteSessionStore.getPendingInteractions('s1').map((i) => i.request.revision)).toEqual([5]);
    remoteSessionStore.setPendingInteractions('s1', [withoutRevision]);
    expect(remoteSessionStore.getPendingInteractions('s1').map((i) => i.request.revision)).toEqual([5]);

    // 反向:手上那份本来就没有 revision 时,沿用既有后写覆盖语义(非 revision 化
    // 交互不受影响)。
    remoteSessionStore.setPendingInteractions('s2', [interaction('r1')]);
    remoteSessionStore.applyInteractionRequest('s2', { request: { kind: 'permission', requestId: 'r1', title: 'updated' } });
    expect(remoteSessionStore.getPendingInteractions('s2').map((i) => i.request.title)).toEqual(['updated']);
  });

  it('非法 revision(负数 / 小数)不参与新旧比较,也不能登记下限', () => {
    // 被控端契约是非负整数;非法值按「没有 revision」处理,不得覆盖已有的合法版本。
    remoteSessionStore.applyInteractionRequest('s1', pluginSetup('setup-1', 4));
    remoteSessionStore.applyInteractionRequest('s1', pluginSetup('setup-1', -1));
    remoteSessionStore.applyInteractionRequest('s1', pluginSetup('setup-1', 2.5));
    expect(remoteSessionStore.getPendingInteractions('s1').map((i) => i.request.revision)).toEqual([4]);

    // 非法值也不能登记下限,否则会凭一个无效数字把后续合法快照挡掉。
    remoteSessionStore.markInteractionRevisionResolved('s1', 'setup-1', -1);
    remoteSessionStore.markInteractionRevisionResolved('s1', 'setup-1', 2.5);
    remoteSessionStore.setPendingInteractions('s1', [pluginSetup('setup-1', 4)]);
    expect(remoteSessionStore.getPendingInteractions('s1').map((i) => i.request.revision)).toEqual([4]);
  });

  it('抑制按 (sessionId, requestId) 隔离:不影响其它会话的同名 request', () => {
    remoteSessionStore.setPendingInteractions('s1', [interaction('r1')]);
    remoteSessionStore.beginOptimisticInteractionDismiss('s1', 'r1');
    remoteSessionStore.setPendingInteractions('s2', [interaction('r1')]);
    expect(remoteSessionStore.getPendingInteractions('s2').map((i) => i.request.requestId)).toEqual(['r1']);
  });
});
