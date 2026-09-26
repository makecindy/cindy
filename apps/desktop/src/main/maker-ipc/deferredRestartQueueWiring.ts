/**
 * deferred Codex restart × 输入队列的生产接线工厂(#2506)。
 *
 * register.ts 与跨模块回归测试(deferredRestartQueueDrain.test.ts)共用这两个
 * 工厂:测试 harness 此前照抄接线形状自行重实现,register 真实接线漏接/错接/
 * 改变谓词时回归照样全绿(Codex review P1)。抽到这里后,谓词与唤醒的**逻辑**
 * 只有一份;register 侧只剩传 deps,测试另以源码断言锁住 register 确实经由
 * 本工厂接线。
 */

/** 重启尝试收口后的 wake reason，包括失败后释放输入队列。 */
export const DEFERRED_RESTART_WAKE_REASON = 'deferred-codex-restart-settled';

/**
 * coordinator 的 hasPendingCredentialSwitch 谓词:
 *  1. 延迟凭证切换登记表里有该会话 → 挡;
 *  2. 实际重启中的本地 Codex 会话 → 暂停派发，包括重启刚关闭的会话。
 * 等待全局空闲的 pending 不阻塞输入。重启范围由 service 的关闭前快照确定，
 * 不能从 live 列表推断，否则关闭到 bridge 替换完成之间会过早放行。
 */
export function createDeferredRestartQueueGate(deps: {
  hasPendingCredentialSwitchEntry: (sessionId: string) => boolean;
  isSessionRestarting: (sessionId: string) => boolean;
}): (sessionId: string) => boolean {
  return (sessionId) => {
    if (deps.hasPendingCredentialSwitchEntry(sessionId)) return true;
    return deps.isSessionRestarting(sessionId);
  };
}

/**
 * DeferredCodexRestartService.onQueueGateReleased 的接线:尝试收口后逐会话唤醒输入队列,
 * wake reason 固定为 DEFERRED_RESTART_WAKE_REASON。
 */
export function createDeferredRestartSettledWake(deps: {
  wakeSession: (sessionId: string, reason: string) => void;
}): (sessionIds: string[]) => void {
  return (sessionIds) => {
    for (const sessionId of sessionIds) {
      deps.wakeSession(sessionId, DEFERRED_RESTART_WAKE_REASON);
    }
  };
}
