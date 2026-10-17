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
import type { ProviderView } from '@cindy/model-providers';
import { getDraft, getPersistedVendorModel } from '@/state/newMakerDraft';
import { resolveNewTaskDefaultRoute } from '@/lib/draftModelCalibration';
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
  notifyWecomGroup: false,
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
      pi: EMPTY_AGENT_PREFS,
    },
  };
}

function loadScheduleFormPrefs(): ScheduleFormPrefs {
  if (typeof window === 'undefined') return defaultScheduleFormPrefs();
  try {
    const raw = window.localStorage.getItem(SCHEDULE_FORM_PREFS_KEY);
    if (!raw) return defaultScheduleFormPrefs();
    const parsed = JSON.parse(raw) as Partial<ScheduleFormPrefs>;
    const agentKind = parsed.agentKind === 'codex' ? 'codex' : parsed.agentKind === 'pi' ? 'pi' : 'claude-code';
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
        pi: sanitizeAgentPrefs(parsed.lastByAgent?.pi),
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
 * 新任务的默认模型(及第三级回退时与之成对的来源),三级回退:
 *   1. 上次建自动化任务时选的模型(scheduleFormPrefs,任务维度记忆)
 *   2. 对话上次选择的模型(newMakerDraft 真实持久化值 —— 与新建对话同源,
 *      跟着用户实际在用的模型走)
 *   3. 新建任务默认(shared/draftModelCalibration resolveNewTaskDefaultRoute,与 runner
 *      对空 model 任务的实时解析同源)。不写死型号:供应商清单未到位(`providers` 缺省)
 *      或一个可用来源都没有时返回 '',由表单在清单到位后回填。第三级返回的来源必须与模型
 *      一起落到表单:只存模型会让 runner 把空来源重新解析成原生默认(可能是网关)。
 * 不变量:返回值是原子的 (模型, 来源) 对,调用方整对应用,不拿别处的来源去拼模型。
 * 三级都返回与模型成对的来源(一级取任务记忆的来源,二级取对话草稿记着的来源),
 * 没有记来源时为 null(跟随原生默认)。`preferredProviderId` 是表单 / 模板已定下的来源:
 * 给定时只接受同一来源的一、二级结果,第三级只在该来源内挑,保证模型一定由这个来源提供。
 */
export function getScheduleDefaultRoute(
  agentKind: ScheduleFormState['agentKind'],
  providers?: readonly ProviderView[],
  preferredProviderId?: string | null,
): { model: string; providerId: string | null } {
  const preferred = preferredProviderId?.trim() || null;
  const compatible = (providerId: string | null) => !preferred || providerId === preferred;
  const prefs = getScheduleAgentPrefs(agentKind);
  const prefsProviderId = prefs.providerId || null;
  if (prefs.model.trim() && compatible(prefsProviderId)) {
    return { model: prefs.model, providerId: prefsProviderId };
  }
  const vendor = agentKind === 'codex' ? 'codex' : agentKind === 'pi' ? 'pi' : 'cc';
  const draft = getDraft();
  const chatLast = getPersistedVendorModel(vendor);
  const chatProviderId = draft.lastByVendor[vendor]?.providerId || null;
  if (chatLast.trim() && compatible(chatProviderId)) {
    return { model: chatLast, providerId: chatProviderId };
  }
  if (!providers) return { model: '', providerId: preferred };
  return (
    resolveNewTaskDefaultRoute({
      providers,
      agent: agentKind,
      requiredProviderId: preferred,
      draft: {
        model: draft.lastByVendor[vendor]?.model,
        providerId: draft.lastByVendor[vendor]?.providerId,
        chosenByUser: draft.modelChosenByVendor[vendor] === true,
      },
    }) ?? { model: '', providerId: preferred }
  );
}

export function getScheduleDefaultModel(
  agentKind: ScheduleFormState['agentKind'],
  providers?: readonly ProviderView[],
): string {
  return getScheduleDefaultRoute(agentKind, providers).model;
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
  // 三级回退:任务上次选择 → 对话上次选择 → 新建任务默认;清单未到位时先留空,
  // 由 ScheduleFormDialog 在清单到位后回填显式值(所见即所存)。模型与来源成对应用。
  const defaultRoute = getScheduleDefaultRoute(prefs.agentKind, undefined, agentPrefs.providerId);
  return {
    ...DEFAULT_FORM,
    agentKind: prefs.agentKind,
    model: defaultRoute.model,
    // providerId 空 = 跟随原生默认来源（no-break）。默认路由已限定在任务记忆的来源内,
    // 整对应用;UI 显示时用 form.providerId || nativeDefaultSourceId(agentKind) 算高亮来源。
    providerId: defaultRoute.providerId ?? '',
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
    agentKind: s.modelAgentKind ?? s.agentKind,
    modelAgentKind: s.modelAgentKind,
    boundAgent: s.targetSessionId ? { sessionId: s.targetSessionId, agentKind: s.agentKind } : undefined,
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
    notifyWecomGroup: s.notify.wecomGroup === true,
  };
}

/** UI destination 三态：local / worktree / thread(=heartbeat)。 */
export type Destination = 'local' | 'worktree' | 'thread';

export interface UseScheduleFormResult {
  form: ScheduleFormState;
  selectModelConfiguration: (
    selection: Pick<ScheduleFormState, 'agentKind' | 'model' | 'providerId' | 'effort' | 'fastMode'> | null,
    followedAgentKind?: ScheduleFormState['agentKind'],
  ) => void;
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
  reset: (s?: Schedule | null, overrides?: Partial<ScheduleFormState>) => void;
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

  const selectModelConfiguration: UseScheduleFormResult['selectModelConfiguration'] = useCallback((selection, followedAgentKind) => {
    setForm((form) => {
      if (selection) {
        const boundAgent = form.targetSessionId && form.targetSessionId !== PENDING_SESSION_ID &&
          form.boundAgent?.sessionId !== form.targetSessionId
          ? { sessionId: form.targetSessionId, agentKind: form.agentKind } : form.boundAgent;
        return { ...form, ...selection, boundAgent, modelAgentKind: selection.agentKind };
      }
      const agentKind = followedAgentKind ??
        (form.boundAgent?.sessionId === form.targetSessionId
          ? form.boundAgent.agentKind : form.agentKind);
      const boundAgent = followedAgentKind && form.targetSessionId
        ? { sessionId: form.targetSessionId, agentKind } : form.boundAgent;
      return { ...form, agentKind, boundAgent, model: '', providerId: '', effort: '', fastMode: false, modelAgentKind: undefined };
    });
  }, []);

  const reset = useCallback((s: Schedule | null = null, overrides?: Partial<ScheduleFormState>) => {
    const next = { ...makeFormFromSchedule(s), ...overrides };
    if (next.targetSessionId && next.boundAgent?.sessionId !== next.targetSessionId) {
      next.boundAgent = { sessionId: next.targetSessionId, agentKind: s?.agentKind ?? next.agentKind };
    }
    lastBindingRef.current = captureBinding(next);
    setForm(next);
  }, []);

  const applyTemplateAgentFields = useCallback((template: ScheduleTemplate) => {
    setForm((f) => {
      const selection = resolveTemplateAgentFields(f, template, {
        getDefaultRoute: (agentKind, preferredProviderId) =>
          getScheduleDefaultRoute(agentKind, undefined, preferredProviderId),
        getAgentPrefs: getScheduleAgentPrefs,
      });
      // A template that supplies a model is an explicit selection, even while following a bound task.
      return { ...f, ...selection, modelAgentKind: selection.model.trim() ? selection.agentKind : undefined };
    });
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
        boundAgent: { sessionId: session.id, agentKind: sessionAgentKindToScheduleAgentKind(session.agentKind) },
        model: '',
        modelAgentKind: undefined,
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
      // Script bindings survive editing; unavailable owners are paused by the host.
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
    // script 模式保留已有前置检查;切换时命令留空不创建 hook,
    // 否则用户明明看不到该区块也点不到那个开关,却被挡在保存之外。
    if (form.executionMode !== 'script' && form.preRunHookEnabled && !form.preRunHookCommand.trim()) {
      return { key: 'scheduler.editor.validation.preRunHookCommandRequired' };
    }
    return null;
  }, [form]);

  // 核心转换在 lib/scheduleFormLogic.buildScheduleInput(纯函数,node 单测覆盖);
  // heartbeat 分支 model/effort 恒带 key(空值 undefined → update patch 清列 = 跟随会话)。
  const toInput = useCallback((): CreateScheduleInput => buildScheduleInput(form), [form]);

  return { form, setField, selectModelConfiguration, setDestination, setRunMode, selectBoundSession, applyTemplateAgentFields, reset, toInput, validate };
}
