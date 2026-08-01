/**
 * session-agent-switch 与消息发送的异步协调层(按 session,模块级)。
 * ---------------------------------------------------------------------------
 * 跨引擎切换的每一次点选都会产生一个**跨越 await 的写入**:发 IPC → 等被控端 ack →
 * 落展示态。这条链上有三个归属问题,组件内的 ref 都兜不住:
 *
 *  1. **串行**:被控端 device-link dispatch 对每个 invoke 独立起协程,而
 *     sessionAgentSwitchHandler 写 pendingSwitches 前还要 await 路由校验与 DB 读——
 *     并发时较旧的请求可能后落库,覆盖较新的选择。队列必须存在于 **session 生命周期**
 *     而不是组件实例:用户切走再切回时旧组件已卸载但 invoke 仍在飞,新组件若另起一条
 *     空队列就会立刻发出第二次选择,两个请求重新并发。
 *  2. **写序号**(判定「在途期间用户是否又点过」)同理:挂在组件 ref 上会随重挂归零,
 *     旧 ack 就会被误判成新鲜。
 *  3. **会话作用域**:同一路由下 ChatInput 可以换 sessionId 继续渲染,await 返回后必须
 *     确认「当前仍是发起时那个会话」,否则旧会话的响应会写进新会话。
 *
 * 因此这些状态按 sessionId 键控放在模块级,与组件挂载无关;会话被清理时调用
 * `disposeAgentSwitchSession` 释放(不释放也只是留下一个已 settle 的 promise 与一个整数)。
 */

/** 每个 session 一条串行链;值恒为已 catch 的 promise,不会向外抛。 */
const switchQueues = new Map<string, Promise<void>>();
/** 每个 session 的本端写次数(登记 / 撤销 / 选回当前引擎都算一次),单调递增。 */
const writeSeqs = new Map<string, number>();
/** 完整切换操作的在途 token；Set 避免并发点选或 dispose 后旧 finally 误清新操作。 */
const pendingOperations = new Map<string, Set<symbol>>();
/** 发送准备至 maker:send 完成的在途 token；与切换操作互斥，避免动作顺序被 await 反转。 */
const pendingSendDispatches = new Map<string, Set<symbol>>();
const pendingListeners = new Set<() => void>();

function emitPendingChange(): void {
  for (const listener of pendingListeners) listener();
}

/**
 * 推进并返回本次点选的写序号。响应到达时与 `getAgentSwitchWriteSeq` 比对即可判断
 * 「在途期间用户是否又点过」——单调递增,不受 ABA 影响(登记后又撤销时值都回到 null,
 * 序号已 +2)。
 */
export function nextAgentSwitchWriteSeq(sessionId: string): number {
  const next = (writeSeqs.get(sessionId) ?? 0) + 1;
  writeSeqs.set(sessionId, next);
  return next;
}

export function getAgentSwitchWriteSeq(sessionId: string): number {
  return writeSeqs.get(sessionId) ?? 0;
}

/**
 * 把一次切换写入排进该 session 的串行链,保证「发送顺序 = 被控端处理顺序」。
 * 前一个任务的成败都不影响后一个继续(链上只串顺序,不串结果)。
 */
export function runAgentSwitchExclusive<T>(
  sessionId: string,
  task: () => Promise<T>,
): Promise<T> {
  const base = switchQueues.get(sessionId) ?? Promise.resolve();
  const run = base.then(task, task);
  switchQueues.set(
    sessionId,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

/**
 * 预占该 session 的串行位置，直到 release 才允许后续任务开始。
 * 用于 host ack 后仍需继续执行 renderer 异步收尾的复合操作，避免后续点选插进两段之间。
 */
export function reserveAgentSwitchExclusive(sessionId: string): {
  ready: Promise<void>;
  release: () => void;
} {
  const base = switchQueues.get(sessionId) ?? Promise.resolve();
  const ready = base.then(() => undefined);
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  switchQueues.set(
    sessionId,
    ready.then(() => gate),
  );

  let released = false;
  return {
    ready,
    release: () => {
      if (released) return;
      released = true;
      releaseGate();
    },
  };
}

/**
 * 登记一次完整的切换操作（含 host ack 后的 renderer 收敛），返回幂等完成函数。
 * pending 状态独立于组件实例，切走再切回或重挂 ChatInput 时发送门禁仍然可靠。
 */
export function beginAgentSwitchOperation(sessionId: string): () => void {
  const token = Symbol(sessionId);
  const tokens = pendingOperations.get(sessionId) ?? new Set<symbol>();
  tokens.add(token);
  pendingOperations.set(sessionId, tokens);
  emitPendingChange();

  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    const current = pendingOperations.get(sessionId);
    if (!current?.delete(token)) return;
    if (current.size === 0) pendingOperations.delete(sessionId);
    emitPendingChange();
  };
}

export function hasPendingAgentSwitchOperation(sessionId: string): boolean {
  return (pendingOperations.get(sessionId)?.size ?? 0) > 0;
}

/**
 * 登记一次完整发送派发（引用水合、预检、maker:send 与发送后清理），返回幂等完成函数。
 * 状态放在模块级，ChatInput 重挂后新的切换入口仍能看到旧实例尚未完成的发送。
 */
export function beginAgentSendDispatch(sessionId: string): () => void {
  const token = Symbol(sessionId);
  const tokens = pendingSendDispatches.get(sessionId) ?? new Set<symbol>();
  tokens.add(token);
  pendingSendDispatches.set(sessionId, tokens);
  emitPendingChange();

  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    const current = pendingSendDispatches.get(sessionId);
    if (!current?.delete(token)) return;
    if (current.size === 0) pendingSendDispatches.delete(sessionId);
    emitPendingChange();
  };
}

/**
 * 在没有完整切换操作占用该 session 时同步登记发送。
 *
 * 检查与登记必须收在同一个无 await 的原语里：调用方若先查再跨异步准备，切换可能在
 * 中间插入；反过来，登记成功后切换入口会立刻看见 token 并拒绝，从而保持用户动作顺序。
 * 已有发送 token 不构成拒绝条件——共享 store 发送边界可能嵌套在 ChatInput 从引用水合
 * 阶段持有的外层 token 中，两层各自在自己的 finally 释放。
 */
export function tryBeginAgentSendDispatch(sessionId: string): (() => void) | null {
  if (hasPendingAgentSwitchOperation(sessionId)) return null;
  return beginAgentSendDispatch(sessionId);
}

export function hasPendingAgentSendDispatch(sessionId: string): boolean {
  return (pendingSendDispatches.get(sessionId)?.size ?? 0) > 0;
}

export function subscribeAgentSwitchPending(listener: () => void): () => void {
  pendingListeners.add(listener);
  return () => pendingListeners.delete(listener);
}

/** 会话销毁(purge / 关闭)时释放协调状态。 */
export function disposeAgentSwitchSession(sessionId: string): void {
  switchQueues.delete(sessionId);
  writeSeqs.delete(sessionId);
  const hadPendingSwitch = pendingOperations.delete(sessionId);
  const hadPendingSend = pendingSendDispatches.delete(sessionId);
  const pendingChanged = hadPendingSwitch || hadPendingSend;
  if (pendingChanged) emitPendingChange();
}

/** 仅供测试:清空全部协调状态。 */
export function __resetAgentSwitchCoordinatorForTests(): void {
  switchQueues.clear();
  writeSeqs.clear();
  pendingOperations.clear();
  pendingSendDispatches.clear();
}
