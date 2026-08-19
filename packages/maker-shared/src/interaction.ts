export interface InteractionRequestLike {
  kind?: string;
  requestId?: string;
  [key: string]: unknown;
}

export interface PendingInteractionLike {
  request: InteractionRequestLike;
  persistId?: string;
}

export interface AskQuestion {
  question: string;
  header?: string;
  options?: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

export interface IssueDraft {
  title: string;
  body: string;
  type: 'bug' | 'feature';
}

export interface IssueEnv {
  appVersion: string;
  platform: string;
  arch: string;
  osVersion?: string;
}

export interface IssueConfirmPayload {
  draft: IssueDraft;
  env: IssueEnv;
}

export interface PermissionReviewPresentation {
  autoReviewUnavailable: boolean;
  canAlwaysAllow: boolean;
  code: string;
  description: string | null;
  riskSummary: string | null;
  summary: InteractionDecisionSummary;
  title: string;
  toolName: string;
}

export interface AskQuestionReviewPresentation {
  allowsCustomAnswer: boolean;
  current: AskQuestion | null;
  currentIndex: number;
  currentNumber: number;
  header: string | null;
  multiSelect: boolean;
  optionCount: number;
  pageLabel: string;
  summary: InteractionDecisionSummary;
  title: string;
  totalCount: number;
}

export interface IssueConfirmReviewPresentation {
  bodyCharCount: number;
  canSubmit: boolean;
  envLabel: string;
  issueTypeLabel: string;
  summary: InteractionDecisionSummary;
  titleCharCount: number;
}

export interface PlanOutlineItem {
  id: string;
  title: string;
  level: 1 | 2 | 3;
  line: number;
  preview: string;
}

export interface PlanReviewEvidencePresentation {
  compactPath: string | null;
  fileName: string | null;
  filePath: string | null;
  hasPlanText: boolean;
  outlineItems: PlanOutlineItem[];
  outlineOverflowCount: number;
  outlineTotalCount: number;
  summary: InteractionDecisionSummary;
}

export interface InteractionDecisionSummary {
  title: string;
  detail: string;
}

export interface InteractionResolveActionPresentation {
  disabled: boolean;
  disabledReason: string | null;
  label: string;
}

export interface PendingInteractionQueueItemPresentation {
  active: boolean;
  kind: string;
  label: string;
  positionLabel: string;
  requestId: string | null;
  title: string;
}

export interface PendingInteractionQueuePresentation {
  active: PendingInteractionQueueItemPresentation | null;
  countLabel: string;
  hint: string;
  items: PendingInteractionQueueItemPresentation[];
  overflowCount: number;
  readOnly: boolean;
  title: string;
  totalCount: number;
}

export function buildInteractionResolveActionPresentation(input: {
  armed?: boolean;
  busy?: boolean;
  busyLabel?: string;
  confirmLabel?: string;
  invalidReason?: string | null;
  label: string;
  readOnlyReason?: string | null;
  requestId?: string | null;
}): InteractionResolveActionPresentation {
  if (input.readOnlyReason) {
    return {
      disabled: true,
      disabledReason: input.readOnlyReason,
      label: input.label,
    };
  }
  if (!input.requestId) {
    return {
      disabled: true,
      disabledReason: '这个远程交互缺少 requestId，无法回传决定。',
      label: input.label,
    };
  }
  if (input.busy) {
    return {
      disabled: true,
      disabledReason: '正在把决定回传到电脑端，请不要重复提交。',
      label: input.busyLabel ?? '提交中',
    };
  }
  if (input.invalidReason) {
    return {
      disabled: true,
      disabledReason: input.invalidReason,
      label: input.label,
    };
  }
  return {
    disabled: false,
    disabledReason: null,
    label: input.armed && input.confirmLabel ? input.confirmLabel : input.label,
  };
}

export function canStartInteractionResolve(input: {
  requestId?: string | null;
  submittingRequestId?: string | null;
}): boolean {
  return !!input.requestId && input.submittingRequestId !== input.requestId;
}

export function buildPermissionDecisionSummary(input: {
  toolName: string;
  riskSummary: string | null;
  canAlwaysAllow: boolean;
}): InteractionDecisionSummary {
  if (input.riskSummary) {
    return {
      title: '高风险授权需要二次确认',
      detail: '先核对命令内容，再点一次确认允许；不确定就拒绝。',
    };
  }
  if (input.canAlwaysAllow) {
    return {
      title: '可以只允许一次，也可以本任务总是允许',
      detail: `工具: ${input.toolName}`,
    };
  }
  return {
    title: '允许后电脑端会继续执行',
    detail: `工具: ${input.toolName}`,
  };
}

export function buildPermissionReviewPresentation(
  request: InteractionRequestLike,
): PermissionReviewPresentation {
  const toolName = permissionToolName(request);
  const input = permissionInput(request);
  const riskSummary = permissionRiskSummary(request);
  const canAlwaysAllow = sessionScopedPermissionSuggestions(request.suggestions).length > 0;

  return {
    autoReviewUnavailable: permissionAutoReviewUnavailable(request),
    canAlwaysAllow,
    code: formatPermissionInput(toolName, input),
    description: permissionDescription(request),
    riskSummary,
    summary: buildPermissionDecisionSummary({ toolName, riskSummary, canAlwaysAllow }),
    title: permissionTitle(request),
    toolName,
  };
}

export function buildAskQuestionProgressSummary(input: {
  currentIndex: number;
  total: number;
  multiSelect: boolean;
}): InteractionDecisionSummary {
  const total = Math.max(1, input.total);
  const current = Math.min(Math.max(0, input.currentIndex), total - 1) + 1;
  return {
    title: `第 ${current}/${total} 个问题`,
    detail: input.multiSelect ? '可多选，也可以输入其他回答。' : '选择一个回答，或输入其他回答。',
  };
}

export function buildAskQuestionReviewPresentation(input: {
  currentIndex: number;
  questions: readonly AskQuestion[];
}): AskQuestionReviewPresentation {
  const totalCount = input.questions.length;
  if (totalCount === 0) {
    return {
      allowsCustomAnswer: false,
      current: null,
      currentIndex: 0,
      currentNumber: 0,
      header: null,
      multiSelect: false,
      optionCount: 0,
      pageLabel: '0/0',
      summary: {
        title: '没有具体问题',
        detail: '可以提交空回答让电脑端继续。',
      },
      title: 'Agent 正在等待确认',
      totalCount: 0,
    };
  }

  const currentIndex = Math.min(Math.max(0, input.currentIndex), totalCount - 1);
  const current = input.questions[currentIndex] ?? null;
  const multiSelect = current?.multiSelect === true;
  const optionCount = current?.options?.length ?? 0;
  const currentNumber = currentIndex + 1;

  return {
    allowsCustomAnswer: true,
    current,
    currentIndex,
    currentNumber,
    header: current?.header?.trim() || null,
    multiSelect,
    optionCount,
    pageLabel: `${currentNumber}/${totalCount}`,
    summary: buildAskQuestionProgressSummary({
      currentIndex,
      total: totalCount,
      multiSelect,
    }),
    title: current?.question || 'Agent 正在等待确认',
    totalCount,
  };
}

export function buildPlanReviewDecisionSummary(input: {
  outlineCount: number;
  hasFilePath: boolean;
  edited: boolean;
}): InteractionDecisionSummary {
  const outline = input.outlineCount > 0 ? `${input.outlineCount} 个章节` : '无章节目录';
  const file = input.hasFilePath ? '有计划文件' : '无计划文件路径';
  return {
    title: input.edited ? '已编辑计划，批准后按当前版本执行' : '批准后电脑端会按计划继续执行',
    detail: `${outline} · ${file}`,
  };
}

export function buildPlanReviewEvidencePresentation(input: {
  edited: boolean;
  filePath?: string | null;
  maxOutlineItems?: number;
  plan: string;
}): PlanReviewEvidencePresentation {
  const outline = extractPlanOutline(input.plan);
  const maxOutlineItems = Math.max(0, Math.floor(input.maxOutlineItems ?? 3));
  const filePath = input.filePath?.trim() || null;
  const outlineItems = maxOutlineItems === 0 ? [] : outline.slice(0, maxOutlineItems);

  return {
    compactPath: filePath ? compactPlanReviewPath(filePath) : null,
    fileName: filePath ? basenameFromPath(filePath) : null,
    filePath,
    hasPlanText: input.plan.trim().length > 0,
    outlineItems,
    outlineOverflowCount: Math.max(0, outline.length - outlineItems.length),
    outlineTotalCount: outline.length,
    summary: buildPlanReviewDecisionSummary({
      edited: input.edited,
      hasFilePath: !!filePath,
      outlineCount: outline.length,
    }),
  };
}

export function buildIssueConfirmDecisionSummary(input: {
  type: IssueDraft['type'];
  canSubmit: boolean;
}): InteractionDecisionSummary {
  return {
    title: input.canSubmit ? '草稿完整，可以确认提交' : '补齐标题和正文后才能提交',
    detail: input.type === 'bug' ? '类型: Bug' : '类型: Feature',
  };
}

export function buildIssueConfirmReviewPresentation(input: {
  draft: IssueDraft;
  env: IssueEnv;
  uiLanguage?: string;
}): IssueConfirmReviewPresentation {
  const title = input.draft.title.trim();
  const body = input.draft.body.trim();
  const canSubmit = title.length > 0 && body.length > 0;
  const envParts = [
    input.env.appVersion,
    input.env.platform,
    input.env.arch,
    input.env.osVersion,
    input.uiLanguage,
  ].filter((part): part is string => typeof part === 'string' && part.trim().length > 0);

  return {
    bodyCharCount: body.length,
    canSubmit,
    envLabel: envParts.join(' / '),
    issueTypeLabel: input.draft.type === 'bug' ? 'Bug' : 'Feature',
    summary: buildIssueConfirmDecisionSummary({
      type: input.draft.type,
      canSubmit,
    }),
    titleCharCount: title.length,
  };
}

export function interactionKind(item: PendingInteractionLike): string {
  return typeof item.request.kind === 'string' ? item.request.kind : 'interaction';
}

export function interactionDisplayTitle(kind: string): string {
  if (kind === 'plan_review') return '需要确认执行计划';
  if (kind === 'permission') return '需要授权电脑端操作';
  if (kind === 'ask_user_question') return '需要回答 Agent 问题';
  if (kind === 'issue_confirm') return '需要确认 Issue 内容';
  if (kind === 'plugin_setup') return '需要在电脑端配置插件';
  return '需要处理远程请求';
}

export function interactionDisplayHint(kind: string, readOnly = false): string {
  if (readOnly) return '协作只读模式，仅展示电脑端请求。';
  if (kind === 'plan_review') return '先看计划，必要时反馈修改，确认后电脑端才继续执行。';
  if (kind === 'permission') return '只把本次决定回传给当前电脑端任务。';
  if (kind === 'ask_user_question') return '回答会保存草稿,提交后电脑端继续。';
  if (kind === 'issue_confirm') return '确认标题和正文后再提交。';
  if (kind === 'plugin_setup') return '配置要在电脑端完成，这里可以取消这次请求。';
  return '手机版会按桌面端的请求顺序处理。';
}

export function interactionKindLabel(kind: string): string {
  if (kind === 'plan_review') return '计划';
  if (kind === 'permission') return '授权';
  if (kind === 'ask_user_question') return '问题';
  if (kind === 'issue_confirm') return 'Issue';
  if (kind === 'plugin_setup') return '插件';
  return '请求';
}

/**
 * 控制端(手机 / 另一台桌面)对一张待处理交互卡实际能做什么。
 *
 * 被控桌面会把**所有** pending interaction 经 device-link 推给控制端,但控制端
 * 能给出终局决定的只有权限 / 提问 / 计划三类。其余必须回被控端完成:
 * plugin_setup 的 run_action 要开 OAuth 或写可信本地设置(被控端 IPC 边界只放
 * cancel 过来,见 desktop `interactionResolveOrigin`),issue_confirm 只在桌面提交。
 *
 * - `resolvable`:控制端能终结这张卡。
 * - `cancel-only`:控制端做不完,但能取消,把会话从等待里放出来。
 * - `desktop-only`:控制端只能展示,等被控端处理。
 */
export type RemoteInteractionHandling = 'resolvable' | 'cancel-only' | 'desktop-only';

const REMOTE_RESOLVABLE_KINDS = new Set(['permission', 'ask_user_question', 'plan_review']);

export function remoteInteractionHandling(item: PendingInteractionLike): RemoteInteractionHandling {
  const kind = interactionKind(item);
  if (REMOTE_RESOLVABLE_KINDS.has(kind)) return 'resolvable';
  // `cancel-only` 必须与 buildPluginSetupCancelDecision 判定一致,否则调用方只看
  // handling 就以为「能取消」,而实际拿不到 decision(#530 review):
  // - terminal 快照是被控端收尾展示用的最后一帧,已经不 actionable;
  // - revision 缺失 / 非法时被控端无法裁决这条命令,也就没有取消入口。
  if (kind === 'plugin_setup' && item.request.terminal !== true
    && pluginSetupCancelRevision(item.request) !== null) {
    return 'cancel-only';
  }
  return 'desktop-only';
}

/**
 * 这张卡是否有资格独占控制端输入框。
 *
 * 只有控制端能终结的卡才可以——控制端做不完的卡若也替换输入框,用户既处理不了
 * 卡、又发不出消息,整个会话在手机上被锁死(只能回电脑端解),这是必须避免的
 * 死锁:任何被控端新增的 interaction kind 默认都落进「不阻塞」这一侧。
 */
export function interactionBlocksRemoteComposer(item: PendingInteractionLike | null | undefined): boolean {
  return !!item && remoteInteractionHandling(item) === 'resolvable';
}

/**
 * 输入框是否该被这一批待处理卡接管。
 *
 * 判据必须是**整个 pending 集合**,不能是「当前正在看的那张卡」:队列里同时有
 * 权限卡和 plugin_setup 时,用户切到 plugin_setup 只是换了查看对象,那张权限卡
 * 仍在等回答 —— 若按当前卡放开 composer,用户就绕过了仍待处理的阻塞交互
 * (#530 review P1)。只有整批都是本端终结不了的卡时,输入框才回来。
 */
export function pendingInteractionsBlockRemoteComposer(
  interactions: readonly PendingInteractionLike[],
): boolean {
  return interactions.some((item) => interactionBlocksRemoteComposer(item));
}

/**
 * plugin_setup 的远端取消决定。
 *
 * 被控端只接受 `expectedRevision` 与当前快照一致的命令(不一致 = 控制端看到的是
 * 旧快照,被控端会改为重新体检并推新快照),因此 revision 缺失时不构造决定——
 * 调用方据此不给取消入口,而不是发一条注定被丢弃的命令。
 */
export function buildPluginSetupCancelDecision(
  request: InteractionRequestLike,
): { kind: 'plugin_setup'; action: 'cancel'; expectedRevision: number } | null {
  const revision = pluginSetupCancelRevision(request);
  if (revision === null) return null;
  return { kind: 'plugin_setup', action: 'cancel', expectedRevision: revision };
}

/**
 * 可用于取消命令的 revision;不是 plugin_setup、或 revision 缺失 / 非法时为 null。
 * 被控端要求 `expectedRevision` 是非负整数(见 parseGhostSetupInteractionCommand)。
 */
function pluginSetupCancelRevision(request: InteractionRequestLike): number | null {
  if (request.kind !== 'plugin_setup') return null;
  const revision = request.revision;
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0) return null;
  return revision;
}

/**
 * 被控端 setup 步骤的稳定枚举。
 *
 * 这里是**副本**,不是从 Desktop import 的(packages 不得依赖 apps)。正本在
 * `apps/desktop/src/shared/ghost.ts`(`GhostSetupStepPhase` /
 * `GHOST_SETUP_ERROR_CODES` / `GhostSetupActionKind`),两端由跨端契约绑定:
 * 正本增删值时必须同步这里,否则控制端会把新值当未知丢弃(降级展示,不会崩)。
 */
export const REMOTE_PLUGIN_SETUP_PHASES = [
  'pending',
  'action_running',
  'waiting_external',
  'verifying',
  'satisfied',
  'failed',
  'cancelled',
] as const;
export type RemotePluginSetupPhase = (typeof REMOTE_PLUGIN_SETUP_PHASES)[number];

export const REMOTE_PLUGIN_SETUP_ERROR_CODES = [
  'ACTION_FAILED',
  'ACTION_STALE',
  'AUTH_CANCELLED',
  'AUTH_FAILED',
  'AUTH_NETWORK',
  'AUTH_SERVICE_UNAVAILABLE',
  'INLINE_INVALID',
  'INLINE_UNAVAILABLE',
  'SAVE_FAILED',
  'WINDOW_CLOSED',
  'TARGET_UNAVAILABLE',
  'ASSESSMENT_FAILED',
  'TIMEOUT',
] as const;
export type RemotePluginSetupErrorCode = (typeof REMOTE_PLUGIN_SETUP_ERROR_CODES)[number];

export const REMOTE_PLUGIN_SETUP_ACTION_KINDS = [
  'oauth_connect',
  'open_plugin_settings',
  'manage_connection',
  'open_client_settings',
  'inline_form',
] as const;
export type RemotePluginSetupActionKind = (typeof REMOTE_PLUGIN_SETUP_ACTION_KINDS)[number];

export interface RemotePluginSetupStep {
  id: string;
  title: string;
  description: string | null;
  /** 非白名单值(被控端更新引入的新 phase)降级为 null,只是少显示一个徽标。 */
  phase: RemotePluginSetupPhase | null;
  errorCode: RemotePluginSetupErrorCode | null;
  actionKind: RemotePluginSetupActionKind | null;
  /**
   * inline_form 字段的**标签**,用于说明「电脑端要填什么」。
   * 只有 label,永远没有值:Secret 不进 interaction snapshot(见
   * `docs/dev-rules/plugin-security-and-authoring.md` §4)。
   */
  inlineFieldLabel: string | null;
}

export interface RemotePluginSetupGroup {
  id: string;
  /** any_of 且组内不止一项 → UI 要提示「选择一种配置方式」,别让用户以为要全做。 */
  anyOf: boolean;
  steps: RemotePluginSetupStep[];
}

export interface RemotePluginSetupPresentation {
  ghostName: string | null;
  /** 只接受 data:image/ 的内联图标;其它形态(远程 URL 等)一律丢弃。 */
  iconDataUrl: string | null;
  intro: string | null;
  groups: RemotePluginSetupGroup[];
  satisfiedCount: number;
  stepCount: number;
  /** 被控端已 settle 的收尾帧:不再 actionable,UI 不给可点动作。 */
  terminal: boolean;
}

/**
 * plugin_setup 卡在控制端的**只读**投影。
 *
 * 控制端不渲染表单、也不触发动作(Secret 输入与 OAuth 都必须留在被控端,见
 * plugin-security-and-authoring.md §4 与 desktop 的 interactionResolveOrigin),
 * 但被控端下发的状态信息足以让用户看懂「哪个插件、卡在哪一步、为什么失败、
 * 回电脑端要做什么」,再决定是去电脑端处理还是取消。
 *
 * 入参来自远端 payload,一律按白名单收敛:未知 phase / errorCode / action kind
 * 降级为 null 而不是原样透传,避免把被控端新版本的值直接喂给文案查表。
 */
export function buildRemotePluginSetupPresentation(
  request: InteractionRequestLike,
): RemotePluginSetupPresentation {
  const empty: RemotePluginSetupPresentation = {
    ghostName: null,
    iconDataUrl: null,
    intro: null,
    groups: [],
    satisfiedCount: 0,
    stepCount: 0,
    terminal: false,
  };
  // 作为导出的 shared API 显式挡住误用:换个 kind 传进来时返回空投影,而不是
  // 从任意 request 上刮字段、让调用错误看起来「正常返回」。
  if (request.kind !== 'plugin_setup') return empty;

  const ghost = isPlainRecord(request.ghost) ? request.ghost : null;
  const rawSteps = Array.isArray(request.steps) ? request.steps : [];
  const groups: RemotePluginSetupGroup[] = [];
  const groupsById = new Map<string, RemotePluginSetupGroup>();
  let satisfiedCount = 0;
  let stepCount = 0;

  rawSteps.forEach((rawStep, index) => {
    if (!isPlainRecord(rawStep)) return;
    const title = trimmedOrNull(rawStep.title);
    if (!title) return;
    const phase = pickFromAllowlist(rawStep.phase, REMOTE_PLUGIN_SETUP_PHASES);
    const action = isPlainRecord(rawStep.action) ? rawStep.action : null;
    const actionKind = pickFromAllowlist(action?.kind, REMOTE_PLUGIN_SETUP_ACTION_KINDS);
    const step: RemotePluginSetupStep = {
      id: trimmedOrNull(rawStep.id) ?? `step-${index}`,
      title,
      description: trimmedOrNull(rawStep.description),
      phase,
      errorCode: pickFromAllowlist(rawStep.errorCode, REMOTE_PLUGIN_SETUP_ERROR_CODES),
      actionKind,
      inlineFieldLabel: actionKind === 'inline_form' ? inlineSecretFieldLabel(action) : null,
    };
    stepCount += 1;
    if (phase === 'satisfied') satisfiedCount += 1;

    // 分组按首次出现顺序保留。
    const rawGroupId = trimmedOrNull(rawStep.groupId);
    if (rawGroupId === null) {
      // 缺 groupId 的步骤各自成组,并且**不进 groupsById**:合成的 id 与被控端真实
      // groupId 共用一个命名空间,一旦撞名(远端某组恰好就叫合成出来的那个名字),
      // 两批互不相关的配置要求会被并成一组、还套上 any_of 语义,让用户以为「二选
      // 一」而漏做另一半(#657 review)。生成身份只用于本地展示,不参与查表。
      groups.push({ id: `ungrouped-${index}`, anyOf: false, steps: [step] });
      return;
    }
    const existing = groupsById.get(rawGroupId);
    if (existing) {
      existing.steps.push(step);
      if (rawStep.groupMode === 'any_of') existing.anyOf = true;
      return;
    }
    const group: RemotePluginSetupGroup = {
      id: rawGroupId,
      anyOf: rawStep.groupMode === 'any_of',
      steps: [step],
    };
    groupsById.set(rawGroupId, group);
    groups.push(group);
  });

  return {
    ghostName: trimmedOrNull(ghost?.name),
    iconDataUrl: inlineImageDataUrl(ghost?.iconDataUrl),
    intro: trimmedOrNull(request.intro),
    // 单项组没有「任选其一」的语义,提示只会让用户困惑。
    groups: dedupeGroupIds(groups).map((group) => ({
      ...group,
      anyOf: group.anyOf && group.steps.length > 1,
    })),
    satisfiedCount,
    stepCount,
    terminal: request.terminal === true,
  };
}

/**
 * 保证组 id 在本次投影内唯一(渲染层拿它当 list key)。
 *
 * 合成的 `ungrouped-*` 已经不参与合并,但仍可能与被控端某个真实 groupId 撞名;
 * 那只是展示身份重复,不该退化成重复 key。id 不回传被控端,改写是安全的。
 */
function dedupeGroupIds(groups: RemotePluginSetupGroup[]): RemotePluginSetupGroup[] {
  const used = new Set<string>();
  return groups.map((group) => {
    let id = group.id;
    for (let suffix = 2; used.has(id); suffix += 1) id = `${group.id}-${suffix}`;
    used.add(id);
    return id === group.id ? group : { ...group, id };
  });
}

function trimmedOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function pickFromAllowlist<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

function inlineSecretFieldLabel(action: Record<string, unknown> | null): string | null {
  const form = isPlainRecord(action?.form) ? action.form : null;
  const fields = Array.isArray(form?.fields) ? form.fields : [];
  const first = fields.length > 0 && isPlainRecord(fields[0]) ? fields[0] : null;
  return trimmedOrNull(first?.label);
}

function inlineImageDataUrl(value: unknown): string | null {
  return typeof value === 'string' && value.startsWith('data:image/') ? value : null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function buildPendingInteractionQueuePresentation(
  interactions: readonly PendingInteractionLike[],
  options: {
    maxVisible?: number;
    readOnly?: boolean;
  } = {},
): PendingInteractionQueuePresentation {
  const sorted = sortPendingInteractions(interactions);
  const totalCount = sorted.length;
  const maxVisible = Math.max(1, options.maxVisible ?? 4);
  const readOnly = options.readOnly === true;
  const items = sorted.slice(0, maxVisible).map((item, index) => {
    const kind = interactionKind(item);
    return {
      active: index === 0,
      kind,
      label: interactionKindLabel(kind),
      positionLabel: interactionPositionLabel(index),
      requestId: readRequestId(item),
      title: interactionDisplayTitle(kind),
    };
  });
  const active = items[0] ?? null;
  const activeKind = active?.kind ?? 'interaction';

  return {
    active,
    countLabel: totalCount > 1 ? `${totalCount} 个` : '当前',
    hint: interactionDisplayHint(activeKind, readOnly),
    items,
    overflowCount: Math.max(0, totalCount - items.length),
    readOnly,
    title: active ? active.title : '没有待处理请求',
    totalCount,
  };
}

const INTERACTION_PRIORITY: Record<string, number> = {
  plan_review: 0,
  permission: 1,
  ask_user_question: 2,
  issue_confirm: 3,
  // 控制端做不完的卡排在能处理的卡之后,免得它抢走 active 位、把用户按在一张
  // 只能回电脑端处理的卡上(手机侧另有不阻塞输入框的兜底,见
  // interactionBlocksRemoteComposer)。
  plugin_setup: 4,
};

export function interactionPriority(item: PendingInteractionLike): number {
  return INTERACTION_PRIORITY[interactionKind(item)] ?? 100;
}

export function sortPendingInteractions(
  interactions: readonly PendingInteractionLike[],
): PendingInteractionLike[] {
  return interactions
    .map((item, index) => ({ item, index }))
    .sort((a, b) => interactionPriority(a.item) - interactionPriority(b.item) || a.index - b.index)
    .map(({ item }) => item);
}

export function selectActivePendingInteraction(
  interactions: readonly PendingInteractionLike[],
): PendingInteractionLike | null {
  return sortPendingInteractions(interactions)[0] ?? null;
}

export function readRequestId(item: PendingInteractionLike): string | null {
  const requestId = item.request.requestId;
  return typeof requestId === 'string' && requestId.length > 0 ? requestId : null;
}

function interactionPositionLabel(index: number): string {
  if (index === 0) return '当前';
  if (index === 1) return '接着';
  return `第 ${index + 1}`;
}

export function formatPermissionInput(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case 'Bash':
      return typeof input.command === 'string' ? input.command : stringifyCompact(input);
    case 'Read':
    case 'Edit':
    case 'Write':
      return typeof input.file_path === 'string' ? input.file_path : stringifyCompact(input);
    case 'Glob':
    case 'Grep':
      return typeof input.pattern === 'string' ? input.pattern : stringifyCompact(input);
    default: {
      const text = stringifyCompact(input);
      return text.length > 500 ? `${text.slice(0, 500)}...` : text;
    }
  }
}

export function permissionTitle(request: InteractionRequestLike): string {
  const explicit = readString(request.title);
  if (explicit) return explicit;
  const displayName = readString(request.displayName);
  const toolName = readString(request.toolName) || 'tool';
  return `允许使用 ${displayName || toolName}?`;
}

export function permissionDescription(request: InteractionRequestLike): string | null {
  return readString(request.description);
}

export function permissionAutoReviewUnavailable(request: InteractionRequestLike): boolean {
  return isRecord(request.metadata) && request.metadata.autoReviewUnavailable === true;
}

export function permissionToolName(request: InteractionRequestLike): string {
  return readString(request.toolName) || 'Tool';
}

export function permissionInput(request: InteractionRequestLike): Record<string, unknown> {
  return isRecord(request.input) ? request.input : {};
}

export function permissionRiskSummary(request: InteractionRequestLike): string | null {
  const toolName = permissionToolName(request);
  const input = permissionInput(request);
  if (toolName !== 'Bash') return null;
  const command = typeof input.command === 'string' ? input.command.trim() : '';
  if (!command) return null;
  if (!isHighRiskShellCommand(command)) return null;
  return '这个命令可能修改系统、仓库或外部服务状态。允许前请确认你信任当前任务和命令内容。';
}

export function sessionScopedPermissionSuggestions(suggestions: unknown): unknown[] {
  if (!Array.isArray(suggestions)) return [];
  return suggestions.filter((suggestion) =>
    isRecord(suggestion) && suggestion.destination === 'session'
  );
}

export function buildPermissionDecision(
  behavior: 'allow' | 'deny',
  opts: {
    reason?: string;
    updatedInput?: Record<string, unknown>;
    permissionUpdates?: unknown[];
  } = {},
): Record<string, unknown> {
  return {
    kind: 'permission',
    behavior,
    updatedInput: opts.updatedInput,
    reason: opts.reason,
    permissionUpdates: opts.permissionUpdates && opts.permissionUpdates.length > 0
      ? opts.permissionUpdates
      : undefined,
  };
}

function isHighRiskShellCommand(command: string): boolean {
  return /(^|[;&|]\s*)(sudo|rm\s+-[^\n;|&]*r|git\s+reset\s+--hard|git\s+push|curl\b[^\n|]*\|\s*(sh|bash)|wget\b[^\n|]*\|\s*(sh|bash)|chmod\s+-R|chown\s+-R|pkill|killall)\b/i
    .test(command);
}

export function normalizeAskQuestions(value: unknown): AskQuestion[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const question = readString(item.question);
    if (!question) return [];
    const options = Array.isArray(item.options)
      ? item.options.flatMap((option) => {
        if (!isRecord(option)) return [];
        const label = readString(option.label);
        if (!label) return [];
        const description = readString(option.description);
        return [{ label, ...(description ? { description } : {}) }];
      })
      : undefined;
    return [{
      question,
      header: readString(item.header) ?? undefined,
      options,
      multiSelect: item.multiSelect === true,
    }];
  });
}

export function answerKey(question: AskQuestion): string {
  return question.question;
}

export function encodeMultiSelectAnswer(
  options: readonly { label: string }[],
  selectedLabels: ReadonlySet<string>,
  customInput: string,
): string {
  const parts = options
    .filter((option) => selectedLabels.has(option.label))
    .map((option) => option.label);
  const custom = customInput.trim();
  if (custom) parts.push(custom);
  return JSON.stringify(parts);
}

export function selectionFromAnswer(question: AskQuestion, answer: string | undefined): {
  selectedLabels: Set<string>;
  customInput: string;
  showCustomInput: boolean;
} {
  const options = question.options ?? [];
  const optionLabels = new Set(options.map((option) => option.label));
  if (!answer) {
    return { selectedLabels: new Set(), customInput: '', showCustomInput: false };
  }
  if (question.multiSelect) {
    try {
      const parsed = JSON.parse(answer);
      if (Array.isArray(parsed)) {
        const labels = parsed.filter((item): item is string => typeof item === 'string');
        const custom = labels.find((label) => !optionLabels.has(label)) ?? '';
        return {
          selectedLabels: new Set(labels.filter((label) => optionLabels.has(label))),
          customInput: custom,
          showCustomInput: custom.length > 0,
        };
      }
    } catch {
      return { selectedLabels: new Set(), customInput: '', showCustomInput: false };
    }
  }
  if (!optionLabels.has(answer)) {
    return { selectedLabels: new Set(), customInput: answer, showCustomInput: true };
  }
  return { selectedLabels: new Set([answer]), customInput: '', showCustomInput: false };
}

export function buildAskUserQuestionDecision(answers: Record<string, string>): Record<string, unknown> {
  return { kind: 'ask_user_question', answers };
}

export function planReviewPlan(request: InteractionRequestLike): string {
  return readString(request.plan) ?? '';
}

export function planReviewFilePath(request: InteractionRequestLike): string {
  return readString(request.planFilePath) ?? '';
}

export function buildPlanReviewDecision(
  approved: boolean,
  plan: string,
  feedback?: string,
): Record<string, unknown> {
  const trimmedFeedback = feedback?.trim() ?? '';
  return {
    kind: 'plan_review',
    behavior: approved ? 'allow' : 'deny',
    editedPlan: approved ? plan : undefined,
    reason: approved ? undefined : trimmedFeedback || undefined,
  };
}

/**
 * Strip an optional ATX closing sequence from a heading title ("## Title ##" → "Title"):
 * trailing whitespace, then a '#' run, then the whitespace separating it from the title.
 *
 * Linear replacement for `value.replace(/\s+#+\s*$/, '')` — that regex backtracks
 * polynomially on uncontrolled heading text with long whitespace runs (CodeQL ReDoS). Like
 * the original, the '#' run is only stripped when it is whitespace-separated from the title,
 * so text such as "Title##" is preserved.
 */
function stripAtxHeadingClosing(value: string): string {
  const isWs = (ch: string) => /\s/.test(ch);
  let end = value.length;
  while (end > 0 && isWs(value[end - 1])) end -= 1;
  const afterTrailingWs = end;
  while (end > 0 && value[end - 1] === '#') end -= 1;
  if (end === afterTrailingWs) return value; // no '#' run → leave for the caller's trim()
  if (end === 0 || !isWs(value[end - 1])) return value; // '#'s not whitespace-separated → keep
  while (end > 0 && isWs(value[end - 1])) end -= 1;
  return value.slice(0, end);
}

export function extractPlanOutline(markdown: string): PlanOutlineItem[] {
  const lines = markdown.split(/\r?\n/);
  const items: PlanOutlineItem[] = [];
  let fenceMarker: '```' | '~~~' | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fence = readFenceMarker(line);
    if (fenceMarker) {
      if (fence === fenceMarker) fenceMarker = null;
      continue;
    }
    if (fence) {
      fenceMarker = fence;
      continue;
    }

    // `\s+(\S.*)` (not `\s+(.+)`) keeps the separator and title char-classes disjoint so the
    // match stays linear — `\s+` vs `.+` overlap on whitespace and CodeQL flags it as a
    // polynomial ReDoS. The title is trimmed below, so requiring a non-space first char is fine.
    const match = /^(#{1,3})\s+(\S.*)$/.exec(line);
    if (!match) continue;
    const title = stripAtxHeadingClosing(match[2]).trim();
    if (!title) continue;
    const lineNumber = index + 1;
    items.push({
      id: `plan-heading-${lineNumber}`,
      title,
      level: match[1].length as 1 | 2 | 3,
      line: lineNumber,
      preview: readHeadingPreview(lines, index + 1),
    });
  }

  return items;
}

export function normalizeIssueConfirm(request: InteractionRequestLike): IssueConfirmPayload | null {
  if (!isRecord(request.draft)) return null;
  const title = readString(request.draft.title);
  const body = readString(request.draft.body);
  const type = request.draft.type === 'feature' ? 'feature' : request.draft.type === 'bug' ? 'bug' : null;
  if (!title || !body || !type) return null;
  const env = isRecord(request.env) ? request.env : {};
  return {
    draft: { title, body, type },
    env: {
      appVersion: readString(env.appVersion) ?? 'unknown',
      platform: readString(env.platform) ?? 'unknown',
      arch: readString(env.arch) ?? 'unknown',
      osVersion: readString(env.osVersion) ?? undefined,
    },
  };
}

export function buildIssueConfirmDecision(
  confirmed: true,
  draft: IssueDraft,
  uiLanguage?: string,
): Record<string, unknown>;
export function buildIssueConfirmDecision(
  confirmed: false,
): Record<string, unknown>;
export function buildIssueConfirmDecision(
  confirmed: boolean,
  draft?: IssueDraft,
  uiLanguage = currentUiLanguage(),
): Record<string, unknown> {
  if (!confirmed || !draft) return { confirmed: false };
  return {
    confirmed: true,
    title: draft.title.trim(),
    body: draft.body.trim(),
    type: draft.type,
    uiLanguage,
  };
}

export function currentUiLanguage(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || 'zh-CN';
  } catch {
    return 'zh-CN';
  }
}

function stringifyCompact(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function readHeadingPreview(lines: string[], startIndex: number): string {
  let fenceMarker: '```' | '~~~' | null = null;
  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index];
    const fence = readFenceMarker(line);
    if (fenceMarker) {
      if (fence === fenceMarker) fenceMarker = null;
      continue;
    }
    if (fence) {
      fenceMarker = fence;
      continue;
    }
    if (/^#{1,6}\s+/.test(line)) return '';
    const trimmed = line.trim();
    if (!trimmed) continue;
    return trimmed.length > 80 ? `${trimmed.slice(0, 80)}...` : trimmed;
  }
  return '';
}

function compactPlanReviewPath(filePath: string): string {
  const normalized = filePath.trim();
  if (normalized.length <= 42) return normalized;
  const name = basenameFromPath(normalized);
  if (name.length >= 36) return `...${name.slice(-36)}`;
  return `.../${name}`;
}

function basenameFromPath(filePath: string): string {
  const parts = filePath.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? filePath;
}

function readFenceMarker(line: string): '```' | '~~~' | null {
  const match = /^\s{0,3}(```|~~~)/.exec(line);
  return match ? match[1] as '```' | '~~~' : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
