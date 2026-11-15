import {
  findForkParentSessionId,
  findPendingAgentHandoff,
  findPendingForkOrigin,
} from '../localDb/agentHandoffPendingQueries.js';
import {
  buildForkOriginHandoff,
  composeForkOriginHandoff,
  createAgentHandoffPendingRegistry,
  type AgentHandoffPendingRegistry,
} from './agentHandoff.js';

/*
 * The pending handoff registry with its database reads, moved unchanged from
 * agentHandoffPendingSingleton.ts so the Node Host can build one without Electron. The desktop's
 * one instance stays that module's singleton; the consumed write and the log are its ports.
 */

/**
 * fork 来源标记同样走 DB 重建,不在 fork 时写内存:
 *  - `parent_session_id` 本就是持久列,重建是确定性的(见 findPendingForkOrigin),
 *    重启后不丢;
 *  - 更关键的是**不能**在 fork 时抢先 set 内存态——那会让 peek 命中内存直接返回,
 *    永远查不到 DB 里那条被 fork 事务 re-arm 成 `consumed: false` 的 agent_switch
 *    边界,把跨引擎交接整段吞掉。两者在这里组合,谁都不丢。
 */
export function createAgentHandoffPending(deps: {
  /** Persists the consumed flag (ipc/messages.ts on the desktop); not awaited, its result is not read. */
  markLatestAgentHandoffConsumed(sessionId: string): Promise<void>;
  log: { warn(message: string, fields?: Record<string, unknown>): void };
}): AgentHandoffPendingRegistry {
  return createAgentHandoffPendingRegistry(async (sessionId) => {
    // 两个查询互不依赖,并行发出——这是 send 路径上的一跳,不该串成两个 RTT。
    // 失败时**独立降级**,两者重要性并不对等:
    //  - 交接查询失败照旧上抛,由 peek 的 catch 处理(返回 null 且**不缓存**,下次
    //    send 重查)——把它就地 catch 成 null 反而会被缓存成"确认无 pending",
    //    等于永久丢掉一段跨引擎交接;
    //  - 来源标记只是元信息,查失败就降级为无,不该反过来拖累交接。
    const [pending, forkParentSessionId] = await Promise.all([
      findPendingAgentHandoff(sessionId),
      findForkParentSessionId(sessionId).catch(() => null),
    ]);
    // 有待注入的交接 = 正在重建原生上下文(agent-switch / 消息删除)。此时用**永久血缘**,
    // 与 decorateCached 同口径:重启若正好落在"重建之后、发送之前",内存态已丢,这条 DB
    // 路径是唯一出口;若它改看首发消费态,首轮跑过的 fork 会在这里丢掉血缘,新原生上下文
    // 再也不知道自己是分叉。
    if (pending) {
      return forkParentSessionId
        ? composeForkOriginHandoff(forkParentSessionId, pending)
        : pending;
    }
    // 没有交接 = 纯首发注入场景,这才该看一次性的消费态。非 fork 会话在这里短路,
    // 只省掉这条**第二**次查询;上面 Promise.all 里的两条对所有会话都会发出。
    if (!forkParentSessionId) return null;
    const pendingForkOrigin = await findPendingForkOrigin(sessionId).catch(() => null);
    return pendingForkOrigin ? buildForkOriginHandoff(pendingForkOrigin) : null;
  },
    (sessionId) => {
      void deps.markLatestAgentHandoffConsumed(sessionId).catch((err) => {
        // accepted 已跨不可逆边界,持久标记失败不能把这次 send 改判失败；内存态
        // 仍已消费,日志用于定位极少见的重启后重复注入风险。
        deps.log.warn('mark consumed failed', {
          sessionId,
          err: err instanceof Error ? err.message : String(err),
        });
      });
    },
    // agent-switch / 消息删除会直接把交接 set 进内存(register.ts 的 setPendingHandoff),
    // 不经上面的 DB fallback。fork 出的子会话若在首发前切了引擎,内存里就只剩切换交接,
    // 来源标记会被整条跳过——这里补一次组合。
    //
    // 这里用 findForkParentSessionId 而**不是** findPendingForkOrigin:这两条路径重建的是
    // 新的原生上下文,交接正文纯按 messages 拼出、不含 fork 信息。fork 是会话的永久属性,
    // 不该随首发那一次性标记被消费掉——否则首轮跑完再切引擎,新上下文就不知道自己是分叉。
    async (sessionId, handoff) => {
      const forkParentSessionId = await findForkParentSessionId(sessionId);
      return forkParentSessionId
        ? composeForkOriginHandoff(forkParentSessionId, handoff)
        : handoff;
    },
  );
}
