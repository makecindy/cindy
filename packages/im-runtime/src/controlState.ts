/**
 * main/im/feishu/ctrState.ts
 * ---------------------------------------------------------------------------
 * `/ctr` 流程的进程内"占用"标记 — per (botAppId, openId)。
 *
 * 进入 /ctr 后, 该 (bot, owner) 的所有后续 message (包括别的 slash) 都会被
 * messageHandler 在最早入口拦截掉, 提示先完成或退出。卡片按钮事件走的是
 * cardAction 通道, 不受这个锁影响 — 这正是 /ctr 流程本身的"出口"。
 *
 * 状态生命周期:
 *   enter  ← /ctr slash 发卡片成功后
 *   exit   ← control:exit 按下 / control:session-pick (终态) 按下
 *
 * 进程重启 → Map 清空 → 老 control 卡片仍能点 (cardAction 不依赖此状态),
 * 用户消息又能正常发。可接受: 避免重启后卡死。代价: 进程重启后用户的"流程
 * 进行中"约束消失, 但这等价于"用户重发一遍 /ctr"。
 *
 * 不做 TTL: 用户没主动退出 = 流程进行中, 这是 /ctr 的"原子化"承诺。
 * 真出现"忘了退出"卡死, 重启进程或加显式 reset 命令解决, 不让计时器悄悄改
 * 状态。
 */

/**
 * value: true = 经典模式(feishu, 拦该用户全部消息);string = thread 模型的
 * 控制 thread scopeKey(slack, 只拦顶层 + 该 thread 内的消息)。
 */
export function createControlState() {
  const inProgress = new Map<string, true | string>();

  function key(botAppId: string, openId: string): string {
    return `${botAppId}:${openId}`;
  }

  function enterControl(
    botAppId: string,
    openId: string,
    scope?: string,
  ): void {
    inProgress.set(key(botAppId, openId), scope ?? true);
  }

  function exitControl(botAppId: string, openId: string): void {
    inProgress.delete(key(botAppId, openId));
  }

  function isInControl(botAppId: string, openId: string): boolean {
    return inProgress.has(key(botAppId, openId));
  }

  /** thread 模型: 当前控制流程所在 thread 的 scopeKey;非 thread 模式/未进入返 null。 */
  function getControlScope(botAppId: string, openId: string): string | null {
    const v = inProgress.get(key(botAppId, openId));
    return typeof v === "string" ? v : null;
  }

  return {
    enterControl,
    exitControl,
    isInControl,
    getControlScope,
    clear: () => inProgress.clear(),
  };
}
export const { enterControl, exitControl, isInControl, getControlScope } =
  createControlState();
