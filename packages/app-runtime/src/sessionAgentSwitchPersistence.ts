import {eq} from 'drizzle-orm';
import {sessions} from '@cindy/runtime-db/schema';
import {normalizeDbAgentKind} from '@cindy/maker-shared/agent-kind-conversion';
import {throwIpcError} from '@cindy/remote-agent/ipcValidate';
import type {SessionServiceHost} from './sessionServiceHost.js';
export function createSessionAgentSwitchPersistence(host: Pick<SessionServiceHost<unknown>,"captureOwnerScope"|"getDbClient"|"persistableSessionEffort"|"isOwnerScopeCurrent"|"broadcastSessionPatched"|"projectSessionRuntimeFields"|"rebroadcastAgentSwitchBoundary"|"logger">) {
const {captureOwnerScope,getDbClient,persistableSessionEffort,isOwnerScopeCurrent,broadcastSessionPatched,projectSessionRuntimeFields,rebroadcastAgentSwitchBoundary,logger:log}=host;
async function applyAgentSwitchToSessionRow(
    sessionId: string,
    patch: {
      agentKind: "cc" | "codex" | "pi";
      model: string;
      providerId: string | null | undefined;
      sdkSessionId?: string | null;
      /** 目标引擎下的 effort / fastMode(意图登记时 renderer 按目标目录解析,apply 一并落库)。 */
      effort?: string;
      fastMode?: boolean | "ultrafast";
      contextWindow?: number | null;
      /** 远程 Agent 换电脑:undefined = 不动,null = 改回任务所在电脑。 */
      agentDeviceId?: string | null;
    },
  ): Promise<void> {
    const ownerScope = captureOwnerScope();
    const db = getDbClient().drizzle;
    const nextSdkSessionId = patch.sdkSessionId ?? null;
    const setObj: Partial<typeof sessions.$inferInsert> = {
      agentKind: patch.agentKind,
      model: patch.model,
      sdkSessionId: nextSdkSessionId,
      updatedAt: Date.now(),
    };
    if (patch.providerId !== undefined) setObj.providerId = patch.providerId;
    if (patch.agentDeviceId !== undefined)
      setObj.agentDeviceId = patch.agentDeviceId;
    // effort 值域由 renderer 按目标引擎 capabilities 解析(schema 列是字面量联合,
    // 跨层传输后此处以 string 到达;非法值与直改 DB 同级,运行时由引擎侧收敛)。
    // 固定 effort 模型运行时为 null；sessions.effort NOT NULL，省略该字段。
    const persistableEffort = persistableSessionEffort(patch.effort);
    if (persistableEffort !== undefined) {
      setObj.effort = persistableEffort;
    }
    if (patch.fastMode !== undefined) setObj.fastMode = patch.fastMode;
    if (typeof patch.contextWindow === "number" && patch.contextWindow > 0) {
      setObj.contextWindow = Math.floor(patch.contextWindow);
    }
    // RETURNING keeps the projection tied to this committed write, including axes
    // omitted by the caller. A later SELECT could observe a newer selection.
    const [committed] = await db
      .update(sessions)
      .set(setObj)
      .where(eq(sessions.id, sessionId))
      .returning({
        id: sessions.id,
        agentKind: sessions.agentKind,
        model: sessions.model,
        providerId: sessions.providerId,
        effort: sessions.effort,
        fastMode: sessions.fastMode,
        scheduledModelBaseline: sessions.scheduledModelBaseline,
      });
    if (!committed || !isOwnerScopeCurrent(ownerScope)) return;
    broadcastSessionPatched(
      sessionId,
      {
        agentKind: patch.agentKind,
        model: patch.model,
        sdkSessionId: nextSdkSessionId,
        ...(patch.providerId !== undefined
          ? { providerId: patch.providerId }
          : {}),
        ...(patch.agentDeviceId !== undefined
          ? { agentDeviceId: patch.agentDeviceId }
          : {}),
        ...(persistableEffort !== undefined
          ? { effort: persistableEffort }
          : {}),
        ...(patch.fastMode !== undefined ? { fastMode: patch.fastMode } : {}),
        ...(typeof patch.contextWindow === "number" && patch.contextWindow > 0
          ? { contextWindow: Math.floor(patch.contextWindow) }
          : {}),
        // Publish before the consumed intent is cleared. Otherwise the composer
        // falls back to runtimeEffective from its last full read.
        ...projectSessionRuntimeFields({
          ...committed,
          agentKind: normalizeDbAgentKind(committed.agentKind),
        }),
      },
      ownerScope,
    );
  }
async function applyAgentSwitchResumeFallbackAtomically(
    sessionId: string,
    boundaryClientId: string,
    content: unknown,
  ): Promise<void> {
    const ownerScope = captureOwnerScope();
    let boundaryContent: string;
    try {
      boundaryContent = JSON.stringify(content);
    } catch {
      throwIpcError(
        "INVALID_PARAMS",
        "agent switch boundary content must be JSON serializable",
      );
    }
    await getDbClient().tx("session.agentSwitchFallback", {
      sessionId,
      boundaryClientId,
      boundaryContent,
      updatedAt: Date.now(),
    });
    if (!isOwnerScopeCurrent(ownerScope)) return;
    broadcastSessionPatched(sessionId, { sdkSessionId: null }, ownerScope);
    await rebroadcastAgentSwitchBoundary(
      sessionId,
      boundaryClientId,
      ownerScope,
    ).catch((err) => {
      // DB 事务已提交，广播失败不能让上层误判为“原子回落失败”并重复事务。
      log.warn("agent-switch fallback boundary broadcast failed", {
        sessionId,
        boundaryClientId,
        err: err instanceof Error ? err.message : String(err),
      });
    });
  }
return {applyAgentSwitchToSessionRow,applyAgentSwitchResumeFallbackAtomically};
}
