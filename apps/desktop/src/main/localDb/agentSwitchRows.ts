import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import { getDbClient } from './client/current.js';
import { messages, sessions } from './schema.js';
import { messageRowid } from './retriedUserTurnSupersede.js';
import { messageToCamel, persistableSessionEffort, projectSessionRuntimeFields } from './mapper.js';
import { normalizeDbAgentKind } from '../../shared/agentKindConversion.js';
import { isProviderShareAgentDeviceId } from '../../shared/providerShare.js';
import { throwIpcError } from '../utils/ipcValidate.js';

type OwnerBroadcastScope = ReturnType<typeof import('../device-link/broadcast-tap.js').captureDataOwnerBroadcastScope>;

/** The agent-switch row patch (applyAgentSwitchToSessionRow). */
export type AgentSwitchRowPatch = {
    agentKind: 'cc' | 'codex' | 'pi';
    model: string;
    providerId: string | null | undefined;
    sdkSessionId?: string | null;
    /** 目标引擎下的 effort / fastMode(意图登记时 renderer 按目标目录解析,apply 一并落库)。 */
    effort?: string;
    fastMode?: boolean | 'ultrafast';
    contextWindow?: number | null;
    /** 远程 Agent 换电脑:undefined = 不动,null = 改回任务所在电脑。 */
    agentDeviceId?: string | null;
  };

/** The owner fence and the session broadcast the caller writes through (the desktop: localDb/ipc/sessions.ts). */
export interface AgentSwitchRowPorts<OwnerScope> {
  captureOwnerScope(): OwnerScope;
  isOwnerScopeCurrent(scope: OwnerScope): boolean;
  broadcastSessionPatched(sessionId: string, patch: Record<string, unknown>, ownerScope: OwnerScope): void;
}

/** As above, plus the boundary row's rebroadcast (the desktop: localDb/ipc/messages.ts) and a log. */
export interface AgentSwitchFallbackPorts<OwnerScope> extends AgentSwitchRowPorts<OwnerScope> {
  rebroadcastAgentSwitchBoundary(sessionId: string, boundaryClientId: string, ownerScope: OwnerScope): Promise<void>;
  log: { warn(message: string, meta?: Record<string, unknown>): void };
}

/**
 * session-agent-switch:切换 agent 引擎的 DB 提交(单点,只被
 * sessionAgentSwitchHandler 调用,不暴露 IPC handler——agent_kind 不进任何
 * 通用 update 白名单,防裸写)。语义:
 *  - agent_kind / model 落新引擎值;providerId undefined = 不动,null = 显式清除;
 *  - sdk_session_id:缺省 / null = 清空,新引擎从全新原生会话开始(全量交接注入
 *    承接上下文);Phase 2 切回停泊引擎时传停泊的原生 session id,随后的
 *    bootstrap / lazy-create 走标准 resume 路径续接(增量交接补齐离开期间进展)。
 *    旧引擎的原生会话 id 绝不能原样残留——resume 会以错误引擎解释它(离场值
 *    快照存在边界行 fromSdkSessionId,即停泊绑定)。
 *  - 广播 sessions:patched:本机各窗口 sessionsStore/会话视图收敛 + device-link
 *    tap 让控制端镜像同步(agentKind 翻转驱动 capabilities 缓存按新 key 重取)。
 */
export async function applyAgentSwitchToSessionRowWithPorts<OwnerScope>(
  sessionId: string,
  patch: AgentSwitchRowPatch,
  { captureOwnerScope, isOwnerScopeCurrent, broadcastSessionPatched }: AgentSwitchRowPorts<OwnerScope>,
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
  if (patch.agentDeviceId !== undefined) setObj.agentDeviceId = patch.agentDeviceId;
  // effort 值域由 renderer 按目标引擎 capabilities 解析(schema 列是字面量联合,
  // 跨层传输后此处以 string 到达;非法值与直改 DB 同级,运行时由引擎侧收敛)。
  // 固定 effort 模型运行时为 null；sessions.effort NOT NULL，省略该字段。
  const persistableEffort = persistableSessionEffort(patch.effort);
  if (persistableEffort !== undefined) {
    setObj.effort = persistableEffort;
  }
  if (patch.fastMode !== undefined) setObj.fastMode = patch.fastMode;
  if (typeof patch.contextWindow === 'number' && patch.contextWindow > 0) {
    setObj.contextWindow = Math.floor(patch.contextWindow);
  }
  // RETURNING keeps the projection tied to this committed write, including axes
  // omitted by the caller. A later SELECT could observe a newer selection.
  const [committed] = await db.update(sessions).set(setObj).where(eq(sessions.id, sessionId))
    .returning({
      id: sessions.id, agentKind: sessions.agentKind, model: sessions.model,
      providerId: sessions.providerId, effort: sessions.effort, fastMode: sessions.fastMode,
      scheduledModelBaseline: sessions.scheduledModelBaseline,
    });
  if (!committed || !isOwnerScopeCurrent(ownerScope)) return;
  broadcastSessionPatched(
    sessionId,
    {
      agentKind: patch.agentKind,
      model: patch.model,
      sdkSessionId: nextSdkSessionId,
      ...(patch.providerId !== undefined ? { providerId: patch.providerId } : {}),
      ...(patch.agentDeviceId !== undefined ? { agentDeviceId: patch.agentDeviceId } : {}),
      ...(persistableEffort !== undefined ? { effort: persistableEffort } : {}),
      ...(patch.fastMode !== undefined ? { fastMode: patch.fastMode } : {}),
      ...(typeof patch.contextWindow === 'number' && patch.contextWindow > 0
        ? { contextWindow: Math.floor(patch.contextWindow) }
        : {}),
      // Publish before the consumed intent is cleared. Otherwise the composer
      // falls back to runtimeEffective from its last full read.
      ...projectSessionRuntimeFields({ ...committed, agentKind: normalizeDbAgentKind(committed.agentKind) }),
    },
    ownerScope,
  );
}

/** resume 停泊失败的原子 DB 回落,提交成功后再把 session 与边界新状态广播。 */
export async function applyAgentSwitchResumeFallbackAtomicallyWithPorts<OwnerScope>(
  sessionId: string,
  boundaryClientId: string,
  content: unknown,
  { captureOwnerScope, isOwnerScopeCurrent, broadcastSessionPatched, rebroadcastAgentSwitchBoundary, log }: AgentSwitchFallbackPorts<OwnerScope>,
): Promise<void> {
  const ownerScope = captureOwnerScope();
  let boundaryContent: string;
  try {
    boundaryContent = JSON.stringify(content);
  } catch {
    throwIpcError('INVALID_PARAMS', 'agent switch boundary content must be JSON serializable');
  }
  await getDbClient().tx('session.agentSwitchFallback', {
    sessionId,
    boundaryClientId,
    boundaryContent,
    updatedAt: Date.now(),
  });
  if (!isOwnerScopeCurrent(ownerScope)) return;
  broadcastSessionPatched(sessionId, { sdkSessionId: null }, ownerScope);
  await rebroadcastAgentSwitchBoundary(sessionId, boundaryClientId, ownerScope).catch((err) => {
    // DB 事务已提交，广播失败不能让上层误判为“原子回落失败”并重复事务。
    log.warn('agent-switch fallback boundary broadcast failed', {
      sessionId,
      boundaryClientId,
      err: err instanceof Error ? err.message : String(err),
    });
  });
}

/** Phase 2:目标引擎的停泊原生会话(由最近一次"它离场"的边界行派生)。 */
export interface ParkedEngineSession {
  /** 该引擎离场时的原生 session id(resume 用)。 */
  sdkSessionId: string;
  /** 水位线 = 离场边界行的位置;增量交接只取其后的消息。 */
  watermarkCreatedAt: number;
  watermarkRowid: number;
}

/**
 * session-agent-switch Phase 2:查目标引擎是否有可续接的停泊原生会话。
 *
 * 停泊绑定不新增 schema,从边界行确定性派生:最新一条未被 rewind、晚于 /clear
 * 的 agent_switch 行中,content.fromAgentKind === targetDbKind 的那条——其
 * fromSdkSessionId 即该引擎离场时的原生会话快照,行位置即水位线。
 *
 * 只认"该引擎最近一次离场"那一行:fromSdkSessionId 为空(该引擎上次在场期间
 * 从未真正 spawn)→ 按无绑定处理,不回退更早的行——更早快照对应的原生会话
 * 已被后来的全新会话取代,续接它会让引擎拿到与消息流矛盾的记忆。
 * 消息删除写入的 context_rebuild 行会使它之前的全部停泊绑定失效；否则
 * 用户稍后切回旧引擎时仍会 resume 含被删消息的 transcript，绕过本次上下文重建。
 * 传 fromAgentDeviceId 时只认在该设备离场的边界:另一台电脑上的原生线程在本机
 * 不存在,误续接会合成一份来源身份错误的恢复历史。缺省不按设备过滤。普通设备 ID
 * 以边界与当前设备相等为准(A→B→A 可继续原生接续);share: 绑定与旧版缺字段边界
 * 在后续换电脑后失效,因为逻辑 ID 无法证明原生线程仍在当前物理机。
 * content 是 JSON,无法在 SQL 里按字段过滤,取有界条数(边界行数量 = 切换次数,
 * 天然很小)在 JS 里扫。
 */
export async function findParkedEngineSession(
  sessionId: string,
  targetDbKind: 'cc' | 'codex' | 'pi',
  fromAgentDeviceId?: string | null,
): Promise<ParkedEngineSession | null> {
  const db = getDbClient().drizzle;
  const [sessRow] = await db
    .select({ clearedAt: sessions.clearedAt })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  const clearedAt = sessRow?.clearedAt ?? null;
  const afterClear = clearedAt === null ? undefined : gt(messages.createdAt, clearedAt);
  const [contextRebuild] = await db
    .select({ rowid: messageRowid, createdAt: messages.createdAt })
    .from(messages)
    .where(and(eq(messages.sessionId, sessionId), eq(messages.role, 'context_rebuild'), afterClear))
    .orderBy(desc(messages.createdAt), desc(messageRowid))
    .limit(1);
  const rows = await db
    .select({
      rowid: messageRowid,
      content: messages.content,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(
      and(
        eq(messages.sessionId, sessionId),
        eq(messages.role, 'agent_switch'),
        isNull(messages.rewindAt),
        afterClear,
      ),
    )
    .orderBy(desc(messages.createdAt), desc(messageRowid))
    .limit(50);
  // Older boundaries did not record their departure device. Keep resuming them
  // only while the task has stayed on one computer; a later relocation makes the
  // missing evidence unsafe to interpret locally.
  let deviceMovedAfterBoundary = false;
  for (const row of rows) {
    let parsed: {
      fromAgentKind?: unknown;
      fromSdkSessionId?: unknown;
      fromAgentDeviceId?: unknown;
      toAgentDeviceId?: unknown;
    };
    try {
      parsed = JSON.parse(row.content) as typeof parsed;
    } catch {
      continue;
    }
    if (parsed.fromAgentKind !== targetDbKind) {
      // toAgentDeviceId exists only on relocation boundaries. Forced provider
      // relocations can keep the same logical share/group id while moving to a
      // different physical computer, so presence (not id inequality) is the
      // safe signal that an older native binding may have changed owners.
      if (parsed.toAgentDeviceId !== undefined) deviceMovedAfterBoundary = true;
      continue;
    }
    // A cross-device switch leaves the native thread on the computer it ran on.
    // This is still the engine's most recent departure, so do not fall back to
    // an older local thread: resuming it would skip the remote interval's native
    // memory and synthesize a lossy history with the wrong client identity.
    if (fromAgentDeviceId !== undefined) {
      const boundaryDeviceId = parsed.fromAgentDeviceId === null
        ? null
        : typeof parsed.fromAgentDeviceId === 'string'
          ? parsed.fromAgentDeviceId
          : undefined;
      // A share binding can hide a physical move behind the same logical id.
      // Legacy boundaries have no device evidence at all, so a later relocation
      // also makes them unsafe. Ordinary device ids can be trusted when they
      // match the current device, including an A -> B -> A return.
      if (deviceMovedAfterBoundary
        && (boundaryDeviceId === undefined || isProviderShareAgentDeviceId(boundaryDeviceId))) {
        return null;
      }
      if (boundaryDeviceId !== undefined && boundaryDeviceId !== fromAgentDeviceId) return null;
    }
    if (
      contextRebuild &&
      (contextRebuild.createdAt > row.createdAt ||
        (contextRebuild.createdAt === row.createdAt && contextRebuild.rowid > row.rowid))
    ) {
      return null;
    }
    // 命中"该引擎最近一次离场":快照为空即无绑定,不再往更早找。
    if (typeof parsed.fromSdkSessionId !== 'string' || parsed.fromSdkSessionId.length === 0) {
      return null;
    }
    return {
      sdkSessionId: parsed.fromSdkSessionId,
      watermarkCreatedAt: row.createdAt,
      watermarkRowid: row.rowid,
    };
  }
  return null;
}

/** messages.ts's rebroadcastAgentSwitchBoundary, with its owner check and broadcast passed in. */
export async function rebroadcastAgentSwitchBoundaryWith(
  ports: {
    isOwnerBroadcastScopeCurrent: (scope: OwnerBroadcastScope | null | undefined) => boolean;
    broadcastMessageRow: (sessionId: string, message: ReturnType<typeof messageToCamel>, ownerScope?: OwnerBroadcastScope | null) => void;
  },
  sessionId: string,
  boundaryClientId: string,
  ownerScope: OwnerBroadcastScope | null,
): Promise<void> {
  const { isOwnerBroadcastScopeCurrent, broadcastMessageRow } = ports;
  const db = getDbClient().drizzle;
  const [row] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.sessionId, sessionId), eq(messages.clientId, boundaryClientId)))
    .limit(1);
  if (row && isOwnerBroadcastScopeCurrent(ownerScope)) {
    broadcastMessageRow(sessionId, messageToCamel(row), ownerScope);
  }
}
