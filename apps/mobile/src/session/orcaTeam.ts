/**
 * 手机端 Orca 协同编排:入口可用性、团队状态订阅与写操作。
 *
 * Lead / Worker / team 的真身都在被控端 main,手机只是镜像 + 编排入口(与桌面 device-link
 * 控制端同一组 channel,见 mobileMakerTransport 的 `orca` 组)。几条不变量:
 *  - 入口判定 fail-closed:被控端不声明 `supportsOrcaWorkerPermissionMode`、或协同插件查询
 *    CHANNEL_NOT_ALLOWED,一律按「设备版本过旧」置灰,不放行到 enable-orca 才撞错。
 *  - 写操作不自动重试;enable-orca 隧道超时不是权威失败 —— 先回查被控端 Worker 列表再定性
 *    (与桌面 remoteCollabHandoff 同口径),查不到才按失败处理。
 *  - 团队列表以被控端为准:`maker:orca:worker-changed` 推送或写操作完成后整表重拉。
 */
import {
  createWorkerLabel,
  parseOrcaTeamWorkers,
  readOrcaCollabPolicy,
  type OrcaCollaborationSettings,
  type OrcaTeamWorker,
  type OrcaWorkerAgentKind,
  type OrcaWorkerPermissionMode,
} from '@cindy/maker-shared/orca-team';
import { formatRemoteError, isTransientRemoteError } from '@cindy/maker-shared/device-link-contract';
import { isLocalOnlyProviderForAgent, isSubscriptionDirectRoute } from '@cindy/model-providers';
import {
  chatEligibleSourcesForModel,
  effectiveSourceIdForModel,
  getModel,
  type ProviderView,
} from '@cindy/model-providers/registry';
import type { AgentKind } from '@cindy/model-providers/types';
import { normalizeMobileAgentCapabilities } from '@/session/agentCapabilities';
import { humanizeRemoteError } from '@/device-link/remoteStatus';
import { i18n } from '@/i18n';
import type {
  MobileMakerTransport,
  MobileOrcaEnableOptions,
} from '@/device-link/mobileMakerTransport';
import type { RemoteSession } from '@/session/types';
import type { OrcaExecutionDeviceView } from '@cindy/device-link';
import type { MobileAgentCapabilities } from '@/session/agentCapabilities';
import type { OrcaWorkerCreationPrefs } from '@/session/orcaWorkerPrefs';

export type { OrcaTeamWorker, OrcaCollaborationSettings, OrcaWorkerAgentKind, OrcaWorkerPermissionMode };

/** 创建 Worker 表单(开启协同与追加 Worker 共用)。 */
export interface OrcaWorkerFormValue {
  role: string;
  agent: OrcaWorkerAgentKind;
  /** null = 跟随被控端默认(该 Agent 上次新建任务的选择,回落 Lead 模型)。 */
  model: { id: string; providerId: string | null; effort: string | null; fast: boolean } | null;
  permissionMode: OrcaWorkerPermissionMode;
  initialTask: string;
  /** 缺省为 Lead 所在电脑；指定后模型与目录都属于该运行设备。 */
  executionDeviceId?: string;
  remoteDirMode?: 'dialogue' | 'path';
  remoteDir?: string;
}

export function parseOrcaExecutionDevices(value: unknown): OrcaExecutionDeviceView[] {
  const devices = (value as { devices?: unknown } | null)?.devices;
  if (!Array.isArray(devices)) return [];
  return devices.flatMap((item) => {
    const row = item as Record<string, unknown> | null;
    if (!row || typeof row.deviceId !== 'string' || !row.deviceId) return [];
    return [{
      deviceId: row.deviceId,
      name: typeof row.name === 'string' && row.name ? row.name : row.deviceId,
      platform: typeof row.platform === 'string' ? row.platform : null,
      supported: row.supported === true,
    }];
  });
}

export function isAbsoluteOrcaWorkerDir(value: string): boolean {
  return /^(\/|[a-zA-Z]:[\\/]|\\\\)/.test(value.trim());
}

export function orcaAgentKindForSession(session: Pick<RemoteSession, 'agentKind'>): OrcaWorkerAgentKind {
  return session.agentKind === 'codex' || session.agentKind === 'pi' ? session.agentKind : 'claude-code';
}

/** 由记忆构造表单:角色回到 developer,初始任务不记忆(与桌面一致)。 */
export function orcaWorkerFormFromPrefs(
  prefs: OrcaWorkerCreationPrefs,
  agent: OrcaWorkerAgentKind,
): OrcaWorkerFormValue {
  const remembered = prefs.agents[agent];
  return {
    role: 'developer',
    agent,
    model: { id: remembered.model, providerId: null, effort: remembered.effort, fast: remembered.fast },
    permissionMode: prefs.workerPermissionMode,
    initialTask: '',
  };
}

/**
 * 按被控端能力收敛模型选择(对齐桌面「加载能力后把选择收敛到可用模型和 effort」):
 * 模型不在该电脑的可用列表 → 回落「默认」(null,交给被控端解析);effort 不在档位表 →
 * 该模型默认档;模型不支持 Fast → 关 Fast。能力未知(null)时保持原样。
 *
 * 显式选了来源时只做可用性检查,不按拍平能力改 effort / Fast:同 id 模型在不同来源的档位与
 * Fast 支持可能不同,拍平条目会把来源 A 的合法选择改成来源 B 的默认。这两项在提交前按
 * 该来源自己的条目对账(narrowOrcaWorkerProvider)。
 */
export function convergeOrcaWorkerModel(
  model: OrcaWorkerFormValue['model'],
  capabilities: Pick<MobileAgentCapabilities, 'availableModels' | 'hasFastMode'> | null,
): OrcaWorkerFormValue['model'] {
  if (!model || !capabilities) return model;
  const option = capabilities.availableModels.find((item) => item.id === model.id);
  if (!option) return null;
  if (model.providerId) return model;
  const effort = model.effort && option.efforts.includes(model.effort)
    ? model.effort
    : option.defaultEffort ?? option.efforts[0] ?? null;
  return {
    ...model,
    effort,
    fast: model.fast && option.supportsFastMode && capabilities.hasFastMode,
  };
}

/**
 * 提交前收窄显式来源(对齐桌面 CreateWorkerPopover 的 narrowProviderSource):用户在选择器里
 * 指定的来源已不再可路由该模型(断开 / 停用 / 下架)时清掉来源,交给被控端默认路由,而不是
 * 带着失效来源被 PROVIDER_ROUTE_UNAVAILABLE 拒绝。
 *
 * 然后按「实际会路由到的来源」的模型条目对账 effort / Fast(被控端按实际来源复核这两项):
 * 显式来源有效时用它;未指定来源时用该模型的默认来源(effectiveSourceIdForModel,与桌面
 * routeEffortMetaFor 同口径),不按拍平能力里恰好排在前面的来源。来源目录未就绪(null)时原样提交。
 */
export function narrowOrcaWorkerProvider(
  form: OrcaWorkerFormValue,
  providers: readonly ProviderView[] | null,
): OrcaWorkerFormValue {
  const model = form.model;
  if (!model || !providers) return form;
  const views = [...providers];
  const providerId = model.providerId
    && chatEligibleSourcesForModel(views, model.id, form.agent).some((candidate) => candidate.id === model.providerId)
    ? model.providerId
    : null;
  const narrowed = providerId === model.providerId ? form : { ...form, model: { ...model, providerId } };
  const sourceId = providerId ?? effectiveSourceIdForModel(views, null, model.id, form.agent);
  const provider = sourceId ? views.find((candidate) => candidate.id === sourceId) : undefined;
  const entry = provider ? getModel(provider, model.id, form.agent) : undefined;
  if (!entry) return narrowed;
  const efforts: readonly string[] = entry.efforts ?? [];
  // 该来源没有推理强度档位 → 不发送 effort(被控端对空档位表的显式 effort 报 INVALID_PARAMS),
  // 与桌面「条目无档 → 省略」同口径。
  // 老被控端的条目可能没有 efforts 字段:未知时保持原选择,交给被控端裁决。
  const effort = entry.efforts === undefined
    ? model.effort
    : efforts.length === 0
      ? null
      : model.effort && efforts.includes(model.effort)
      ? model.effort
      : entry.defaultEffort ?? efforts[0] ?? null;
  const fast = model.fast && entry.supportsFastMode === true;
  return effort === model.effort && fast === model.fast
    ? narrowed
    : { ...narrowed, model: { ...model, providerId, effort, fast } };
}

/**
 * Worker 可选的来源目录(对齐桌面 CreateWorkerPopover 的 excludeSubscriptionDirect /
 * excludeChatBridgedCodex):SSH 远端 Lead 的 Worker 在远端运行,只能在本机桥接的来源
 * (订阅直连模型、chat 桥接 / 本地 OAuth 供应商)会被被控端拒绝,选择器里不列出。
 */
export function orcaWorkerProvidersForLead(
  providers: readonly ProviderView[],
  sshRemote: boolean,
): readonly ProviderView[] {
  if (!sshRemote) return providers;
  return providers.map((provider) => {
    const models: ProviderView['models'] = {};
    for (const agent of Object.keys(provider.models) as AgentKind[]) {
      models[agent] = isLocalOnlyProviderForAgent(provider, agent)
        ? []
        : (provider.models[agent] ?? []).filter((model) => !isSubscriptionDirectRoute(model.id));
    }
    return { ...provider, models };
  });
}

/** 表单 → 被控端 enable-orca / worker:create 的共同字段。 */
function formWireFields(form: OrcaWorkerFormValue) {
  if (form.executionDeviceId && form.remoteDirMode === 'path' && !isAbsoluteOrcaWorkerDir(form.remoteDir ?? '')) {
    throw new Error('[INVALID_PARAMS] execution device working directory must be absolute');
  }
  const model = form.model;
  return {
    ...(model ? { model: model.id } : {}),
    ...(model?.effort ? { effort: model.effort } : {}),
    // 选了具体模型就显式发送 Fast(含 false):省略会让被控端沿用 Lead / 默认的 Fast,与表单相反。
    // 「默认」模型(null)才省略,交给被控端一并解析。模型不支持 Fast 时被控端按 false 落。
    ...(model ? { fast: model.fast } : {}),
    ...(model?.providerId ? { providerId: model.providerId } : {}),
    workerPermissionMode: form.permissionMode,
    ...(form.executionDeviceId ? {
      executionDeviceId: form.executionDeviceId,
      ...(form.remoteDirMode === 'path' ? { workingDir: form.remoteDir?.trim() } : {}),
    } : {}),
  };
}

export function buildOrcaEnableOptions(
  form: OrcaWorkerFormValue,
  delegateTask?: string,
): MobileOrcaEnableOptions {
  const role = form.role.trim() || 'developer';
  const task = delegateTask?.trim();
  return {
    workerAgent: form.agent,
    role,
    label: createWorkerLabel(role, []),
    ...formWireFields(form),
    ...(task ? { delegateTask: task } : {}),
  };
}

// ─── 错误文案 ────────────────────────────────────────────────────────────────

const ORCA_ERROR_CODES = [
  'WORKER_LIMIT_HARD_EXCEEDED',
  'NO_PROVIDER_FOR_AGENT',
  'PROVIDER_ROUTE_UNAVAILABLE',
  'BUDGET_MODEL_REQUIRES_API_MODE',
  'INVALID_PARAMS',
  'PRECONDITION_FAILED',
  'WORKER_CREATION_IN_PROGRESS',
  'WORKER_NOT_FOUND',
  'ORCA_CREATE_UNCONFIRMED',
  'ORCA_ACTION_UNCONFIRMED',
] as const;

export function isOrcaUnsupportedError(error: unknown): boolean {
  return formatRemoteError(error).includes('CHANNEL_NOT_ALLOWED');
}

export function isOrcaDuplicateLabelError(error: unknown): boolean {
  return formatRemoteError(error).includes('DUPLICATE_LABEL');
}

/** 超时不是权威失败:主机可能仍在执行,结果以回查到的状态为准。 */
export function isOrcaAmbiguousTimeout(error: unknown): boolean {
  return isAmbiguousTimeout(error);
}

function isAmbiguousTimeout(error: unknown): boolean {
  const text = formatRemoteError(error);
  return text.includes('INVOKE_TIMEOUT') || text.includes('REQUEST_TIMEOUT') || text.includes('DEVICE_LINK_TIMEOUT');
}

/**
 * 协同写操作失败 → 界面语言文案(已知错误码精确映射,其余走通用远程错误)。
 * fallbackKey 是未知错误时的动作前缀(如「开启协同失败。」);外层文案已说明动作时传 null。
 */
export function describeOrcaError(error: unknown, fallbackKey: string | null): string {
  if (isOrcaUnsupportedError(error)) return i18n.t('session.collab.errors.unsupported');
  const text = formatRemoteError(error);
  const code = ORCA_ERROR_CODES.find((candidate) => text.includes(candidate));
  if (code) return i18n.t(`session.collab.errors.${code}`);
  const generic = humanizeRemoteError(error);
  return fallbackKey ? `${i18n.t(fallbackKey)}${generic ? ` ${generic}` : ''}` : generic;
}

// ─── 入口可用性 ──────────────────────────────────────────────────────────────

export type OrcaCollabEntryStatus =
  | 'ineligible'
  | 'loading'
  | 'ready'
  | 'disabled'
  | 'unsupported'
  | 'unavailable';

/** 能否挂协同入口(与桌面 resolveCollabEntryPolicy 同口径):Worker 子任务不能嵌套协同。 */
export function isOrcaCollabEligible(
  session: Pick<RemoteSession, 'orcaRole' | 'orcaRemoteLead' | 'workspaceKind' | 'workingDir'> | null,
): boolean {
  if (!session || session.orcaRole === 'worker' || session.orcaRemoteLead) return false;
  if (session.workspaceKind === 'dialogue') return true;
  return session.workspaceKind === 'project' && !!session.workingDir?.trim();
}

/**
 * 读被控端的协同入口状态:能力声明 + 协同插件开关。已经是 Lead 的任务不再查插件开关
 * (团队已存在,管理操作由被控端逐次授权)。
 */
export async function readOrcaCollabEntryStatus(
  maker: MobileMakerTransport,
  session: Pick<RemoteSession, 'orcaRole' | 'orcaRemoteLead' | 'workspaceKind' | 'workingDir' | 'remoteHostId'>,
  agent: OrcaWorkerAgentKind,
): Promise<Exclude<OrcaCollabEntryStatus, 'loading'>> {
  if (!isOrcaCollabEligible(session)) return 'ineligible';
  let capabilities;
  try {
    capabilities = normalizeMobileAgentCapabilities(await maker.getCapabilities(agent));
  } catch (error) {
    return isOrcaUnsupportedError(error) ? 'unsupported' : 'unavailable';
  }
  if (capabilities?.supportsOrcaWorkerPermissionMode !== true) return 'unsupported';
  if (session.orcaRole === 'lead') return 'ready';
  const workingDir = session.remoteHostId ? undefined : session.workingDir?.trim() || undefined;
  try {
    const policy = readOrcaCollabPolicy(
      await maker.orca.getCollabPolicy(workingDir, session.workspaceKind),
      session.workspaceKind,
    );
    if (policy.unsupported) return 'unsupported';
    return policy.enabled ? 'ready' : 'disabled';
  } catch (error) {
    return isOrcaUnsupportedError(error) ? 'unsupported' : 'unavailable';
  }
}

export function orcaCollabEntryHint(status: OrcaCollabEntryStatus): string | null {
  switch (status) {
    case 'loading': return i18n.t('session.collab.loadingHint');
    case 'disabled': return i18n.t('session.collab.disabledHint');
    case 'unsupported': return i18n.t('session.collab.errors.unsupported');
    case 'unavailable': return i18n.t('session.collab.unavailableHint');
    default: return null;
  }
}

// ─── 写操作 ──────────────────────────────────────────────────────────────────

const TIMEOUT_RECOVERY_ATTEMPTS = 4;
const TIMEOUT_RECOVERY_DELAY_MS = 3000;
/** 回查的总时限:探针自身可能各走满隧道超时,只限次数不限时会把恢复窗口拖到分钟级。 */
const TIMEOUT_RECOVERY_DEADLINE_MS = 30_000;
/** 连续撞已占用 label 的上限(每次都是一次远端往返;正常一两次就能找到空位)。 */
const MAX_LABEL_ATTEMPTS = 20;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * 开启协同。mutation 前重读能力(弹窗展示时的快照可能已随重连降级);隧道超时后回查
 * 被控端 Worker 列表 —— 非空即团队已提交,按成功返回;查不到才把原始超时抛出。
 */
/**
 * 创建 Worker 前重读被控端能力:老被控端会忽略 workerPermissionMode、按它自己的默认权限
 * 建 Worker(可能是完全访问),与用户在手机上选的不符 —— 一律 fail-closed。
 */
async function assertWorkerPermissionSupported(
  maker: MobileMakerTransport,
  agent: OrcaWorkerAgentKind,
  executionDeviceId?: string,
): Promise<void> {
  // 权限协议位属于 Lead 宿主。远端 Worker 的 Agent 可以只安装在运行设备上，
  // 因此用 Lead 已注册的 Agent 查询宿主能力，不要求 Lead 也安装该 Worker Agent。
  const probeAgent = executionDeviceId ? (await maker.listAvailableAgents())[0] : agent;
  const capabilities = probeAgent
    ? normalizeMobileAgentCapabilities(await maker.getCapabilities(probeAgent))
    : null;
  if (capabilities?.supportsOrcaWorkerPermissionMode !== true) {
    throw new Error('[DEVICE_LINK_CHANNEL_NOT_ALLOWED] controlled device does not support Orca Worker permission mode');
  }
}

/** 隧道超时后按被控端 Worker 列表回查;predicate 命中即说明写操作已提交。 */
async function probeCommittedWorker(
  maker: MobileMakerTransport,
  leadSessionId: string,
  predicate: (worker: OrcaTeamWorker) => boolean,
): Promise<OrcaTeamWorker | null> {
  const deadline = Date.now() + TIMEOUT_RECOVERY_DEADLINE_MS;
  for (let attempt = 0; attempt < TIMEOUT_RECOVERY_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await delay(TIMEOUT_RECOVERY_DELAY_MS);
    if (Date.now() >= deadline) return null;
    try {
      const match = parseOrcaTeamWorkers(await maker.orca.listWorkers(leadSessionId)).find(predicate);
      if (match) return match;
    } catch (probeError) {
      if (!isTransientRemoteError(probeError)) return null;
    }
  }
  return null;
}

export async function enableOrcaTeam(
  maker: MobileMakerTransport,
  leadSessionId: string,
  options: MobileOrcaEnableOptions,
): Promise<{ workerSessionId: string | null }> {
  await assertWorkerPermissionSupported(maker, options.workerAgent, options.executionDeviceId);
  try {
    const result = await maker.orca.enable(leadSessionId, options);
    return { workerSessionId: typeof result?.workerSessionId === 'string' ? result.workerSessionId : null };
  } catch (error) {
    // 隧道超时不代表被控端没执行;ALREADY_EXISTS 说明已有团队(另一端刚开启 / 管线重跑),
    // 但团队先于首个 Worker 落库,并发开启时首个 Worker 仍可能失败。两种都以被控端的
    // Worker 列表为准:有 Worker 才算开启成功,查不到按原错误处理。
    const alreadyExists = formatRemoteError(error).includes('ALREADY_EXISTS');
    if (!alreadyExists && !isAmbiguousTimeout(error)) throw error;
    const committed = await probeCommittedWorker(maker, leadSessionId, () => true);
    if (committed) return { workerSessionId: committed.sessionId };
    throw error;
  }
}

/**
 * 追加 Worker:label 按现有团队派生,撞 DUPLICATE_LABEL(并发创建 / 已归档 Worker 占用)时跳过该 label 继续派生。
 * 隧道超时不是权威失败:按本次请求的确切 label 回查被控端,查到即成功;查不到抛
 * ORCA_CREATE_UNCONFIRMED,提示用户先看 Worker 列表,不让「超时→重试」建出第二个。
 */
export async function createOrcaWorker(
  maker: MobileMakerTransport,
  leadSessionId: string,
  form: OrcaWorkerFormValue,
  existingWorkers: readonly OrcaTeamWorker[],
): Promise<{ workerSessionId: string | null }> {
  await assertWorkerPermissionSupported(maker, form.agent, form.executionDeviceId);
  const role = form.role.trim() || 'developer';
  const submit = async (label: string) => {
    try {
      const result = await maker.orca.createWorker({
        leadSessionId,
        role,
        label,
        agent: form.agent,
        ...formWireFields(form),
        ...(form.initialTask.trim() ? { initialTask: form.initialTask.trim() } : {}),
      });
      return typeof result?.workerSessionId === 'string' ? result.workerSessionId : null;
    } catch (error) {
      if (!isAmbiguousTimeout(error)) throw error;
      const committed = await probeCommittedWorker(
        maker,
        leadSessionId,
        (worker) => worker.label?.toLowerCase() === label,
      );
      if (committed) return committed.sessionId;
      throw new Error('[ORCA_CREATE_UNCONFIRMED] worker creation timed out and could not be confirmed');
    }
  };
  // 与桌面 useOrcaWorkerSelection 同口径:已归档 Worker 不在列表里,但 label 在团队生命周期内
  // 永久占用;被拒的 label 记下来继续派生下一个,不重复撞同一个。
  const allocated = existingWorkers
    .map((worker) => worker.label)
    .filter((label): label is string => !!label);
  for (let attempt = 0; attempt < MAX_LABEL_ATTEMPTS; attempt += 1) {
    const label = createWorkerLabel(role, allocated);
    try {
      return { workerSessionId: await submit(label) };
    } catch (error) {
      if (!isOrcaDuplicateLabelError(error)) throw error;
      allocated.push(label);
    }
  }
  throw new Error('[DUPLICATE_LABEL] no unique worker label available');
}

/**
 * 归档 Worker(协同面板长按与 Worker 自身菜单共用)。隧道超时不是权威失败:只读回查一次
 * 团队,Worker 已不在列表里即归档已生效,按成功返回;仍在或回查失败时抛
 * ORCA_ACTION_UNCONFIRMED(提示以列表为准),由调用方回滚乐观状态。
 */
export async function archiveOrcaWorker(
  maker: MobileMakerTransport,
  leadSessionId: string,
  workerId: string,
): Promise<void> {
  try {
    await maker.orca.archiveWorker(leadSessionId, workerId);
  } catch (error) {
    if (!isAmbiguousTimeout(error)) throw error;
    const archived = await maker.orca.listWorkers(leadSessionId)
      .then((raw) => !parseOrcaTeamWorkers(raw).some((worker) => worker.workerId === workerId))
      .catch(() => false);
    if (archived) return;
    throw new Error('[ORCA_ACTION_UNCONFIRMED] worker archive timed out and could not be confirmed');
  }
}

/** 新建页协同草稿所属目标(设备 + 工作区):目标变了草稿作废。 */
export function orcaCollabDraftTargetKey(
  deviceId: string | null | undefined,
  workspaceKind: string | null | undefined,
  workingDir: string | null | undefined,
): string {
  return [deviceId ?? '', workspaceKind ?? '', workingDir ?? ''].join('\u0000');
}

// ─── 新建任务开启协同失败的跨页提示 ──────────────────────────────────────────
// 新建页在后台管线里开启协同;失败时任务照单任务继续,提示要在跳转后的会话页出现。
// 会话页通常在失败发生前就已挂载,所以既要能在挂载时取走,也要能在失败时推给已挂载的页面。
const orcaStartFailures = new Map<string, string>();
const orcaStartFailureListeners = new Set<(sessionId: string) => void>();

export function rememberOrcaStartFailure(sessionId: string, message: string): void {
  orcaStartFailures.set(sessionId, message);
  for (const listener of orcaStartFailureListeners) listener(sessionId);
}

export function subscribeOrcaStartFailure(listener: (sessionId: string) => void): () => void {
  orcaStartFailureListeners.add(listener);
  return () => { orcaStartFailureListeners.delete(listener); };
}

export function takeOrcaStartFailure(sessionId: string): string | null {
  const message = orcaStartFailures.get(sessionId) ?? null;
  orcaStartFailures.delete(sessionId);
  return message;
}

export function orcaWorkerStatusLabel(status: OrcaTeamWorker['status']): string {
  return i18n.t(`session.collab.status.${status}`);
}

export function orcaWorkerDisplayName(worker: Pick<OrcaTeamWorker, 'role' | 'label'>): string {
  return worker.label && worker.label !== worker.role ? `${worker.role} #${worker.label}` : worker.role;
}

export function orcaAgentLabel(agent: OrcaWorkerAgentKind): string {
  return agent === 'codex' ? 'Codex' : agent === 'pi' ? 'Pi' : 'Claude Code';
}
