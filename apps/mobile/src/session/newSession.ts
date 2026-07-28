import { stripTrailingPathSeparators } from '@cindy/maker-shared/path-text';
import { i18n } from '@/i18n';
import type { CreateSessionOptions, RemoteDirectoryEntry } from '@/device-link/mobileMakerTransport';
import { reconcileEffortForModel, type ProviderModelRow } from './providerModelSections';
import type { RemoteSession } from './types';

export type NewSessionAgentKind = 'claude-code' | 'codex';
export type NewSessionWorkspaceKind = 'project' | 'dialogue';

export interface NewSessionDraft {
  agentKind: NewSessionAgentKind;
  workspaceKind: NewSessionWorkspaceKind;
  workingDir: string;
  model: string;
  /**
   * 显式选中的供应商(来源)id。null = 跟随被控端默认路由(对齐桌面:草稿不写本地 prefs 默认,
   * 由被控端 nativeDefaultSourceId 决定)。仅当用户在模型下拉里选了某来源时才非空。
   */
  providerId: string | null;
  effort: string;
  permissionMode: string;
  fastMode: boolean;
  firstMessage: string;
  extraDirs?: string[];
}

export interface CreateSessionResult {
  sessionId: string;
  agentKind?: string;
  workDir?: string;
  capabilities?: unknown;
  usedProjectContext?: boolean;
}

export interface RecentWorkspaceOption {
  workingDir: string;
  title: string;
  sessionCount: number;
  lastActivityAt: string;
}

export interface NewSessionDeviceOption {
  deviceId: string;
  name: string;
}

export interface NewSessionStoredPreferences {
  agentKind: NewSessionAgentKind | null;
  device: NewSessionDeviceOption | null;
  /**
   * 每个 agent 上次在新建页显式选过的权限档(对齐桌面 lastByVendor 的权限记忆语义);
   * 没选过 = 缺失,回落该 agent 的安全种子默认。'plan' 不入记忆(计划模式是独立开关)。
   */
  permissionModeByAgent: Partial<Record<NewSessionAgentKind, string>>;
}

export interface NewSessionDraftSummary {
  agentLabel: string;
  canCreate: boolean;
  runtimeLabel: string;
  scopeLabel: string;
  validationMessage: string | null;
  workspaceLabel: string;
}

export interface NewSessionCreatePreview {
  title: string;
  subtitle: string;
  details: string[];
}

export interface NewSessionDraftContentState {
  attachmentCount?: number;
}

export function serializeNewSessionDeviceOptions(
  options: readonly NewSessionDeviceOption[],
): string {
  return JSON.stringify(normalizeNewSessionDeviceOptions(options));
}

export function parseNewSessionDeviceOptions(
  value: unknown,
  fallback?: NewSessionDeviceOption | null,
): NewSessionDeviceOption[] {
  return normalizeNewSessionDeviceOptions([
    ...readNewSessionDeviceOptionsParam(value),
    ...(fallback ? [fallback] : []),
  ]);
}

export function normalizeNewSessionAgentKind(value: unknown): NewSessionAgentKind | null {
  return value === 'claude-code' || value === 'codex' ? value : null;
}

export function pickNewSessionDefaultDevice(input: {
  deviceOptions: readonly NewSessionDeviceOption[];
  preferredDeviceId?: string | null;
  routeDevice?: NewSessionDeviceOption | null;
  routeDeviceExplicit: boolean;
}): NewSessionDeviceOption | null {
  const preferred = input.preferredDeviceId
    ? input.deviceOptions.find((option) => option.deviceId === input.preferredDeviceId) ?? null
    : null;
  if (!input.routeDeviceExplicit && preferred) return preferred;
  if (input.routeDevice) return input.routeDevice;
  return preferred ?? input.deviceOptions[0] ?? null;
}

export const DEFAULT_NEW_SESSION_DRAFT: NewSessionDraft = {
  agentKind: 'claude-code',
  workspaceKind: 'project',
  workingDir: '',
  model: 'claude-sonnet-4-6',
  providerId: null,
  effort: 'medium',
  // Claude 保留 Auto-review 种子默认；用户上次在新建页选过的档走
  // newSessionPreferenceStore 的 per-agent 记忆恢复。
  permissionMode: 'auto',
  fastMode: false,
  firstMessage: '',
};

const DEFAULT_MODELS: Record<NewSessionAgentKind, string> = {
  'claude-code': 'claude-sonnet-4-6',
  codex: 'gpt-5.4',
};

/** 新建交互式会话的权限种子默认；两种 agent 都保留 Auto-review。 */
export function defaultPermissionModeForNewSessionAgent(_agentKind: NewSessionAgentKind): string {
  return 'auto';
}

export function withAgentDefaults(
  draft: NewSessionDraft,
  agentKind: NewSessionAgentKind,
): NewSessionDraft {
  if (draft.agentKind === agentKind) return draft;
  return {
    ...draft,
    agentKind,
    model: DEFAULT_MODELS[agentKind],
    permissionMode: defaultPermissionModeForNewSessionAgent(agentKind),
    // 换 agent → 来源选择作废(各 agent 的供应商集不同),回到默认路由由被控端定。
    providerId: null,
    fastMode: agentKind === 'codex' ? draft.fastMode : false,
  };
}

export function validateNewSessionDraft(
  draft: NewSessionDraft,
  content: NewSessionDraftContentState = {},
): string | null {
  if (draft.workspaceKind === 'project' && !draft.workingDir.trim()) {
    return i18n.t('session.new.enterProjectPath');
  }
  if (!draft.model.trim()) return i18n.t('session.new.enterModel');
  if (!hasFirstMessagePayload(draft, content)) return i18n.t('session.new.enterFirstMessageOrAttachment');
  return null;
}

/**
 * 校验失败是否**仅**缺正文/附件(项目路径与模型均已通过)。
 * 语音听写中「点创建 = 停录并用转写创建」的豁免判定:只有这一类失败会被
 * 最终转写补上,才允许放行。结构化判定,与 validateNewSessionDraft 同模块
 * 同顺序维护——不要在调用方比对本地化文案(locale 异步恢复时 memo 住的
 * 旧语言文案与新 t() 输出不等,豁免会静默失效)。
 */
export function isNewSessionDraftMissingPayloadOnly(
  draft: NewSessionDraft,
  content: NewSessionDraftContentState = {},
): boolean {
  if (draft.workspaceKind === 'project' && !draft.workingDir.trim()) return false;
  if (!draft.model.trim()) return false;
  return !hasFirstMessagePayload(draft, content);
}

export function summarizeNewSessionDraft(
  draft: NewSessionDraft,
  content: NewSessionDraftContentState = {},
): NewSessionDraftSummary {
  const validationMessage = validateNewSessionDraft(draft, content);
  const agentLabel = draft.agentKind === 'codex' ? 'Codex' : 'Claude';
  const model = draft.model.trim() || i18n.t('session.new.noModelSelected');
  const effort = draft.effort.trim();
  const workspaceLabel = draft.workspaceKind === 'dialogue'
    ? i18n.t('session.new.workspaceDialogue')
    : i18n.t('session.new.workspaceProject');
  const trimmedWorkingDir = draft.workingDir.trim();
  const extraDirs = normalizeExtraDirs(draft.extraDirs);
  return {
    agentLabel,
    canCreate: validationMessage === null,
    runtimeLabel: [agentLabel, model, effort || null, draft.fastMode ? 'Fast' : null].filter(Boolean).join(' · '),
    scopeLabel: draft.workspaceKind === 'dialogue'
      ? i18n.t('session.new.assignedDialogueDir')
      : trimmedWorkingDir
        ? [projectTitle(trimmedWorkingDir), extraDirs.length > 0 ? i18n.t('session.new.extraDirsSuffix', { num: extraDirs.length }) : null].filter(Boolean).join(' · ')
        : i18n.t('session.new.noProjectPath'),
    validationMessage,
    workspaceLabel,
  };
}

export function buildNewSessionCreatePreview(
  draft: NewSessionDraft,
  deviceName: string,
  content: NewSessionDraftContentState = {},
): NewSessionCreatePreview {
  const summary = summarizeNewSessionDraft(draft, content);
  const message = draft.firstMessage.trim();
  const attachmentCount = normalizeAttachmentCount(content.attachmentCount);
  const target = draft.workspaceKind === 'dialogue'
    ? i18n.t('session.new.dialogueWorkspace')
    : draft.workingDir.trim() || i18n.t('session.new.noProjectPath');
  const details = [
    i18n.t('session.new.previewDevice', { name: deviceName || i18n.t('session.new.unknownDevice') }),
    i18n.t('session.new.previewLocation', { target }),
    i18n.t('session.new.previewRuntime', { runtime: summary.runtimeLabel }),
    message
      ? i18n.t('session.new.previewFirstMessage', { preview: clipPreview(message, 64) })
      : attachmentCount > 0
        ? i18n.t('session.new.previewFirstAttachmentOnly')
        : i18n.t('session.new.previewFirstEmpty'),
    ...(attachmentCount > 0 ? [i18n.t('session.new.previewAttachments', { num: attachmentCount })] : []),
  ];
  return {
    title: summary.canCreate ? i18n.t('session.new.previewReadyTitle') : i18n.t('session.new.previewNotReadyTitle'),
    subtitle: summary.validationMessage ?? i18n.t('session.new.previewReadySubtitle'),
    details,
  };
}

export function parseExtraDirsInput(value: string): string[] {
  return normalizeExtraDirs(value.split(/[\n,]/));
}

/** 移动端项目目录浏览默认隐藏点号目录，用户显式开启后才完整展示。 */
export function filterRemoteDirectoryEntries(
  entries: readonly RemoteDirectoryEntry[],
  showHiddenDirectories: boolean,
): readonly RemoteDirectoryEntry[] {
  if (showHiddenDirectories) return entries;
  return entries.filter((entry) => !entry.name.startsWith('.'));
}

export function buildRecentWorkspaceOptions(
  sessions: readonly RemoteSession[],
  deviceId?: string,
  limit = 6,
): RecentWorkspaceOption[] {
  const byPath = new Map<string, RecentWorkspaceOption>();
  for (const session of sessions) {
    if (deviceId && session.deviceLinkDeviceId && session.deviceLinkDeviceId !== deviceId) continue;
    if (session.status === 'deleted') continue;
    if (session.workspaceKind !== 'project') continue;
    const workingDir = session.workingDir?.trim();
    if (!workingDir) continue;
    const lastActivityAt = session.userSendAt ?? session.updatedAt ?? session.createdAt;
    const current = byPath.get(workingDir);
    if (!current) {
      byPath.set(workingDir, {
        workingDir,
        title: projectTitle(workingDir),
        sessionCount: 1,
        lastActivityAt,
      });
      continue;
    }
    current.sessionCount += 1;
    if (lastActivityAt.localeCompare(current.lastActivityAt) > 0) {
      current.lastActivityAt = lastActivityAt;
    }
  }

  return [...byPath.values()]
    .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt) || a.workingDir.localeCompare(b.workingDir))
    .slice(0, Math.max(0, limit));
}

export interface NewSessionRuntime {
  agentKind: NewSessionAgentKind;
  model: string;
  effort: string;
}

/**
 * 从现有会话列表挑"最近一次"的整套运行配置(agent + model + effort),用于新建对话默认跟随最近会话。
 * 过滤:排除 status==='deleted'、无 model;可选 `deviceId`(只看该设备——模型列表 per-device,跨设备 model 可能
 * 在目标设备不存在);可选 `agentKind`(只看该 agent)。排序:按活动时间(userSendAt ?? updatedAt ?? createdAt)
 * 降序取第一条。映射 `RemoteSession.agentKind`('cc'|'codex') → NewSessionDraft 的 'claude-code'|'codex'。无匹配→null。
 * deviceId 过滤口径对齐 buildRecentWorkspaceOptions:仅当 session 带了 deviceLinkDeviceId 且与目标不符才排除。
 */
export function pickMostRecentSessionRuntime(
  sessions: readonly RemoteSession[],
  options: { deviceId?: string; agentKind?: NewSessionAgentKind } = {},
): NewSessionRuntime | null {
  let best: { runtime: NewSessionRuntime; activityAt: string } | null = null;
  for (const session of sessions) {
    if (session.status === 'deleted') continue;
    const model = session.model?.trim();
    if (!model) continue;
    if (options.deviceId && session.deviceLinkDeviceId && session.deviceLinkDeviceId !== options.deviceId) continue;
    const agentKind: NewSessionAgentKind = session.agentKind === 'codex' ? 'codex' : 'claude-code';
    if (options.agentKind && agentKind !== options.agentKind) continue;
    const activityAt = session.userSendAt ?? session.updatedAt ?? session.createdAt;
    if (!best || activityAt.localeCompare(best.activityAt) > 0) {
      best = {
        runtime: { agentKind, model, effort: session.effort?.trim() ?? '' },
        activityAt,
      };
    }
  }
  return best?.runtime ?? null;
}

/**
 * 算"切到某 agent 后的默认运行配置(model + effort)",供新建对话「切 agent」入口复用,
 * 与初始自动默认共用同一套 fallback 口径。纯函数:所有输入显式传入,不读 react / 设备状态。
 * model 优先级:
 *   1) 该 agent 的最近一次会话模型(pickMostRecentSessionRuntime,按 deviceId scope);
 *   2) 否则该 agent 的模型列表最上面那个(modelRows[0] —— providers 已加载时同步可得,
 *      与下拉渲染的第一项一致);
 *   3) 否则该 agent 的内置默认 DEFAULT_MODELS[agentKind]。
 * effort:reconcile 到目标 model 的合法档(reconcileEffortForModel,base = 最近会话 effort ?? 当前 effort);
 *   拿不到目标 model 对应的 SectionModel(model 不在 modelRows 里,如走了 DEFAULT_MODELS 兜底或历史模型已下架)
 *   时保留 base effort 不动。providerId 由调用方统一置 null(各 agent 供应商集不同,回默认路由)。
 */
export function pickAgentDefaultRuntime(args: {
  agentKind: NewSessionAgentKind;
  sessions: readonly RemoteSession[];
  modelRows: readonly ProviderModelRow[];
  currentEffort: string;
  deviceId?: string;
}): NewSessionRuntime {
  const { agentKind, sessions, modelRows, currentEffort, deviceId } = args;
  const recent = pickMostRecentSessionRuntime(sessions, { deviceId, agentKind });
  const baseEffort = recent?.effort ?? currentEffort;
  let model: string;
  let sectionModel = recent?.model
    ? modelRows.find((row) => row.model.id === recent.model)?.model
    : undefined;
  if (recent?.model) {
    model = recent.model;
  } else if (modelRows[0]) {
    sectionModel = modelRows[0].model;
    model = sectionModel.id;
  } else {
    model = DEFAULT_MODELS[agentKind];
  }
  const effort = sectionModel ? reconcileEffortForModel(sectionModel, baseEffort) : baseEffort;
  return { agentKind, model, effort };
}

/**
 * 新建对话「自动默认运行配置」effect 的决策核心(纯函数,从 new.tsx 那个 effect 内联逻辑抽出,便于单测)。
 * 返回 null = 本次不动 draft(已手动选过 / 无 selectedDevice / 该设备已应用过 / modelRows 未就绪且无 recent);
 * 返回 { patch, appliedDeviceId } = 调用方 setDraft(prev => ({ ...prev, ...patch })) 并记录 appliedDeviceId。
 * 三条意图与 effect 完全一致:
 *   1) 有最近会话(按 selectedDeviceId scope)→ 整套跟随(agentKind + model + effort,effort reconcile 同
 *      pickAgentDefaultRuntime 口径:model 命中 modelRows 才 reconcile,否则保留;providerId 置 null);
 *   2) 无最近会话但 modelRows 就绪 → 取列表最上面(model + effort reconcile + providerId:null,不动 agentKind);
 *   3) 无最近会话且 modelRows 未就绪(providers 加载中)→ null(等下次 modelRows 就绪再设,绝不误设)。
 * currentEffort = 当前 draft.effort,作为 reconcile 的 base(与 effect 里 setDraft updater 读 current.effort 等价)。
 */
export function resolveNewSessionAutoDefault(input: {
  userTouched: boolean;
  appliedDeviceId: string | null;
  selectedDeviceId: string;
  sessions: readonly RemoteSession[];
  modelRows: readonly ProviderModelRow[];
  currentEffort: string;
}): { patch: Partial<NewSessionDraft>; appliedDeviceId: string } | null {
  const { userTouched, appliedDeviceId, selectedDeviceId, sessions, modelRows, currentEffort } = input;
  if (userTouched) return null;
  if (!selectedDeviceId) return null;
  if (appliedDeviceId === selectedDeviceId) return null;
  const recent = pickMostRecentSessionRuntime(sessions, { deviceId: selectedDeviceId });
  if (recent) {
    const sectionModel = modelRows.find((row) => row.model.id === recent.model)?.model;
    return {
      appliedDeviceId: selectedDeviceId,
      patch: {
        agentKind: recent.agentKind,
        model: recent.model,
        effort: sectionModel
          ? reconcileEffortForModel(sectionModel, recent.effort || currentEffort)
          : recent.effort || currentEffort,
        permissionMode: defaultPermissionModeForNewSessionAgent(recent.agentKind),
        providerId: null,
      },
    };
  }
  // 无最近会话 → 列表最上面那个(与 UI 渲染第一项一致);列表未就绪则不动,等下次触发。
  const top = modelRows[0];
  if (!top) return null;
  return {
    appliedDeviceId: selectedDeviceId,
    patch: {
      model: top.model.id,
      effort: reconcileEffortForModel(top.model, currentEffort),
      providerId: null,
    },
  };
}

export function pickInitialNewSessionWorkspace(
  currentWorkingDir: string,
  recentWorkspaces: readonly RecentWorkspaceOption[],
): string | null {
  if (currentWorkingDir.trim()) return null;
  return recentWorkspaces[0]?.workingDir ?? null;
}

export function buildRemoteCreateSessionOptions(draft: NewSessionDraft): CreateSessionOptions {
  const extraDirs = normalizeExtraDirs(draft.extraDirs);
  const effort = draft.effort.trim();
  const providerId = draft.providerId?.trim();
  const base = {
    agentKind: draft.agentKind,
    workspaceKind: draft.workspaceKind,
    model: draft.model.trim(),
    permissionMode: draft.permissionMode,
    fastMode: draft.fastMode,
    ...(effort ? { effort } : {}),
    // 仅显式选了非空来源才带 providerId(空 = NULL = 被控端默认路由,对齐桌面 deviceLinkCreateArgs)。
    ...(providerId ? { providerId } : {}),
  };
  if (draft.workspaceKind === 'dialogue') return base;
  return {
    ...base,
    workingDir: draft.workingDir.trim(),
    ...(extraDirs.length > 0 ? { extraDirs } : {}),
  };
}

export function normalizeCreateSessionResult(value: unknown): CreateSessionResult | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const sessionId = record.sessionId;
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
  return {
    sessionId,
    agentKind: readString(record.agentKind),
    workDir: readString(record.workDir),
    capabilities: record.capabilities,
    usedProjectContext: record.usedProjectContext === true,
  };
}

export function sessionFromCreateResult(
  result: CreateSessionResult,
  fallback: Pick<NewSessionDraft, 'agentKind' | 'workspaceKind' | 'model' | 'effort' | 'permissionMode' | 'fastMode' | 'workingDir'>,
  now = new Date(),
): RemoteSession {
  const iso = now.toISOString();
  return {
    id: result.sessionId,
    userId: '',
    title: 'New remote session',
    workingDir: result.workDir ?? fallback.workingDir,
    workspaceKind: fallback.workspaceKind,
    model: fallback.model,
    effort: fallback.effort,
    permissionMode: fallback.permissionMode,
    fastMode: fallback.fastMode,
    status: 'active',
    agentKind: fallback.agentKind === 'codex' ? 'codex' : 'cc',
    userSendAt: iso,
    createdAt: iso,
    updatedAt: iso,
    _count: { messages: 0 },
  };
}

export function normalizeExtraDirs(value: readonly string[] | undefined): string[] {
  if (!value) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function readNewSessionDeviceOptionsParam(value: unknown): NewSessionDeviceOption[] {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string' || raw.trim().length === 0) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
      const record = item as Record<string, unknown>;
      const deviceId = readString(record.deviceId)?.trim() ?? '';
      if (!deviceId) return [];
      const name = readString(record.name)?.trim() || deviceId;
      return [{ deviceId, name }];
    });
  } catch {
    return [];
  }
}

function normalizeNewSessionDeviceOptions(
  options: readonly NewSessionDeviceOption[],
): NewSessionDeviceOption[] {
  const result: NewSessionDeviceOption[] = [];
  const seen = new Set<string>();
  for (const option of options) {
    const deviceId = option.deviceId.trim();
    if (!deviceId || seen.has(deviceId)) continue;
    seen.add(deviceId);
    result.push({ deviceId, name: option.name.trim() || deviceId });
  }
  return result;
}

function projectTitle(workingDir: string): string {
  const trimmed = stripTrailingPathSeparators(workingDir);
  const parts = trimmed.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || workingDir;
}

function clipPreview(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength)}...` : compact;
}

function hasFirstMessagePayload(
  draft: Pick<NewSessionDraft, 'firstMessage'>,
  content: NewSessionDraftContentState,
): boolean {
  return draft.firstMessage.trim().length > 0 || normalizeAttachmentCount(content.attachmentCount) > 0;
}

function normalizeAttachmentCount(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
