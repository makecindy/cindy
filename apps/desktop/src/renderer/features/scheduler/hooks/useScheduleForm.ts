/**
 * useScheduleForm — Form state machine（new / edit 共用）
 * ---------------------------------------------------------------------------
 * 字段直接对应 CreateScheduleInput；新建用空白 default，编辑用现有 Schedule 回填。
 *
 * Heartbeat 模式（targetSessionId 非空）下 workingDir/useWorktree 两字段 runner 会忽略
 *（绑定 session 的 workDir 是权威），submit 时不发送；model/effort 则照常发送 ——
 * runner 在 heartbeat fire 时 schedule.model 优先于 session meta（用户改了要生效）。
 */

import { useCallback, useRef, useState } from 'react';
import type { CreateScheduleInput, Schedule, ScheduleTemplate, ScheduleWorkspaceKind } from '@cindy/maker-scheduler';
import { getPersistedVendorModel } from '@/state/newMakerDraft';
import type { Session } from '@/lib/ccAgent.types';
import {
  EFFORT_VALUES,
  isEffortValue,
  applyRunMode,
  buildScheduleInput,
  captureBinding,
  sessionAgentKindToScheduleAgentKind,
  PENDING_SESSION_ID,
  resolveTemplateAgentFields,
} from '../lib/scheduleFormLogic';
import type { ScheduleFormState, RunMode, RememberedBinding } from '../lib/scheduleFormLogic';

// 类型与 effort 白名单已迁入 lib/scheduleFormLogic(纯函数层,node 环境可测);
// 原处 re-export 保持既有 import 路径不变(ScheduleChips / projectAutomationConfig 等)。
export { EFFORT_VALUES, isEffortValue } from '../lib/scheduleFormLogic';
export type { EffortValue, ScheduleFormState, RunMode } from '../lib/scheduleFormLogic';
export { deriveRunMode, hasRealBinding, PENDING_SESSION_ID } from '../lib/scheduleFormLogic';

const DEFAULT_FORM: ScheduleFormState = {
  name: '',
  prompt: '',
  executionMode: 'agent',
  scriptCommand: '',
  scriptTimeoutSec: '',
  scriptCapabilities: [],
  cronExpr: '0 9 * * *',
  intervalMs: undefined,
  timezone: 'Asia/Shanghai',
  recurring: true,
  manual: false,
  agentKind: 'claude-code',
  model: '',
  providerId: '',
  effort: '',
  fastMode: false,
  workspaceKind: 'dialogue',
  workingDir: '',
  useWorktree: false,
  targetSessionId: '',
  persistentSession: false,
  silentWhenIdle: false,
  preRunHookEnabled: false,
  preRunHookCommand: '',
  preRunHookTimeoutSec: '',
  notifyDesktop: true,
  notifyFeishu: false,
};

const SCHEDULE_FORM_PREFS_KEY = 'xdt:scheduleFormPrefs:v1';

type ScheduleAgentPrefs = Pick<ScheduleFormState, 'model' | 'providerId' | 'effort' | 'fastMode'>;

interface ScheduleFormPrefs {
  agentKind: ScheduleFormState['agentKind'];
  workspaceKind: ScheduleWorkspaceKind;
  workingDir: string;
  useWorktree: boolean;
  lastByAgent: Record<ScheduleFormState['agentKind'], ScheduleAgentPrefs>;
}

const EMPTY_AGENT_PREFS: ScheduleAgentPrefs = { model: '', providerId: '', effort: '', fastMode: false };

function defaultScheduleFormPrefs(): ScheduleFormPrefs {
  return {
    agentKind: DEFAULT_FORM.agentKind,
    workspaceKind: DEFAULT_FORM.workspaceKind,
    workingDir: '',
    useWorktree: false,
    lastByAgent: {
      'claude-code': EMPTY_AGENT_PREFS,
      codex: EMPTY_AGENT_PREFS,
    },
  };
}

function loadScheduleFormPrefs(): ScheduleFormPrefs {
  if (typeof window === 'undefined') return defaultScheduleFormPrefs();
  try {
    const raw = window.localStorage.getItem(SCHEDULE_FORM_PREFS_KEY);
    if (!raw) return defaultScheduleFormPrefs();
    const parsed = JSON.parse(raw) as Partial<ScheduleFormPrefs>;
    const agentKind = parsed.agentKind === 'codex' ? 'codex' : 'claude-code';
    const workingDir = typeof parsed.workingDir === 'string' ? parsed.workingDir : '';
    const workspaceKind = normalizePrefsWorkspaceKind(parsed.workspaceKind, workingDir);
    return {
      agentKind,
      workspaceKind,
      workingDir: workspaceKind === 'project' ? workingDir : '',
      useWorktree: workspaceKind === 'project' && parsed.useWorktree === true,
      lastByAgent: {
        'claude-code': sanitizeAgentPrefs(parsed.lastByAgent?.['claude-code']),
        codex: sanitizeAgentPrefs(parsed.lastByAgent?.codex),
      },
    };
  } catch {
    return defaultScheduleFormPrefs();
  }
}

function normalizePrefsWorkspaceKind(
  raw: unknown,
  workingDir: string,
): ScheduleWorkspaceKind {
  if (raw === 'dialogue') return 'dialogue';
  if (raw === 'project' || workingDir.trim()) return 'project';
  return DEFAULT_FORM.workspaceKind;
}

function sanitizeAgentPrefs(raw: Partial<ScheduleAgentPrefs> | undefined): ScheduleAgentPrefs {
  return {
    model: typeof raw?.model === 'string' ? raw.model : '',
    providerId: typeof raw?.providerId === 'string' ? raw.providerId : '',
    effort: raw?.effort && isEffortValue(raw.effort) ? raw.effort : '',
    fastMode: raw?.fastMode === true,
  };
}

function saveScheduleFormPrefs(prefs: ScheduleFormPrefs): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SCHEDULE_FORM_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Ignore storage failures; form state still works for the current dialog.
  }
}

export function getScheduleAgentPrefs(agentKind: ScheduleFormState['agentKind']): ScheduleAgentPrefs {
  return loadScheduleFormPrefs().lastByAgent[agentKind] ?? EMPTY_AGENT_PREFS;
}

/**
 * 调度任务的冷启动兜底模型 —— 故意**不**跟对话的 Opus 默认
 * (modelDefinitions.ts getDefaultModelForVendor):自动化是无人值守反复执行的
 * 场景,默认不该是最贵的模型,要 Opus 的用户会显式选。
 * ⚠️ 必须与 scheduler-host/runner.ts defaultModelFor 保持一致
 * (runner 对 MCP 建的 / 历史遗留空 model 任务兜同一个值,UI 显示 ≠ 实际运行
 * 的事故见 2026-06 踩坑:任务里看着选了 Opus 4.8,实际每次跑 4.7)。
 */
export function schedulerFallbackModel(agentKind: ScheduleFormState['agentKind']): string {
  return agentKind === 'codex' ? 'gpt-5.5' : 'claude-sonnet-4-6';
}

/**
 * 新任务的默认模型,三级回退:
 *   1. 上次建自动化任务时选的模型(scheduleFormPrefs,任务维度记忆)
 *   2. 对话上次选择的模型(newMakerDraft 真实持久化值 —— 与新建对话同源,
 *      跟着用户实际在用的模型走)
 *   3. 成本保守冷启动兜底(schedulerFallbackModel)
 */
export function getScheduleDefaultModel(agentKind: ScheduleFormState['agentKind']): string {
  const prefs = getScheduleAgentPrefs(agentKind);
  if (prefs.model.trim()) return prefs.model;
  const chatLast = getPersistedVendorModel(agentKind === 'codex' ? 'codex' : 'cc');
  if (chatLast.trim()) return chatLast;
  return schedulerFallbackModel(agentKind);
}

export function rememberScheduleFormPrefs(form: ScheduleFormState): void {
  const current = loadScheduleFormPrefs();
  const workspaceKind = form.workspaceKind;
  saveScheduleFormPrefs({
    agentKind: form.agentKind,
    workspaceKind,
    workingDir: workspaceKind === 'project' ? form.workingDir : '',
    useWorktree: workspaceKind === 'project' && form.useWorktree,
    lastByAgent: {
      ...current.lastByAgent,
      [form.agentKind]: {
        model: form.model,
        providerId: form.providerId,
        effort: form.effort,
        fastMode: form.fastMode,
      },
    },
  });
}

function makeDefaultForm(): ScheduleFormState {
  const prefs = loadScheduleFormPrefs();
  const agentPrefs = prefs.lastByAgent[prefs.agentKind] ?? EMPTY_AGENT_PREFS;
  return {
    ...DEFAULT_FORM,
    agentKind: prefs.agentKind,
    // 三级回退:任务上次选择 → 对话上次选择 → 成本保守兜底,保证新任务
    // 表单的 model 永远是显式值(所见即所存,不再依赖 chip 的显示回退)。
    model: getScheduleDefaultModel(prefs.agentKind),
    // providerId 空 = 跟随原生默认来源（no-break）。沿用任务维度记忆;UI 显示时
    // 用 form.providerId || nativeDefaultSourceId(agentKind) 算高亮来源。
    providerId: agentPrefs.providerId,
    effort: agentPrefs.effort,
    fastMode: agentPrefs.fastMode,
    workspaceKind: prefs.workspaceKind,
    workingDir: prefs.workingDir,
    useWorktree: prefs.useWorktree,
  };
}

export function makeFormFromSchedule(s: Schedule | null): ScheduleFormState {
  if (!s) return makeDefaultForm();
  const workspaceKind = s.workspaceKind ?? (s.workingDir ? 'project' : 'dialogue');
  return {
    name: s.name,
    prompt: s.prompt,
    executionMode: s.executionMode ?? 'agent',
    scriptCommand: s.scriptConfig?.command ?? '',
    scriptTimeoutSec: s.scriptConfig?.timeoutMs
      ? String(Math.round(s.scriptConfig.timeoutMs / 1000))
      : '',
    scriptCapabilities: [...(s.scriptConfig?.capabilities ?? [])],
    cronExpr: s.cronExpr,
    intervalMs: s.intervalMs,
    timezone: s.timezone,
    recurring: s.recurring,
    manual: s.manual,
    agentKind: s.agentKind,
    model: s.model ?? '',
    providerId: s.providerId ?? '',
    effort: s.effort && isEffortValue(s.effort) ? s.effort : '',
    fastMode: !!s.fastMode,
    workspaceKind,
    workingDir: s.workingDir ?? '',
    useWorktree: workspaceKind === 'project' && s.useWorktree,
    targetSessionId: s.targetSessionId ?? '',
    persistentSession: !!s.persistentSession,
    silentWhenIdle: !!s.silentWhenIdle,
    preRunHookEnabled: !!s.preRunHook?.command,
    preRunHookCommand: s.preRunHook?.command ?? '',
    preRunHookTimeoutSec: s.preRunHook?.timeoutMs
      ? String(Math.round(s.preRunHook.timeoutMs / 1000))
      : '',
    notifyDesktop: s.notify.desktop,
    notifyFeishu: s.notify.feishu,
  };
}

/** UI destination 三态：local / worktree / thread(=heartbeat)。 */
export type Destination = 'local' | 'worktree' | 'thread';

export interface UseScheduleFormResult {
  form: ScheduleFormState;
  setField: <K extends keyof ScheduleFormState>(k: K, v: ScheduleFormState[K]) => void;
  /** 改 destination 时同步改 useWorktree / targetSessionId 三态互斥。 */
  setDestination: (d: Destination) => void;
  /** "运行会话"三态切换(fresh / persistent / bound),转换逻辑见 applyRunMode。 */
  setRunMode: (mode: RunMode) => void;
  /**
   * bound 态从 picker 选中会话:写 targetSessionId + agentKind 跟随会话 +
   * model/effort 清空(默认"跟随会话")+ fastMode=false(heartbeat 下 runner
   * 忽略 schedule.fastMode,清掉防脏值)。传 null = 选回占位(保持 bound 态)。
   */
  selectBoundSession: (session: Session | null) => void;
  /** 应用模板里的 agent/model/provider/effort/fast 字段,并在跨 agent 时重建成目标 agent 的默认组合。 */
  applyTemplateAgentFields: (template: ScheduleTemplate) => void;
  reset: (s?: Schedule | null) => void;
  /**
   * 把表单转成 CreateScheduleInput；
   * heartbeat 模式（targetSessionId 非空）只跳过 workingDir/useWorktree
   * （runner 从 SessionMeta 取，传了也被忽略）；model/effort 照常发送。
   */
  toInput: () => CreateScheduleInput;
  /**
   * 校验 + 返回错误 i18n key + 可选 interpolation values。null = 通过。
   * 调用方负责用 t() 翻译。
   */
  validate: () => { key: string; values?: Record<string, string> } | null;
}

export function useScheduleForm(initial: Schedule | null = null): UseScheduleFormResult {
  const [form, setForm] = useState<ScheduleFormState>(() => makeFormFromSchedule(initial));
  // "记住的真实绑定"快照:三态来回切换(bound → fresh/persistent → bound)时
  // 不丢用户已选/任务已有的绑定 —— 表单切换是非破坏性的,只有保存才落库。
  // 快照含 model/effort 等关联字段:切到 fresh 后空 model 会被回填 effect 填成
  // 显式值,只记 id 还原会把该显式值 patch 给"跟随会话"任务(review 逃逸路径)。
  const lastBindingRef = useRef<RememberedBinding | null>(null);
  if (lastBindingRef.current === null) {
    lastBindingRef.current = captureBinding(form);
  }

  const setField = useCallback(
    <K extends keyof ScheduleFormState>(k: K, v: ScheduleFormState[K]) => {
      setForm((f) => ({ ...f, [k]: v }));
    },
    [],
  );

  const reset = useCallback((s: Schedule | null = null) => {
    const next = makeFormFromSchedule(s);
    lastBindingRef.current = captureBinding(next);
    setForm(next);
  }, []);

  const applyTemplateAgentFields = useCallback((template: ScheduleTemplate) => {
    setForm((f) => ({
      ...f,
      ...resolveTemplateAgentFields(f, template, {
        getDefaultModel: getScheduleDefaultModel,
        getAgentPrefs: getScheduleAgentPrefs,
      }),
    }));
  }, []);

  /**
   * 切 destination：
   *   local    → useWorktree=false, targetSessionId=''
   *   worktree → useWorktree=true,  targetSessionId=''
   *   thread   → useWorktree=false, targetSessionId 保持（用户后续会在 picker 选具体 id）
   *               若当前 targetSessionId 空，置为占位 '__pending__' 让 isHeartbeat 判定生效，
   *               picker 内部把 '__pending__' 显示为空选；validate 会拦真正空 id。
   */
  const setDestination = useCallback((d: Destination) => {
    setForm((f) => {
      switch (d) {
        case 'local':
          return { ...f, useWorktree: false, targetSessionId: '' };
        case 'worktree':
          return { ...f, useWorktree: true, targetSessionId: '' };
        case 'thread':
          return {
            ...f,
            useWorktree: false,
            targetSessionId: f.targetSessionId.trim() ? f.targetSessionId : PENDING_SESSION_ID,
          };
      }
    });
  }, []);

  const setRunMode = useCallback((mode: RunMode) => {
    setForm((f) => {
      // 切走前快照真实绑定(含 model/effort 等),切回 bound/persistent 时整组
      // 还原 —— 模式切换非破坏性,绑定只有保存才真正丢失。
      const snapshot = captureBinding(f);
      if (snapshot) lastBindingRef.current = snapshot;
      return applyRunMode(f, mode, lastBindingRef.current);
    });
  }, []);

  const selectBoundSession = useCallback((session: Session | null) => {
    setForm((f) => {
      if (!session) {
        // 选回占位项:保持 bound 态,绝不能写 ''(会被 deriveRunMode 判成 fresh 跳态)。
        // remembered 保留旧快照 —— 用户切走再切回还能还原上一个真实绑定。
        return { ...f, targetSessionId: PENDING_SESSION_ID };
      }
      const next: ScheduleFormState = {
        ...f,
        targetSessionId: session.id,
        agentKind: sessionAgentKindToScheduleAgentKind(session.agentKind),
        model: '',
        // 绑定会话 = 跟随其模型/来源,providerId 一并清空(与 model/effort 同语义)。
        providerId: '',
        effort: '',
        fastMode: false,
      };
      lastBindingRef.current = captureBinding(next);
      return next;
    });
  }, []);

  const validate = useCallback((): { key: string; values?: Record<string, string> } | null => {
    if (!form.name.trim()) return { key: 'scheduler.editor.validation.nameRequired' };
    if ((form.executionMode ?? 'agent') === 'agent' && !form.prompt.trim()) {
      return { key: 'scheduler.editor.validation.promptRequired' };
    }
    if (form.executionMode === 'script' && !form.scriptCommand?.trim()) {
      return { key: 'scheduler.editor.validation.scriptCommandRequired' };
    }
    if (!form.cronExpr.trim()) return { key: 'scheduler.editor.validation.scheduleRequired' };
    if (!form.timezone.trim()) return { key: 'scheduler.editor.validation.timezoneRequired' };

    const tgt = form.targetSessionId.trim();
    const isHeartbeat = !!tgt;
    if (form.executionMode === 'script') {
      if (!form.workingDir.trim()) return { key: 'scheduler.editor.validation.selectProject' };
      // 编辑 bound/persistent 任务切到 script 时 targetSessionId 会残留在 form 里
      // (运行会话控件已隐藏,用户无从清理)——不在这里拦:buildScheduleInput 的
      // script 分支会把绑定/worktree/静默字段全部清干净,保存即完成模式转换。
    } else if (isHeartbeat) {
      if (tgt === '__pending__') return { key: 'scheduler.editor.validation.selectThread' };
    } else {
      if (form.workspaceKind === 'project' && !form.workingDir.trim()) {
        return { key: 'scheduler.editor.validation.selectProject' };
      }
      if (form.effort && !isEffortValue(form.effort)) {
        return { key: 'scheduler.editor.validation.reasoningInvalid', values: { values: EFFORT_VALUES.join(' / ') } };
      }
    }
    // script 模式不展示前置检查区块,buildScheduleInput 的 script 分支也会把它清空
    // ——若在 agent 模式下开了前置检查但命令留空,切到 script 后这条校验不该沿用,
    // 否则用户明明看不到该区块也点不到那个开关,却被挡在保存之外。
    if (form.executionMode !== 'script' && form.preRunHookEnabled && !form.preRunHookCommand.trim()) {
      return { key: 'scheduler.editor.validation.preRunHookCommandRequired' };
    }
    return null;
  }, [form]);

  // 核心转换在 lib/scheduleFormLogic.buildScheduleInput(纯函数,node 单测覆盖);
  // heartbeat 分支 model/effort 恒带 key(空值 undefined → update patch 清列 = 跟随会话)。
  const toInput = useCallback((): CreateScheduleInput => buildScheduleInput(form), [form]);

  return { form, setField, setDestination, setRunMode, selectBoundSession, applyTemplateAgentFields, reset, toInput, validate };
}
