import { stripTrailingPathSeparators } from '@cindy/maker-shared/path-text';
import { collapseWorktreeDirForGrouping } from '@cindy/maker-shared/worktree-paths';
import {
  DEFAULT_DRAFT_SESSION_TITLE,
  deriveOptimisticSessionTitle,
} from '@cindy/maker-shared/session-title';
import { i18n } from '@/i18n';
import type { CreateSessionOptions, RemoteDirectoryEntry } from '@/device-link/mobileMakerTransport';
import type { DeviceProvidersPayload } from '@/device-link/deviceProvidersCache';
import type { MobileModelOption } from './agentCapabilities';
import { effectiveSourceIdForModel } from '@cindy/model-providers/registry';
import { reconcileEffortForModel, type ProviderModelRow } from './providerModelSections';
import type { RemoteSession } from './types';

export type NewSessionAgentKind = 'claude-code' | 'codex' | 'pi';
export type NewSessionWorkspaceKind = 'project' | 'dialogue';

export const NEW_SESSION_AGENT_OPTIONS: readonly { kind: NewSessionAgentKind; label: string }[] = [
  { kind: 'claude-code', label: 'Claude' },
  { kind: 'codex', label: 'Codex' },
  { kind: 'pi', label: 'Pi' },
];

/**
 * 按被控端 runtime 已注册的 agent 集合过滤新建入口(maker:list-available-agents)。
 * `available === null` = 尚未拉到 → fail-open 返回全部(避免异步期间误隐藏合法 agent);
 * 拉到后只保留已注册的 kind —— Pi 二进制缺失时被控端无 pi,过滤掉可防用户建出最终
 * requireAgent 报 not-registered 的会话(codex review P2)。
 */
export function availableNewSessionAgentOptions(
  available: ReadonlySet<NewSessionAgentKind> | null,
): readonly { kind: NewSessionAgentKind; label: string }[] {
  if (!available) return NEW_SESSION_AGENT_OPTIONS;
  const filtered = NEW_SESSION_AGENT_OPTIONS.filter((option) => available.has(option.kind));
  // 防御:被控端异常返回空集时不至于把入口清空到无法创建(至少保留 Claude)。
  return filtered.length > 0 ? filtered : NEW_SESSION_AGENT_OPTIONS.filter((o) => o.kind === 'claude-code');
}

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
  /** 上次显式选择的项目/对话模式；null 表示尚未选择，沿用入口默认。 */
  workspaceKind: NewSessionWorkspaceKind | null;
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
  return value === 'claude-code' || value === 'codex' || value === 'pi' ? value : null;
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
  pi: 'gpt-5.4',
};

/** 新建交互式会话的权限种子默认；三个 agent 都保留 Auto-review。 */
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
    fastMode: agentKind === 'claude-code' ? false : draft.fastMode,
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
  const agentLabel = draft.agentKind === 'codex' ? 'Codex' : draft.agentKind === 'pi' ? 'Pi' : 'Claude';
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
    const rawWorkingDir = session.workingDir?.trim();
    if (!rawWorkingDir) continue;
    const workingDir = collapseWorktreeDirForGrouping(rawWorkingDir);
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
  /**
   * 来源(供应商)id;null = 跟随被控端默认路由。跟随最近会话 / 取模型列表首项时连同
   * model 一起带出 —— 只带 model 不带来源会把自定义供应商模型(如 deepseek-v4-flash)
   * 回落到默认网关,网关无该裸 id → 400 Invalid model name(#1898)。
   */
  providerId: string | null;
}

type NewSessionDefaultModel = {
  id: string;
  efforts: readonly string[];
  defaultEffort: string | null;
  newSessionDefault?: readonly ('claude-code' | 'codex' | 'pi')[];
};

function isNewSessionDefaultForAgent(
  model: NewSessionDefaultModel,
  agentKind: NewSessionAgentKind,
): boolean {
  return model.newSessionDefault?.includes(agentKind) === true;
}

function pickRegionalNewSessionDefault<T extends NewSessionDefaultModel>(
  models: readonly T[],
  agentKind: NewSessionAgentKind,
): T | undefined {
  return models.find((model) => isNewSessionDefaultForAgent(model, agentKind));
}

/**
 * 校验 draft 里的来源(providerId)对当前 model 是否仍然有效:
 * - providerId 为空 → null(默认路由);
 * - catalogReady=false(目录未就绪,providers 仍在拉取)→ 无法校验,信任既有绑定 ——
 *   同设备最近会话的来源是当时最强的证据,被控端是最终路由真相;此处清空反而会把
 *   绑定丢掉(#1898);
 * - catalogReady=true(目录已就绪,哪怕为空)→ 必须仍存在 (provider, model) 匹配行,
 *   否则清空回默认路由 —— provider 被删/断开/模型下架后,继续带着失效来源会让创建
 *   或首条消息直接失败(Greptile/Copilot review P1:空清单与"加载中"必须区分)。
 *
 * 同时服务两个场景:自动默认继承最近会话来源时的校验,与目录就绪后的来源终检
 * (codex review P1:加载期信任的来源,就绪后必须复核)。
 */
export function validateModelProviderId(
  modelRows: readonly ProviderModelRow[],
  providerId: string | null | undefined,
  modelId: string,
  catalogReady: boolean,
): string | null {
  if (!providerId) return null;
  if (!catalogReady) return providerId;
  const stillOffered = modelRows.some(
    (row) => row.provider.id === providerId && row.model.id === modelId,
  );
  return stillOffered ? providerId : null;
}

/**
 * 联合解析 (model, providerId)(codex review P1:provider 失效时 model 必须一起回退——
 * 只清 provider 保留裸模型 id 会回落默认网关,正是 #1898 的 400 Invalid model name):
 *   1) 来源仍有效(或本来就走默认路由)→ 原样保留;
 *   2) 失效但仍有其他已连接来源提供该模型 → 顶替为该来源(模型照用);
 *   3) 没有任何来源提供该模型 → 落目录首项(连同其 provider);
 *   4) 目录为空 → 该 agent 内置默认模型 + 默认路由;
 * catalogReady=false 时不评判,维持信任语义(见 validateModelProviderId)。
 * 通用于「跟随最近会话」的自动默认与「提交点 / 目录就绪」的草稿终检(codex review P2:
 * 提交终检时同样联合回退)。
 */
export function resolveRecentModelAndProvider(
  modelRows: readonly ProviderModelRow[],
  recent: { model: string; providerId: string | null },
  agentKind: NewSessionAgentKind,
  catalogReady: boolean,
): { model: string; providerId: string | null } {
  if (!catalogReady) return { model: recent.model, providerId: recent.providerId };
  // providerId 为 null 分两种:①该会话本来就走被控端默认路由(合法来源);
  // ②历史版本遗留的「自定义供应商模型 + providerId=NULL」坏数据(#1898 典型
  // 现场)——目录就绪且 modelRows 存在同名模型行时补全为该行 provider,让自动
  // 默认自愈旧数据,不再产出「裸 model + 默认网关」的必 400 组合(copilot P2);
  // 无同名行(真内置默认模型)保持 null。
  if (!recent.providerId) {
    // 同名模型行的提供者集合:空 → 无该模型行(真内置默认)保持 null;
    // 唯一提供者 → 无歧义自愈(#1898 坏数据现场);多提供者 → 不能取目录首行——
    // 实际默认来源由被控端按 agent 解析(effectiveSourceIdForModel,Claude Code
    // 优先 XD,即使 Anthropic 排在目录前面),取首行会把默认路由固化成别的供应商,
    // 改变凭证/计费/Fast 语义(codex review P2:保留 null 草稿的默认来源语义)。
    // 多来源时按同一默认来源解析函数选来源,解析不到 → 保留 null 默认路由。
    const offerings = modelRows.filter((row) => row.model.id === recent.model);
    if (offerings.length === 1) return { model: recent.model, providerId: offerings[0].provider.id };
    if (offerings.length > 1) {
      const defaultSourceId = effectiveSourceIdForModel(
        offerings.map((row) => row.provider),
        null,
        recent.model,
        agentKind,
      );
      if (defaultSourceId) return { model: recent.model, providerId: defaultSourceId };
    }
    return { model: recent.model, providerId: null };
  }
  const valid = validateModelProviderId(modelRows, recent.providerId, recent.model, true);
  if (valid) return { model: recent.model, providerId: valid };
  // 显式来源失效的替代选择:与 null 分支同口径(codex review P2:按 Agent 默认
  // 规则选择失效来源的替代项)——同名模型多来源时**不得取目录首行**(目录顺序
  // ≠ Agent 原生默认顺序,如 Codex 候选 [custom, xd] 会被首行绑定到 custom,
  // 而 effectiveSourceIdForModel 与模型面板高亮都选 xd,会悄然改用另一套凭证/
  // 计费/Fast 语义)。单来源 → 无歧义顶替;多来源 → 按 agent 默认解析,解析不到
  // → 落目录首项(整体回退)。
  const offerings = modelRows.filter((row) => row.model.id === recent.model);
  if (offerings.length === 1) return { model: recent.model, providerId: offerings[0].provider.id };
  if (offerings.length > 1) {
    const defaultSourceId = effectiveSourceIdForModel(
      offerings.map((row) => row.provider),
      null,
      recent.model,
      agentKind,
    );
    if (defaultSourceId) return { model: recent.model, providerId: defaultSourceId };
  }
  const top = modelRows[0];
  if (top) return { model: top.model.id, providerId: top.provider.id };
  return { model: DEFAULT_MODELS[agentKind], providerId: null };
}

/**
 * 提交终检的目录取信(代际安全版,独立 review P1-1):**唯一数据源 = 设备缓存 + 代际**,
 * 不再读渲染期 rows——catalogReadyRef 是渲染期镜像,外部驱逐后要等下一渲染才失效,
 * 渲染 rows 在该窗口内不可信(㉛ 分支此前因此被绕过)。缓存写入受代际门控
 * (fetch 完成时代际已变则不回写),故缓存内容恒为「当前代最新一次完成的快照」,
 * 缓存命中即当前代已确认目录(含 loaded-but-empty)。判定:
 * - 缓存命中 → 采信(不 fetch,零额外往返);
 * - 未命中 + 从未驱逐(gen=0,冷启动)→ 「一无所知」→ 信任(不加延迟,原语义);
 * - 未命中 + 曾驱逐(gen>0,重拉窗口)→ await 在途重拉(缓存层 inflight 去重,join);
 *   await **前后各核对一次代际**——期间换代则弃用旧 promise 返回值、join 新代
 *   (循环 ≤3,防代际持续抖动死循环);重拉失败且代际稳定 → 未知 → 信任(fail-open)。
 */
export async function resolveSubmitGuardCatalog(args: {
  /** 普通创建保留用户选择，由后台建链后的权威目录终检；Goal 不适用。 */
  deferRefreshToCreation?: boolean;
  /** 设备缓存读取(驱逐即清空;写入受代际门控)。 */
  cached: () => DeviceProvidersPayload | undefined;
  /** 当前设备缓存代际(驱逐 +1;0 = 从未驱逐)。 */
  gen: () => number;
  /** 拉取器(缓存层 inflight 去重)。 */
  fetch: () => Promise<DeviceProvidersPayload>;
  /** 把 payload 重建为守卫 rows(含 keepSelected 豁免)。 */
  buildRows: (payload: DeviceProvidersPayload) => readonly ProviderModelRow[];
}): Promise<{ rows: readonly ProviderModelRow[]; catalogKnown: boolean; genAt: number }> {
  const { cached, gen, fetch, buildRows } = args;
  if (args.deferRefreshToCreation) {
    // 旧缓存可能缺少刚连接的来源，不能先把用户选择回退、再让 fresh 校验这个回退值。
    return { rows: [], catalogKnown: false, genAt: gen() };
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const genAt = gen();
    const hit = cached();
    if (hit) {
      // 缓存命中也要与新鲜响应 revalidate(codex review P1):缓存仍含 provider A,
      // 但工作站已换成 B 时(confirmAgentUnauthenticated 现拉过 fresh 却不回写缓存),
      // 直接采信缓存会向已移除的来源发创建 → 失败。join 一次拉取(缓存层 inflight
      // 去重,不重复发请求):成功 → 用新目录(同时缓存层回写);失败 → 回退缓存命中
      // (历史知识优于未知,保持 fail-open 语义)。
      try {
        const fresh = await fetch();
        if (gen() !== genAt) continue; // 拉取期间换代 → join 新代
        return { rows: buildRows(fresh), catalogKnown: true, genAt };
      } catch {
        if (gen() !== genAt) continue;
        return { rows: buildRows(hit), catalogKnown: true, genAt };
      }
    }
    if (genAt === 0) {
      // 冷启动:首轮拉取可能在途——join 它(缓存层 inflight 去重,不重复发请求),
      // 成功按新目录校验,避免带着已失效的最近会话绑定提交(Codex review P2:
      // 目录就绪后的终检 effect 来不及纠正提交);首轮拉取失败 → 未知 → 信任
      // (原 fail-open 语义)。
      try {
        const fresh = await fetch();
        if (gen() !== genAt) continue; // 拉取期间换代 → join 新代
        return { rows: buildRows(fresh), catalogKnown: true, genAt };
      } catch {
        if (gen() !== genAt) continue;
        return { rows: [], catalogKnown: false, genAt };
      }
    }
    try {
      const fresh = await fetch();
      // await 期间换代 → 旧 promise 返回值已过期(缓存层只拒绝回写、仍 resolve),
      // 弃用并 join 新代(下一轮循环重读缓存/新 inflight)。
      if (gen() !== genAt) continue;
      return { rows: buildRows(fresh), catalogKnown: true, genAt };
    } catch {
      if (gen() !== genAt) continue;
      return { rows: [], catalogKnown: false, genAt };
    }
  }
  return { rows: [], catalogKnown: false, genAt: gen() };
}

/**
 * 设备切换时的预创建 worktree 补偿(独立 review P1-3):**不得在远端目录已产生后
 * 只删账本**——forgetPendingPrecreatedWorktree 会删掉唯一 ledger 行,而远端目录
 * 还在,恢复器从此找不到它 → 永久孤儿。分阶段:
 * - phase='precreated'(远端目录已产生):先 discardPrecreated 获**严格 ACK**
 *   (parseAck 返回 { discarded: true }),ACK 后才 forget + release;ACK 失败 /
 *   未知 / discard 抛错 → **保留 ledger**(留给 recovery 对账回收)。注意 retained
 *   分支本身不调 release——调用方的外层 finally 会兜底释放内存持有(volatile
 *   镜像只挡本进程重复造孤儿,不冒充跨进程保证)。
 * - phase='reserved'(仅账本,无远端副作用):直接 forget 安全。
 * 返回 'discarded' = 远端与账本均已清理;'retained' = 账本保留待 recovery。
 * deps 注入(含 parseAck)便于 node 单测覆盖各阶段时序。
 */
/**
 * started 落账后的设备切换处置(独立 review round-23 Spec P1-1/P1-2):
 * 设备已切换 → 尝试把账本 durable 降级回 precreated(可回收阶段):
 * - 降级成功 → 返回 'downgraded'(调用方 return,recovery 可回收);
 * - 降级失败(读/写异常或返回 false)→ **恢复 volatile 回 started** 后返回
 *   'commit'——register 在首个 await 前已同步把 volatile 升为 precreated,若不
 *   恢复,recovery 会读到可 discard 的 precreated,对「createSession 结果未知」
 *   的会话做 destructive discard,绕过「started 绝不回收未知创建」不变量。
 *   调用方收到 'commit' 后必须重跑有界 guard(降级 await 窗口可能换代)再零
 *   await 应用 + createSession。
 * deps 注入便于 deferred 行为测试。
 */
export async function resolveStartedDowngradeOrCommit(args: {
  downgrade: () => Promise<boolean>;
  restoreStarted: () => Promise<unknown>;
}): Promise<'downgraded' | 'commit'> {
  const downgraded = await args.downgrade().catch(() => false);
  if (downgraded) return 'downgraded';
  await args.restoreStarted().catch(() => undefined);
  return 'commit';
}

export async function compensatePrecreatedWorktree(args: {
  sessionId: string;
  recoveryKey: string;
  createdAt: number;
  phase: 'reserved' | 'precreated';
  /** 远端 discard(被控端 worktree:discard-precreated)。 */
  discard: () => Promise<unknown>;
  /** 严格 ACK 解析(parseDiscardPrecreatedAck 同款口径,注入避免拉 React 依赖)。 */
  parseAck: (value: unknown) => { discarded: true } | null;
  forget: () => Promise<void>;
  release: (() => void) | null;
}): Promise<'discarded' | 'retained'> {
  if (args.phase === 'precreated') {
    try {
      if (!args.parseAck(await args.discard())) return 'retained';
      await args.forget();
      args.release?.();
      return 'discarded';
    } catch {
      return 'retained';
    }
  }
  await args.forget();
  args.release?.();
  return 'discarded';
}

/**
 * 联合回退后的 effort 校准:回退改变了 (model, providerId) 时,用新组合精确匹配行
 * reconcile 既有档位,旧档位不受新模型支持时降到其默认档(codex review P2:回退模型
 * 时同步校准 effort)。组合未变化时调用方不应调用本函数(原样保留即可)。
 * 配套约定:组合变化时调用方还应把 fastMode 保守置 false(fast 能力 per-(provider,
 * model, agent),新组合是否支持无法本地判定,关闭最安全,用户可手动重开)。
 */
export function reconcileEffortAfterFallback(
  modelRows: readonly ProviderModelRow[],
  next: { model: string; providerId: string | null },
  baseEffort: string,
): string {
  const sectionModel = findSectionModelRow(modelRows, next.model, next.providerId)?.model;
  // 无匹配行 = 回退到内置默认模型(目录为空/loaded-but-empty):旧自定义模型的档位
  // 对新内置模型无效——省略 effort(创建时省略该字段,由被控端取默认),不得沿用
  // (Codex review P2:沿用会向不支持该档位的模型发送非法 effort)。
  return sectionModel ? reconcileEffortForModel(sectionModel, baseEffort) : '';
}

/**
 * 按 (providerId, modelId) 精确找 row;providerId 为空或无精确匹配时退回 modelId 首匹配。
 * 同一 modelId 可被多个 provider 提供(各自 effort 档位表可能不同)——reconcile effort
 * 必须用最终选中来源的那一行,否则会被错误降档/升档(Copilot review)。
 */
function findSectionModelRow(
  modelRows: readonly ProviderModelRow[],
  modelId: string,
  providerId: string | null,
): ProviderModelRow | undefined {
  if (providerId) {
    const exact = modelRows.find((row) => row.provider.id === providerId && row.model.id === modelId);
    if (exact) return exact;
  }
  return modelRows.find((row) => row.model.id === modelId);
}

/**
 * 从现有会话列表挑"最近一次"的整套运行配置(agent + model + effort + providerId),用于新建对话
 * 默认跟随最近会话。providerId 取自该会话在被控端落盘的来源选择(null = 默认路由)。
 * 过滤:排除 status==='deleted'、无 model;可选 `deviceId`(只看该设备——模型列表 per-device,跨设备 model 可能
 * 在目标设备不存在,来源同理——同设备过滤保证继承的来源在目标设备存在);可选 `agentKind`(只看该 agent)。
 * 排序:按活动时间(userSendAt ?? updatedAt ?? createdAt)降序取第一条。
 * 映射 `RemoteSession.agentKind`:'codex'|'pi' 原样保留,其余(含 'cc')归一为 'claude-code'。无匹配→null。
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
    const agentKind: NewSessionAgentKind = session.agentKind === 'codex' || session.agentKind === 'pi'
      ? session.agentKind
      : 'claude-code';
    if (options.agentKind && agentKind !== options.agentKind) continue;
    const activityAt = session.userSendAt ?? session.updatedAt ?? session.createdAt;
    if (!best || activityAt.localeCompare(best.activityAt) > 0) {
      best = {
        runtime: { agentKind, model, effort: session.effort?.trim() ?? '', providerId: session.providerId ?? null },
        activityAt,
      };
    }
  }
  return best?.runtime ?? null;
}

/**
 * 算"切到某 agent 后的默认运行配置(model + effort + providerId)",供新建对话「切 agent」入口复用,
 * 与初始自动默认共用同一套 fallback 口径。纯函数:所有输入显式传入,不读 react / 设备状态。
 * model 优先级:
 *   1) 该 agent 的最近一次会话模型(pickMostRecentSessionRuntime,按 deviceId scope);
 *   2) 否则取区域门控后的新任务默认；无标记再取该 agent 的模型列表最上面那个
 *      (modelRows[0] —— providers 已加载时同步可得,与下拉渲染的第一项一致);
 *   3) 否则该 agent 的内置默认 DEFAULT_MODELS[agentKind]。
 * providerId 跟随 model 同源:
 *   1) 跟随最近会话 → 继承该会话的来源(validateModelProviderId 校验:目录已就绪且来源
 *      已删/不再提供该模型时清空回默认路由;同设备+同 agent 范围,供应商集天然兼容);
 *   2) 取列表首项 → 该行的 provider(modelRows[0].provider.id);
 *   3) 内置默认兜底 → null(默认路由)。
 * effort:reconcile 到目标 model 的合法档(reconcileEffortForModel,base = 最近会话 effort ?? 当前 effort,
 *   SectionModel 按 (providerId, modelId) 精确匹配行——同模型多来源时不串档);
 *   拿不到目标 model 对应的 SectionModel(model 不在 modelRows 里,如走了 DEFAULT_MODELS 兜底或历史模型已下架)
 *   时保留 base effort 不动。
 */
export function pickAgentDefaultRuntime(args: {
  agentKind: NewSessionAgentKind;
  sessions: readonly RemoteSession[];
  modelRows: readonly ProviderModelRow[];
  currentEffort: string;
  deviceId?: string;
  /** 供应商目录是否已就绪(加载完成);未就绪时来源校验信任最近会话(见 validateModelProviderId)。 */
  catalogReady: boolean;
}): NewSessionRuntime {
  const { agentKind, sessions, modelRows, currentEffort, deviceId, catalogReady } = args;
  const recent = pickMostRecentSessionRuntime(sessions, { deviceId, agentKind });
  const baseEffort = recent?.effort ?? currentEffort;
  let model: string;
  let providerId: string | null;
  if (recent?.model) {
    // 联合解析:来源失效时 model 随之一并回退(顶替其他来源 / 首项 / 内置默认),
    // 不留「裸模型 + 默认路由」的必 400 组合(codex review P1)。
    ({ model, providerId } = resolveRecentModelAndProvider(
      modelRows,
      { model: recent.model, providerId: recent.providerId },
      agentKind,
      catalogReady,
    ));
  } else if (catalogReady && modelRows[0]) {
    // 首项分支只在目录就绪时取——切到未缓存设备瞬间旧设备目录会短暂残留
    // (ready=false),抄它的首项会把别设备的来源写进草稿(codex review P1)。
    // 区域默认标记优先(上游 main 移植):模型声明 newSessionDefault 时按 agent 门控。
    // 在 ProviderModelRow 层面选行,保留来源身份(codex review P2):同 modelId
    // 多 provider 时按 id 回查会把标记行错绑到首见 provider;标记行优先、无标记
    // 取首行,模型与 provider 同源。
    const chosenRow = modelRows.find((row) => isNewSessionDefaultForAgent(row.model, agentKind))
      ?? modelRows[0];
    model = chosenRow.model.id;
    providerId = chosenRow.provider.id;
  } else {
    model = DEFAULT_MODELS[agentKind];
    providerId = null;
  }
  // 目录未就绪时不做 effort 校准:catalogReady=false 时 modelRows 可能是上一设备
  // 的残留行,findSectionModelRow 的 modelId 回退会按错误来源校准 effort;新目录
  // 确认原 (provider, model) 有效后组合未变化又不再重校准,用户可能在能力表到达前
  // 提交该来源不支持的档位(codex review P2)。未就绪时保留最近任务的 effort。
  // catalogReady 且无匹配行 = 回退到内置默认(目录为空/模型下架):旧自定义模型的
  // 档位对新内置模型无效——省略 effort,由被控端取默认(codex review P2:模型无行
  // 回退时不得沿用旧档位;与 reconcileEffortAfterFallback 的 no-row 口径一致)。
  const sectionModel = catalogReady ? findSectionModelRow(modelRows, model, providerId)?.model : undefined;
  const effort = sectionModel
    ? reconcileEffortForModel(sectionModel, baseEffort)
    : catalogReady ? '' : baseEffort;
  return { agentKind, model, effort, providerId };
}

/**
 * 新建对话「自动默认运行配置」effect 的决策核心(纯函数,从 new.tsx 那个 effect 内联逻辑抽出,便于单测)。
 * 返回 null = 本次不动 draft(已手动选过 / 无 selectedDevice / 该设备已应用过 / modelRows 未就绪且无 recent);
 * 返回 { patch, appliedDeviceId } = 调用方 setDraft(prev => ({ ...prev, ...patch })) 并记录 appliedDeviceId。
 * 三条意图与 effect 完全一致:
 *   1) 有最近会话(按 selectedDeviceId scope)→ 整套跟随(agentKind + model + effort + providerId,
 *      effort reconcile 同 pickAgentDefaultRuntime 口径:SectionModel 按 (providerId, modelId)
 *      精确匹配;providerId 经 validateModelProviderId 校验后继承);
 *   2) 无最近会话 → 区域默认标记优先;无 provider 结构时才信 capabilities 扁平标记
 *      (上游 main 移植);无标记再取 provider 列表最上面(model + effort reconcile + 该行
 *      provider,不动 agentKind);
 *   3) 无最近会话且目录未就绪 / 两份模型列表都未就绪 → null(等下次数据就绪再设,绝不误设)。
 * currentEffort = 当前 draft.effort,作为 reconcile 的 base(与 effect 里 setDraft updater 读 current.effort 等价)。
 */
export function resolveNewSessionAutoDefault(input: {
  userTouched: boolean;
  appliedDeviceId: string | null;
  selectedDeviceId: string;
  sessions: readonly RemoteSession[];
  modelRows: readonly ProviderModelRow[];
  /** modelRows 是按哪个 agent 的目录构建的。跟随的最近会话可能是另一个 agent ——
   *  目录不一致时不做来源校验(无权评判,直接信任),否则会把合法来源误清(codex review P1)。 */
  rowsAgentKind: NewSessionAgentKind;
  /** 供应商目录是否已就绪;未就绪时来源校验信任最近会话(见 validateModelProviderId)。 */
  catalogReady: boolean;
  /** 目录是否「明确不可用」(拉取失败,典型:旧被控端无 maker:provider:list 通道)。
   *  与 catalogReady=false(仍在加载/切设备间隙)区分:仅明确不可用才放行
   *  capabilities 扁平回退,否则回退被 !catalogReady 的 return null 挡死
   *  (codex review P2)。 */
  providersUnavailable?: boolean;
  /** 仅在 provider-aware 列表不可用时传入,避免绕过被控端的模型可见性设置(上游 main 移植)。 */
  availableModels?: readonly MobileModelOption[];
  currentEffort: string;
}): { patch: Partial<NewSessionDraft>; appliedDeviceId: string } | null {
  const {
    userTouched,
    appliedDeviceId,
    selectedDeviceId,
    sessions,
    modelRows,
    rowsAgentKind,
    catalogReady,
    providersUnavailable = false,
    availableModels = [],
    currentEffort,
  } = input;
  if (userTouched) return null;
  if (!selectedDeviceId) return null;
  if (appliedDeviceId === selectedDeviceId) return null;
  const recent = pickMostRecentSessionRuntime(sessions, { deviceId: selectedDeviceId });
  if (recent) {
    // 联合解析(口径同 pickAgentDefaultRuntime):来源失效时 model 随之一并回退
    // (codex review P1);目录 agent 不一致时不评判、维持信任。
    const { model, providerId } = resolveRecentModelAndProvider(
      modelRows,
      { model: recent.model, providerId: recent.providerId },
      recent.agentKind,
      catalogReady && recent.agentKind === rowsAgentKind,
    );
    // 跨 agent 跟随时 modelRows 按当前 agent 构建,其档位表对目标 agent 无权威——
    // 命中同名模型行会把 recent.effort 错 reconcile 成当前 agent 的默认档(独立
    // review P2)。此时直接用 recent.effort;渲染后目录按目标 agent 重建,由既有
    // 就绪终检链路校准。同 agent 才按精确匹配行 reconcile(原有口径)。
    const sectionModel = recent.agentKind === rowsAgentKind
      ? findSectionModelRow(modelRows, model, providerId)?.model
      : undefined;
    return {
      appliedDeviceId: selectedDeviceId,
      patch: {
        agentKind: recent.agentKind,
        model,
        effort: sectionModel
          ? reconcileEffortForModel(sectionModel, recent.effort || currentEffort)
          : recent.effort || currentEffort,
        permissionMode: defaultPermissionModeForNewSessionAgent(recent.agentKind),
        providerId,
      },
    };
  }
  // 无最近会话 → 区域默认标记优先;无 provider 结构时才信 capabilities 扁平标记
  // (上游 main 移植);provider-aware 列表由调用方传空 availableModels,避免区域
  // 默认绕过用户隐藏设置。目录未就绪(加载中/切设备间隙残留旧设备目录,
  // ready=false)则不动,等就绪后 effect 重算(codex review P1);目录「明确不可用」
  // (旧被控端无 provider:list 通道或请求持续失败,error 非空)则放行扁平回退,
  // 否则下方 availableModels 分支永远不可达(codex review P2)。
  if (!catalogReady && !providersUnavailable) return null;
  // 在 ProviderModelRow 层面选行,保留来源身份(codex review P2):同 modelId 多
  // provider 时按 id 回查会把标记行错绑到首见 provider;标记行优先、无标记取
  // 首行,模型与 provider 同源。modelRows 为空(旧被控端/目录不可用)才走扁平回退。
  const providerRow = modelRows.length > 0
    ? modelRows.find((row) => isNewSessionDefaultForAgent(row.model, rowsAgentKind))
      ?? modelRows[0]
    : undefined;
  const flatDefault = providerRow
    ? undefined
    : pickRegionalNewSessionDefault(availableModels, rowsAgentKind);
  const defaultModel = providerRow?.model ?? flatDefault;
  if (!defaultModel) return null;
  return {
    appliedDeviceId: selectedDeviceId,
    patch: {
      model: defaultModel.id,
      effort: reconcileEffortForModel(defaultModel, currentEffort),
      // 区域默认来自 provider 行 → 携带该行 provider(#1898);来自扁平列表 → 默认路由
      providerId: providerRow ? providerRow.provider.id : null,
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
  fallback: Pick<NewSessionDraft, 'agentKind' | 'workspaceKind' | 'model' | 'effort' | 'permissionMode' | 'fastMode' | 'workingDir' | 'providerId'> & {
    firstMessage?: string;
    attachments?: readonly { name?: string; originalName?: string; path?: string; category?: string }[];
  },
  now = new Date(),
): RemoteSession {
  const iso = now.toISOString();
  const first = fallback.attachments?.[0];
  const optimisticTitle = deriveOptimisticSessionTitle({
    text: fallback.firstMessage,
    fileNames: (fallback.attachments ?? [])
      .filter((file) => !file.path?.startsWith('clipboard://'))
      .map((file) => file.originalName || file.name || '')
      .filter(Boolean),
    imageLabel: i18n.t('session.common.photo'),
    fileLabel: i18n.t('session.common.file'),
    firstFileIsImage: first?.category === 'image',
  });
  return {
    id: result.sessionId,
    userId: '',
    title: optimisticTitle || DEFAULT_DRAFT_SESSION_TITLE,
    workingDir: result.workDir ?? fallback.workingDir,
    workspaceKind: fallback.workspaceKind,
    model: fallback.model,
    effort: fallback.effort,
    permissionMode: fallback.permissionMode,
    fastMode: fallback.fastMode,
    status: 'active',
    agentKind: fallback.agentKind === 'claude-code' ? 'cc' : fallback.agentKind,
    userSendAt: iso,
    createdAt: iso,
    updatedAt: iso,
    // 兜底/乐观会话必须带出来源:buildQueuedTextMessage 从这里复制 providerId 进
    // createOpts,缺了它,创建确认前排队的首条消息会丢来源路由(codex review P1)。
    providerId: fallback.providerId ?? null,
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
