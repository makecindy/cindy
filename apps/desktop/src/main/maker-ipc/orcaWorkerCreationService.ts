import type { AgentKind } from '@cindy/maker-core';

import { isCredentialModeSwitchBusyError } from '../maker-host/codex-credential-switch.js';
import type { DispatchWorkerTaskResult, OrcaWorkerEffort, OrcaWorkerStatus } from './orcaTeamService.js';
import type { MakerSessionCreateOpts } from './sessionRequest.js';

/** active team 的最小快照；创建 service 不直接持有 Drizzle row。 */
export interface OrcaTeamSnapshot {
  id: string;
  leadSessionId: string;
}

/** 解析 worker 默认 model/effort/fastMode 所需的 lead session 字段。 */
export interface OrcaLeadSessionSnapshot {
  id: string;
  agentKind: AgentKind;
  workingDir: string | null;
  model: string;
  effort: string | null;
  permissionMode: string;
  fastMode: boolean;
  providerId: string | null;
}

/** worker limit 与 duplicate label 校验只需要 worker 的身份、label 与占槽状态。 */
export interface OrcaWorkerListSnapshot {
  id: string;
  label: string | null;
  status: OrcaWorkerStatus;
}

/** New Maker 面板传来的按 agent 默认值缓存；undefined/null 都表示继续 fallback。 */
export interface OrcaWorkerDefaultsSnapshot {
  model?: string | null;
  effort?: string | null;
  fastMode?: boolean | null;
  providerId?: string | null;
}

/** Worker 创建前所需的已连接供应商最小视图。 */
export interface OrcaWorkerProviderSnapshot {
  id: string;
  name: string;
  models: readonly string[];
  /**
   * 该来源下 supportsFastMode 的模型 id 集合。Fast 能力是 per-(provider, model) 的,
   * 同 id 模型在不同来源可分叉;缺省 = 该快照来源未提供 Fast 元数据,Fast 判定
   * 回落拍平清单解析(兼容旧组装方,不整体压灭 Fast)。
   */
  fastModels?: readonly string[];
  /**
   * 该来源下各模型的 effort 元数据。effort 档位同样是 per-(provider, model) 的:
   * 自定义来源追加同 id 模型时不经过基础目录的跨来源一致性校验,efforts /
   * defaultEffort 可与拍平清单的首见条目分叉;缺省 = 该快照来源未提供 effort
   * 元数据,effort 归一保留拍平清单解析(兼容旧组装方)。
   */
  effortMetaByModel?: Readonly<
    Record<string, { efforts: readonly string[]; defaultEffort: string | null }>
  >;
  /** true 表示该来源必须写入 session provider store 才能注入自己的 API key/OAuth token。 */
  requiresExplicitRoute?: boolean;
}

/** 同一次 provider registry 快照派生出的可用性与默认模型路由，避免两次读取产生竞态。 */
export interface OrcaWorkerProviderRoutingContext {
  availability: Record<AgentKind, OrcaWorkerProviderSnapshot[]>;
  resolveDefaultProviderIdForModel(agent: AgentKind, model: string): string | null;
}

/** worker 创建边界只依赖 model 的运行能力，不直接耦合完整 capabilities 类型。 */
export interface OrcaWorkerModelCapabilities {
  id: string;
  efforts?: readonly string[];
  defaultEffort?: string | null;
  supportsFastMode?: boolean;
}

/** 写入 orca_workers 的最小输入；createdAt/updatedAt 等 store 默认值仍由 store 负责。 */
export interface OrcaWorkerRecordInput {
  id: string;
  teamId: string;
  sessionId: string;
  status: OrcaWorkerStatus;
  label: string;
  role: string;
  focused: boolean;
}

/** create_worker 返回给 MCP 编排层的数量闸快照。 */
export interface OrcaWorkerLimitSnapshot {
  workerHardLimit: number;
  occupiedSlots: number;
  remainingSlots: number;
}

/** create_worker 的稳定业务错误码，IPC 与 MCP adapter 各自翻译。 */
export type OrcaWorkerCreationErrorCode =
  | 'INVALID_PARAMS'
  | 'NOT_FOUND'
  | 'DUPLICATE_LABEL'
  | 'WORKER_CREATION_IN_PROGRESS'
  | 'WORKER_LIMIT_HARD_EXCEEDED'
  | 'BUDGET_MODEL_REQUIRES_API_MODE'
  | 'NO_PROVIDER_FOR_AGENT'
  | 'PROVIDER_ROUTE_UNAVAILABLE'
  | 'BUSY'
  | 'INTERNAL';

/** worker 创建结果保留首条派活 outcome，让调用方区分 created-but-not-dispatched。 */
export type OrcaWorkerCreationResult =
  | {
      ok: true;
      teamId: string;
      workerId: string;
      workerSessionId: string;
      softLimitExceeded?: boolean;
      dispatched?: boolean;
      dispatchOutcome?: DispatchWorkerTaskResult['dispatchOutcome'];
      /** initial_task 入队(未直发)时回传:排队消息的可寻址句柄,供 lead 查看/修改/撤回。 */
      queuedMessageId?: string;
      limit?: OrcaWorkerLimitSnapshot;
      resolved: {
        agent: AgentKind;
        model: string;
        effort: string | null;
        fastMode: boolean;
        providerId: string | null;
        role: string;
        label: string;
      };
    }
  | {
      ok: false;
      errorCode: OrcaWorkerCreationErrorCode;
      message: string;
      limit?: OrcaWorkerLimitSnapshot;
    };

/** 普通 create_worker 入参，已由 IPC/MCP adapter 做过粗校验。 */
export interface OrcaWorkerCreateParams {
  leadSessionId: string;
  role: string;
  agent: AgentKind;
  label: string;
  model?: string;
  effort?: OrcaWorkerEffort;
  fast?: boolean;
  /**
   * 显式选定的模型来源(标准模型选择面板的 per-worker 选择)。string = 显式来源,
   * 走下方精确 preflight 校验「已连接且提供该模型」,不满足即失败,不静默换路由;
   * undefined / null = 未显式选择,沿用 defaults 缓存 / Lead 继承 / spawn-aware
   * 默认路由的既有解析(含 requiresExplicitRoute 唯一来源救援与 stale 回落)。
   */
  providerId?: string | null;
  initialTask?: string;
}

/** enableOrca 已经创建 team 后，可复用同一 worker 创建内核。 */
export interface OrcaWorkerCreateInTeamParams extends OrcaWorkerCreateParams {
  teamId: string;
}

/** creation service 的 I/O 边界；register.ts 负责把 DB、Maker 与 broadcast 注入进来。 */
export interface OrcaWorkerCreationDeps {
  getActiveTeamByLead(leadSessionId: string): Promise<OrcaTeamSnapshot | null>;
  listWorkersByLead(leadSessionId: string): Promise<OrcaWorkerListSnapshot[]>;
  isActiveWorkerStatus(status: OrcaWorkerStatus): boolean;
  readCollaborationSettings(): { workerSoftLimit: number; workerHardLimit: number };
  getLeadSessionRow(leadSessionId: string): Promise<OrcaLeadSessionSnapshot | null>;
  getWorkerDefaults(agent: AgentKind): OrcaWorkerDefaultsSnapshot;
  getAvailableModels(agent: AgentKind): OrcaWorkerModelCapabilities[];
  /**
   * 从同一次 provider registry 读取构造 Worker 路由上下文。
   * availability 只保留已连接 provider 的最小视图；显式 model 的默认来源解析复用
   * model-providers 的 effectiveSourceIdForModel，避免在创建服务里复制供应商优先级。
   */
  getProviderRoutingContext(): Promise<OrcaWorkerProviderRoutingContext>;
  readClaudeApiKey(): string | null;
  reserveWorkerCreation(input: {
    reservationId: string;
    teamId: string;
    label: string;
    hardLimit: number;
    leaseMs: number;
  }): Promise<
    | { ok: true; occupiedSlotsBefore: number }
    | { ok: false; errorCode: 'DUPLICATE_LABEL' | 'WORKER_CREATION_IN_PROGRESS' | 'WORKER_LIMIT_HARD_EXCEEDED' }
  >;
  renewWorkerCreationReservation(reservationId: string, leaseMs: number): Promise<boolean>;
  releaseWorkerCreationReservation(reservationId: string): Promise<void>;
  createId(): string;
  createSessionId(): string;
  buildCreateOptsWithStderr(opts: MakerSessionCreateOpts): MakerSessionCreateOpts;
  bootstrapSession(opts: MakerSessionCreateOpts): Promise<{
    session: { id: string; agentKind: AgentKind };
    didInjectOrcaInstructions: boolean;
    didInjectProjectContext: boolean;
  }>;
  addOrUpdateWorker(worker: OrcaWorkerRecordInput): Promise<void>;
  markOrcaRoleIfNeeded(sessionId: string, role: 'worker'): Promise<void>;
  closeWorkerSession(sessionId: string): Promise<void>;
  archiveWorkerSession(sessionId: string): Promise<void>;
  forgetWorkerSession(sessionId: string): void;
  removeWorker(workerId: string): Promise<void>;
  dispatchWorkerTask(params: {
    targetSessionId: string;
    message: string;
    dispatchMeta: {
      source: string;
      context: string;
    };
  }): Promise<DispatchWorkerTaskResult>;
  broadcastSessionCreated(sessionId: string): void;
  broadcastOrcaWorkerChanged(leadSessionId: string): void;
}

/** Orca worker 创建服务，只负责创建既有 team 下的新 worker，不负责 team lifecycle。 */
export interface OrcaWorkerCreationService {
  createWorker(params: OrcaWorkerCreateParams): Promise<OrcaWorkerCreationResult>;
  createWorkerInTeam(params: OrcaWorkerCreateInTeamParams): Promise<OrcaWorkerCreationResult>;
}

function toInternalFailure(err: unknown): Extract<OrcaWorkerCreationResult, { ok: false }> {
  if (isCredentialModeSwitchBusyError(err)) {
    return {
      ok: false,
      errorCode: 'BUSY',
      message: err.message,
    };
  }
  return {
    ok: false,
    errorCode: 'INTERNAL',
    message: err instanceof Error ? err.message : String(err),
  };
}

function normalizeRequiredText(value: string, field: string): { ok: true; value: string } | { ok: false; message: string } {
  const trimmed = value.trim();
  if (!trimmed) return { ok: false, message: `${field} required` };
  return { ok: true, value: trimmed };
}

const ORCA_WORKER_LABEL_MAX_LENGTH = 32;
const ORCA_WORKER_LABEL_PATTERN = /^[a-z0-9_-]+$/i;

/** worker label 是 switch_focus 的稳定定位键，所有创建入口都走同一组 slug 约束。 */
export function normalizeOrcaWorkerLabel(value: string): { ok: true; value: string } | { ok: false; message: string } {
  const label = normalizeRequiredText(value, 'label');
  if (!label.ok) return label;
  if (label.value.length > ORCA_WORKER_LABEL_MAX_LENGTH) {
    return { ok: false, message: 'label must be 1-32 chars' };
  }
  if (!ORCA_WORKER_LABEL_PATTERN.test(label.value)) {
    return { ok: false, message: 'label may only contain letters, numbers, hyphens and underscores' };
  }
  return { ok: true, value: label.value.toLowerCase() };
}

const ORCA_WORKER_CREATION_RESERVATION_LEASE_MS = 5 * 60 * 1000;

function isWorkerLabelConstraintError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.message.includes("uniq_orca_workers_team_label");
}

type ResolveWorkerConfigResult =
  | {
      ok: true;
      model: string;
      effort: string | null;
      fastMode: boolean;
      providerId: string | null;
      /**
       * 显式 effort 被拍平首见条目拒绝的**暂存**错误:拍平清单(首来源 wins,不含
       * 连接态)不是档位权威 —— 实际路由来源(显式/缓存/默认解析)的条目可能支持
       * 该档(如首见来源已断开且缺 xhigh,而生效默认来源提供,codex review)。由
       * 调用方在解析出路由来源后裁决:有该来源元数据则按它重归一定论;没有(旧
       * 组装方)才按本错误落地。
       */
      pendingEffortError?: string;
    }
  | {
      ok: false;
      message: string;
    };

function modelValidEfforts(model: OrcaWorkerModelCapabilities): readonly string[] {
  return model.efforts ?? [];
}

function normalizeResolvedEffort(params: {
  model: OrcaWorkerModelCapabilities;
  effort: string | null | undefined;
  explicit: boolean;
}): { ok: true; effort: string | null } | { ok: false; message: string } {
  const { model, effort, explicit } = params;
  const validEfforts = modelValidEfforts(model);
  const defaultEffort = model.defaultEffort ?? null;
  if (effort == null) return { ok: true, effort: defaultEffort };
  if (validEfforts.includes(effort)) return { ok: true, effort };
  if (effort === 'minimal' && !explicit && validEfforts.includes('low')) {
    return { ok: true, effort: 'low' };
  }
  if (effort === 'ultra' && !explicit && validEfforts.includes('max')) {
    return { ok: true, effort: 'max' };
  }
  // ultra 但模型无 max(只到 xhigh)时,级联到 xhigh,别掉回 defaultEffort 丢掉最高兼容档。
  if (effort === 'ultra' && !explicit && validEfforts.includes('xhigh')) {
    return { ok: true, effort: 'xhigh' };
  }
  if (effort === 'max' && !explicit && validEfforts.includes('xhigh')) {
    return { ok: true, effort: 'xhigh' };
  }
  if (effort === 'xhigh' && !explicit && validEfforts.includes('max')) {
    return { ok: true, effort: 'max' };
  }
  if (!explicit) return { ok: true, effort: defaultEffort };
  return {
    ok: false,
    message: `effort "${effort}" not supported by model "${model.id}". valid: ${validEfforts.join(', ') || 'none'}`,
  };
}

function resolveWorkerConfig(params: {
  input: OrcaWorkerCreateParams;
  lead: OrcaLeadSessionSnapshot;
  defaults: OrcaWorkerDefaultsSnapshot;
  availableModels: OrcaWorkerModelCapabilities[];
}): ResolveWorkerConfigResult {
  const { input, lead, defaults, availableModels } = params;
  const model = input.model
    ?? defaults.model
    ?? (input.agent === lead.agentKind ? lead.model : input.agent === 'codex' ? 'gpt-5.5' : 'claude-sonnet-4-6');
  const modelCapabilities = availableModels.find((candidate) => candidate.id === model);
  if (!modelCapabilities) {
    return {
      ok: false,
      message: `model "${model}" not available for ${input.agent}. valid: ${availableModels.map((candidate) => candidate.id).join(', ')}`,
    };
  }
  const normalizedEffort = normalizeResolvedEffort({
    model: modelCapabilities,
    effort: input.effort ?? defaults.effort ?? lead.effort,
    explicit: input.effort !== undefined,
  });
  return {
    ok: true,
    model,
    // 归一 !ok 只发生在 explicit 输入:此处不 error 早退,暂存给调用方按实际路由
    // 来源的档位表裁决(见 pendingEffortError 注);其余字段照常解析。
    effort: normalizedEffort.ok ? normalizedEffort.effort : null,
    ...(normalizedEffort.ok ? {} : { pendingEffortError: normalizedEffort.message }),
    providerId: defaults.providerId !== undefined
      ? defaults.providerId
      : (input.agent === lead.agentKind ? lead.providerId : null),
    fastMode: modelCapabilities.supportsFastMode === false
      ? false
      : ((input.agent === 'codex' && input.fast !== undefined)
          ? input.fast
          : (defaults.fastMode ?? !!lead.fastMode)),
  };
}

export function budgetModelRequiresApiKey(agent: AgentKind, model: string, hasApiKey: boolean): boolean {
  return agent === 'codex' && model.startsWith('codex/') && !hasApiKey;
}

export function budgetModelRequiresApiKeyMessage(model: string): string {
  return `模型 "${model}"（codex/ 路由）需要先在设置里连接 Cindy AI 才能使用。`;
}

/** agent 的人类可读名,用于 preflight 失败信息。 */
function agentDisplayName(agent: AgentKind): string {
  return agent === 'codex' ? 'Codex' : 'Claude Code';
}

/**
 * worker 启动 preflight 失败信息:该 agent 无任何已连接的模型供应商时,
 * 引导用户去「设置 → 模型供应商」配置;若**其它** agent 已有可用供应商,则一并建议改用该 agent。
 * 纯函数(无 IO),便于单测。
 */
export function buildNoProviderMessage(
  agent: AgentKind,
  availability: Record<AgentKind, OrcaWorkerProviderSnapshot[]>,
): string {
  const base = `${agentDisplayName(agent)} 当前没有可用的模型供应商(provider)。请在「设置 → 模型供应商」连接一个支持 ${agentDisplayName(agent)} 的供应商后重试`;
  const others = (['claude-code', 'codex'] as AgentKind[]).filter(
    (a) => a !== agent && (availability[a]?.length ?? 0) > 0,
  );
  if (others.length === 0) return `${base}。`;
  const suggestion = others
    .map((a) => `${agentDisplayName(a)}(已连接:${availability[a].map((provider) => provider.name).join(' / ')})`)
    .join('、');
  return `${base},或改用已连接供应商的 agent 创建 worker(可用:${suggestion})。`;
}

function buildProviderRouteUnavailableMessage(
  agent: AgentKind,
  providerId: string | null,
  model: string,
  provider: OrcaWorkerProviderSnapshot | undefined,
): string {
  if (providerId === null) {
    return `${agentDisplayName(agent)} 当前没有已连接的供应商提供模型 "${model}",请调整模型或在「设置 → 模型供应商」连接对应供应商后重试。`;
  }
  if (!provider) {
    return `${agentDisplayName(agent)} Worker 选择的供应商 "${providerId}" 当前未连接或不支持该 agent,请在「设置 → 模型供应商」检查后重试。`;
  }
  return `${agentDisplayName(agent)} Worker 选择的供应商 "${provider.name}" 不提供模型 "${model}",请调整供应商或模型后重试。`;
}

export function createOrcaWorkerCreationService(deps: OrcaWorkerCreationDeps): OrcaWorkerCreationService {
  function limitSnapshot(workerHardLimit: number, occupiedSlots: number): OrcaWorkerLimitSnapshot {
    return {
      workerHardLimit,
      occupiedSlots,
      remainingSlots: Math.max(0, workerHardLimit - occupiedSlots),
    };
  }

  async function cleanupBootstrappedWorkerSession(sessionId: string): Promise<void> {
    await deps.closeWorkerSession(sessionId).catch(() => undefined);
    try {
      deps.forgetWorkerSession(sessionId);
    } catch {
      // cache 清理是 best-effort；DB 归档仍继续执行。
    }
    await deps.archiveWorkerSession(sessionId).catch(() => undefined);
  }

  async function createWorker(params: OrcaWorkerCreateParams): Promise<OrcaWorkerCreationResult> {
    const team = await deps.getActiveTeamByLead(params.leadSessionId);
    if (!team) {
      return { ok: false, errorCode: 'NOT_FOUND', message: 'no active team for this lead' };
    }
    return createWorkerInTeam({ ...params, teamId: team.id });
  }

  async function createWorkerInTeam(params: OrcaWorkerCreateInTeamParams): Promise<OrcaWorkerCreationResult> {
    const role = normalizeRequiredText(params.role, 'role');
    if (!role.ok) return { ok: false, errorCode: 'INVALID_PARAMS', message: role.message };
    if (role.value.length > 32) {
      return { ok: false, errorCode: 'INVALID_PARAMS', message: 'role must be 1-32 chars' };
    }
    const label = normalizeOrcaWorkerLabel(params.label);
    if (!label.ok) return { ok: false, errorCode: 'INVALID_PARAMS', message: label.message };

    const existing = await deps.listWorkersByLead(params.leadSessionId);
    if (existing.some((worker) => worker.label?.toLowerCase() === label.value)) {
      return { ok: false, errorCode: 'DUPLICATE_LABEL', message: `label "${label.value}" already used in this team` };
    }

    const settings = deps.readCollaborationSettings();
    const activeCount = existing.filter((worker) => deps.isActiveWorkerStatus(worker.status)).length;
    if (activeCount >= settings.workerHardLimit) {
      return {
        ok: false,
        errorCode: 'WORKER_LIMIT_HARD_EXCEEDED',
        message: `hard limit ${settings.workerHardLimit} reached`,
        limit: limitSnapshot(settings.workerHardLimit, activeCount),
      };
    }
    const availableModels = deps.getAvailableModels(params.agent);
    if (params.model) {
      const validModels = availableModels.map((model) => model.id);
      if (!validModels.includes(params.model)) {
        return {
          ok: false,
          errorCode: 'INVALID_PARAMS',
          message: `model "${params.model}" not available for ${params.agent}. valid: ${validModels.join(', ')}`,
        };
      }
    }

    // 先保留无 provider 的快速失败；精确的 provider + model 校验要等 Lead/defaults 解析完成。
    const providerRouting = await deps.getProviderRoutingContext();
    const providerAvailability = providerRouting.availability;
    const agentProviders = providerAvailability[params.agent] ?? [];
    if (agentProviders.length === 0) {
      return {
        ok: false,
        errorCode: 'NO_PROVIDER_FOR_AGENT',
        message: buildNoProviderMessage(params.agent, providerAvailability),
      };
    }

    const lead = await deps.getLeadSessionRow(params.leadSessionId);
    if (!lead) {
      return { ok: false, errorCode: 'NOT_FOUND', message: `lead session ${params.leadSessionId} not found` };
    }

    const defaults = deps.getWorkerDefaults(params.agent);
    // 标准面板显式选定的来源(非空 string)直接生效,由下方精确 preflight 把关「已连接且
    // 提供该模型」;空串/null/undefined 一律按未显式处理(与 IPC 边界同口径,service 作为
    // 共用内核自防调用方漏归一),维持既有解析,包括「显式 model 不等于显式来源」的
    // 强制默认路由与 requiresExplicitRoute 唯一来源救援。
    const explicitSourceId =
      typeof params.providerId === 'string' && params.providerId.trim().length > 0
        ? params.providerId.trim()
        : null;
    const resolvedConfig = resolveWorkerConfig({ input: params, lead, defaults, availableModels });
    if (!resolvedConfig.ok) {
      return { ok: false, errorCode: 'INVALID_PARAMS', message: resolvedConfig.message };
    }
    const explicitModelDefaultProviderId = params.model !== undefined
      ? providerRouting.resolveDefaultProviderIdForModel(params.agent, resolvedConfig.model)
      : null;
    const explicitModelProviders = params.model !== undefined
      ? agentProviders.filter((provider) => provider.models.includes(resolvedConfig.model))
      : [];
    const explicitModelProvider = explicitModelDefaultProviderId === null
      ? undefined
      : agentProviders.find((provider) => provider.id === explicitModelDefaultProviderId);
    const cachedProviderRouteIsStale = params.model === undefined
      && defaults.providerId !== undefined
      && defaults.providerId !== null
      && !agentProviders.some(
        (provider) => provider.id === defaults.providerId && provider.models.includes(resolvedConfig.model),
      );
    const cachedProviderFallbackId = cachedProviderRouteIsStale
      ? providerRouting.resolveDefaultProviderIdForModel(params.agent, resolvedConfig.model)
      : null;
    const cachedProviderFallback = cachedProviderFallbackId === null
      ? undefined
      : agentProviders.find((provider) => provider.id === cachedProviderFallbackId);
    const resolved = {
      ...resolvedConfig,
      // 仅显式指定 model 不等于显式选择来源：providerId=null 必须保留 spawn-aware 默认路由。
      // 例外是该模型只有一个来源且它必须依赖 session provider store 注入自己的凭证。
      providerId: explicitSourceId !== null
        ? explicitSourceId
        : params.model !== undefined
          && explicitModelProviders.length === 1
          && explicitModelProvider?.requiresExplicitRoute
          ? explicitModelProvider.id
          : params.model !== undefined
            ? null
            : cachedProviderRouteIsStale
              ? (cachedProviderFallback?.requiresExplicitRoute ? cachedProviderFallback.id : null)
              : resolvedConfig.providerId,
    };
    // Fast 与 effort 都按**实际路由来源**自己的模型条目判定(显式来源、defaults 缓存
    // 来源、spawn 默认来源统一)—— getAvailableModels 是跨来源拍平清单(首来源 wins,
    // 且不含连接态),同 id 模型的 supportsFastMode / efforts 在不同来源可分叉:首来源
    // 的元数据会误杀或误放行真实路由来源的能力(codex review 三轮)。
    const routeProviderId = explicitSourceId
      ?? resolved.providerId
      ?? providerRouting.resolveDefaultProviderIdForModel(params.agent, resolved.model);
    const routeProvider = routeProviderId === null
      ? undefined
      : agentProviders.find((provider) => provider.id === routeProviderId);
    // 只有该来源确实带了 Fast 元数据才覆盖;无元数据(旧组装方)保留拍平解析。
    if (routeProvider?.fastModels) {
      const providerSupportsFast = routeProvider.fastModels.includes(resolved.model);
      const requestedFast = params.agent === 'codex' && params.fast !== undefined
        ? params.fast
        : (defaults.fastMode ?? !!lead.fastMode);
      resolved.fastMode = providerSupportsFast && requestedFast === true;
    }
    // effort 按路由来源自己的条目**重归一定论**:resolveWorkerConfig 按拍平首见
    // 条目归一只是初值(该条目不含连接态、同 id 模型档位表跨来源可分叉),显式
    // 来源、defaults 缓存来源与默认解析来源统一在这里按权威档位表收口 —— 误放行
    // (无档副本携带拍平档位)与误拒(路由来源支持而拍平缺档,explicit 输入已被
    // 暂存为 pendingEffortError,不在归一处 error 早退)两个方向都在此裁决
    // (codex review 两轮)。重归一用与 resolveWorkerConfig 相同的**原始输入**,
    // 不拿已归一值二次级联;路由来源无元数据(旧组装方)时没有更权威的档位表,
    // 按拍平结果落地 —— 含暂存的拒绝。
    const routeEffortMeta = routeProvider?.effortMetaByModel?.[resolved.model];
    if (routeEffortMeta) {
      const renormalized = normalizeResolvedEffort({
        model: {
          id: resolved.model,
          efforts: routeEffortMeta.efforts,
          defaultEffort: routeEffortMeta.defaultEffort,
        },
        effort: params.effort ?? defaults.effort ?? lead.effort,
        explicit: params.effort !== undefined,
      });
      if (!renormalized.ok) {
        return { ok: false, errorCode: 'INVALID_PARAMS', message: renormalized.message };
      }
      resolved.effort = renormalized.effort;
    } else if (resolvedConfig.pendingEffortError) {
      return { ok: false, errorCode: 'INVALID_PARAMS', message: resolvedConfig.pendingEffortError };
    }
    const budgetRouteProviderId = explicitSourceId !== null
      ? explicitSourceId
      : params.model !== undefined
        ? explicitModelDefaultProviderId
        : (cachedProviderRouteIsStale ? cachedProviderFallbackId : resolved.providerId);

    // codex/ 预算模型依赖 Cindy AI API key；XD/default 路由即使因 provider 缺失，
    // 也要先返回这条可操作的凭证错误，避免被下方通用的精确路由失败遮蔽。
    if (
      budgetModelRequiresApiKey(params.agent, resolved.model, deps.readClaudeApiKey() != null)
      && (budgetRouteProviderId === null || budgetRouteProviderId === 'xd')
    ) {
      return {
        ok: false,
        errorCode: 'BUDGET_MODEL_REQUIRES_API_MODE',
        message: budgetModelRequiresApiKeyMessage(resolved.model),
      };
    }

    if (params.model !== undefined && explicitModelDefaultProviderId === null) {
      return {
        ok: false,
        errorCode: 'PROVIDER_ROUTE_UNAVAILABLE',
        message: buildProviderRouteUnavailableMessage(
          params.agent,
          null,
          resolved.model,
          undefined,
        ),
      };
    }

    if (cachedProviderRouteIsStale && cachedProviderFallbackId === null) {
      return {
        ok: false,
        errorCode: 'PROVIDER_ROUTE_UNAVAILABLE',
        message: buildProviderRouteUnavailableMessage(
          params.agent,
          null,
          resolved.model,
          undefined,
        ),
      };
    }

    // 按 Worker 最终解析出的 provider + model 做精确 preflight。只检查“任意 provider 可用”会
    // 掩盖来源丢失,让请求静默落到无关的全局凭证路由。
    if (resolved.providerId !== null) {
      const provider = agentProviders.find((candidate) => candidate.id === resolved.providerId);
      if (!provider || !provider.models.includes(resolved.model)) {
        return {
          ok: false,
          errorCode: 'PROVIDER_ROUTE_UNAVAILABLE',
          message: buildProviderRouteUnavailableMessage(
            params.agent,
            resolved.providerId,
            resolved.model,
            provider,
          ),
        };
      }
    }
    const workerId = deps.createId();
    let reservation:
      | { ok: true; occupiedSlotsBefore: number }
      | { ok: false; errorCode: 'DUPLICATE_LABEL' | 'WORKER_CREATION_IN_PROGRESS' | 'WORKER_LIMIT_HARD_EXCEEDED' };
    try {
      reservation = await deps.reserveWorkerCreation({
        reservationId: workerId,
        teamId: params.teamId,
        label: label.value,
        hardLimit: settings.workerHardLimit,
        leaseMs: ORCA_WORKER_CREATION_RESERVATION_LEASE_MS,
      });
    } catch (err) {
      return toInternalFailure(err);
    }
    if (!reservation.ok) {
      if (reservation.errorCode === 'DUPLICATE_LABEL') {
        return { ok: false, errorCode: 'DUPLICATE_LABEL', message: `label "${label.value}" already used in this team` };
      }
      if (reservation.errorCode === 'WORKER_CREATION_IN_PROGRESS') {
        return { ok: false, errorCode: 'WORKER_CREATION_IN_PROGRESS', message: `label "${label.value}" is currently being created` };
      }
      return {
        ok: false,
        errorCode: 'WORKER_LIMIT_HARD_EXCEEDED',
        message: `hard limit ${settings.workerHardLimit} reached`,
        limit: limitSnapshot(settings.workerHardLimit, settings.workerHardLimit),
      };
    }
    const softLimitExceeded = reservation.occupiedSlotsBefore >= settings.workerSoftLimit;
    let reservationValid = true;
    const renewalTimer = setInterval(() => {
      void deps.renewWorkerCreationReservation(workerId, ORCA_WORKER_CREATION_RESERVATION_LEASE_MS)
        .then((renewed) => { if (!renewed) reservationValid = false; })
        .catch(() => { reservationValid = false; });
    }, Math.floor(ORCA_WORKER_CREATION_RESERVATION_LEASE_MS / 3));
    renewalTimer.unref?.();

    try {
      const workerSessionId = deps.createSessionId();
      const workerVendorOptions = {
        orcaRole: 'worker' as const,
        orcaWorkflowId: params.teamId,
        orcaLeadSessionId: params.leadSessionId,
        orcaWorkerId: workerId,
        orcaWorkerSessionId: workerSessionId,
      };

      const workerOpts = deps.buildCreateOptsWithStderr({
        id: workerSessionId,
        agentKind: params.agent,
        workingDir: lead.workingDir ?? '',
        model: resolved.model,
        providerId: resolved.providerId,
        effort: resolved.effort as MakerSessionCreateOpts['effort'],
        fastMode: resolved.fastMode,
        permissionMode: 'bypassPermissions',
        title: `Worker · ${role.value} · ${label.value}`,
        orcaRole: 'worker',
        vendorOptions: workerVendorOptions,
      });

      let workerSession: { id: string; agentKind: AgentKind };
      try {
        const bootstrapped = await deps.bootstrapSession(workerOpts);
        workerSession = bootstrapped.session;
      } catch (err) {
        return toInternalFailure(err);
      }

      const renewed = reservationValid
        ? await deps.renewWorkerCreationReservation(workerId, ORCA_WORKER_CREATION_RESERVATION_LEASE_MS).catch(() => false)
        : false;
      if (!renewed) {
        await cleanupBootstrappedWorkerSession(workerSession.id);
        return { ok: false, errorCode: 'INTERNAL', message: 'worker creation reservation expired before persistence' };
      }

      try {
        await deps.addOrUpdateWorker({
          id: workerId,
          teamId: params.teamId,
          sessionId: workerSession.id,
          status: 'idle',
          label: label.value,
          role: role.value,
          focused: false,
        });
      } catch (err) {
        await cleanupBootstrappedWorkerSession(workerSession.id);
        if (isWorkerLabelConstraintError(err)) {
          return { ok: false, errorCode: 'DUPLICATE_LABEL', message: `label "${label.value}" already used in this team` };
        }
        return toInternalFailure(err);
      }

      try {
        await deps.markOrcaRoleIfNeeded(workerSession.id, 'worker');
      } catch (err) {
        await cleanupBootstrappedWorkerSession(workerSession.id);
        await deps.removeWorker(workerId).catch(() => undefined);
        return toInternalFailure(err);
      }

      return {
        ok: true,
        teamId: params.teamId,
        workerId,
        workerSessionId: workerSession.id,
        softLimitExceeded,
        limit: limitSnapshot(settings.workerHardLimit, reservation.occupiedSlotsBefore + 1),
        resolved: {
          agent: params.agent,
          model: resolved.model,
          effort: resolved.effort,
          fastMode: resolved.fastMode,
          providerId: resolved.providerId,
          role: role.value,
          label: label.value,
        },
      };
    } finally {
      clearInterval(renewalTimer);
      await deps.releaseWorkerCreationReservation(workerId).catch(() => undefined);
    }
  }

  return {
    createWorker,
    createWorkerInTeam,
  };
}
