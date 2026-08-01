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
  agentKind: RemoteScheduleAgentKind;
  model: string;
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
    agentKind: schedule.agentKind ?? 'claude-code',
    model: schedule.model ?? defaultModelFor(schedule.agentKind ?? 'claude-code'),
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
    intervalMinutes: '',
    agentKind,
    model: template.model ?? (draft.agentKind === agentKind ? draft.model : defaultModelFor(agentKind)),
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
    intervalMs: recurring && intervalMinutes ? intervalMinutes * 60_000 : undefined,
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

  if (draft.workspaceKind === 'project' && !input.targetSessionId) {
    input.workingDir = draft.workingDir.trim();
  }
  const model = draft.model.trim();
  if (model) input.model = model;
  const effort = draft.effort.trim();
  if (isMobileScheduleEffort(effort)) input.effort = effort;
  if (draft.agentKind === 'codex') input.fastMode = draft.fastMode;
  return input;
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
    effort: '',
    fastMode: false,
  };
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
  return agentKind === 'codex' ? DEFAULT_CODEX_MODEL : DEFAULT_CLAUDE_MODEL;
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
