import type {
  RemoteSchedule,
  RemoteScheduleAgentKind,
  RemoteScheduleExecutionMode,
  RemoteScheduleTemplate,
  RemoteScheduleWorkspaceKind,
  RemoteScheduleWriteInput,
  RemoteTemplateParameter,
} from './scheduleTypes';

export const MOBILE_SCHEDULE_EFFORT_VALUES = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
] as const;

export type MobileScheduleEffort = (typeof MOBILE_SCHEDULE_EFFORT_VALUES)[number];
export type MobileScheduleRunMode = 'recurring' | 'manual';
export type MobileScheduleSessionMode = 'fresh' | 'persistent' | 'bound';

export const MOBILE_SCHEDULE_PENDING_SESSION_ID = '__pending__';

export interface MobileScheduleDraft {
  name: string;
  prompt: string;
  // 只读:标记这个 draft 来自一个"仅运行脚本"的桌面端任务(mobile 没有编辑
  // scriptConfig 的 UI,不通过表单改变它)。仅用于豁免 prompt 必填校验;
  // buildMobileScheduleInput 不回写这个字段,交给引擎侧 patch 合并语义保留原值。
  executionMode: RemoteScheduleExecutionMode;
  runMode: MobileScheduleRunMode;
  cronExpr: string;
  timezone: string;
  intervalMinutes: string;
  /**
   * 原任务的 intervalMs。表单只表达得了 1-59 分钟 / 整点小时,MCP 可以设出
   * 表单区间外的间隔(如 90 分钟),这时 intervalMinutes 折叠成 '' ——保存时
   * 必须能区分「表达不了」和「用户清空」,否则只改 prompt 也会静默清掉间隔
   * (copilot review 发现)。
   */
  sourceIntervalMs?: number;
  /**
   * 用户是否动过间隔(输入框编辑、切 manual、套模板都算)。动过且为空 =
   * 明确清空;没动过为空 = 保留 sourceIntervalMs 原值。
   */
  intervalMinutesTouched?: boolean;
  agentKind: RemoteScheduleAgentKind;
  model: string;
  providerId: string;
  effort: string;
  fastMode: boolean;
  workspaceKind: RemoteScheduleWorkspaceKind;
  workingDir: string;
  useWorktree: boolean;
  notifyDesktop: boolean;
  notifyFeishu: boolean;
  notifyWecomGroup?: boolean;
  targetSessionId: string;
  persistentSession: boolean;
  silentWhenIdle: boolean;
}

export interface ScheduleDraftValidation {
  field: keyof MobileScheduleDraft;
  message: string;
}

const DEFAULT_CRON = '0 9 * * *';
const DEFAULT_TIMEZONE = 'Asia/Shanghai';
const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-4-6';
const DEFAULT_CODEX_MODEL = 'gpt-5.5';

export function createMobileScheduleDraft(
  schedule?: RemoteSchedule | null,
  opts: { fallbackWorkingDir?: string | null } = {},
): MobileScheduleDraft {
  if (!schedule) {
    const workingDir = opts.fallbackWorkingDir?.trim() ?? '';
    return {
      name: '',
      prompt: '',
      executionMode: 'agent',
      runMode: 'recurring',
      cronExpr: DEFAULT_CRON,
      timezone: DEFAULT_TIMEZONE,
      intervalMinutes: '',
      agentKind: 'claude-code',
      model: DEFAULT_CLAUDE_MODEL,
      providerId: '',
      effort: '',
      fastMode: false,
      workspaceKind: workingDir ? 'project' : 'dialogue',
      workingDir,
      useWorktree: false,
      notifyDesktop: true,
      notifyFeishu: false,
      targetSessionId: '',
      persistentSession: false,
      silentWhenIdle: false,
    };
  }

  const workspaceKind = schedule.workspaceKind ?? (schedule.workingDir ? 'project' : 'dialogue');
  return {
    name: schedule.name ?? '',
    prompt: schedule.prompt ?? '',
    executionMode: schedule.executionMode ?? 'agent',
    runMode: schedule.manual ? 'manual' : 'recurring',
    cronExpr: schedule.cronExpr?.trim() || DEFAULT_CRON,
    timezone: schedule.timezone?.trim() || DEFAULT_TIMEZONE,
    intervalMinutes: intervalMsToSupportedMinutes(schedule.intervalMs),
    ...(typeof schedule.intervalMs === 'number' ? { sourceIntervalMs: schedule.intervalMs } : {}),
    agentKind: schedule.agentKind ?? 'claude-code',
    model: schedule.model ?? defaultModelFor(schedule.agentKind ?? 'claude-code'),
    providerId: schedule.providerId ?? '',
    effort: schedule.effort ?? '',
    fastMode: !!schedule.fastMode,
    workspaceKind,
    workingDir: schedule.workingDir ?? '',
    useWorktree: workspaceKind === 'project' && !!schedule.useWorktree,
    notifyDesktop: schedule.notify?.desktop !== false,
    notifyFeishu: schedule.notify?.feishu === true,
    ...(schedule.notify?.wecomGroup === true ? { notifyWecomGroup: true } : {}),
    targetSessionId: schedule.targetSessionId ?? '',
    persistentSession: !!schedule.persistentSession,
    silentWhenIdle: !!schedule.silentWhenIdle,
  };
}

export function createTemplateParamDefaults(
  template: Pick<RemoteScheduleTemplate, 'parameters'>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const parameter of template.parameters ?? []) {
    if (parameter.default !== undefined) out[parameter.key] = parameter.default;
  }
  return out;
}

export function applyTemplateToMobileScheduleDraft(
  draft: MobileScheduleDraft,
  template: RemoteScheduleTemplate,
  paramValues: Record<string, string> = {},
): MobileScheduleDraft {
  const agentKind = template.agentKind ?? draft.agentKind;
  return {
    ...draft,
    name: template.name || draft.name,
    prompt: applyMobileTemplateParams(template.prompt ?? '', paramValues, template.parameters),
    runMode: template.recurring === false ? 'manual' : 'recurring',
    cronExpr: template.cronExpr?.trim() || draft.cronExpr,
    timezone: template.timezone?.trim() || draft.timezone,
    // 模板显式定义 cadence:清空间隔是模板的意图,不是「表达不了」,按已触碰处理。
    intervalMinutes: '',
    intervalMinutesTouched: true,
    agentKind,
    model: template.model ?? (draft.agentKind === agentKind ? draft.model : defaultModelFor(agentKind)),
    // 模板若固定了 provider，必须随模板一起落到新建任务；否则 Pi 的空模型会在
    // host 侧按错误的默认来源解析。模板未指定时才保留同 agent 的用户选择。
    providerId: template.providerId ?? (draft.agentKind === agentKind ? draft.providerId : ''),
    effort: template.effort ?? '',
    fastMode: template.fastMode === true,
    useWorktree: template.useWorktree ?? draft.useWorktree,
    // useWorktree 只在 project workspace 且无会话绑定时会被 buildMobileScheduleInput
    // 保留；模板要求 worktree 时把 draft 一并切到 project 模式并清掉绑定会话
    // （绑定与 worktree 互斥），否则保存会被静默打回 false，与模板承诺的隔离
    // 工作区不符（workingDir 为空由 draft 校验兜底）。
    workspaceKind: template.useWorktree ? 'project' : draft.workspaceKind,
    targetSessionId: template.useWorktree ? '' : draft.targetSessionId,
    persistentSession: template.persistentSession ?? draft.persistentSession,
    notifyDesktop: template.notify?.desktop ?? draft.notifyDesktop,
    notifyFeishu: template.notify?.feishu ?? draft.notifyFeishu,
    ...((template.notify?.wecomGroup ?? draft.notifyWecomGroup) !== undefined
      ? { notifyWecomGroup: template.notify?.wecomGroup ?? draft.notifyWecomGroup }
      : {}),
  };
}

export function validateTemplateParamValues(
  template: Pick<RemoteScheduleTemplate, 'parameters'>,
  values: Record<string, string>,
): string | null {
  for (const parameter of template.parameters ?? []) {
    if (!parameter.required) continue;
    if ((values[parameter.key] ?? parameter.default ?? '').trim()) continue;
    return `请输入模板参数：${parameter.label || parameter.key}`;
  }
  return null;
}

export function applyMobileTemplateParams(
  prompt: string,
  params: Record<string, string>,
  definitions?: RemoteTemplateParameter[],
): string {
  if (prompt === '') return '';
  const definitionsByKey = new Map<string, RemoteTemplateParameter>();
  for (const definition of definitions ?? []) {
    definitionsByKey.set(definition.key, definition);
    if (!definition.required) continue;
    const provided = hasTemplateParam(params, definition.key);
    const hasDefault = definition.default !== undefined && definition.default !== '';
    if (!provided && !hasDefault) {
      throw new Error(`Missing required template parameter: ${definition.key}`);
    }
  }

  return prompt.replace(/\{\{([A-Za-z0-9_-]+)\}\}/g, (match, key: string) => {
    if (hasTemplateParam(params, key)) return params[key];
    const definition = definitionsByKey.get(key);
    if (definition?.default !== undefined) return definition.default;
    return definition ? '' : match;
  });
}

export function validateMobileScheduleDraft(
  draft: MobileScheduleDraft,
): ScheduleDraftValidation | null {
  if (!draft.name.trim()) return { field: 'name', message: '请输入任务名称' };
  // "仅运行脚本"任务(桌面端高级功能)prompt 合法为空——mobile 没有编辑
  // scriptConfig 的 UI,不该拿桌面端才有意义的字段挡住这类任务在移动端的其它
  // 可编辑操作(改名、通知开关等),否则打开/保存一个桌面端创建的脚本任务在
  // 移动端会先于任何改动就校验失败(codex review 发现)。
  if (draft.executionMode !== 'script' && !draft.prompt.trim()) {
    return { field: 'prompt', message: '请输入任务提示词' };
  }
  if (!draft.timezone.trim()) return { field: 'timezone', message: '请输入时区' };
  if (draft.targetSessionId.trim() === MOBILE_SCHEDULE_PENDING_SESSION_ID) {
    return { field: 'targetSessionId', message: '请选择要绑定的任务' };
  }
  if (draft.runMode === 'recurring') {
    if (!draft.cronExpr.trim()) return { field: 'cronExpr', message: '请输入 cron 表达式' };
    const intervalError = validateIntervalMinutes(draft.intervalMinutes);
    if (intervalError) return { field: 'intervalMinutes', message: intervalError };
  }
  if (
    draft.workspaceKind === 'project' &&
    !draft.targetSessionId.trim() &&
    !draft.workingDir.trim()
  ) {
    return { field: 'workingDir', message: '请输入项目目录' };
  }
  if (draft.effort.trim() && !isMobileScheduleEffort(draft.effort.trim())) {
    return {
      field: 'effort',
      message: `推理强度只能是 ${MOBILE_SCHEDULE_EFFORT_VALUES.join(' / ')}`,
    };
  }
  return null;
}

export function buildMobileScheduleInput(draft: MobileScheduleDraft): RemoteScheduleWriteInput {
  const intervalMinutes = parseSupportedIntervalMinutes(draft.intervalMinutes);
  const recurring = draft.runMode === 'recurring';
  const intervalCronExpr = intervalMinutes ? intervalMinutesToCronExpr(intervalMinutes) : null;
  const cronExpr = recurring && intervalCronExpr ? intervalCronExpr : draft.cronExpr.trim();
  const rawTargetSessionId = draft.targetSessionId.trim();
  const targetSessionId = rawTargetSessionId === MOBILE_SCHEDULE_PENDING_SESSION_ID
    ? ''
    : rawTargetSessionId;
  const input: RemoteScheduleWriteInput = {
    name: draft.name.trim(),
    prompt: draft.prompt,
    kind: 'cron',
    cronExpr,
    timezone: draft.timezone.trim(),
    recurring,
    manual: !recurring,
    // Mobile 表单是全量提交:没填间隔(或 manual 模式)就是要清空间隔。清空必须
    // 发 null 而不是 undefined——这个 input 经 device-link JSON.stringify 传输,
    // undefined 的 key 会被丢掉,desktop 端真 partial 语义下旧 intervalMs 会被
    // 保留,清空间隔 / manual 切回 recurring 就静默失效(codex review 发现)。
    // 例外:表单区间表达不了的既有间隔(sourceIntervalMs 在、intervalMinutes 折叠
    // 为 '' 且用户没动过)原值回传,只改 prompt 不得顺手清 cadence(copilot review
    // 发现;touched 语义见 MobileScheduleDraft.intervalMinutesTouched)。
    intervalMs: recurring && intervalMinutes
      ? intervalMinutes * 60_000
      : recurring
          && !draft.intervalMinutesTouched
          && typeof draft.sourceIntervalMs === 'number'
        ? draft.sourceIntervalMs
        : null,
    agentKind: draft.agentKind,
    workspaceKind: draft.workspaceKind,
    useWorktree: draft.workspaceKind === 'project' && draft.useWorktree,
    persistentSession: draft.persistentSession,
    targetSessionId: targetSessionId || undefined,
    silentWhenIdle: draft.silentWhenIdle,
    notify: {
      desktop: draft.notifyDesktop,
      feishu: draft.notifyFeishu,
      wecomGroup: draft.notifyWecomGroup === true,
    },
  };
  if (draft.executionMode === 'script') {
    // 仅运行脚本任务:引擎合并态校验对 script 模式拒绝 worktree/绑定/持续会话/
    // silentWhenIdle 与非 project 工作区——表单残留或误操作的这些 agent-only
    // 字段一律钉回 script 合法值,否则一个可见控件就能让整个保存失败(codex
    // review 发现)。model/effort/fastMode 不带(= 不修改),targetSessionId 为
    // undefined 时 JSON 序列化自然丢 key(= 不修改)。
    return {
      ...input,
      workspaceKind: 'project',
      workingDir: draft.workingDir.trim(),
      useWorktree: false,
      persistentSession: false,
      targetSessionId: undefined,
      silentWhenIdle: false,
    };
  }

  if (targetSessionId) {
    input.useWorktree = false;
    input.model = draft.model.trim() || undefined;
    const effort = draft.effort.trim();
    input.effort = isMobileScheduleEffort(effort) ? effort : undefined;
    return input;
  }

  const providerId = draft.providerId.trim();
  if (providerId) input.providerId = providerId;

  if (draft.workspaceKind === 'project' && !input.targetSessionId) {
    input.workingDir = draft.workingDir.trim();
  }
  const model = draft.model.trim();
  if (model) input.model = model;
  const effort = draft.effort.trim();
  if (isMobileScheduleEffort(effort)) input.effort = effort;
  // Fast 对 Codex 与 Pi 都生效(runner 对 claude-code 忽略此字段,并按模型 supportsFastMode
  // 收口);只序列化 codex 会让 Pi 任务里开的 Fast 被静默丢弃。
  if (draft.agentKind === 'codex' || draft.agentKind === 'pi') input.fastMode = draft.fastMode;
  return input;
}

/**
 * 按被控端能力决定 intervalMs 清空的 wire 形态(device-link 两端版本会错位):
 *
 * - 新 desktop(capabilities.supportsScheduleIntervalNullClear)认识 null,
 *   IPC 入口把它归一化成引擎的「带 key 的 undefined」显式清空;
 * - 旧 desktop 没有归一化逻辑,null 会被旧引擎当成已设间隔算出 now + null
 *   立即触发(codex review 发现);对它必须回退旧 wire 形态——**省略 key**,
 *   旧引擎「带 cronExpr 不带 intervalMs = 隐式清空」恰好承担等价的清空语义。
 *
 * 能力探测失败按不支持处理:错发省略 key 到新 desktop 最坏是清空 no-op
 * (重新保存可纠正),错发 null 到旧 desktop 是立即触发,失败方向必须朝前者。
 */
export function applyScheduleWireCompat(
  input: RemoteScheduleWriteInput,
  opts: { supportsIntervalNullClear: boolean },
): RemoteScheduleWriteInput {
  if (opts.supportsIntervalNullClear || input.intervalMs !== null) return input;
  const { intervalMs: _legacyDropped, ...legacy } = input;
  return legacy;
}

export function updateDraftAgentKind(
  draft: MobileScheduleDraft,
  agentKind: RemoteScheduleAgentKind,
): MobileScheduleDraft {
  if (draft.agentKind === agentKind) return draft;
  return {
    ...draft,
    agentKind,
    model: defaultModelFor(agentKind),
    providerId: '',
    effort: '',
    fastMode: false,
  };
}

/** 间隔输入框的编辑入口:任何编辑(含清空)都标记 touched,与「表达不了被折叠成空」区分。 */
export function updateDraftIntervalMinutes(
  draft: MobileScheduleDraft,
  intervalMinutes: string,
): MobileScheduleDraft {
  return { ...draft, intervalMinutes, intervalMinutesTouched: true };
}

/**
 * cron 表达式输入的编辑入口:编辑任何可见 cadence 字段都是显式 cadence 操作,
 * 一并丢弃表单表达不了的隐藏 interval——否则用户改了看得见的 cron,保存后隐藏
 * interval 仍是权威,刚改的排期完全不生效(codex review 发现)。不变量:保存后
 * 的 cadence 语义 = 用户在表单看到并确认的状态;隐藏 interval 只在编辑无关
 * 字段(prompt / 名称 / 通知等)时保留。
 */
export function updateDraftCronExpr(
  draft: MobileScheduleDraft,
  cronExpr: string,
): MobileScheduleDraft {
  return { ...draft, cronExpr, intervalMinutesTouched: true };
}

/** 时区输入的编辑入口:与 updateDraftCronExpr 同一 cadence 不变量。 */
export function updateDraftTimezone(
  draft: MobileScheduleDraft,
  timezone: string,
): MobileScheduleDraft {
  return { ...draft, timezone, intervalMinutesTouched: true };
}

export function updateDraftRunMode(
  draft: MobileScheduleDraft,
  runMode: MobileScheduleRunMode,
): MobileScheduleDraft {
  if (draft.runMode === runMode) return draft;
  return {
    ...draft,
    runMode,
    intervalMinutes: runMode === 'manual' ? '' : draft.intervalMinutes,
    // 切 manual 是对 cadence 的显式操作:之后切回 recurring 也不该复活旧间隔
    // (2026-08-03 codex review:manual 切回 recurring 仍按旧间隔跑就是事故形态)。
    ...(runMode === 'manual' ? { intervalMinutesTouched: true } : {}),
  };
}

export function updateDraftWorkspaceKind(
  draft: MobileScheduleDraft,
  workspaceKind: RemoteScheduleWorkspaceKind,
): MobileScheduleDraft {
  if (draft.workspaceKind === workspaceKind) return draft;
  return {
    ...draft,
    workspaceKind,
    useWorktree: workspaceKind === 'project' && draft.useWorktree,
  };
}

export function hasMobileScheduleRealBinding(
  draft: Pick<MobileScheduleDraft, 'targetSessionId'>,
): boolean {
  const targetSessionId = draft.targetSessionId.trim();
  return !!targetSessionId && targetSessionId !== MOBILE_SCHEDULE_PENDING_SESSION_ID;
}

export function deriveMobileScheduleSessionMode(
  draft: Pick<MobileScheduleDraft, 'persistentSession' | 'targetSessionId'>,
): MobileScheduleSessionMode {
  if (draft.persistentSession) return 'persistent';
  if (draft.targetSessionId.trim()) return 'bound';
  return 'fresh';
}

export function updateDraftSessionMode(
  draft: MobileScheduleDraft,
  sessionMode: MobileScheduleSessionMode,
): MobileScheduleDraft {
  switch (sessionMode) {
    case 'fresh':
      if (!draft.persistentSession && draft.targetSessionId === '') return draft;
      return { ...draft, persistentSession: false, targetSessionId: '' };
    case 'persistent':
      if (
        draft.persistentSession &&
        draft.targetSessionId.trim() !== MOBILE_SCHEDULE_PENDING_SESSION_ID
      ) {
        return draft;
      }
      return {
        ...draft,
        persistentSession: true,
        targetSessionId: draft.targetSessionId.trim() === MOBILE_SCHEDULE_PENDING_SESSION_ID
          ? ''
          : draft.targetSessionId,
      };
    case 'bound':
      if (!draft.persistentSession && draft.targetSessionId.trim()) return draft;
      return {
        ...draft,
        persistentSession: false,
        targetSessionId: draft.targetSessionId.trim() || MOBILE_SCHEDULE_PENDING_SESSION_ID,
        useWorktree: false,
      };
  }
}

export function updateDraftBoundSessionId(
  draft: MobileScheduleDraft,
  targetSessionId: string,
): MobileScheduleDraft {
  const nextTargetSessionId = targetSessionId.trim() || MOBILE_SCHEDULE_PENDING_SESSION_ID;
  if (
    !draft.persistentSession &&
    draft.targetSessionId === nextTargetSessionId &&
    !draft.useWorktree
  ) {
    return draft;
  }
  return {
    ...draft,
    persistentSession: false,
    targetSessionId: nextTargetSessionId,
    useWorktree: false,
  };
}

function isMobileScheduleEffort(value: string): value is MobileScheduleEffort {
  return (MOBILE_SCHEDULE_EFFORT_VALUES as readonly string[]).includes(value);
}

function hasTemplateParam(params: Record<string, string>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(params, key) && params[key] !== '';
}

function defaultModelFor(agentKind: RemoteScheduleAgentKind): string {
  if (agentKind === 'codex') return DEFAULT_CODEX_MODEL;
  // Pi 模型来自动态 BYOM 供应商目录,没有固定默认 id;留空 → 序列化时省略 → host 解析
  // 该 Pi agent 的当前默认模型(用户仍可在自由文本模型框里显式指定)。
  if (agentKind === 'pi') return '';
  return DEFAULT_CLAUDE_MODEL;
}

function validateIntervalMinutes(value: string): string | null {
  if (!value.trim()) return null;
  const minutes = Number(value);
  if (!Number.isInteger(minutes) || minutes <= 0) {
    return '间隔分钟必须是正整数';
  }
  if (intervalMinutesToCronExpr(minutes) === null) {
    return '分钟间隔只支持 1-59 分钟，或 1-23 小时的整点间隔';
  }
  return null;
}

function parseSupportedIntervalMinutes(value: string): number | null {
  if (!value.trim()) return null;
  const minutes = Number(value);
  if (!Number.isInteger(minutes) || minutes <= 0) return null;
  return intervalMinutesToCronExpr(minutes) ? minutes : null;
}

function intervalMinutesToCronExpr(minutes: number): string | null {
  if (minutes === 1) return '* * * * *';
  if (minutes >= 2 && minutes <= 59) return `*/${minutes} * * * *`;
  if (minutes === 60) return '0 * * * *';
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    if (hours >= 1 && hours <= 23) return `0 */${hours} * * *`;
  }
  return null;
}

function intervalMsToSupportedMinutes(intervalMs: number | undefined): string {
  if (!Number.isFinite(intervalMs) || !intervalMs) return '';
  const minutes = Math.round(intervalMs / 60_000);
  return intervalMinutesToCronExpr(minutes) ? String(minutes) : '';
}
