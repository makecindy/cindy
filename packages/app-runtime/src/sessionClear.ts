import { throwIpcError } from "@cindy/remote-agent/ipcValidate";
import { createMakerInputValidation } from "./makerInputValidation.js";
import type { AgentInputCoordinator } from "./agent-input-coordinator.js";
import type { createAgentHandoffRuntime } from "./agentHandoffRuntime.js";
import type { createWireNoteMemory } from "./wireNoteMemory.js";
import type { createMakerInputBoundary } from "./makerInputBoundary.js";
import type { DbLogger } from "@cindy/runtime-db/logging";
import { resolveClearSessionBoundary } from "./clearSessionBoundary.js";
export interface SessionClearHost extends Pick<
  ReturnType<typeof createMakerInputBoundary>,
  "beginRemoteInputClearGate" | "endRemoteInputClearGate"
> {
  inputCoordinator: Pick<AgentInputCoordinator, "clearSession">;
  agentHandoffPending: Pick<
    ReturnType<typeof createAgentHandoffRuntime>["agentHandoffPending"],
    "invalidate" | "sealClearBoundary"
  >;
  wireNoteMemory: Pick<ReturnType<typeof createWireNoteMemory>, "reset">;
  assertReviewExternalInputAllowed(id: string): Promise<void>;
  isDeviceLinkInvoke(): boolean;
  resetSessionRuntime(id: string): void;
  notifyQueueEmptied?(id: string): void;
  goalClearObserver?(id: string): void;
  clearSessionContextInDb(id: string, atMs: number): Promise<void>;
  pruneWithdrawnWorkingMemoryForSession(
    id: string,
    root: string,
  ): Promise<number>;
  userDataDirectory(): string;
  log: DbLogger;
}
export function createSessionClear(host: SessionClearHost) {
  const { requireSessionId } = createMakerInputValidation(
    host.isDeviceLinkInvoke,
  );
  const {
    inputCoordinator,
    agentHandoffPending,
    wireNoteMemory,
    assertReviewExternalInputAllowed,
    isDeviceLinkInvoke,
    resetSessionRuntime,
    notifyQueueEmptied,
    goalClearObserver,
    clearSessionContextInDb,
    pruneWithdrawnWorkingMemoryForSession,
    userDataDirectory,
    log,
    beginRemoteInputClearGate,
    endRemoteInputClearGate,
  } = host;
  return async (sessionId: unknown, clearedAt?: unknown) => {
    if (
      clearedAt !== undefined &&
      (typeof clearedAt !== "string" ||
        !Number.isFinite(new Date(clearedAt).getTime()))
    ) {
      throwIpcError("INVALID_PARAMS", "clearedAt must be an ISO timestamp");
    }
    const sid = requireSessionId(sessionId);
    await assertReviewExternalInputAllowed(sid);
    // Fence remote content-bearing controls for the whole clear lifecycle,
    // including the DB await below.  Local clear is gated too so a remote
    // controller cannot enter the same sealing window through another peer.
    beginRemoteInputClearGate(sid);
    try {
      const remoteInvoke = isDeviceLinkInvoke();
      const clearBoundary = resolveClearSessionBoundary({
        clearedAt: typeof clearedAt === "string" ? clearedAt : undefined,
        isRemoteInvoke: remoteInvoke,
      });
      const projection = inputCoordinator.clearSession(sid, clearBoundary);
      resetSessionRuntime(sid);
      // 丢弃缓存的待注入交接 / fork 来源标记:它们是按 clear 之前的历史算出来的,
      // DB 侧的 cleared_at 抑制拦不住已经落进 registry 内存的那一份(首发被拒后
      // 缓存仍在),下次 send 会把旧血缘灌进用户刚显式清空的上下文。
      //
      // 用 invalidate(留 null 墓碑)而不是 clear(删条目):删条目会让后续 send 回落到
      // DB 重建,把旧交接捞回来再缓存住。墓碑同步生效,窗口内的 send 立刻拿到 null;
      // clear 纪元则要等下面 cleared_at 落库之后才推进。
      agentHandoffPending.invalidate(sid);
      // 清空后的原生上下文没看过任何环境说明:下一轮整体重发。
      wireNoteMemory.reset(sid);
      notifyQueueEmptied?.(sid);
      // 清上下文后,active 目标失去其依据(objective 引用的内容已被抹掉)→ 一并清除目标。
      goalClearObserver?.(sid);
      // cleared_at 在 handler 内**同步**落库,本地与远程同一口径。
      //
      // 过去本地路径只靠 renderer 事后 fire-and-forget 写这一列,于是 handler 返回到那次
      // 写入落库之间有个窗口:此刻启动的引擎切换 / 消息删除会读到**尚未标记 clear**的
      // DB 历史,却又拿到 clear 之后的纪元——纪元校验因此形同虚设,基于已清空历史算出的
      // 交接会盖掉刚立的墓碑。在这里同步写掉,那个窗口就不存在了;renderer 之后若再写一次
      // 也是同值幂等。
      const clearBoundaryMs =
        typeof clearBoundary === "number"
          ? clearBoundary
          : new Date(clearBoundary).getTime();
      try {
        await clearSessionContextInDb(sid, clearBoundaryMs);
        // cleared_at 落库后,清空前产生的伙伴工作记忆条目一并持久清掉(与 rewind / 删除
        // 同一失效模式);失败不影响 clear,渲染时按 cleared_at 的统一过滤仍兜底。
        await pruneWithdrawnWorkingMemoryForSession(
          sid,
          userDataDirectory(),
        ).catch(() => 0);
      } catch (err) {
        // The in-memory fence is still authoritative for this process. Keep
        // /clear remains a local cleanup action even when persistence fails;
        // surface the failure in logs, and
        // let the next input/projection boundary retry the durable token.
        log.error("clear session context persist failed", {
          sessionId: sid,
          remoteInvoke,
          err: err instanceof Error ? err.message : String(err),
        });
      }
      return projection;
    } finally {
      // 落库尝试结束后封边界:重立墓碑(清掉这段 await 里用 clear 前纪元挤进来的那份)
      // + 推进纪元(挡住后面才写回的那批)。顺序不可颠倒,理由见 sealClearBoundary 注释。
      agentHandoffPending.sealClearBoundary(sid);
      endRemoteInputClearGate(sid);
    }
  };
}
