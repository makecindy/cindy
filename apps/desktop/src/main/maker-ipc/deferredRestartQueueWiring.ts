/**
 * deferred Codex restart × 输入队列的生产接线工厂(#2506)。
 *
 * register.ts 与跨模块回归测试(deferredRestartQueueDrain.test.ts)共用这两个
 * 工厂:测试 harness 此前照抄接线形状自行重实现,register 真实接线漏接/错接/
 * 改变谓词时回归照样全绿(Codex review P1)。抽到这里后,谓词与唤醒的**逻辑**
 * 只有一份;register 侧只剩传 deps,测试另以源码断言锁住 register 确实经由
 * 本工厂接线。
 */

/** onApplied 唤醒的 wake reason,coordinator 日志与测试断言共用同一常量。 */
export const DEFERRED_RESTART_WAKE_REASON = 'deferred-codex-restart-applied';

interface GateSessionShape {
  id: string;
  agentKind: string;
  remoteHostId?: string | null;
}

/**
 * coordinator 的 hasPendingCredentialSwitch 谓词:
 *  1. 延迟凭证切换登记表里有该会话 → 挡;
 *  2. 延迟 Codex 重启 pending 期间,本地 Codex live 会话 → 挡 —— 否则排队消息
 *     在旧 host 上接续开新 turn,重启被无限顺延(review P1 2026-07-23)。未
 *     spawn / 已关闭的会话不挡:fresh spawn 本来就读新设置。
 * maker 是 dynamic facade,owner 边界窗口 listActiveSessions 会抛 → 按不挡
 * 处理(边界会清 pending)。
 */
export function createDeferredRestartQueueGate(deps: {
  hasPendingCredentialSwitchEntry: (sessionId: string) => boolean;
  isDeferredRestartPending: () => boolean;
  listActiveSessions: () => GateSessionShape[];
}): (sessionId: string) => boolean {
  return (sessionId) => {
    if (deps.hasPendingCredentialSwitchEntry(sessionId)) return true;
    if (!deps.isDeferredRestartPending()) return false;
    try {
      const session = deps.listActiveSessions().find((s) => s.id === sessionId);
      return !!session && session.agentKind === 'codex' && !session.remoteHostId;
    } catch {
      return false;
    }
  };
}

/**
 * DeferredCodexRestartService.onApplied 的接线:重启兑现后逐会话唤醒输入队列,
 * wake reason 固定为 DEFERRED_RESTART_WAKE_REASON。
 */
export function createDeferredRestartAppliedWake(deps: {
  wakeSession: (sessionId: string, reason: string) => void;
}): (sessionIds: string[]) => void {
  return (sessionIds) => {
    for (const sessionId of sessionIds) {
      deps.wakeSession(sessionId, DEFERRED_RESTART_WAKE_REASON);
    }
  };
}
