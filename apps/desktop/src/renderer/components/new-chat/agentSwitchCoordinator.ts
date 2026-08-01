/**
 * session-agent-switch 的异步写入协调层(按 session,模块级)。
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

/** 会话销毁(purge / 关闭)时释放协调状态。 */
export function disposeAgentSwitchSession(sessionId: string): void {
  switchQueues.delete(sessionId);
  writeSeqs.delete(sessionId);
}

/** 仅供测试:清空全部协调状态。 */
export function __resetAgentSwitchCoordinatorForTests(): void {
  switchQueues.clear();
  writeSeqs.clear();
}
