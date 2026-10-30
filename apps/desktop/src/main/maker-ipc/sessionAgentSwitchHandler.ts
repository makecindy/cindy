/**
 * session-agent-switch:同一会话的引擎／模型选择与发送时应用。
 *
 * 意图制(2026-07-20):外部调用(IPC)只登记切换意图并返回 deferred——用户在
 * 选择器里反复改选零成本;renderer 乐观呈现意图。真切换在下一条消息发送时刻由
 * send 事务(applyPendingAgentSwitchIfIdle → applyNow=true)执行一次:
 *   校验 → 查目标引擎停泊绑定(Phase 2)→ 构造交接文本(纯代码,
 *   agentHandoff.buildHandoffText:有停泊绑定 = 增量模式,否则全量)
 *   → 关旧 live session → DB 提交(agent_kind + model + provider_id + effort/fast;
 *   sdk_session_id 落迁移／停泊 id 或 null)→ 插 agent_switch 边界行(交接全文持久化
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
 * 边界:远程会话(remoteHostId)仍不支持切换(UNSUPPORTED_CAPABILITY)。Orca Lead/Worker
 * 复用同一交接与停泊事务，协同身份由 vendorOptions/DB 在重建时恢复。
 * Orca Lead 的 Agent 在另一台电脑时，关闭旧远程会话若因链路失败(离线/不可达/超时/拥塞/无响应)
 * 而没送到对方，不挡住 Lead 离开那台电脑；其它错误仍原样抛出。
 * turn 进行中登记 pending 推迟到下一条消息发送时刻执行。
 *
 * 远程 Agent 换电脑(agentDeviceId 变化,null = 任务所在电脑):原生会话记录在原来运行 Agent
 * 的那台电脑上；同引擎优先迁移原生历史并恢复，不可用时回落到有界交接；
 * 目标是另一台电脑时，登记与落地前都按那台的目录校验，不留一个发送时必然失败的意图。
 */

import type { AgentKind } from '@cindy/maker-core';
import { getDeviceLinkInvokeContext, isDeviceLinkInvoke, runOutsideDeviceLinkInvokeContext } from '../device-link/invoke-context.js';
import { parseOrcaRemoteLead } from '../../shared/orcaRemoteWorker.js';
import { isProviderShareAgentDeviceId } from '../../shared/providerShare.js';
import { createSharedTaskPendingSelectionGuard, createSharedTaskSettingGuard } from './sharedTaskSetting.js';

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

/**
 * closeSession 失败时仍可切回本机的链路错误码。两侧都认：
 * 裸码 = main→main 经 remoteAgentLinkError 保留的 DeviceLinkError.code；
 * DEVICE_LINK_* = ipc.ts DEVICE_LINK_CODE_MAP 给 renderer 的映射名（消息里的前缀）。
 * 不认：REMOTE_DISABLED / CHANNEL_NOT_ALLOWED / ACCESS_REVOKED / VERSION_MISMATCH / 裸 TIMEOUT / 无 code 的 REMOTE_AGENT_UNAVAILABLE。
 * 改这里时对照 apps/desktop/src/main/device-link/ipc.ts 的 DEVICE_LINK_CODE_MAP。
 */
const AGENT_SWITCH_LINK_CLOSE_CODES = new Set([
  'DEVICE_OFFLINE',
  'INVOKE_TIMEOUT',
  'DEVICE_UNRESPONSIVE',
  'NOT_CONNECTED',
  'LINK_NOT_OPEN',
  'PEER_RESET',
  'BACKPRESSURE',
  'DEVICE_LINK_DEVICE_OFFLINE',
  'DEVICE_LINK_TIMEOUT',
  'DEVICE_LINK_DEVICE_UNRESPONSIVE',
  'DEVICE_LINK_NOT_CONNECTED',
  'DEVICE_LINK_BUSY',
]);

function agentSwitchLinkCloseErrorCode(error: unknown): string | null {
  const tokens = new Set<string>();
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && code) tokens.add(code);
  const message = error instanceof Error ? error.message : String(error ?? '');
  for (const match of message.matchAll(/\[([A-Z_]+)\]/g)) tokens.add(match[1]!);
  for (const token of tokens) {
    if (AGENT_SWITCH_LINK_CLOSE_CODES.has(token)) return token;
  }
  return null;
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
  /**
   * 只在 Agent 换电脑时出现:离场 / 目标位置(null = 任务所在电脑)。名称在切换时快照,
   * 那台电脑之后改名或移除，分隔条仍看得懂；缺名称时界面显示「另一台电脑」。
   */
  fromAgentDeviceId?: string | null;
  toAgentDeviceId?: string | null;
  fromAgentDeviceName?: string | null;
  toAgentDeviceName?: string | null;
  /**
   * 只在供应商组换电脑、且原因要告诉用户时出现：`quota-rebalance` = 用户确认为了先用那台的配额换过去
   * (原电脑没出问题，provider-groups.md §6.2「任务进行中换号」)。旧端忽略，照常显示「Agent 已改到 X 上运行」。
   */
  switchReason?: 'quota-rebalance';
  /** Distinguishes native relocation from a lossy fallback; absent on old boundaries. */
  nativeHistory?: 'restored' | 'fallback';
}

const NATIVE_RELOCATION_NOTE = '[Session location changed] Your native conversation history was restored on another computer. '
  + 'Continue the current task. Use the current environment and tools for file paths and running processes; '
  + 'historical machine-local paths and process handles may no longer apply.';

function nativeRelocationHandoff(pending: string | null | undefined): string {
  if (!pending) return NATIVE_RELOCATION_NOTE;
  // A previous switch may have opened a native session without sending its pending context yet.
  // Repeated relocations reuse the same location note instead of growing a chain of notes.
  return pending.startsWith(NATIVE_RELOCATION_NOTE) ? pending : `${NATIVE_RELOCATION_NOTE}\n\n${pending}`;
}

export interface AgentSwitchSessionRow {
  id: string;
  agentKind: string;
  model: string | null;
  providerId: string | null;
  status: string;
  remoteHostId: string | null;
  orcaRole: string | null;
  /** Execution-device Worker binding; these tasks have no local orcaRole. */
  orcaRemoteLead?: string | null;
  sdkSessionId: string | null;
  workingDir?: string | null;
  source?: string | null;
  /** Agent 在哪台电脑运行(null / 缺省 = 任务所在电脑)。 */
  agentDeviceId?: string | null;
}

/** 与 create-session 的 agentDeviceId 校验同一口径。 */
const AGENT_DEVICE_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

export interface MakerSessionAgentSwitchHandlerDeps {
  /**
   * 任务要换到供应商组那一项(组所在电脑上那个建了组的供应商)时，由组按它的状态选一台能用的电脑
   * (docs/product-rules/provider-groups.md §6)：返回选中那台的位置；不是组那一项或组读不到返回 null(照用户选的位置)；
   * 组里都不能用时抛错。只在真正提交(applyNow)、要换电脑时调用。缺省 = 不经组选。
   */
  resolveProviderGroupTarget?(
    sessionId: string,
    target: {
      agentKind: 'claude-code' | 'codex' | 'pi' | 'zcode';
      model: string;
      providerId: string | null;
      /** 用户选的位置(null = 任务所在电脑)。 */
      agentDeviceId: string | null;
      /** 任务此刻的位置。 */
      current: { agentDeviceId: string | null; providerId: string | null };
    },
  ): Promise<{
    agentDeviceId: string | null;
    providerId: string | null;
    /**
     * 把这次选中的组内电脑写进绑定；调用方必须等本次切换真正提交成功再调用，
     * 不要在选定位置后立即调(chatgpt-codex-connector P2, PR #5792 review)。
     */
    commitBinding?: () => Promise<void>;
  } | null>;
  /** Same-engine choices use SET_MODEL validation; only the send boundary applies them. Caller owns the session lock. */
  selectSameAgentModel?(
    sessionId: string,
    intent: PendingAgentSwitchIntent,
    applyNow: boolean,
    assertSelectionCurrent?: () => void,
    beforeMutation?: () => Promise<void>,
    pendingSelectionAccess?: ReturnType<typeof createSharedTaskPendingSelectionGuard>,
  ): Promise<{ deferred: boolean; superseded?: boolean }>;
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
    agent: 'claude-code' | 'codex' | 'pi' | 'zcode',
    model: string,
    providerId: string | null,
    /** 被切换的任务；Agent 在另一台电脑运行的任务按那台的目录裁决(本机不校验)。 */
    sessionId?: string,
    /** 本次选择的 Agent 位置；undefined = 按任务当前位置，null = 任务所在电脑。 */
    targetAgentDeviceId?: string | null,
  ): Promise<string | undefined>;
  /**
   * Agent 将在另一台电脑运行时的准入：那台在线、允许被远程调用该供应商、目录里有这个模型。
   * 不满足抛错。缺省 = 不校验(测试最小 harness)。
   */
  assertAgentDeviceRouteUsable?(
    deviceId: string,
    agent: 'claude-code' | 'codex' | 'pi' | 'zcode',
    model: string,
    providerId: string | null,
  ): Promise<void>;
  /** 分隔条展示用的电脑名(null = 任务所在电脑)。缺省 = 不记名称。 */
  describeAgentDevice?(deviceId: string | null): string | null;
  getSessionRow(sessionId: string): Promise<AgentSwitchSessionRow | null>;
  getLiveSession(sessionId: string): { isTurnRunning(): boolean; sdkSessionId?: string } | null | undefined;
  readOwnerGeneration?(): number;
  confirmNativeHistoryFallback?(sessionId: string, targetDeviceId: string | null): Promise<boolean>;
  relocateNativeHistory?(input: {
    sessionId: string; kind: 'claude-code' | 'codex' | 'pi' | 'zcode'; nativeId: string; workingDir: string;
    fromDevice: string | null; toDevice: string | null; assertCurrent(): void;
  }): Promise<string | null>;
  closeSession(sessionId: string): Promise<void>;
  /** after = 停泊水位线(Phase 2 增量交接):只取严格晚于该边界行的消息。 */
  listMessagesForHandoff(
    sessionId: string,
    after?: { createdAt: number; rowid: number },
  ): Promise<HandoffSourceMessage[]>;
  /** 伙伴工作记忆账本渲染段(botWorkingMemory);全量交接时带上,增量交接(停泊会话 resume)不带。 */
  readWorkingMemoryNote?(sessionId: string): Promise<string | null>;
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
      fastMode?: boolean | 'ultrafast';
      /** Agent 换电脑:undefined = 不动,null = 改回任务所在电脑。 */
      agentDeviceId?: string | null;
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
  peekPendingHandoff?(sessionId: string): Promise<string | null>;
  /** 从 DB 行(切换已提交后的新值)重建 live session;抛错 = 引擎未就绪。 */
  /** 记录用户对目标模型的思考开关选择（跨引擎切换提交后落本机偏好镜像）。 */
  rememberThinkingIntent?(input: {
    agentKind: AgentKind;
    providerId: string | null;
    model: string;
    thinking: boolean;
  }): void;
  bootstrapSwitchedSession(sessionId: string, opts?: { thinkingEnabled?: boolean; nativeHistoryResume?: boolean }): Promise<void>;
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
  /**
   * 用户选择的路由落地(应用成功)后回调 —— 供 IM 侧给任务打「脱离跟随」标记:
   * 「单独改过」按选择行为判定, 同值重选也永久脱离跟随(greptile P1 补充, PR #5155)。
   * 系统配置对齐(configStaged)与 Agent 自选不触发。**失败会抛错**: 墓碑写不进去时
   * 意图保留、下一条消息重试, 不把用户选择当成功消费。
   */
  onUserRouteSelectionLanded?(sessionId: string): void | Promise<void>;
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
   * engineReady=false 时新会话没能启动的原因(错误原文)。供应商组换电脑据此判断是不是那台电脑的问题、要不要
   * 换下一台(provider-group/failurePolicy)。
   */
  bootstrapError?: string;
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
  /** Agent-requested complete selection, exposed by the runtime control query. */
  runtimeSource?: 'agent';
  /**
   * 系统配置对齐(IM 渠道默认跟随 / 伙伴模型对齐)登记的意图 —— 不是用户选择,
   * 落地时不给任务打「脱离跟随」标记。用户 picker 选择不带此标(PR #5155)。
   */
  configStaged?: boolean;
  /** Auto 跟随登记时验证的两端身份；仅内存使用，目录移除来源后仍可撤销/改登记。 */
  cindyAutoRelocation?: { fromProviderId: string; targetProviderId: string };
  /** SET_MODEL intent: apply the route without a cross-engine handoff. */
  sameAgentSelection?: boolean;
  targetAgentKind: AgentKind;
  model: string;
  providerId: string | null | undefined;
  effort?: string;
  fastMode?: boolean | 'ultrafast';
  /**
   * Agent 在另一台电脑运行的任务：点选时按那台的目录确认过的目标上下文窗口。本机目录里没有
   * 那台的模型，发送时据此做「换小窗口前先交接」。本机 Orca 也保留选择时核对的窗口，
   * 发送时必须与实际目标窗口匹配，不能把 deferred 当作任意窗口的确认。
   */
  confirmedContextWindow?: number;
  /** 选择同时换 Agent 所在电脑(null = 任务所在电脑)；缺省 = 位置不变。 */
  targetAgentDeviceId?: string | null;
  /**
   * Pi-only：目标模型的思考开关意图（renderer 记忆，缺省开）。发送时刻回放暂存
   * 选择时必须一并应用，否则上一模型的 off 会残留——Pi 的 set_model 不重置
   * thinking level。
   */
  thinking?: boolean;
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

/** 用户 picker 意图的统一来源判据；引擎与执行电脑是否改变不影响归属。 */
export function isUserPendingAgentSwitchIntent(
  intent: PendingAgentSwitchIntent | undefined,
): intent is PendingAgentSwitchIntent {
  return !!intent && intent.configStaged !== true && intent.runtimeSource !== 'agent';
}

/** 控制端可见的 pending intent 投影；刻意排除 main 内部恢复载荷。 */
export interface PublicAgentSwitchIntent {
  targetAgentKind: AgentKind;
  model: string;
  providerId: string | null;
  effort?: string;
  fastMode?: boolean | 'ultrafast';
  /** 只在换 Agent 所在电脑时出现(null = 任务所在电脑)；旧控制端忽略。 */
  agentDeviceId?: string | null;
}

/**
 * pending 切换意图注册表(内存;重启丢失可接受——与凭证 deferred 同级的轻量意图,
 * 用户重开后重新选择即可)。同 session 重复登记 = 覆盖(用户改主意)；同引擎
 * 模型选择同样暂存，实际发送才应用，不提前改变原生线程或持久路由。
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
    ...((typeof intent.fastMode === 'boolean' || intent.fastMode === 'ultrafast') ? { fastMode: intent.fastMode } : {}),
    ...(intent.targetAgentDeviceId !== undefined ? { agentDeviceId: intent.targetAgentDeviceId } : {}),
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

/**
 * 打开任务时 Agent 没能启动、要换到另一个位置重新打开(供应商组启动阶段换电脑，docs/product-rules/provider-groups.md §6)：
 * 同 Harness 优先迁移原生记录；源端不可用或目标端不支持时回落有界交接。没有开着的会话
 * (这次就是要打开它)，也不在这里启动：调用方正在启动 Agent，按返回后的任务记录接着打开，这次发送带上交接。
 * `sharedRelocation`：位置仍是同一个分享、由分享者的组换一台(分隔条不写电脑名称)。
 */
export async function relocateForFreshStart(
  deps: Pick<
    MakerSessionAgentSwitchHandlerDeps,
    | 'getSessionRow'
    | 'listMessagesForHandoff'
    | 'readWorkingMemoryNote'
    | 'applyAgentSwitchToDb'
    | 'setSessionProvider'
    | 'insertBoundaryMessage'
    | 'setPendingHandoff'
    | 'readPendingHandoffGeneration'
    | 'peekPendingHandoff'
    | 'relocateNativeHistory'
    | 'readOwnerGeneration'
    | 'applyResumeFallbackAtomically'
    | 'describeAgentDevice'
    | 'log'
  >,
  params: {
    sessionId: string;
    agentDeviceId: string | null;
    providerId: string | null;
    /** 原来那个位置(调用方可能已把任务记录改到了目标位置)；不给 = 按任务记录。 */
    from?: { agentDeviceId: string | null; providerId: string | null };
    sharedRelocation?: boolean;
    assertCurrent?: () => void;
  },
): Promise<{ nativeId: string | null; fallback?: () => Promise<void> }> {
  const ownerGeneration = deps.readOwnerGeneration?.();
  const { sessionId, agentDeviceId, providerId } = params;
  const row = await deps.getSessionRow(sessionId);
  if (!row || row.status === 'deleted') throwIpcError('NOT_FOUND', `Session ${sessionId} not found`);
  if (!row.model) throwIpcError('PRECONDITION_FAILED', `Session ${sessionId} has no model to relocate`);
  const model = row.model;
  const dbKind = normalizeDbAgentKind(row.agentKind);
  const handoffGeneration = deps.readPendingHandoffGeneration?.(sessionId);
  const fullHandoff = buildHandoffText(await deps.listMessagesForHandoff(sessionId), {
    fromLabel: `${agentEngineLabel(dbKind)} (on a different computer)`,
    toLabel: agentEngineLabel(dbKind),
    sessionId,
    workingMemory: (await deps.readWorkingMemoryNote?.(sessionId)) ?? null,
  });
  const fromAgentDeviceId = params.from ? params.from.agentDeviceId : row.agentDeviceId ?? null;
  const fromProviderId = params.from ? params.from.providerId : row.providerId;
  const assertCurrent = () => {
    params.assertCurrent?.();
    if (deps.readOwnerGeneration?.() !== ownerGeneration) throw new Error('REMOTE_AGENT_ACCOUNT_CHANGED');
    if (handoffGeneration !== undefined && deps.readPendingHandoffGeneration?.(sessionId) !== handoffGeneration) {
      throw new Error('Session history changed during agent relocation');
    }
  };
  let nativeId: string | null = null;
  if (!params.sharedRelocation && fromAgentDeviceId !== agentDeviceId && row.sdkSessionId && row.workingDir && deps.relocateNativeHistory) {
    try {
      nativeId = await deps.relocateNativeHistory({ sessionId, kind: dbToMakerAgentKind(dbKind),
        nativeId: row.sdkSessionId, workingDir: row.workingDir, fromDevice: fromAgentDeviceId, toDevice: agentDeviceId, assertCurrent });
    } catch (error) {
      assertCurrent();
      deps.log.warn('agent-switch: native history unavailable on startup relocation', { sessionId, error: String(error) });
    }
  }
  assertCurrent();
  const handoff = nativeId ? nativeRelocationHandoff(await deps.peekPendingHandoff?.(sessionId)) : fullHandoff;
  assertCurrent();
  await deps.applyAgentSwitchToDb(sessionId, {
    agentKind: dbKind,
    model,
    providerId,
    sdkSessionId: nativeId,
    agentDeviceId,
  });
  deps.setSessionProvider(sessionId, providerId);
  const boundaryContent: AgentSwitchBoundaryContent = {
    fromAgentKind: dbKind,
    toAgentKind: dbKind,
    fromModel: row.model,
    toModel: row.model,
    fromProviderId,
    toProviderId: providerId,
    fromSdkSessionId: row.sdkSessionId,
    handoff,
    resumed: !!nativeId,
    nativeHistory: nativeId ? 'restored' : 'fallback',
    consumed: false,
    fromAgentDeviceId,
    toAgentDeviceId: agentDeviceId,
    fromAgentDeviceName: params.sharedRelocation ? null : deps.describeAgentDevice?.(fromAgentDeviceId) ?? null,
    toAgentDeviceName: params.sharedRelocation ? null : deps.describeAgentDevice?.(agentDeviceId) ?? null,
  };
  let boundaryId: string | null = null;
  try {
    boundaryId = await deps.insertBoundaryMessage(sessionId, boundaryContent);
  } catch (err) {
    if (nativeId) {
      // A native copy cannot be published without the boundary needed for an
      // atomic fallback. Abort before opening it and retain the source identity.
      assertCurrent();
      await deps.applyAgentSwitchToDb(sessionId, {
        agentKind: dbKind, model, providerId: fromProviderId,
        sdkSessionId: row.sdkSessionId, agentDeviceId: fromAgentDeviceId,
      });
      assertCurrent();
      deps.setSessionProvider(sessionId, fromProviderId);
      throw err;
    }
    deps.log.warn('agent-switch: boundary message insert failed on fresh-start relocation (degraded)', {
      sessionId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
  deps.setPendingHandoff(sessionId, handoff, handoffGeneration);
  deps.log.info('agent-switch: relocated for a fresh start', {
    sessionId,
    handoffChars: handoff.length,
    agentDeviceChange: params.sharedRelocation ? 'reassigned-by-provider-group' : agentDeviceId ? 'other-device' : 'task-device',
  });
  return { nativeId, ...(nativeId ? { fallback: async () => {
    assertCurrent();
    if (!boundaryId) throw new Error('Cannot replace native relocation without its boundary record');
    await deps.applyResumeFallbackAtomically(sessionId, boundaryId, {
      ...boundaryContent, resumed: false, nativeHistory: 'fallback', handoff: fullHandoff,
    });
    deps.setPendingHandoff(sessionId, fullHandoff, handoffGeneration);
  } } : {}) };
}

/** 带思考意图重建？不传时保持单参调用形状（既有调用方/断言都不受影响）。 */
function bootstrapSwitchedSessionWithThinking(
  deps: MakerSessionAgentSwitchHandlerDeps,
  sessionId: string,
  thinkingEnabled: boolean | undefined,
  nativeHistoryResume = false,
): Promise<void> {
  if (nativeHistoryResume) return deps.bootstrapSwitchedSession(sessionId, { thinkingEnabled, nativeHistoryResume: true });
  return thinkingEnabled === undefined
    ? deps.bootstrapSwitchedSession(sessionId)
    : deps.bootstrapSwitchedSession(sessionId, { thinkingEnabled });
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
    /** Local picker acknowledgement of this route's checked context window. */
    confirmedContextWindow?: unknown;
    /**
     * 选择的 Agent 位置(远程 Agent):undefined = 保持任务当前位置(内部调用与不认识该字段的
     * 旧控制端都走这里，不做推断)，null = 任务所在电脑，字符串 = 同账号另一台电脑。
     */
    agentDeviceId?: unknown;
    /**
     * Pi-only：目标模型的思考开关意图。重登记(意图期内改档位 / 改选 / 切思考
     * 开关)时必须带上；缺省时由同引擎分支继承既有 intent，不能静默丢字段。
     */
    thinking?: unknown;
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
    runtimeSource?: 'agent';
    /** 系统配置对齐(IM 渠道默认跟随 / 伙伴模型对齐)登记: 落地时不打「脱离跟随」标记。 */
    configStaged?: boolean;
    /** Recheck caller CAS after asynchronous validation, before staging any intent. */
    assertSelectionCurrent?: () => void;
    beforeMutation?: () => Promise<void>;
    /**
     * 仅限 main 内部(不接受 IPC 传入)：Agent 位置不变也按换电脑重新交接、新建原生会话。供应商组替分享的人
     * 换电脑时任务的位置仍是同一个分享，实际运行的电脑由组所在电脑重新选(docs/product-rules/provider-groups.md §6.1)。
     * 只在 applyNow 且 Agent 在另一台电脑上时生效。
     */
    forceRelocation?: boolean;
    /**
     * 仅限 main 内部(不接受 IPC 传入)：供应商组为这个任务换电脑——引擎与模型不变、只换 Agent 所在位置。
     * 协同任务(Lead / Worker)不接受用户换引擎或换位置，只接受这一种切换(docs/product-rules/provider-groups.md §6.1)。
     * 只在 applyNow 时生效。
     */
    providerGroupRelocation?: boolean;
    /**
     * 仅限 main 内部：供应商组换电脑的原因写进分隔条。`quota-rebalance` = 用户确认为了先用那台的配额换过去
     * (provider-groups.md §6.2「任务进行中换号」)。只在真正换了电脑时写。
     */
    providerGroupSwitchReason?: 'quota-rebalance';
  },
): Promise<SessionAgentSwitchResult> {
  const ownerGeneration = deps.readOwnerGeneration?.();
  const { sessionId, targetAgentKind, model, providerId, signal } = params;
  // Pi 跨引擎重建时同样要带上思考开关意图：不传就容易落到被控端镜像/默认值，
  // 与用户在意图期内刚改的开关不一致（device-link 远程场景最明显）。
  const thinkingEnabled = typeof params.thinking === 'boolean' ? params.thinking : undefined;
  throwIfAgentSwitchAborted(signal);
  const confirmedContextWindow = params.confirmedContextWindow;
  if (confirmedContextWindow !== undefined &&
      (typeof confirmedContextWindow !== 'number' || !Number.isSafeInteger(confirmedContextWindow) || confirmedContextWindow <= 0)) {
    throwIpcError('INVALID_PARAMS', 'confirmedContextWindow must be a positive integer');
  }
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
  const rawAgentDeviceId = params.agentDeviceId;
  if (
    rawAgentDeviceId !== undefined &&
    rawAgentDeviceId !== null &&
    (typeof rawAgentDeviceId !== 'string' || !AGENT_DEVICE_ID_PATTERN.test(rawAgentDeviceId))
  ) {
    throwIpcError('INVALID_PARAMS', 'agentDeviceId must be a device id or null');
  }
  let requestedAgentDeviceId = rawAgentDeviceId as string | null | undefined;
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
      sessionId,
      requestedAgentDeviceId,
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
  if (params.runtimeSource === 'agent' && row.status === 'archived') {
    throwIpcError('UNSUPPORTED_CAPABILITY', 'archived task cannot change harness');
  }
  if (row.source === 'review') {
    throwIpcError('UNSUPPORTED_CAPABILITY', 'Review task settings are fixed to the source task');
  }
  if (row.remoteHostId) {
    // SSH can run all three Harnesses, but cannot hand off an existing task between them.
    throwIpcError('SSH_HARNESS_SWITCH_UNSUPPORTED', 'agent switch is not supported for remote sessions');
  }
  // Orca Lead / Worker tasks live on this computer, so moving their Agent works like
  // a normal task (2026-10-16). An execution-device Worker's task lives on that device;
  // its Agent only moves through the provider group's internal relocation.
  const providerGroupRelocationOnly =
    params.providerGroupRelocation === true &&
    params.applyNow === true &&
    normalizeDbAgentKind(row.agentKind) === makerToDbAgentKind(targetAgentKind) &&
    row.model === model;
  if (parseOrcaRemoteLead(row.orcaRemoteLead) &&
      params.agentDeviceId !== undefined && !providerGroupRelocationOnly) {
    throwIpcError('UNSUPPORTED_CAPABILITY', 'agent relocation is not supported for Orca sessions');
  }
  if (params.beforeMutation) await params.beforeMutation();
  params.assertSelectionCurrent?.();

  const fromDbKind: DbAgentKind = normalizeDbAgentKind(row.agentKind);
  const toDbKind: DbAgentKind = makerToDbAgentKind(targetAgentKind);
  const currentAgentDeviceId = row.agentDeviceId ?? null;
  let targetAgentDeviceId =
    requestedAgentDeviceId === undefined ? currentAgentDeviceId : requestedAgentDeviceId;
  // 换到供应商组那一项、要换电脑：由组按它此刻的状态选一台能用的电脑，不直接落到组所在电脑本身
  // (docs/product-rules/provider-groups.md §6，2026-10-11 用户反馈)。登记意图时不选，真正提交时按那一刻的状态选。
  let groupResolvedToCurrentPosition = false;
  let commitProviderGroupBinding: (() => Promise<void>) | undefined;
  // 切换已提交后，绑定文件失败不能把整次切换当成未发生，否则重试会丢掉原电脑的交接。
  async function commitBindingAfterSwitch(): Promise<void> {
    try {
      await commitProviderGroupBinding?.();
    } catch (error) {
      deps.log.warn('agent-switch: provider group binding save failed after switch committed', {
        sessionId,
        err: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (
    params.applyNow === true &&
    params.providerGroupRelocation !== true &&
    targetAgentDeviceId !== currentAgentDeviceId &&
    deps.resolveProviderGroupTarget
  ) {
    const chosen = await deps.resolveProviderGroupTarget(sessionId, {
      agentKind: targetAgentKind,
      model,
      providerId: typeof normalizedProviderId === 'string' ? normalizedProviderId : null,
      agentDeviceId: targetAgentDeviceId,
      current: { agentDeviceId: currentAgentDeviceId, providerId: row.providerId ?? null },
    });
    throwIfAgentSwitchAborted(signal);
    if (chosen) {
      targetAgentDeviceId = chosen.agentDeviceId;
      requestedAgentDeviceId = chosen.agentDeviceId;
      normalizedProviderId = chosen.providerId;
      // 组把这次换电脑选回了当前位置：下面会撞上同引擎同位置的 no-op 分支——但这次
      // 提交本来就是新模型 / effort / fastMode 落地的时刻(登记意图时还没经过组选，
      // 不是走 selectSameAgentModel 的 picker 直选)，no-op 会悄悄丢弹已选的新设置
      // (greptile-apps P1, PR #5792 review)。标记后改走真正的同引擎模型应用路径。
      groupResolvedToCurrentPosition = true;
      // 绑定推迟到本次切换真正提交成功再写：下面还要做目标目录校验和实际交接，
      // 失败时不应该已经持久化新绑定(chatgpt-codex-connector P2, PR #5792 review)。
      commitProviderGroupBinding = chosen.commitBinding;
    }
  }
  const agentDeviceChanges = targetAgentDeviceId !== currentAgentDeviceId;
  // 位置不变的强制换电脑(只认内部 applyNow 调用，且 Agent 在另一台电脑上)：交接、提交、分隔条都按换电脑处理。
  const forcedRelocation =
    !agentDeviceChanges && params.forceRelocation === true && params.applyNow === true && targetAgentDeviceId !== null;
  const relocating = agentDeviceChanges || forcedRelocation;
  // 协同任务点了别处的供应商组、组又选回当前位置：同引擎原地换模型在发送时要用点选时核对过的窗口，
  // 而这次点选按换电脑登记、没有窗口确认，换到更小窗口的模型时会一直卡在发送前。用户已确认过按交接
  // 重新开始，这里照此全量交接重建，不走原地换模型。
  const orcaGroupReturnRebuild = groupResolvedToCurrentPosition && !!row.orcaRole && fromDbKind === toDbKind;
  // 落到另一台电脑的完整切换(换引擎或换电脑)：登记与落地前都按那台的目录裁决。同引擎同位置
  // 的模型选择走 selectSameAgentModel，在 SET_MODEL 链路里裁决。
  if (targetAgentDeviceId && (relocating || orcaGroupReturnRebuild || fromDbKind !== toDbKind)) {
    await deps.assertAgentDeviceRouteUsable?.(
      targetAgentDeviceId,
      targetAgentKind,
      model,
      typeof normalizedProviderId === 'string' ? normalizedProviderId : null,
    );
    if (params.beforeMutation) await params.beforeMutation();
    throwIfAgentSwitchAborted(signal);
    params.assertSelectionCurrent?.();
  }
  if (fromDbKind === toDbKind && !relocating && !orcaGroupReturnRebuild) {
    // Only picker calls stage a model choice here. Internal cross-engine apply/recovery
    // callers retain the existing same-engine no-op; send consumes staged choices below.
    if (deps.selectSameAgentModel && (!params.applyNow || groupResolvedToCurrentPosition)) {
      // 重登记可能不带思考意图(旧调用方 / 只改 effort·Fast)：仍指向同一个目标时
      // 继承既有 intent，否则登记时的快照被覆盖成 undefined，结算回放会丢掉思考
      // 档位收敛；目标已换（改选到别的模型）时不继承——旧模型的开关不适用，
      // 宁可当未提供，让运行时按目标模型自己的能力处理。
      const existingIntent = deps.pendingSwitches?.get?.(sessionId);
      const sameTarget =
        existingIntent !== undefined &&
        existingIntent.model === model &&
        (existingIntent.providerId ?? null) === (normalizedProviderId ?? null);
      const thinking =
        typeof params.thinking === 'boolean'
          ? params.thinking
          : sameTarget
            ? existingIntent?.thinking
            : undefined;
      const result = await deps.selectSameAgentModel(sessionId, {
        targetAgentKind,
        model,
        providerId: normalizedProviderId,
        ...(typeof params.effort === 'string' ? { effort: params.effort } : {}),
        ...((typeof params.fastMode === 'boolean' || params.fastMode === 'ultrafast') ? { fastMode: params.fastMode } : {}),
        ...(typeof thinking === 'boolean' ? { thinking } : {}),
        sameAgentSelection: true,
        ...(confirmedContextWindow !== undefined ? { confirmedContextWindow } : {}),
        ...(params.runtimeSource ? { runtimeSource: params.runtimeSource } : {}),
        ...(params.configStaged === true ? { configStaged: true } : {}),
      }, params.applyNow === true, params.assertSelectionCurrent, params.beforeMutation);
      // 组选回当前位置并且模型应用真正成功(非 deferred/superseded)时才持久化新绑定；
      // 没落地的调用不应该殊到已纳入组(chatgpt-codex-connector P2, PR #5792 review)。
      if (groupResolvedToCurrentPosition && !result.deferred && !result.superseded) {
        await commitBindingAfterSwitch();
      }
      return {
        switched: false,
        agentKind: targetAgentKind,
        model,
        engineReady: true,
        deferred: result.deferred,
        ...(result.superseded ? { sameEngineSuperseded: true } : {}),
      };
    }
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
  // 重复登记 = 覆盖(同一意图的最新表达);但只改档位/Fast 的重登记(旧调用方不带
  // 思考意图)仍指向同一目标时继承旧值——登记快照被覆盖成 undefined 后,发送回放
  // 会丢掉思考开关。目标已换则不继承:旧目标的开关不适用于新目标。
  if (!params.applyNow && deps.pendingSwitches) {
    const existingIntent = deps.pendingSwitches.get?.(sessionId);
    const sameTarget =
      existingIntent !== undefined &&
      existingIntent.targetAgentKind === targetAgentKind &&
      existingIntent.model === model &&
      (existingIntent.providerId ?? null) === (normalizedProviderId ?? null);
    const thinking =
      typeof params.thinking === 'boolean'
        ? params.thinking
        : sameTarget
          ? existingIntent?.thinking
          : undefined;
    const intent: PendingAgentSwitchIntent = {
      ...(params.runtimeSource ? { runtimeSource: params.runtimeSource } : {}),
      ...(params.configStaged === true ? { configStaged: true } : {}),
      targetAgentKind,
      model,
      providerId: normalizedProviderId,
      ...(typeof params.effort === 'string' && params.effort ? { effort: params.effort } : {}),
      ...((typeof params.fastMode === 'boolean' || params.fastMode === 'ultrafast') ? { fastMode: params.fastMode } : {}),
      ...(typeof thinking === 'boolean' ? { thinking } : {}),
      ...(agentDeviceChanges ? { targetAgentDeviceId } : {}),
    };
    deps.pendingSwitches.set(sessionId, intent);
    deps.onPendingSwitchChanged?.(sessionId, projectPendingAgentSwitchIntent(intent));
    deps.log.info('agent-switch: intent registered (applies on next send)', {
      sessionId,
      targetAgentKind,
      model,
      ...(agentDeviceChanges ? { agentDeviceChange: targetAgentDeviceId ? 'other-device' : 'task-device' } : {}),
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
  // 换电脑不复用目标电脑旧的停泊记录；关闭当前会话后迁移最新原生历史。
  const parked = deps.findParkedEngineSession && !relocating && !orcaGroupReturnRebuild
    ? await deps.findParkedEngineSession(sessionId, toDbKind)
    : null;
  const fullSourceMessages = await deps.listMessagesForHandoff(sessionId);
  throwIfAgentSwitchAborted(signal);
  const handoffOptsBase = {
    // 同引擎换电脑时两边引擎名相同，标出旧的那段跑在另一台电脑上。
    fromLabel: relocating
      ? `${agentEngineLabel(fromDbKind)} (on a different computer)`
      : agentEngineLabel(fromDbKind),
    toLabel: agentEngineLabel(toDbKind),
    // 附带早期原文检索指引(get_chat_history / search_chat_history 定向到本会话)。
    sessionId,
  };
  // 全量交接(全新原生会话)带伙伴工作记忆账本;增量交接的目标引擎仍持有离场前记忆,不带。
  const workingMemory = (await deps.readWorkingMemoryNote?.(sessionId)) ?? null;
  const buildFullHandoff = () => buildHandoffText(fullSourceMessages, { ...handoffOptsBase, workingMemory });
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

  // Orca Lead 的 Agent 在另一台电脑时,旧远程 Session 的 close 请求可能因对方不可达而没送到;
  // 这种链路失败不该挡住 Lead 离开那台电脑(普通任务与 Worker 的关闭失败语义不变)。
  const orcaLeadLeavingRemote = row.orcaRole === 'lead' && currentAgentDeviceId !== null;

  return deps.withCloseSuppressed(sessionId, async () => {
    throwIfAgentSwitchAborted(signal);
    if (live) {
      try {
        await deps.closeSession(sessionId);
      } catch (error) {
        const linkCode = orcaLeadLeavingRemote ? agentSwitchLinkCloseErrorCode(error) : null;
        if (!linkCode) throw error;
        // 旧远程 Session 的 close 已在本地 finish/dispose；链路失败只表示 close 请求没送到对方。
        // Maker 把该实例标成 error 仍占 activeSessions，bootstrap/lazy-create 会再 close 一次后换新。
        deps.log.warn('agent-switch: close failed while an orca lead leaves its remote computer; continuing', {
          sessionId,
          code: linkCode,
        });
      }
    }

    let relocatedNativeId: string | null = null;
    let sourceNativeId = row.sdkSessionId;
    let nativeBootstrapReady = false;
    const confirmSummary = params.providerGroupSwitchReason === 'quota-rebalance'
      && relocating && fromDbKind === toDbKind && !forcedRelocation
      && !isProviderShareAgentDeviceId(currentAgentDeviceId)
      && !isProviderShareAgentDeviceId(targetAgentDeviceId);
    const assertTransferCurrent = () => {
      if (deps.readOwnerGeneration?.() !== ownerGeneration) throw new Error('REMOTE_AGENT_ACCOUNT_CHANGED');
      throwIfAgentSwitchAborted(signal);
      params.assertSelectionCurrent?.();
      if (handoffGeneration !== undefined && deps.readPendingHandoffGeneration?.(sessionId) !== handoffGeneration) {
        throw new Error('Session history changed during agent relocation');
      }
    };
    const closeFailedNativeSession = async () => {
      if (!deps.getLiveSession(sessionId)) return;
      try {
        await deps.closeSession(sessionId);
      } catch (error) {
        // The failed target is only cleanup. Its link cannot veto source rollback
        // or the atomic removal of an unusable native ID and restored boundary.
        deps.log.warn('agent-switch: failed native session cleanup failed; continuing fallback', {
          sessionId, error: error instanceof Error ? error.message : String(error),
        });
      }
    };
    const restoreNativeProbeSource = async (error: unknown) => {
      // Cancel/selection changes still restore the source, but never restore old
      // history after clear or write the previous owner's route into a new account.
      const assertProbeOwner = () => {
        if (deps.readOwnerGeneration?.() !== ownerGeneration
          || (handoffGeneration !== undefined && deps.readPendingHandoffGeneration?.(sessionId) !== handoffGeneration)) {
          throw error;
        }
      };
      assertProbeOwner();
      await closeFailedNativeSession();
      assertProbeOwner();
      await deps.applyAgentSwitchToDb(sessionId, {
        agentKind: fromDbKind, model: row.model ?? model, providerId: row.providerId,
        sdkSessionId: sourceNativeId, agentDeviceId: currentAgentDeviceId,
      });
      assertProbeOwner();
      deps.setSessionProvider(sessionId, row.providerId);
      assertTransferCurrent();
    };
    if (relocating && !forcedRelocation && fromDbKind === toDbKind && deps.relocateNativeHistory) {
      // Close flushes the last native ID. Never snapshot the pre-close ID after a native fork/compact.
      const fresh = await deps.getSessionRow(sessionId);
      assertTransferCurrent();
      if (!fresh) throw new Error('Session no longer exists');
      sourceNativeId = fresh.sdkSessionId;
      if (fresh.sdkSessionId && fresh.workingDir) {
        try {
          relocatedNativeId = await deps.relocateNativeHistory({
            sessionId, kind: targetAgentKind, nativeId: fresh.sdkSessionId, workingDir: fresh.workingDir,
            fromDevice: currentAgentDeviceId, toDevice: targetAgentDeviceId, assertCurrent: assertTransferCurrent,
          });
        } catch (error) {
          assertTransferCurrent();
          deps.log.warn('agent-switch: native history unavailable; using bounded handoff', {
            sessionId, error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (relocatedNativeId) {
        // History is already in the native session. Only explain the changed execution environment.
        handoff = nativeRelocationHandoff(await deps.peekPendingHandoff?.(sessionId));
      }
    }
    if (relocating) assertTransferCurrent();

    // Revalidate before probing and after any user confirmation, which may take time.
    const revalidateRoute = async () => {
      if (!deps.assertModelRouteUsable) return;
      const rerouteAtCommit = await deps.assertModelRouteUsable(
        targetAgentKind, model, typeof normalizedProviderId === 'string' ? normalizedProviderId : null,
        sessionId, requestedAgentDeviceId,
      );
      if (rerouteAtCommit && typeof normalizedProviderId !== 'string') normalizedProviderId = rerouteAtCommit;
    };
    await revalidateRoute();
    if (relocating) assertTransferCurrent();

    if (confirmSummary) {
      // Probe native resume before publishing a switch boundary or replacing pending
      // context. A failed probe restores the source route before asking the user.
      if (relocatedNativeId) {
        await deps.applyAgentSwitchToDb(sessionId, {
          agentKind: toDbKind, model, providerId: normalizedProviderId,
          sdkSessionId: relocatedNativeId, agentDeviceId: targetAgentDeviceId,
        });
        if (normalizedProviderId !== undefined) deps.setSessionProvider(sessionId, normalizedProviderId);
        try {
          assertTransferCurrent();
          await bootstrapSwitchedSessionWithThinking(deps, sessionId, thinkingEnabled, true);
          assertTransferCurrent();
          if (deps.getLiveSession(sessionId)?.sdkSessionId !== relocatedNativeId) {
            throw new Error('Native history resume did not restore the transferred session');
          }
          nativeBootstrapReady = true;
        } catch (error) {
          await restoreNativeProbeSource(error);
          relocatedNativeId = null;
          handoff = buildFullHandoff();
          deps.log.warn('agent-switch: native quota relocation failed; restored source before summary confirmation', {
            sessionId, error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (!relocatedNativeId) {
        const confirmed = await deps.confirmNativeHistoryFallback?.(sessionId, targetAgentDeviceId);
        assertTransferCurrent();
        if (!confirmed) throw new Error('NATIVE_HISTORY_FALLBACK_DECLINED');
        await revalidateRoute();
      }
    }

    if (relocating) assertTransferCurrent();
    // ---- commit point:此后切换生效 ----
    try {
      await deps.applyAgentSwitchToDb(sessionId, {
        agentKind: toDbKind,
        model,
        providerId: normalizedProviderId,
        sdkSessionId: relocatedNativeId ?? parked?.sdkSessionId ?? null,
        ...(typeof params.effort === 'string' && params.effort ? { effort: params.effort } : {}),
        ...((typeof params.fastMode === 'boolean' || params.fastMode === 'ultrafast') ? { fastMode: params.fastMode } : {}),
        // 组选回的当前位置在另一台电脑时也带上位置：提交按它判断窗口该查哪台的目录，不能拿本机目录。
        ...(agentDeviceChanges || (orcaGroupReturnRebuild && targetAgentDeviceId)
          ? { agentDeviceId: targetAgentDeviceId }
          : {}),
      });
    } catch (error) {
      // A successful probe already persisted and opened the target. If the final
      // settings write fails, the caller must see the original route, not a half switch.
      if (nativeBootstrapReady) await restoreNativeProbeSource(error);
      throw error;
    }
    if (normalizedProviderId !== undefined) {
      deps.setSessionProvider(sessionId, normalizedProviderId);
    }
    if (typeof thinkingEnabled === 'boolean') {
      // 跨引擎切换提交后把用户的思考选择落到本机偏好镜像：普通 send 的 lazy-create
      // 只读镜像（不经过 bootstrap），否则远端推送未回流时会用旧值建会话。
      deps.rememberThinkingIntent?.({
        agentKind: targetAgentKind,
        providerId: normalizedProviderId ?? row.providerId ?? null,
        model,
        thinking: thinkingEnabled,
      });
    }
    // DB 已过 commit point，切换生效：此刻再持久化组内绑定，前面的目录校验 /
    // closeSession / assertModelRouteUsable 任何一步抛错都不会让新绑定抔先持久化
    // (chatgpt-codex-connector P2, PR #5792 review)。
    if (commitProviderGroupBinding) {
      await commitBindingAfterSwitch();
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
      resumed: !!(relocatedNativeId || parked),
      ...(relocating && fromDbKind === toDbKind ? { nativeHistory: relocatedNativeId ? 'restored' as const : 'fallback' as const } : {}),
      consumed: false,
      ...(relocating
        ? {
            fromAgentDeviceId: currentAgentDeviceId,
            toAgentDeviceId: targetAgentDeviceId,
            // 强制换电脑时实际运行的电脑由对方选，本机不知道是哪台(也不该显示)：分隔条写「另一台电脑」。
            fromAgentDeviceName: forcedRelocation ? null : deps.describeAgentDevice?.(currentAgentDeviceId) ?? null,
            toAgentDeviceName: forcedRelocation ? null : deps.describeAgentDevice?.(targetAgentDeviceId) ?? null,
            ...(params.providerGroupSwitchReason ? { switchReason: params.providerGroupSwitchReason } : {}),
          }
        : {}),
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
    let bootstrapError: string | undefined;
    let resumed = !!(relocatedNativeId || parked);
    let retryPending = false;
    // resume 模式无视 skipBootstrap:只有 eager spawn 才能确定性观测 resume 失败
    // 并在同一事务内回落全量交接;交给 lazy-create 的话,失效的停泊 id 会让之后
    // 每次发送反复失败且无人回落。
    if (!nativeBootstrapReady && (relocatedNativeId || parked || !params.skipBootstrap)) {
      try {
        await bootstrapSwitchedSessionWithThinking(deps, sessionId, thinkingEnabled, !!relocatedNativeId);
        if (relocating) assertTransferCurrent();
        if (relocatedNativeId && deps.getLiveSession(sessionId)?.sdkSessionId !== relocatedNativeId) {
          throw new Error('Native history resume did not restore the transferred session');
        }
      } catch (err) {
        if (relocating) assertTransferCurrent();
        if (relocatedNativeId || parked) {
          if (relocatedNativeId) {
            await closeFailedNativeSession();
            assertTransferCurrent();
          }
          // ---- resume 回落:清停泊 id → 换全量交接 → 全新原生会话重试 ----
          // 停泊原生会话可能已失效(transcript 被清理、CLI 升级不兼容等),这些
          // 只有 spawn 时才暴露。回落是确定性代码路径,不留半 resume 状态。
          deps.log.warn('agent-switch: resume parked session failed; fallback to fresh + full handoff', {
            sessionId,
            targetAgentKind,
            parkedSdkSessionId: relocatedNativeId ?? parked?.sdkSessionId,
            err: err instanceof Error ? err.message : String(err),
          });
          resumed = false;
          const fullHandoff = buildFullHandoff();
          const fallbackBoundaryContent = {
            ...boundaryContent,
            handoff: fullHandoff,
            resumed: false,
            ...(relocatedNativeId ? { nativeHistory: 'fallback' as const } : {}),
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
                ...(params.runtimeSource ? { runtimeSource: params.runtimeSource } : {}),
                ...(params.configStaged === true ? { configStaged: true } : {}),
                targetAgentKind,
                model,
                providerId: normalizedProviderId,
                ...(typeof params.effort === 'string' && params.effort ? { effort: params.effort } : {}),
                ...((typeof params.fastMode === 'boolean' || params.fastMode === 'ultrafast') ? { fastMode: params.fastMode } : {}),
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
              ...(params.runtimeSource ? { runtimeSource: params.runtimeSource } : {}),
              ...(params.configStaged === true ? { configStaged: true } : {}),
              targetAgentKind,
              model,
              providerId: normalizedProviderId,
              ...(typeof params.effort === 'string' && params.effort ? { effort: params.effort } : {}),
              ...((typeof params.fastMode === 'boolean' || params.fastMode === 'ultrafast') ? { fastMode: params.fastMode } : {}),
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
              await bootstrapSwitchedSessionWithThinking(deps, sessionId, thinkingEnabled);
            } catch (err2) {
              engineReady = false;
              bootstrapError = err2 instanceof Error ? err2.message : String(err2);
              deps.log.warn('agent-switch: fresh bootstrap after resume fallback failed', {
                sessionId,
                targetAgentKind,
                err: err2 instanceof Error ? err2.message : String(err2),
              });
            }
          }
        } else {
          engineReady = false;
          bootstrapError = err instanceof Error ? err.message : String(err);
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
      ...(agentDeviceChanges ? { agentDeviceChange: targetAgentDeviceId ? 'other-device' : 'task-device' } : {}),
      ...(forcedRelocation ? { agentDeviceChange: 'reassigned-by-provider-group' } : {}),
    });
    return {
      switched: true,
      agentKind: targetAgentKind,
      model,
      engineReady,
      ...(bootstrapError !== undefined ? { bootstrapError } : {}),
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
 *  - 完整 Agent 选择或同引擎模型选择失败时阻止发送并保留意图；旧跨引擎选择器
 *    保留原有失败后继续发送的行为。resume 回落事务
 *    已进入 commit point 后若失败,则只重试其原子恢复尾段。
 */
/** 墓碑写失败: 一律阻止发送并保留可重试状态 —— 不适用跨引擎的 fail-continue(PR #5155 review P2)。 */
export class UserRouteSelectionMarkerError extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'UserRouteSelectionMarkerError';
    this.cause = cause;
  }
}

/**
 * 用户选择落地 → 给任务打「脱离跟随」标记。只认用户选择: 系统配置对齐
 * (configStaged)与 Agent 自选都由默认变化覆盖, 不得永久脱离。
 *
 * **先立碑再清意图**: 同值重选的唯一证据就是这份墓碑, 写入必须等成功 —— 失败抛错
 * 让意图保留、下一条消息重试, 不得把选择当成功消费(PR #5155 review P2)。
 */
async function noteLandedUserRouteSelection(
  deps: MakerSessionAgentSwitchHandlerDeps,
  sessionId: string,
  intent: PendingAgentSwitchIntent,
): Promise<void> {
  if (!isUserPendingAgentSwitchIntent(intent)) return;
  try {
    await deps.onUserRouteSelectionLanded?.(sessionId);
  } catch (err) {
    deps.log.warn('failed to record landed user route selection', {
      sessionId,
      err: err instanceof Error ? err.message : String(err),
    });
    // 保留可重试状态: 切换事务内部的同引擎 no-op 收口可能已把意图清掉, 重新登记,
    // 下一条消息重试立碑 —— 否则进程一退, 在世证据与落点双双丢失(PR #5155 review P2)。
    if (!deps.pendingSwitches?.get(sessionId)) deps.pendingSwitches?.set(sessionId, intent);
    throw new UserRouteSelectionMarkerError(err);
  }
}

const pendingAgentSwitchApplyInFlight = new Map<string, Promise<void>>();

/**
 * 系统路由切换(`applySessionRouteUnderSendLock`)应用后的意图收口裁决。
 *
 * `applyPendingAgentSwitchIfIdle` 对跨引擎意图是 fail-continue: 应用失败只记日志、
 * 意图原样保留、不抛错(上一条语义注释)。调用方若把「意图还在」一律当「任务正忙」,
 * 后续消息会反复重试同一个必然失败的切换 —— 必须区分「忙 / 恢复尾段待重试」与
 * 「应用失败被吞」, 后者要撤回意图并报错(PR #5155 review P1)。
 */
export function settleSystemRouteSwitchIntent(input: {
  /** 本次要应用的意图(登记后读回)。 */
  stagedIntent: unknown;
  /** 应用尝试之后仍在登记的意图。 */
  remainingIntent: unknown;
  /** 应用尝试之后会话是否空闲(不忙 = 意图没被真的推迟, 而是没生效)。 */
  sessionIdle: boolean;
}): 'applied' | 'staged' | 'failed' {
  const { stagedIntent, remainingIntent, sessionIdle } = input;
  if (!remainingIntent) return 'applied';
  // resume 回落尾段待重试 = 切换已过 commit 点, 保留意图是对的, 下一条消息续跑。
  if ((remainingIntent as { resumeFallbackRecovery?: unknown } | null)?.resumeFallbackRecovery) {
    return 'staged';
  }
  // 意图被更晚的选择超车, 或应用瞬间会话又忙起来了: 留给各自的收口, 按待生效处理。
  if (remainingIntent !== stagedIntent || !sessionIdle) return 'staged';
  return 'failed';
}

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
      if (intent.sameAgentSelection) {
        if (!deps.selectSameAgentModel) throw new Error('model selection apply is unavailable');
        const sharedTask = getDeviceLinkInvokeContext()?.sharedTask;
        const access = sharedTask ? createSharedTaskPendingSelectionGuard(sharedTask, sessionId) : undefined;
        access?.();
        // #7825: the guest triggers a send, but the choice above came from the
        // host registry. Apply only that choice under host authority; retain the
        // captured send fence through preflight and admit before mutation. Keep
        // this admission separate from the guest invoke's settings transaction.
        const result = await (sharedTask
          ? runOutsideDeviceLinkInvokeContext(() => deps.selectSameAgentModel!(
              sessionId, intent, true, undefined, undefined, access,
            ))
          : deps.selectSameAgentModel(sessionId, intent, true));
        if (result.deferred || result.superseded) {
          throw new Error('model selection could not be applied before send');
        }
        await noteLandedUserRouteSelection(deps, sessionId, intent);
        if (deps.pendingSwitches?.get(sessionId) === intent) {
          deps.pendingSwitches.clear(sessionId);
          deps.onPendingSwitchChanged?.(sessionId, null);
        }
        throwIfAgentSwitchAborted(opts?.signal);
        if (opts?.bootstrapAfterSwitch && !deps.getLiveSession(sessionId)) {
          await bootstrapSwitchedSessionWithThinking(deps, sessionId, intent.thinking);
        }
        return;
      }
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
        await noteLandedUserRouteSelection(deps, sessionId, intent);
        if (deps.pendingSwitches?.get(sessionId) === intent) {
          deps.pendingSwitches.clear(sessionId);
          deps.onPendingSwitchChanged?.(sessionId, null);
        }
        return;
      }
      const result = await performSessionAgentSwitch(deps, {
        sessionId,
        targetAgentKind: intent.targetAgentKind,
        runtimeSource: intent.runtimeSource,
        // 系统配置对齐的身份必须随重入传递: resume 回落的恢复意图丢了它, 就会被
        // 当成用户选择打上 manual 墓碑, 任务永久脱离跟随(chatgpt-codex-connector P2,
        // PR #5155)。
        configStaged: intent.configStaged,
        model: intent.model,
        providerId: intent.providerId,
        effort: intent.effort,
        fastMode: intent.fastMode,
        thinking: intent.thinking,
        agentDeviceId: intent.targetAgentDeviceId,
        // 普通 maker send 随后会按 DB 真源 lazy-create,无需在 apply 内多 spawn 一次;
        // Goal / IM / scheduler 三条直发路径没有该 lazy-create 事务,必须先把新引擎
        // bootstrap 好再拿 live session 发送,否则会继续持有已关闭的旧 session。
        skipBootstrap: opts?.bootstrapAfterSwitch !== true,
        applyNow: true,
        signal: opts?.signal,
      });
      if (result.retryPending && intent.runtimeSource === 'agent') {
        throwIpcError('HARNESS_SWITCH_NOT_READY', 'Harness switch recovery is pending; retry the send after recovery');
      }
      // CAS 语义:执行期间用户可能又选了另一个目标,不能把新意图一起清掉。
      if (!result.retryPending) {
        // 同引擎 CAS 超车(sameEngineSuperseded)= 这次选择没落地, 不立碑。
        if (result.sameEngineSuperseded !== true) {
          await noteLandedUserRouteSelection(deps, sessionId, intent);
        }
        // CAS 语义:执行期间用户可能又选了另一个目标,不能把新意图一起清掉。
        if (deps.pendingSwitches?.get(sessionId) === intent) {
          deps.pendingSwitches.clear(sessionId);
          deps.onPendingSwitchChanged?.(sessionId, null);
        }
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
      // Never send on the old model after the user's selected route failed preparation.
      // 墓碑写失败同理: 跨引擎的 fail-continue 也必须挡住 —— 发送继续 + 进程退出会把
      // 同值重选的唯一证据一起丢掉(PR #5155 review P2)。
      // 换电脑同理:用户选的是另一台电脑(或改回本机)，不能悄悄留在原来那台继续发。
      if (
        err instanceof UserRouteSelectionMarkerError ||
        intent.sameAgentSelection ||
        intent.runtimeSource === 'agent' ||
        intent.targetAgentDeviceId !== undefined
      ) {
        throw err;
      }
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
      // 第 7 参(可选):{ agentDeviceId } —— 同时换 Agent 所在电脑。旧被控端忽略多余参数,
      // 位置保持不变(与今天一致)。
      options?: unknown,
      thinking?: unknown,
    ) => {
      const context = getDeviceLinkInvokeContext();
      const confirmedContextWindow = options && typeof options === 'object' && !Array.isArray(options)
        ? (options as { confirmedContextWindow?: unknown }).confirmedContextWindow : undefined;
      // Same trust boundary as SET_MODEL: remote controllers cannot authorize a
      // destructive local-context rebuild by supplying a confirmation number.
      if (isDeviceLinkInvoke() && confirmedContextWindow !== undefined) {
        throwIpcError('PRECONDITION_FAILED', 'remote model-window confirmation is unsupported');
      }
      const agentDeviceId =
        options && typeof options === 'object' && !Array.isArray(options) && 'agentDeviceId' in options
          ? (options as { agentDeviceId?: unknown }).agentDeviceId
          : undefined;
      // 共享任务的访客只能在主人给的范围内改设置，不能把 Agent 挪到主人的其他电脑上。
      if (agentDeviceId !== undefined && context?.sharedTask) {
        throwIpcError('UNSUPPORTED_CAPABILITY', 'shared task guests cannot move the agent to another computer');
      }
      const guard = createSharedTaskSettingGuard(context?.sharedTask, String(sessionId), context?.sharedTaskSetting ?? { admitted: false });
      const run = () => performSessionAgentSwitch(deps, {
        sessionId,
        targetAgentKind,
        model,
        providerId,
        effort,
        fastMode,
        ...(confirmedContextWindow !== undefined ? { confirmedContextWindow } : {}),
        ...(agentDeviceId !== undefined ? { agentDeviceId } : {}),
        thinking,
        assertSelectionCurrent: guard.admit,
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
