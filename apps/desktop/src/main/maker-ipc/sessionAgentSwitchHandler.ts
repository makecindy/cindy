/**
 * session-agent-switch:同一会话在 Claude Code / Codex 引擎间切换的 IPC handler。
 *
 * 意图制(2026-07-20):外部调用(IPC)只登记切换意图并返回 deferred——用户在
 * 选择器里反复改选零成本;renderer 乐观呈现意图。真切换在下一条消息发送时刻由
 * send 事务(applyPendingAgentSwitchIfIdle → applyNow=true)执行一次:
 *   校验 → 查目标引擎停泊绑定(Phase 2)→ 构造交接文本(纯代码,
 *   agentHandoff.buildHandoffText:有停泊绑定 = 增量模式,否则全量)
 *   → 关旧 live session → DB 提交(agent_kind + model + provider_id + effort/fast;
 *   sdk_session_id 落停泊 id 或 null)→ 插 agent_switch 边界行(交接全文持久化
 *   于此,UI 可展开)→ 登记 pending 注入 →(resume 时)立即重建新引擎 session。
 *
 * Phase 2(双会话停泊/切回续接):每家引擎的原生会话在离场时"停泊"——离场
 * 快照(fromSdkSessionId)就存在边界行里,不新增 schema。切回时 resume 停泊
 * 会话 + 只注入增量交接(离开期间的进展),prompt cache 前缀与引擎自身记忆
 * 都保住;resume spawn 失败走确定性回落(清停泊 id → 全量交接 → 全新会话)。
 *
 * 失败语义:
 *  - DB 提交之前任何失败 → 原样抛错,会话状态不变;
 *  - DB 提交即切换成功的 commit point;之后边界行插入失败只降级(无分隔条,注入
 *    靠内存 pending 保住本进程内语义),新引擎 spawn 失败返回 engineReady=false,
 *    下一条消息走既有 lazy-create 路径重试并复用其错误呈现(resume 模式先走
 *    上述回落再降级)。
 *
 * 边界:远程会话(remoteHostId)与 Orca 协同会话不支持切换(UNSUPPORTED_CAPABILITY);
 * turn 进行中登记 pending 推迟到下一条消息发送时刻执行。
 */

import type { AgentKind } from '@cindy/maker-core';

import { MAKER_INVOKE } from './channels.js';
import type { IpcHandlerRegistry } from './ipcHandlerRegistry.js';
import {
  buildHandoffText,
  type DbAgentKind,
  type HandoffSourceMessage,
} from './agentHandoff.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { shouldApplyExclusiveProviderRerouteLive } from '../maker-host/model-route-guard-live.js';
import { dbToMakerAgentKind, makerToDbAgentKind, normalizeDbAgentKind } from '../../shared/agentKindConversion.js';

function throwIfAgentSwitchAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error('agent switch aborted');
  }
}

/** Phase 2:目标引擎的停泊原生会话绑定(localDb findParkedEngineSession 的投影)。 */
export interface ParkedEngineSessionRef {
  sdkSessionId: string;
  watermarkCreatedAt: number;
  watermarkRowid: number;
}

/** DB ↔ maker-core 形态映射 —— 正本在 shared/agentKindConversion.ts,此处仅转发。 */
export function toDbAgentKind(kind: AgentKind): DbAgentKind {
  return makerToDbAgentKind(kind);
}

export function toMakerAgentKind(dbKind: string): AgentKind {
  return dbToMakerAgentKind(dbKind);
}

/** 交接 framing 与边界卡展示用的引擎名。 */
export function agentEngineLabel(dbKind: DbAgentKind): string {
  if (dbKind === 'codex') return 'Codex';
  if (dbKind === 'pi') return 'Pi';
  return 'Claude Code';
}

/** role='agent_switch' 边界行的 content 结构(与 renderer AgentSwitchContent 对齐)。 */
export interface AgentSwitchBoundaryContent {
  fromAgentKind: DbAgentKind;
  toAgentKind: DbAgentKind;
  fromModel: string | null;
  toModel: string | null;
  /** 离场引擎与目标引擎各自的 provider 快照；缺失表示旧版边界。 */
  fromProviderId?: string | null;
  toProviderId?: string | null;
  /**
   * 旧引擎的原生 session id 快照 = 它的停泊绑定:Phase 2 切回该引擎时由
   * findParkedEngineSession 从最近一条"它离场"的边界行读回,resume 续接。
   */
  fromSdkSessionId: string | null;
  handoff: string;
  /**
   * Phase 2:本次切换是否 resume 了目标引擎的停泊原生会话(交接为增量模式)。
   * 缺省/false = 全新原生会话 + 全量交接(v1 行为)。
   */
  resumed?: boolean;
  /**
   * 交接前缀是否已被某条 user 消息跨过 vendor accepted 边界消费。
   * 缺失表示 v1 老行,重建时继续使用“边界后是否存在 user 行”的兼容启发式。
   */
  consumed?: boolean;
}

export interface AgentSwitchSessionRow {
  id: string;
  agentKind: string;
  model: string | null;
  providerId: string | null;
  status: string;
  remoteHostId: string | null;
  orcaRole: string | null;
  sdkSessionId: string | null;
  source?: string | null;
}

export interface MakerSessionAgentSwitchHandlerDeps {
  /** 与 send / SET_MODEL 共用的 session 锁；生产注入，最小测试 harness 可省略。 */
  withSessionLock?<T>(sessionId: string, task: () => Promise<T>): Promise<T>;
  /**
   * 停用轴的边界裁决(生产 = register.ts 的 assertModelRouteUsable,内核纯逻辑在
   * model-route-guard.ts)。跨引擎切换是新的路由选择,目标 (agent, model, 来源) 被
   * 停用必须抛错拒绝 —— 本 channel 在 device-link allowlist 内,且切回停泊引擎会以
   * resumeSessionId bootstrap,create 侧的 resume 豁免拦不住它(PR #744 review)。
   * 返回非空 = 隐式来源的默认落点被停用,应改路由到该启用来源。缺省 = 不裁决
   * (测试最小 harness)。
   */
  assertModelRouteUsable?(
    agent: 'claude-code' | 'codex' | 'pi',
    model: string,
    providerId: string | null,
  ): Promise<string | undefined>;
  getSessionRow(sessionId: string): Promise<AgentSwitchSessionRow | null>;
  getLiveSession(sessionId: string): { isTurnRunning(): boolean } | null | undefined;
  closeSession(sessionId: string): Promise<void>;
  /** after = 停泊水位线(Phase 2 增量交接):只取严格晚于该边界行的消息。 */
  listMessagesForHandoff(
    sessionId: string,
    after?: { createdAt: number; rowid: number },
  ): Promise<HandoffSourceMessage[]>;
  /**
   * Phase 2:查目标引擎的停泊原生会话(边界行派生)。缺省(测试最小 harness /
   * 显式关闭)= 恒无绑定,回落 v1 全量交接行为。
   */
  findParkedEngineSession?(
    sessionId: string,
    targetDbKind: DbAgentKind,
  ): Promise<ParkedEngineSessionRef | null>;
  /**
   * 提交切换:update agent_kind/model/provider_id + sdk_session_id + 广播
   * sessions:patched。sdkSessionId null = 全新原生会话;Phase 2 切回时传停泊 id,
   * 随后 bootstrap / lazy-create 走标准 resume 路径。
   */
  applyAgentSwitchToDb(
    sessionId: string,
    patch: {
      agentKind: DbAgentKind;
      model: string;
      providerId: string | null | undefined;
      sdkSessionId?: string | null;
      /** 目标引擎下的 effort / fastMode(意图登记时由 renderer 解析,apply 时一并落库)。 */
      effort?: string;
      fastMode?: boolean;
    },
  ): Promise<void>;
  /**
   * DB 提交成功后同步跨引擎 provider route。这里只在显式携带 providerId 的
   * 生命周期切换边界调用，避免普通 create/resume 的异步 DB 读取覆盖运行时 SET_MODEL。
   */
  setSessionProvider(sessionId: string, providerId: string | null): void;
  /**
   * 新的跨引擎选择淘汰较早的 deferred model/provider 选择。后者可能正在等待
   * close 完成，必须先清登记，避免它在新 agent route 提交后回写旧 provider。
   */
  supersedePendingCredentialSwitch?(sessionId: string): void;
  /** 返回边界行 clientId(resume 回落时原子改写定位用)。 */
  insertBoundaryMessage(sessionId: string, content: AgentSwitchBoundaryContent): Promise<string>;
  /**
   * Phase 2:resume bootstrap 失败时,在单个 SQLite 事务内清 sdk_session_id 并
   * 把边界行改成全量交接。任一目标行不存在或写失败都整体回滚。
   */
  applyResumeFallbackAtomically(
    sessionId: string,
    clientId: string,
    content: AgentSwitchBoundaryContent,
  ): Promise<void>;
  /**
   * 写待注入交接。`expectedGeneration` 取自 readPendingHandoffGeneration:本函数从读
   * 历史到写回之间有大量异步工作,期间若发生 /clear,这份按 clear 前历史算出的交接
   * 必须被丢弃,而不是盖掉 clear 立的墓碑。
   */
  setPendingHandoff(sessionId: string, handoff: string, expectedGeneration?: number): void;
  /** 读交接注册表的当前代次(在读历史之前取一次)。 */
  readPendingHandoffGeneration?(sessionId: string): number;
  /** 从 DB 行(切换已提交后的新值)重建 live session;抛错 = 引擎未就绪。 */
  bootstrapSwitchedSession(sessionId: string): Promise<void>;
  /**
   * close→bootstrap 窗口的 onClose 重副作用抑制(desktop 注入
   * withRehydrateCloseSuppressed)——切换的瞬态 close 绝不能触发 worktree
   * stash/清理等 session 收尾钩子(与 Orca rehydrate 同保护)。
   */
  withCloseSuppressed<T>(sessionId: string, fn: () => Promise<T>): Promise<T>;
  /**
   * pending 切换意图注册表。缺省(测试最小 harness)时 turn 运行中回落抛
   * SESSION_RUNNING 的旧语义。
   */
  pendingSwitches?: PendingAgentSwitchRegistry;
  /** pending intent 变化后广播给本机窗口与 device-link 控制端。 */
  onPendingSwitchChanged?(
    sessionId: string,
    intent: PublicAgentSwitchIntent | null,
  ): void;
  log: {
    info(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
  };
}

export interface SessionAgentSwitchResult {
  switched: boolean;
  agentKind: AgentKind;
  model: string;
  /** 新引擎 live session 是否已就绪;false 时下一条消息走 lazy-create 重试。 */
  engineReady: boolean;
  /**
   * turn 运行中登记为 pending:切换不打断当前 turn,推迟到下一条消息发送时刻
   * 由 send 事务执行(applyPendingAgentSwitchIfIdle)。true 时 switched=false,
   * 会话状态(DB / 消息流 / chip)保持旧引擎——旧 turn 确实仍由旧引擎驱动。
   */
  deferred?: boolean;
  /** resume 回落的原子事务失败,保留切换意图供下一条消息重试恢复尾段。 */
  retryPending?: boolean;
  /**
   * 同引擎 no-op 成功清除意图后的 host 修订号。renderer 后续 SET_MODEL 必须带回
   * 该值做 CAS，防止另一控制端的更新在 ack 往返期间被旧选择覆盖。
   */
  sameEngineRevision?: number;
  /** 同引擎请求已被更晚的意图写入/撤销超车，renderer 必须丢弃旧选择。 */
  sameEngineSuperseded?: boolean;
}

/** 登记的切换意图(下一条消息发送时刻执行;effort/fastMode 由 renderer 按目标引擎解析好带入)。 */
export interface PendingAgentSwitchIntent {
  targetAgentKind: AgentKind;
  model: string;
  providerId: string | null | undefined;
  effort?: string;
  fastMode?: boolean;
  /** resume 回落事务失败后的内部恢复载荷；下一次 send 先重试这笔原子事务。 */
  resumeFallbackRecovery?: {
    boundaryClientId: string | null;
    boundaryContent: AgentSwitchBoundaryContent;
    handoff: string;
    /**
     * 构造这份 handoff 时的 clear 纪元。重试路径必须用它、而不是重试开始时重读——
     * intent 里的 handoff 是按**当初**的历史生成的,若这中间用户 /clear 过(而 /clear
     * 并不取消 intent),重读会拿到 clear 之后的纪元,让这份已作废的历史绕过墓碑写回去。
     */
    handoffClearEpoch?: number;
  };
}

/** 控制端可见的 pending intent 投影；刻意排除 main 内部恢复载荷。 */
export interface PublicAgentSwitchIntent {
  targetAgentKind: AgentKind;
  model: string;
  providerId: string | null;
  effort?: string;
  fastMode?: boolean;
}

/**
 * pending 切换意图注册表(内存;重启丢失可接受——与凭证 deferred 同级的轻量意图,
 * 用户重开后重新选择即可)。同 session 重复登记 = 覆盖(用户改主意);SET_MODEL /
 * 同引擎 no-op 切换会清除(用户选回当前引擎)。
 */
export interface PendingAgentSwitchRegistry {
  set(sessionId: string, intent: PendingAgentSwitchIntent): void;
  get(sessionId: string): PendingAgentSwitchIntent | undefined;
  clear(sessionId: string): void;
  /** session 级单调修订号；set / clear（含 ABA）都会推进。 */
  revision?(sessionId: string): number;
  /** 修订号仍匹配才清除，成功返回清除后的新修订号，否则返回 null。 */
  clearIfRevision?(sessionId: string, expectedRevision: number): number | null;
}

/** 将 main 内部 intent 收窄成可跨 IPC / device-link 暴露的只读投影。 */
export function projectPendingAgentSwitchIntent(
  intent: PendingAgentSwitchIntent | undefined,
): PublicAgentSwitchIntent | null {
  if (!intent) return null;
  return {
    targetAgentKind: intent.targetAgentKind,
    model: intent.model,
    providerId: intent.providerId ?? null,
    ...(intent.effort ? { effort: intent.effort } : {}),
    ...(typeof intent.fastMode === 'boolean' ? { fastMode: intent.fastMode } : {}),
  };
}

export function createPendingAgentSwitchRegistry(): PendingAgentSwitchRegistry {
  const pending = new Map<string, PendingAgentSwitchIntent>();
  const revisions = new Map<string, number>();
  const bump = (sessionId: string): number => {
    const next = (revisions.get(sessionId) ?? 0) + 1;
    revisions.set(sessionId, next);
    return next;
  };
  return {
    set: (sessionId, intent) => {
      pending.set(sessionId, intent);
      bump(sessionId);
    },
    get: (sessionId) => pending.get(sessionId),
    clear: (sessionId) => {
      pending.delete(sessionId);
      bump(sessionId);
    },
    revision: (sessionId) => revisions.get(sessionId) ?? 0,
    clearIfRevision: (sessionId, expectedRevision) => {
      if ((revisions.get(sessionId) ?? 0) !== expectedRevision) return null;
      pending.delete(sessionId);
      return bump(sessionId);
    },
  };
}

/** SET_MODEL 成功后才取消跨引擎意图；apply 抛错时 registry 与 renderer 都不动。 */
export async function applySetModelThenCancelAgentSwitchIntent<T>(
  pendingSwitches: PendingAgentSwitchRegistry,
  sessionId: string,
  applySetModel: () => Promise<T>,
  broadcastCanceled: (sessionId: string) => void,
): Promise<T> {
  const result = await applySetModel();
  pendingSwitches.clear(sessionId);
  broadcastCanceled(sessionId);
  return result;
}

/** 业务体(纯依赖注入,单测直接调):校验 → 交接 → 提交 → 重建。 */
export async function performSessionAgentSwitch(
  deps: MakerSessionAgentSwitchHandlerDeps,
  params: {
    sessionId: unknown;
    targetAgentKind: unknown;
    model: unknown;
    providerId?: unknown;
    /** 目标引擎下应生效的 effort / fastMode(renderer 按目标目录与预设解析好带入)。 */
    effort?: unknown;
    fastMode?: unknown;
    /**
     * pending-apply 路径(send 事务派发前执行):跳过新引擎立即重建——send 随后
     * 的 lazy-create 会按 DB 新值 spawn(reconcileCreateOptsWithDb 校正兜底),
     * 不必重复 bootstrap 一次。
     */
    skipBootstrap?: boolean;
    /**
     * 意图制(2026-07-20 产品反馈"切换应以消息实际发出为准"):外部调用(IPC)
     * 一律只登记意图立即返回 deferred——用户在选择器里反复改选零成本,不反复
     * 关引擎/建交接/插边界行;真正的切换事务只在下一条消息发送时刻由
     * applyPendingAgentSwitchIfIdle 以 applyNow=true 执行一次。
     */
    applyNow?: boolean;
    /** Abort signal for direct scheduler/IM sends; checked at side-effect boundaries. */
    signal?: AbortSignal;
  },
): Promise<SessionAgentSwitchResult> {
  const { sessionId, targetAgentKind, model, providerId, signal } = params;
  throwIfAgentSwitchAborted(signal);
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throwIpcError('INVALID_PARAMS', 'sessionId required');
  }
  if (targetAgentKind !== 'claude-code' && targetAgentKind !== 'codex' && targetAgentKind !== 'pi') {
    throwIpcError('INVALID_PARAMS', 'targetAgentKind must be claude-code | codex | pi');
  }
  if (typeof model !== 'string' || model.length === 0) {
    throwIpcError('INVALID_PARAMS', 'model required');
  }
  if (providerId !== undefined && providerId !== null && typeof providerId !== 'string') {
    throwIpcError('INVALID_PARAMS', 'providerId must be string | null');
  }
  // 必须在第一个 await 前快照：跨窗口 / 跨设备写入即使 set→clear 回到同值，修订号也会变化。
  const pendingRevisionAtStart = deps.pendingSwitches?.revision?.(sessionId);
  let normalizedProviderId =
    typeof providerId === 'string' ? providerId.trim() || null : providerId;

  // 停用轴准入(PR #744 review):意图登记与 applyNow 提交都要过裁决(applyNow 重入
  // 本函数时按最新目录再判一次)。目标路由被停用 → 抛错;隐式默认落点被停用而有
  // 启用替代拷贝 → 直接以显式来源落地(后续意图/提交/内存路由全部用改后的值)。
  if (deps.assertModelRouteUsable) {
    const reroute = await deps.assertModelRouteUsable(
      targetAgentKind,
      model,
      typeof normalizedProviderId === 'string' ? normalizedProviderId : null,
    );
    if (reroute && shouldApplyExclusiveProviderRerouteLive(normalizedProviderId)) {
      normalizedProviderId = reroute;
    }
  }

  const row = await deps.getSessionRow(sessionId);
  throwIfAgentSwitchAborted(signal);
  if (!row || row.status === 'deleted') {
    throwIpcError('NOT_FOUND', `Session ${sessionId} not found`);
  }
  if (row.source === 'review') {
    throwIpcError('UNSUPPORTED_CAPABILITY', 'Review task settings are fixed to the source task');
  }
  if (row.remoteHostId) {
    // SSH 远程会话:agent 进程在远端机器,cc-manager 链路仅覆盖 Claude,v1 不支持切换。
    throwIpcError('UNSUPPORTED_CAPABILITY', 'agent switch is not supported for remote sessions');
  }
  if (row.orcaRole) {
    // Orca lead/worker:协同运行时对 agent 形态有独立契约(docs/dev-rules/orca-team-architecture.md),不掺和。
    throwIpcError('UNSUPPORTED_CAPABILITY', 'agent switch is not supported for Orca sessions');
  }

  const fromDbKind: DbAgentKind = normalizeDbAgentKind(row.agentKind);
  const toDbKind: DbAgentKind = makerToDbAgentKind(targetAgentKind);
  if (fromDbKind === toDbKind) {
    // 同引擎 = 纯模型切换,调用方应走 SET_MODEL;这里按 no-op 成功返回。
    // 顺带清 pending:用户先登记了跨引擎切换、又选回当前引擎 = 改主意取消。
    let sameEngineRevision: number | undefined;
    if (deps.pendingSwitches?.clearIfRevision && pendingRevisionAtStart !== undefined) {
      const clearedRevision = deps.pendingSwitches.clearIfRevision(
        sessionId,
        pendingRevisionAtStart,
      );
      if (clearedRevision === null) {
        return {
          switched: false,
          agentKind: targetAgentKind,
          model,
          engineReady: true,
          sameEngineSuperseded: true,
        };
      }
      sameEngineRevision = clearedRevision;
    } else {
      // 最小测试 harness / 旧内嵌调用方没有修订能力时维持原 no-op 清除语义。
      deps.pendingSwitches?.clear(sessionId);
    }
    deps.onPendingSwitchChanged?.(sessionId, null);
    return {
      switched: false,
      agentKind: targetAgentKind,
      model,
      engineReady: true,
      ...(sameEngineRevision !== undefined ? { sameEngineRevision } : {}),
    };
  }

  // 跨引擎选择比此前登记的凭证切换更新；即使旧切换已在 await close，清掉登记后
  // 它也会在收口前重读并放弃，避免 DB 已是新 agent、内存 route 却被旧 provider 覆盖。
  deps.supersedePendingCredentialSwitch?.(sessionId);

  // 意图制:外部调用(非 applyNow)一律只登记意图——空闲/运行中同一语义,
  // 用户反复改选零成本;renderer 乐观显示意图,真切换在下一条消息发送时刻执行。
  // 重复登记 = 覆盖(同一意图的最新表达)。
  if (!params.applyNow && deps.pendingSwitches) {
    const intent: PendingAgentSwitchIntent = {
      targetAgentKind,
      model,
      providerId: normalizedProviderId,
      ...(typeof params.effort === 'string' && params.effort ? { effort: params.effort } : {}),
      ...(typeof params.fastMode === 'boolean' ? { fastMode: params.fastMode } : {}),
    };
    deps.pendingSwitches.set(sessionId, intent);
    deps.onPendingSwitchChanged?.(sessionId, projectPendingAgentSwitchIntent(intent));
    deps.log.info('agent-switch: intent registered (applies on next send)', {
      sessionId,
      targetAgentKind,
      model,
    });
    return { switched: false, agentKind: targetAgentKind, model, engineReady: true, deferred: true };
  }

  const live = deps.getLiveSession(sessionId);
  if (live?.isTurnRunning()) {
    // applyNow 只应在空闲时被调用(applyPendingAgentSwitchIfIdle 已前置检查);
    // 竞态兜底:仍在跑就拒绝,绝不打断进行中的 turn。
    throwIpcError('SESSION_RUNNING', `Session ${sessionId} is running a turn`);
  }
  // 交接注册表代次:必须在读历史**之前**取。下面到 setPendingHandoff 之间全是异步活,
  // 期间用户可能 /clear——带上它,过期的写入会被 registry 丢弃而不是盖掉墓碑。
  const handoffGeneration = deps.readPendingHandoffGeneration?.(sessionId);
  // 交接素材与停泊绑定先于任何状态变更取得(失败不留半切换状态)。
  // Phase 2:目标引擎有停泊原生会话 → resume + 增量交接(只补离开期间的进展,
  // 工作状态区仍按全量历史提取);无绑定 → v1 全量交接 + 全新原生会话。
  const parked = deps.findParkedEngineSession
    ? await deps.findParkedEngineSession(sessionId, toDbKind)
    : null;
  const fullSourceMessages = await deps.listMessagesForHandoff(sessionId);
  throwIfAgentSwitchAborted(signal);
  const handoffOptsBase = {
    fromLabel: agentEngineLabel(fromDbKind),
    toLabel: agentEngineLabel(toDbKind),
    // 附带早期原文检索指引(get_chat_history / search_chat_history 定向到本会话)。
    sessionId,
  };
  const buildFullHandoff = () => buildHandoffText(fullSourceMessages, handoffOptsBase);
  let handoff: string;
  if (parked) {
    const deltaMessages = await deps.listMessagesForHandoff(sessionId, {
      createdAt: parked.watermarkCreatedAt,
      rowid: parked.watermarkRowid,
    });
    handoff = buildHandoffText(deltaMessages, {
      ...handoffOptsBase,
      mode: 'delta',
      workStateMessages: fullSourceMessages,
    });
  } else {
    handoff = buildFullHandoff();
  }

  return deps.withCloseSuppressed(sessionId, async () => {
    throwIfAgentSwitchAborted(signal);
    if (live) {
      await deps.closeSession(sessionId);
    }

    // 停用轴:提交点重裁决(PR #744 review 第十五轮)—— parked 数据加载、handoff
    // 构建、closeSession 都是长 await,入口裁决可能已过期。此刻拒绝仍安全:DB 未写,
    // 旧会话即使已关也只是下一次发送按旧路由懒重建,不产生新的停用路由请求。
    if (deps.assertModelRouteUsable) {
      const rerouteAtCommit = await deps.assertModelRouteUsable(
        targetAgentKind,
        model,
        typeof normalizedProviderId === 'string' ? normalizedProviderId : null,
      );
      if (rerouteAtCommit && typeof normalizedProviderId !== 'string') {
        normalizedProviderId = rerouteAtCommit;
      }
    }

    // ---- commit point:此后切换生效 ----
    await deps.applyAgentSwitchToDb(sessionId, {
      agentKind: toDbKind,
      model,
      providerId: normalizedProviderId,
      sdkSessionId: parked?.sdkSessionId ?? null,
      ...(typeof params.effort === 'string' && params.effort ? { effort: params.effort } : {}),
      ...(typeof params.fastMode === 'boolean' ? { fastMode: params.fastMode } : {}),
    });
    if (normalizedProviderId !== undefined) {
      deps.setSessionProvider(sessionId, normalizedProviderId);
    }

    const boundaryContent: AgentSwitchBoundaryContent = {
      fromAgentKind: fromDbKind,
      toAgentKind: toDbKind,
      fromModel: row.model,
      toModel: model,
      fromProviderId: row.providerId,
      toProviderId:
        normalizedProviderId === undefined ? row.providerId : normalizedProviderId,
      fromSdkSessionId: row.sdkSessionId,
      handoff,
      resumed: !!parked,
      consumed: false,
    };
    let boundaryClientId: string | null = null;
    try {
      boundaryClientId = await deps.insertBoundaryMessage(sessionId, boundaryContent);
    } catch (err) {
      // 降级:分隔条缺失是外观问题;注入语义由下面的内存 pending 保住(本进程内)。
      deps.log.warn('agent-switch: boundary message insert failed (degraded)', {
        sessionId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
    deps.setPendingHandoff(sessionId, handoff, handoffGeneration);

    let engineReady = true;
    let resumed = !!parked;
    let retryPending = false;
    // resume 模式无视 skipBootstrap:只有 eager spawn 才能确定性观测 resume 失败
    // 并在同一事务内回落全量交接;交给 lazy-create 的话,失效的停泊 id 会让之后
    // 每次发送反复失败且无人回落。
    if (parked || !params.skipBootstrap) {
      try {
        await deps.bootstrapSwitchedSession(sessionId);
      } catch (err) {
        if (parked) {
          // ---- resume 回落:清停泊 id → 换全量交接 → 全新原生会话重试 ----
          // 停泊原生会话可能已失效(transcript 被清理、CLI 升级不兼容等),这些
          // 只有 spawn 时才暴露。回落是确定性代码路径,不留半 resume 状态。
          deps.log.warn('agent-switch: resume parked session failed; fallback to fresh + full handoff', {
            sessionId,
            targetAgentKind,
            parkedSdkSessionId: parked.sdkSessionId,
            err: err instanceof Error ? err.message : String(err),
          });
          resumed = false;
          const fullHandoff = buildFullHandoff();
          const fallbackBoundaryContent = {
            ...boundaryContent,
            handoff: fullHandoff,
            resumed: false,
          };
          let fallbackCommitted = false;
          if (boundaryClientId) {
            try {
              await deps.applyResumeFallbackAtomically(
                sessionId,
                boundaryClientId,
                fallbackBoundaryContent,
              );
              fallbackCommitted = true;
            } catch (err2) {
              // 清 id 与改边界必须同成同败。失败后重新登记完整意图与恢复载荷,
              // 下一条消息先重试原子恢复尾段,而不是带半状态继续 lazy-create。
              deps.pendingSwitches?.set(sessionId, {
                targetAgentKind,
                model,
                providerId: normalizedProviderId,
                ...(typeof params.effort === 'string' && params.effort ? { effort: params.effort } : {}),
                ...(typeof params.fastMode === 'boolean' ? { fastMode: params.fastMode } : {}),
                resumeFallbackRecovery: {
                  boundaryClientId,
                  boundaryContent: fallbackBoundaryContent,
                  handoff: fullHandoff,
                  handoffClearEpoch: handoffGeneration,
                },
              });
              engineReady = false;
              retryPending = true;
              deps.log.warn('agent-switch: atomic resume fallback failed; intent retained for retry', {
                sessionId,
                err: err2 instanceof Error ? err2.message : String(err2),
              });
            }
          } else {
            // 边界插入失败时无法原子保证“清 id + 改边界”。保留意图自愈,
            // 避免只清 sdk id 后 DB pending 与实际注入内容分叉。
            deps.pendingSwitches?.set(sessionId, {
              targetAgentKind,
              model,
              providerId: normalizedProviderId,
              ...(typeof params.effort === 'string' && params.effort ? { effort: params.effort } : {}),
              ...(typeof params.fastMode === 'boolean' ? { fastMode: params.fastMode } : {}),
              resumeFallbackRecovery: {
                boundaryClientId: null,
                boundaryContent: fallbackBoundaryContent,
                handoff: fullHandoff,
                handoffClearEpoch: handoffGeneration,
              },
            });
            engineReady = false;
            retryPending = true;
            deps.log.warn('agent-switch: resume fallback has no boundary row; intent retained for retry', {
              sessionId,
            });
          }
          // 仍用最初那个纪元,**不要**在这里重读:纪元只由 /clear 推进,所以覆盖自己
          // 先前写的增量交接本来就不会被挡;而重读会在"期间发生过 /clear、首次写入
          // 已被正确拒绝"时拿到 clear 之后的新纪元,让这份基于清空前历史构造的全量
          // 交接反而绕过墓碑写进去。
          deps.setPendingHandoff(sessionId, fullHandoff, handoffGeneration);
          if (fallbackCommitted) {
            try {
              await deps.bootstrapSwitchedSession(sessionId);
            } catch (err2) {
              engineReady = false;
              deps.log.warn('agent-switch: fresh bootstrap after resume fallback failed', {
                sessionId,
                targetAgentKind,
                err: err2 instanceof Error ? err2.message : String(err2),
              });
            }
          }
        } else {
          engineReady = false;
          deps.log.warn('agent-switch: bootstrap new engine failed; next send will lazy-create', {
            sessionId,
            targetAgentKind,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    deps.log.info('agent-switch: switched', {
      sessionId,
      from: fromDbKind,
      to: toDbKind,
      model,
      engineReady,
      resumed,
      handoffChars: handoff.length,
    });
    return {
      switched: true,
      agentKind: targetAgentKind,
      model,
      engineReady,
      ...(retryPending ? { retryPending: true } : {}),
    };
  });
}

/**
 * send 事务派发前执行 pending 切换(makerSendTransaction.applyPendingAgentSwitch
 * 钩子的实现体)。语义:
 *  - 无 pending → no-op;
 *  - turn 仍在跑(排队消息提前 drain 等竞态)→ 保留 pending 本次不 apply,交给
 *    send 事务既有的 SESSION_RUNNING guard / coordinator 重试;
 *  - 空闲 → 执行完整切换事务(skipBootstrap:随后的 lazy-create 会按 DB 新值
 *    spawn),成功后才以 CAS 清 pending;
 *  - 执行失败不阻塞发送,但保留原意图,下一条消息自动重试。resume 回落事务
 *    已进入 commit point 后若失败,则只重试其原子恢复尾段。
 */
const pendingAgentSwitchApplyInFlight = new Map<string, Promise<void>>();

export function applyPendingAgentSwitchIfIdle(
  deps: MakerSessionAgentSwitchHandlerDeps,
  sessionId: string,
  opts?: { bootstrapAfterSwitch?: boolean; signal?: AbortSignal },
): Promise<void> {
  const existing = pendingAgentSwitchApplyInFlight.get(sessionId);
  if (existing) return existing;

  // `run` is captured by its own finally handler to clear the in-flight map.
  let run: Promise<void>;
  // eslint-disable-next-line prefer-const
  run = (async () => {
    throwIfAgentSwitchAborted(opts?.signal);
    const intent = deps.pendingSwitches?.get(sessionId);
    if (!intent) return;
    const live = deps.getLiveSession(sessionId);
    if (live?.isTurnRunning()) return;
    try {
      if (intent.resumeFallbackRecovery) {
        const recovery = intent.resumeFallbackRecovery;
        throwIfAgentSwitchAborted(opts?.signal);
        // 用**构造这份 handoff 时**记下的纪元,不要在这里重读:intent 里的 handoff 按
        // 当初的历史生成,而 /clear 并不取消 intent——重读会拿到 clear 之后的纪元,让
        // 这份已作废的历史绕过墓碑写回去。
        const recoveryHandoffGeneration = recovery.handoffClearEpoch;
        const boundaryClientId = recovery.boundaryClientId ??
          await deps.insertBoundaryMessage(sessionId, recovery.boundaryContent);
        // 边界补写成功、原子事务仍失败时记住 id；下次只重试事务，不重复插边界。
        recovery.boundaryClientId = boundaryClientId;
        await deps.applyResumeFallbackAtomically(
          sessionId,
          boundaryClientId,
          recovery.boundaryContent,
        );
        deps.setPendingHandoff(sessionId, recovery.handoff, recoveryHandoffGeneration);
        if (deps.pendingSwitches?.get(sessionId) === intent) {
          deps.pendingSwitches.clear(sessionId);
          deps.onPendingSwitchChanged?.(sessionId, null);
        }
        return;
      }
      const result = await performSessionAgentSwitch(deps, {
        sessionId,
        targetAgentKind: intent.targetAgentKind,
        model: intent.model,
        providerId: intent.providerId,
        effort: intent.effort,
        fastMode: intent.fastMode,
        // 普通 maker send 随后会按 DB 真源 lazy-create,无需在 apply 内多 spawn 一次;
        // Goal / IM / scheduler 三条直发路径没有该 lazy-create 事务,必须先把新引擎
        // bootstrap 好再拿 live session 发送,否则会继续持有已关闭的旧 session。
        skipBootstrap: opts?.bootstrapAfterSwitch !== true,
        applyNow: true,
        signal: opts?.signal,
      });
      // CAS 语义:执行期间用户可能又选了另一个目标,不能把新意图一起清掉。
      if (!result.retryPending && deps.pendingSwitches?.get(sessionId) === intent) {
        deps.pendingSwitches.clear(sessionId);
        deps.onPendingSwitchChanged?.(sessionId, null);
      }
      // Once the switch has committed, the intent has been consumed even if
      // cancellation arrived during the final bootstrap step.  The caller's
      // post-apply guard will still abort the fire without replaying it.
      throwIfAgentSwitchAborted(opts?.signal);
    } catch (err) {
      // 失败(包括 pre-check 后 running guard 的竞态)保留原 intent,下一次发送重试。
      deps.log.warn('agent-switch: pending apply failed; intent retained for next send', {
        sessionId,
        targetAgentKind: intent.targetAgentKind,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  })().finally(() => {
    if (pendingAgentSwitchApplyInFlight.get(sessionId) === run) {
      pendingAgentSwitchApplyInFlight.delete(sessionId);
    }
  });
  pendingAgentSwitchApplyInFlight.set(sessionId, run);
  return run;
}

export function registerMakerSessionAgentSwitchHandler(
  registry: IpcHandlerRegistry,
  deps: MakerSessionAgentSwitchHandlerDeps,
): void {
  registry.handle(
    MAKER_INVOKE.SWITCH_SESSION_AGENT,
    async (
      _e,
      sessionId: unknown,
      targetAgentKind: unknown,
      model: unknown,
      providerId: unknown,
      effort: unknown,
      fastMode: unknown,
    ) => {
      const run = () => performSessionAgentSwitch(deps, {
        sessionId,
        targetAgentKind,
        model,
        providerId,
        effort,
        fastMode,
      });
      return typeof sessionId === 'string' && sessionId && deps.withSessionLock
        ? deps.withSessionLock(sessionId, run)
        : run();
    },
  );
  registry.handle(
    MAKER_INVOKE.GET_SESSION_AGENT_SWITCH_INTENT,
    (_e, sessionId: unknown) => {
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        throwIpcError('INVALID_PARAMS', 'sessionId required');
      }
      return projectPendingAgentSwitchIntent(deps.pendingSwitches?.get(sessionId));
    },
  );
}
