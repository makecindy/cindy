import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import * as Dialog from '@radix-ui/react-dialog';
import { Check, FolderOpen, Info, Play, Sparkles, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import * as sessionService from '@/lib/sessionService';
import { extractIpcError } from '@/utils/ipcError';
import { Tip } from '@/components/ui/tooltip';
import { useAgentCapabilities } from '@/hooks/useAgentCapabilities';
import { useProviders } from '@/hooks/useProviders';
import {
  sessionModelSupportsFastMode,
} from '@cindy/model-providers';
import type { UtilityTextAttemptReason, UtilityTextFailure } from '../../../../shared/utilityTextResult';
import { useFeishuBot } from '@/hooks/useFeishuBot';
import { useProjectPickerOptions } from '@/hooks/useProjectPickerOptions';
import { useWecomGroupNotificationSettings } from '@/hooks/useWecomGroupNotificationSettings';
import type { Schedule, CreateScheduleInput, ScheduleTemplate, UpdateScheduleInput } from '@cindy/maker-scheduler';
import { applyTemplateParams } from '@cindy/maker-scheduler/template-engine';
import { ScriptCapabilityMultiSelect } from './ScriptCapabilityMultiSelect';

import {
  getScheduleAgentPrefs,
  getScheduleDefaultModel,
  rememberScheduleFormPrefs,
  useScheduleForm,
  deriveRunMode,
  hasRealBinding,
} from '../hooks/useScheduleForm';
import { useSessionReferences } from '../hooks/useSessionReferences';
import {
  buildHookCommandForScriptFile,
  canSubmitSessionBinding,
  isExplicitScheduleModelUnavailable,
  needsBoundSessionGenerationRouteResolution,
  parsePreRunHookTimeoutMs,
  resolveScheduleGenerationProviderId,
  resolveScheduleModelEfforts,
  usesBoundSessionGenerationModel,
} from '../lib/scheduleFormLogic';
import type { RunMode, ScheduleFormState } from '../hooks/useScheduleForm';
import { BoundSessionCard } from './BoundSessionCard';
import { TemplateGallery } from './TemplateGallery';
import { TemplateParamForm } from './TemplateParamForm';
import {
  formToProjectConfig,
  generateProjectScheduleId,
} from '../lib/projectAutomationConfig';
import {
  AgentTabs,
  ModelEffortChip,
  ProjectChip,
  ScheduleChip,
  ScheduleSettingsButton,
  ThreadPickerInline,
} from './ScheduleChips';

/** 可直接运行的最小协议示例，帮助用户理解 stdout 的 JSONL 约束。 */
const SCRIPT_PROTOCOL_PYTHON_EXAMPLE = `import json

print(json.dumps({
    "protocol": "cindy-script/1",
    "type": "complete",
    "resultText": "done"
}))`;

/** i18n suffix for every credential-safe utility candidate diagnostic. */
const UTILITY_ATTEMPT_REASON_KEY: Record<UtilityTextAttemptReason, string> = {
  unsupported_transport: 'unsupportedTransport',
  agent_unavailable: 'agentUnavailable',
  model_unavailable: 'modelUnavailable',
  not_authenticated: 'notAuthenticated',
  auth_probe_failed: 'authProbeFailed',
  api_key_missing: 'apiKeyMissing',
  endpoint_missing: 'endpointMissing',
  timeout: 'timeout',
  empty_response: 'emptyResponse',
  http_error: 'httpError',
  request_failed: 'requestFailed',
};

/**
 * 前置检查相关 IPC 失败的 toast:先走 extractIpcError 剥掉 `[CODE]` 编码前缀
 * (规则 13:renderer 消费 IPC 错误统一解码,不给用户看协议内码),非 IPC 错误原样展示。
 */
function showHookErrorToast(err: unknown): void {
  const ipc = extractIpcError(err);
  const message = ipc?.message?.trim()
    ? ipc.message
    : err instanceof Error
      ? err.message
      : String(err);
  toast.error(message);
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: Schedule | null;
  /** 从外部推荐卡片进入新建弹窗时，直接把对应模板应用到表单。 */
  initialTemplate?: ScheduleTemplate | null;
  /** 外部快捷入口的新建表单覆写；只负责预填，仍须用户主动提交。 */
  initialValues?: Partial<ScheduleFormState> | null;
  onSubmit: (input: CreateScheduleInput | UpdateScheduleInput, isEdit: boolean) => Promise<void>;
  /** 项目分组里"+"按钮的便捷入口：仅预填 workingDir，等同于普通新建（用户级 schedule，
   *  不写 schedules.json，可继续选模板、改项目）。 */
  initialWorkingDir?: string | null;
  /** 编辑 project schedule 时为 true，保存走 schedules.json upsert。 */
  editProjectSchedule?: boolean;
  /**
   * 本次新建面板是由哪个插件请求打开的（agent 槽 schedule 加档）。非空时在标题下
   * 显示来源标注，让用户看清是谁请求建这条任务 —— 预填内容来自插件，用户必须知道
   * 自己在替谁保存。仅展示，不影响提交内容。
   */
  requestedByGhostName?: string | null;
}

export function ScheduleFormDialog({
  open,
  onOpenChange,
  initial,
  initialTemplate = null,
  initialValues = null,
  onSubmit,
  initialWorkingDir = null,
  editProjectSchedule = false,
  requestedByGhostName = null,
}: Props) {
  const { t } = useTranslation();
  const formApi = useScheduleForm(initial);
  const { form, setField, setDestination, setRunMode, selectBoundSession, applyTemplateAgentFields, reset, toInput, validate } = formApi;
  const caps = useAgentCapabilities(form.agentKind);
  const { providers } = useProviders();
  // "运行会话"三态(fresh / persistent / bound)与心跳形态派生值。
  // hasRealBinding = targetSessionId 为真实会话 id(B 已绑 / C 已选 / MCP 手绑),
  // 此时目录 / worktree / fastMode 由绑定会话决定,表单隐藏对应字段。
  const runMode = deriveRunMode(form);
  const isBound = hasRealBinding(form);
  const boundSessionIds = useMemo(
    () => (isBound ? [form.targetSessionId] : []),
    [isBound, form.targetSessionId],
  );
  const boundSessionReferences = useSessionReferences(boundSessionIds);
  const boundSessionReference = isBound
    ? boundSessionReferences.get(form.targetSessionId)
    : undefined;
  const hideWorkspaceFields = runMode === 'bound' || isBound;
  const [submitting, setSubmitting] = useState(false);
  const [mode, setMode] = useState<'gallery' | 'form'>('form');
  // 前置检查「测试运行」状态:结果只在弹窗内展示,不落任何记录。
  const [hookTesting, setHookTesting] = useState(false);
  const [hookTestResult, setHookTestResult] = useState<Awaited<
    ReturnType<typeof window.electronAPI.maker.schedule.testPreRunHook>
  > | null>(null);
  // 前置检查「AI 生成」内联面板:用户描述需求 → 生成脚本落盘 → 命令自动回填。
  const [hookGenOpen, setHookGenOpen] = useState(false);
  const [hookGenDesc, setHookGenDesc] = useState('');
  const [hookGenerating, setHookGenerating] = useState(false);
  const [hookGenPath, setHookGenPath] = useState<string | null>(null);
  const [hookGenFailure, setHookGenFailure] = useState<UtilityTextFailure | null>(null);
  // 命令输入框的拖拽悬停态(高亮提示可放置)。
  const [hookDragOver, setHookDragOver] = useState(false);

  /** 选中/拖入脚本文件 → 按扩展名+平台生成调用命令并回填(纯代码映射,见 scheduleFormLogic)。 */
  const applyHookScriptFile = useCallback(
    (filePath: string) => {
      if (!filePath.trim()) return;
      const command = buildHookCommandForScriptFile(filePath, {
        workingDir: form.workingDir,
        platform: window.electronAPI.platform,
      });
      setField('preRunHookCommand', command);
      setHookTestResult(null);
      setHookGenPath(null);
    },
    [form.workingDir, setField],
  );

  /** 「浏览」按钮:系统文件选择器选脚本。 */
  const browseHookScript = useCallback(async () => {
    try {
      const result = await window.electronAPI.dialog.showOpenFile({
        defaultPath: form.workingDir.trim() || undefined,
        filters: [
          { name: 'Scripts', extensions: ['mjs', 'js', 'cjs', 'py', 'sh', 'ps1', 'bat', 'cmd', 'exe'] },
          { name: 'All Files', extensions: ['*'] },
        ],
      });
      if (result.path) applyHookScriptFile(result.path);
    } catch (err) {
      showHookErrorToast(err);
    }
  }, [form.workingDir, applyHookScriptFile]);
  const [selectedTemplate, setSelectedTemplate] = useState<ScheduleTemplate | null>(null);
  const [paramValues, setParamValues] = useState<Record<string, string>>({});
  const [promptDirty, setPromptDirty] = useState(false);
  const isEdit = !!initial;
  // 仅编辑已存在的 project schedule 时才进入"项目自动化"模式（写 schedules.json + 锁项目 + 隐藏模板）；
  // 普通新建（包括项目分组"+"带 workingDir 预填）一律走用户级路径，UI 与顶部"新建自动化"对齐。
  const isProjectAutomationMode = editProjectSchedule;
  const projectWorkingDir = editProjectSchedule ? (initial?.workingDir ?? null) : null;
  const isTemplateMode = mode === 'gallery' || !!selectedTemplate;
  // script/agent 双执行模式的唯一判别常量——所有条件渲染共用,避免散拷漂移
  const isScriptMode = (form.executionMode ?? 'agent') === 'script';
  const submitLabel = isEdit
    ? t('scheduler.editor.promptDialog.save')
    : t('scheduler.editor.promptDialog.create');

  const initialId = initial?.id;
  useEffect(() => {
    if (!open) return;
    reset(initial, initialValues ?? undefined);
    setMode('form');
    setSelectedTemplate(null);
    setParamValues({});
    setPromptDirty(false);
    setHookTesting(false);
    setHookDragOver(false);
    setHookTestResult(null);
    setHookGenOpen(false);
    setHookGenDesc('');
    setHookGenerating(false);
    setHookGenPath(null);
    setHookGenFailure(null);
    const prefill = projectWorkingDir ?? initialWorkingDir;
    if (prefill) {
      setField('workspaceKind', 'project');
      setField('workingDir', prefill);
    }
  }, [
    open,
    initialId,
    reset,
    initial,
    initialValues,
    isProjectAutomationMode,
    projectWorkingDir,
    initialWorkingDir,
    setField,
  ]);

  /** 前置检查「AI 生成」:描述 → utility model 生成脚本落盘 → 命令回填输入框。 */
  const runHookGenerate = useCallback(async () => {
    const description = hookGenDesc.trim();
    if (!description || hookGenerating) return;
    const hasSessionTarget = hasRealBinding(form);
    const resolveBoundSessionRoute = needsBoundSessionGenerationRouteResolution(form);
    const inheritsBoundSessionModel = usesBoundSessionGenerationModel(form);
    const providerId = resolveBoundSessionRoute
      ? form.providerId.trim() || undefined
      : resolveScheduleGenerationProviderId({
        providers,
        providerId: form.providerId,
        model: form.model,
        agentKind: form.agentKind,
      });
    if (!resolveBoundSessionRoute && !providerId) {
      toast.warning(t('scheduler.editor.validation.modelUnavailable', { model: form.model }));
      return;
    }
    setHookGenerating(true);
    setHookGenPath(null);
    setHookGenFailure(null);
    try {
      const result = await window.electronAPI.maker.schedule.generatePreRunHook({
        description,
        scheduleName: form.name.trim() || undefined,
        providerId: providerId ?? undefined,
        // bound 任务的缺省模型/来源维度由 main 按绑定会话补齐；provider/model 的显式
        // 覆盖仍原样透传。persistent 任务即使已回写 targetSessionId，也按任务级选择生成。
        agentKind: resolveBoundSessionRoute ? undefined : form.agentKind,
        model: inheritsBoundSessionModel ? undefined : form.model.trim() || undefined,
        // 绑定会话任务:workingDir 不发(表单残留值可能是改绑前的过期项目目录,
        // 显式值会压过会话解析),真实 cwd 由 main 按会话 meta.workDir 解析 ——
        // 落盘目录/自测环境与生产运行一致
        workingDir: hasSessionTarget ? undefined : form.workingDir.trim() || undefined,
        targetSessionId: hasSessionTarget ? form.targetSessionId.trim() : undefined,
        resolveBoundSessionRoute: resolveBoundSessionRoute ? true : undefined,
        currentCommand: form.preRunHookCommand.trim() || undefined,
      });
      if (!result.ok) {
        setHookGenFailure(result);
        return;
      }
      setField('preRunHookCommand', result.command);
      // 落盘即自测(installHookScript):直接回显自测结果,无需用户再点「测试」
      setHookTestResult(result.test);
      setHookGenPath(result.filePath);
      setHookGenOpen(false);
      setHookGenDesc('');
    } catch (err) {
      showHookErrorToast(err);
    } finally {
      setHookGenerating(false);
    }
  }, [
    hookGenDesc,
    hookGenerating,
    providers,
    form.name,
    form.providerId,
    form.effort,
    form.agentKind,
    form.model,
    form.workingDir,
    form.targetSessionId,
    form.persistentSession,
    form.preRunHookCommand,
    form.executionMode,
    setField,
    t,
  ]);

  /** 前置检查「测试运行」:立即执行一次脚本并就地回显 exit code / 输出 / 耗时。 */
  const runHookTest = useCallback(async () => {
    const command = form.preRunHookCommand.trim();
    if (!command || hookTesting) return;
    setHookTesting(true);
    setHookTestResult(null);
    try {
      const result = await window.electronAPI.maker.schedule.testPreRunHook({
        command,
        // 定时触发路径未配置 timeoutMs = 不限时;但交互式测试必须有界,否则
        // 脚本卡死会让 hookTesting 永远不复位、按钮卡死 —— 未配置兜 30s,
        // 显式值也钳到 5min 诊断上限(MCP 可设小时级超时,不能让按钮锁那么久)。
        timeoutMs: Math.min(parsePreRunHookTimeoutMs(form.preRunHookTimeoutSec) ?? 30_000, 300_000),
        // 同 AI 生成:绑定态不发 workingDir(残留值可能过期),交给 main 按会话目录解析
        workingDir: hasRealBinding(form) ? undefined : form.workingDir.trim() || undefined,
        targetSessionId: hasRealBinding(form) ? form.targetSessionId.trim() : undefined,
        scheduleName: form.name.trim() || undefined,
      });
      setHookTestResult(result);
    } catch (err) {
      showHookErrorToast(err);
    } finally {
      setHookTesting(false);
    }
  }, [form.preRunHookCommand, form.preRunHookTimeoutSec, form.workingDir, form.targetSessionId, form.name, hookTesting]);

  const applyTemplateToForm = useCallback((template: ScheduleTemplate) => {
    setSelectedTemplate(template);
    if (template.name) setField('name', template.name);
    if (template.prompt !== undefined) setField('prompt', template.prompt);
    if (template.cronExpr) setField('cronExpr', template.cronExpr);
    if (template.timezone) setField('timezone', template.timezone);
    if (template.recurring !== undefined) {
      setField('recurring', template.recurring);
      setField('manual', false);
    }
    applyTemplateAgentFields(template);
    if (template.useWorktree !== undefined) setField('useWorktree', template.useWorktree);
    // useWorktree 只在 project workspace 且无会话绑定时会被 buildScheduleInput 保留；
    // 模板要求 worktree 时把表单切到 project 模式并清掉绑定会话（绑定与 worktree
    // 互斥，语义同 setDestination('worktree')），否则保存会被静默打回 false，与
    // 卡片上的「隔离工作区」承诺不符（workingDir 为空时 validate 会要求选目录）。
    if (template.useWorktree) {
      setField('workspaceKind', 'project');
      setField('targetSessionId', '');
    }
    if (template.persistentSession !== undefined) setField('persistentSession', template.persistentSession);
    if (template.silentWhenIdle !== undefined) setField('silentWhenIdle', template.silentWhenIdle);
    if (template.notify) {
      setField('notifyDesktop', template.notify.desktop);
      setField('notifyFeishu', template.notify.feishu);
      setField('notifyWecomGroup', template.notify.wecomGroup === true);
    }
    const initParams: Record<string, string> = {};
    for (const parameter of template.parameters ?? []) {
      if (parameter.default !== undefined) initParams[parameter.key] = parameter.default;
    }
    setParamValues(initParams);
    setPromptDirty(false);
    setMode('form');
  }, [setField, applyTemplateAgentFields]);

  // Must run after the open/reset effect above so template fields override fresh defaults.
  useEffect(() => {
    if (!open || !initialTemplate || isEdit || isProjectAutomationMode) return;
    applyTemplateToForm(initialTemplate);
  }, [open, initialTemplate, isEdit, isProjectAutomationMode, applyTemplateToForm]);

  useEffect(() => {
    if (!selectedTemplate || promptDirty) return;
    try {
      setField(
        'prompt',
        applyTemplateParams(selectedTemplate.prompt ?? '', paramValues, selectedTemplate.parameters),
      );
    } catch {
      // Required params are surfaced on submit; while editing, keep the template prompt visible.
    }
  }, [selectedTemplate, paramValues, promptDirty, setField]);

  const feishuBotReady = useFeishuBot().status === 'connected';
  const wecomGroupSettings = useWecomGroupNotificationSettings();
  const wecomGroupReady = wecomGroupSettings.configured && wecomGroupSettings.enabled;
  const navigate = useNavigate();
  const openReferencedSession = useCallback(
    async (sessionId: string) => {
      try {
        const [reference] = await sessionService.resolveReferences([sessionId]);
        if (reference?.state !== 'available') {
          toast.error(t('scheduler.runs.sessionDeleted'));
          return;
        }
        onOpenChange(false);
        navigate(`/cc-agent/${sessionId}`);
      } catch {
        toast.error(t('scheduler.runs.sessionUnavailable'));
      }
    },
    [navigate, onOpenChange, t],
  );
  const goConfigFeishuBot = () => {
    onOpenChange(false);
    // 飞书机器人在「IM 机器人」页的「个人」分栏,缺省 imGroup 会落到默认的 Cindy 栏
    navigate('/settings?tab=im-bot&imGroup=personal');
  };
  const goConfigWecomGroup = () => {
    onOpenChange(false);
    navigate('/settings?tab=im-bot&imGroup=personal');
  };

  const projectOptions = useProjectPickerOptions();

  const currentModel = useMemo(() => {
    const list = caps.capabilities?.availableModels ?? [];
    return form.model ? list.find((m) => m.id === form.model) : undefined;
  }, [caps.capabilities, form.model]);

  const currentModelEfforts = useMemo(() => {
    return resolveScheduleModelEfforts({
      providers,
      providerId: form.providerId,
      model: form.model,
      agentKind: form.agentKind,
      fallbackEfforts: currentModel?.efforts,
    });
  }, [currentModel, form.agentKind, form.model, form.providerId, providers]);

  // form.model 为空时回填默认模型（三级回退,所见即所存）。
  // 覆盖历史遗留的空 model 任务（编辑打开时回填）；若不回填,提交后落库是
  // 空字符串,runner 走自己 hardcode 的兜底 —— 两边一旦漂移就会出现
  // "任务里看着选了 Opus 4.8、实际每次跑 4.7"（2026-06 实际踩坑）。
  // ⚠️ heartbeat 形态(targetSessionId 非空,含 '__pending__')必须跳过:
  // 空 model = "跟随会话"是有效语义,回填会把 MCP 建的跟随任务静默落成
  // 显式模型,下次 fire runner setModel 反向改掉绑定会话的模型。
  useEffect(() => {
    if (form.targetSessionId.trim()) return;
    if (!form.model) setField('model', getScheduleDefaultModel(form.agentKind));
  }, [form.model, form.agentKind, form.targetSessionId, setField]);

  useEffect(() => {
    if (!currentModelEfforts || !form.effort) return;
    const allowed = currentModelEfforts as readonly string[];
    if (!allowed.includes(form.effort)) setField('effort', '');
  }, [currentModelEfforts, form.effort, setField]);

  // Fast 模式门控：agent 级 hasFastMode × 该 (生效来源, 模型) 的 supportsFastMode（per-provider，
  // 唯一真相）。生效来源按 form.providerId 解析（空则该模型的默认来源）。Claude 当前 hasFastMode
  // 虽为 true，但只有模型本身支持 fast 才显示。
  const showFastModeToggle = Boolean(
    caps.capabilities?.hasFastMode &&
      currentModel &&
      sessionModelSupportsFastMode(providers, form.providerId ?? null, currentModel.id, form.agentKind),
  );

  // 切到 Claude / 不支持 fast 的模型时，清掉表单里残留的 fast 态，
  // 杜绝脏值经 toInput 流向 createSession（与上面 effort 失配自动清除同思路）。
  useEffect(() => {
    if (form.fastMode && !showFastModeToggle) setField('fastMode', false);
  }, [form.fastMode, showFastModeToggle, setField]);

  const handleSubmit = async () => {
    const err = validate();
    if (err) {
      toast.warning(t(err.key, err.values));
      return;
    }
    if (!canSubmitSessionBinding(form.executionMode ?? 'agent', runMode, boundSessionReference)) {
      toast.warning(t(
        boundSessionReference?.state === 'available' && boundSessionReference.status === 'archived'
          ? 'scheduler.editor.thread.archivedBinding'
          : boundSessionReference
            ? 'scheduler.editor.thread.deletedBinding'
            : 'scheduler.runs.sessionUnavailable',
      ));
      return;
    }
    if (
      (form.executionMode ?? 'agent') === 'agent'
      && isExplicitScheduleModelUnavailable(
        form.model,
        caps.capabilities?.availableModels,
      )
    ) {
      toast.warning(t('scheduler.editor.validation.modelUnavailable', { model: form.model }));
      return;
    }
    if (isProjectAutomationMode && projectWorkingDir) {
      const id = initial?.projectConfigId ?? generateProjectScheduleId();
      const config = formToProjectConfig(form, id);
      setSubmitting(true);
      try {
        await window.electronAPI.maker.projectAutomation.upsertSchedule({
          workingDir: projectWorkingDir,
          config,
        });
        // 项目自动化保存反馈由 ProjectAutomationNotifyBridge 监听 reconciled 事件统一弹出
        // （文案含项目名 + 增删改数量），此处不要再弹通用 toast，否则保存一次会出现两条提示。
        onOpenChange(false);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      } finally {
        setSubmitting(false);
      }
      return;
    }
    let input = toInput();
    if (selectedTemplate && !promptDirty) {
      try {
        input = {
          ...input,
          prompt: applyTemplateParams(selectedTemplate.prompt ?? '', paramValues, selectedTemplate.parameters),
        };
      } catch (e) {
        toast.warning(e instanceof Error ? e.message : String(e));
        return;
      }
    }
    setSubmitting(true);
    try {
      await onSubmit(input, isEdit);
      if (!isEdit) rememberScheduleFormPrefs(form);
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(v) => !submitting && onOpenChange(v)}>
      <Dialog.Portal>
        <Dialog.Overlay
          className={cn(
            'fixed inset-0 z-[10000]',
            'bg-neutral-900/40 dark:bg-neutral-950/60',
            'data-[state=open]:animate-confirm-overlay-in',
            'data-[state=closed]:animate-confirm-overlay-out',
          )}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        />
        <Dialog.Content
          aria-describedby={undefined}
          onPointerDownOutside={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => submitting && e.preventDefault()}
          className={cn(
            'fixed left-1/2 top-1/2 z-[10000] -translate-x-1/2 -translate-y-1/2',
            'flex max-h-[88vh] w-[760px] flex-col overflow-hidden rounded-xl',
            'border border-[var(--cmd-palette-border)] bg-[var(--cmd-palette-bg)]',
          )}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <header className="flex h-[72px] shrink-0 items-center gap-4 pt-[22px] pr-4 pb-[14px] pl-6">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <Dialog.Title className="text-24 font-normal leading-[1.33] text-[var(--msg-assistant-text)]">
                {isProjectAutomationMode
                  ? isEdit
                    ? t('scheduler.editor.promptDialog.titleProjectEdit')
                    : t('scheduler.editor.promptDialog.titleProjectCreate')
                  : isEdit
                    ? t('scheduler.editor.promptDialog.titleEdit')
                    : t('scheduler.editor.promptDialog.titleCreate')}
              </Dialog.Title>
              <p className="text-sm leading-[1.43] text-[var(--cmd-palette-item-meta)]">
                {requestedByGhostName
                  ? t('scheduler.editor.promptDialog.subtitleFromGhost', {
                      name: requestedByGhostName,
                    })
                  : t('scheduler.editor.promptDialog.subtitle')}
              </p>
            </div>
            {!isEdit && !isProjectAutomationMode && (
              <div className="flex h-[34px] shrink-0 items-center gap-0.5 rounded-full bg-[var(--chat-input-chip-bg)] p-[3px] dark:border dark:border-[var(--cmd-palette-border)] dark:bg-[var(--cmd-palette-bg)]">
                <button
                  type="button"
                  onClick={() => {
                    setSelectedTemplate(null);
                    setParamValues({});
                    setPromptDirty(false);
                    reset(null);
                    setMode('form');
                  }}
                  aria-pressed={!isTemplateMode}
                  className={cn(
                    'h-full rounded-full border px-3 text-12 font-medium transition-colors',
                    !isTemplateMode
                      ? 'border-[var(--confirm-btn-secondary-border)] bg-[var(--cmd-palette-bg)] text-[var(--msg-assistant-text)] dark:border-[var(--confirm-btn-secondary-border)] dark:bg-[var(--chat-input-chip-bg)]'
                      : 'border-transparent bg-transparent text-[var(--cmd-palette-item-meta)] hover:text-[var(--msg-assistant-text)] dark:text-[var(--settings-section-desc)] dark:hover:text-[var(--msg-assistant-text)]',
                  )}
                >
                  {t('scheduler.template.blank')}
                </button>
                <button
                  type="button"
                  onClick={() => setMode('gallery')}
                  aria-pressed={isTemplateMode}
                  className={cn(
                    'h-full rounded-full border px-3 text-12 font-medium transition-colors',
                    isTemplateMode
                      ? 'border-[var(--confirm-btn-secondary-border)] bg-[var(--cmd-palette-bg)] text-[var(--msg-assistant-text)] dark:border-[var(--confirm-btn-secondary-border)] dark:bg-[var(--chat-input-chip-bg)]'
                      : 'border-transparent bg-transparent text-[var(--cmd-palette-item-meta)] hover:text-[var(--msg-assistant-text)] dark:text-[var(--settings-section-desc)] dark:hover:text-[var(--msg-assistant-text)]',
                  )}
                >
                  {t('scheduler.template.useTemplate')}
                </button>
              </div>
            )}
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              aria-label={t('scheduler.button.close')}
              disabled={submitting}
              className={cn(
                'flex h-8 w-8 shrink-0 items-center justify-center rounded-full',
                'text-[var(--cmd-palette-item-meta)] transition-colors dark:text-[var(--settings-section-desc)] hover:bg-[var(--confirm-btn-secondary-hover)] dark:hover:bg-[var(--confirm-btn-secondary-hover)]',
                'disabled:opacity-50',
              )}
            >
              <X size={16} />
            </button>
          </header>

          {!isEdit && !isProjectAutomationMode && mode === 'gallery' ? (
            // 固定高度对齐表单模式"默认(未勾前置检查)"的常态内容高,空白/模板两个 tab 来回切不跳变。
            // 546 = pt18 + 名称块68(label16+gap8+input44) + gap18 + 计划行34 + gap18 + 运行会话行34
            //     + gap18 + 前置检查行34 + gap18 + 提示词块264(label16+gap8+编辑框240) + pb22。
            // 表单新增/删除常驻区块时需同步更新此值;前置检查勾选等临时展开态与画廊的高度差属预期。
            <div className="h-[546px] min-h-0 overflow-y-auto px-6 pt-[18px] pb-[22px]">
              <TemplateGallery onSelect={applyTemplateToForm} selectedId={selectedTemplate?.id} />
            </div>
          ) : (
          // overflow-y-auto:内容超过弹窗 max-h 时整体滚动;
          // 提示词编辑框是固定高度,不会被可展开区块挤压。
          <div className="flex min-h-0 flex-1 flex-col gap-[18px] overflow-y-auto pt-[18px] pr-6 pb-[22px] pl-6">
            <div className="flex flex-col gap-2">
              <label className="text-xs leading-[1.33] text-[var(--cmd-palette-item-meta)] dark:text-[var(--settings-section-desc)]">{t('scheduler.editor.fields.title')}</label>
              <div className="flex h-11 items-center rounded-full border border-[var(--settings-input-border)] bg-[var(--settings-input-bg)] px-4">
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setField('name', e.target.value)}
                  placeholder={t('scheduler.editor.promptDialog.namePlaceholder')}
                  className={cn(
                    'w-full bg-transparent text-sm font-normal outline-none',
                    'text-[var(--settings-input-text)] placeholder-[var(--settings-input-placeholder)]',
                    'select-text',
                  )}
                />
              </div>
            </div>

            {selectedTemplate?.parameters && selectedTemplate.parameters.length > 0 && (
              <TemplateParamForm
                parameters={selectedTemplate.parameters}
                values={paramValues}
                onChange={setParamValues}
              />
            )}


            {/* 项目自动化(.cindy/automations/schedules.json)的 config schema 尚无
                executionMode/scriptConfig 字段,展示切换器会让 script 配置被静默丢弃
                ——该形态下隐藏,项目自动化对 script 模式的支持另行迭代。 */}
            {!isProjectAutomationMode && (
            <div className="flex items-center gap-2.5">
              <span className="text-xs leading-[1.33] text-[var(--cmd-palette-item-meta)] dark:text-[var(--settings-section-desc)]">
                {t('scheduler.editor.executionMode.label')}
              </span>
              <div className="flex h-[34px] shrink-0 items-center gap-0.5 rounded-full bg-[var(--chat-input-chip-bg)] p-[3px] dark:border dark:border-[var(--cmd-palette-border)] dark:bg-[var(--cmd-palette-bg)]">
                {(['agent', 'script'] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    aria-pressed={(form.executionMode ?? 'agent') === mode}
                    onClick={() => setField('executionMode', mode)}
                    className={cn(
                      'h-full rounded-full border px-3 text-12 font-medium transition-colors',
                      (form.executionMode ?? 'agent') === mode
                        ? 'border-[var(--confirm-btn-secondary-border)] bg-[var(--cmd-palette-bg)] text-[var(--msg-assistant-text)]'
                        : 'border-transparent bg-transparent text-[var(--cmd-palette-item-meta)] hover:text-[var(--msg-assistant-text)]',
                    )}
                  >
                    {t(`scheduler.editor.executionMode.${mode}`)}
                  </button>
                ))}
              </div>
            </div>
            )}

            {isScriptMode && (
              <div className="flex flex-col gap-3 rounded-xl border border-[var(--settings-input-border)] bg-[var(--settings-input-bg)] p-4">
                <div className="flex gap-2 rounded-xl border border-[var(--settings-input-border)] bg-[var(--cmd-palette-bg)] p-3">
                  <Info className="mt-0.5 h-4 w-4 shrink-0 text-[var(--cmd-palette-item-meta)]" aria-hidden="true" />
                  <div className="min-w-0 text-xs leading-[1.5] text-[var(--cmd-palette-item-meta)] dark:text-[var(--settings-section-desc)]">
                    <p>{t('scheduler.editor.script.protocolSummary')}</p>
                    <p className="mt-1">{t('scheduler.editor.script.protocolCapabilities')}</p>
                    <details className="mt-2">
                      <summary className="w-fit cursor-pointer select-none text-[var(--settings-btn-secondary-text)] hover:text-[var(--msg-assistant-text)]">
                        {t('scheduler.editor.script.protocolExample')}
                      </summary>
                      <pre className="mt-2 overflow-x-auto rounded-xl border border-[var(--settings-input-border)] bg-[var(--settings-input-bg)] p-3 font-mono text-11 leading-[1.5] text-[var(--settings-input-text)]">
                        <code>{SCRIPT_PROTOCOL_PYTHON_EXAMPLE}</code>
                      </pre>
                    </details>
                  </div>
                </div>
                <label className="text-xs text-[var(--cmd-palette-item-meta)] dark:text-[var(--settings-section-desc)]">
                  {t('scheduler.editor.script.command')}
                </label>
                <input
                  type="text"
                  value={form.scriptCommand ?? ''}
                  onChange={(e) => setField('scriptCommand', e.target.value)}
                  placeholder={t('scheduler.editor.script.commandPlaceholder')}
                  className="h-10 rounded-full border border-[var(--settings-input-border)] bg-transparent px-4 text-sm text-[var(--settings-input-text)] outline-none"
                />
                <div className="flex items-center gap-2">
                  <span className="text-xs text-[var(--cmd-palette-item-meta)] dark:text-[var(--settings-section-desc)]">
                    {t('scheduler.editor.script.project')}
                  </span>
                  <ProjectChip
                    value={form.workingDir}
                    workspaceKind="project"
                    onChange={(value) => setField('workingDir', value)}
                    onChangeWorkspaceKind={() => undefined}
                    projectOptions={projectOptions}
                    disabled={isProjectAutomationMode}
                    onChangeDestination={() => undefined}
                  />
                </div>
                <label className="text-xs text-[var(--cmd-palette-item-meta)] dark:text-[var(--settings-section-desc)]">
                  {t('scheduler.editor.script.timeout')}
                </label>
                <input
                  type="number"
                  min="1"
                  value={form.scriptTimeoutSec ?? ''}
                  onChange={(e) => setField('scriptTimeoutSec', e.target.value)}
                  placeholder={t('scheduler.editor.script.timeoutPlaceholder')}
                  className="h-10 rounded-full border border-[var(--settings-input-border)] bg-transparent px-4 text-sm text-[var(--settings-input-text)] outline-none"
                />
                <label className="text-xs text-[var(--cmd-palette-item-meta)] dark:text-[var(--settings-section-desc)]">
                  {t('scheduler.editor.script.capabilitiesLabel')}
                </label>
                <ScriptCapabilityMultiSelect
                  value={form.scriptCapabilities ?? []}
                  onChange={(next) => setField('scriptCapabilities', next)}
                />
              </div>
            )}

            <div className="flex items-center gap-2.5">
              <span className="text-xs leading-[1.33] text-[var(--cmd-palette-item-meta)] dark:text-[var(--settings-section-desc)]">{t('scheduler.editor.fields.schedule')}</span>
              {/* 自动/手动 pill：把原先"勾一次才出现 Manually"的隐藏路径显式化。
                  自动 → manual=false,显示 cron chip + Once;手动 → manual=true,cron 保留占位值不参与调度。 */}
              <div className="flex h-[34px] shrink-0 items-center gap-0.5 rounded-full bg-[var(--chat-input-chip-bg)] p-[3px] dark:border dark:border-[var(--cmd-palette-border)] dark:bg-[var(--cmd-palette-bg)]">
                {(['automatic', 'manually'] as const).map((m) => {
                  const isManual = m === 'manually';
                  const active = form.manual === isManual;
                  return (
                    <button
                      key={m}
                      type="button"
                      onClick={() => {
                        if (active) return;
                        setField('manual', isManual);
                        // Manual: no cron requeue. Auto: restore default recurring=true.
                        setField('recurring', !isManual);
                      }}
                      aria-pressed={active}
                      className={cn(
                        'h-full rounded-full border px-3 text-12 font-medium transition-colors',
                        active
                          ? 'border-[var(--confirm-btn-secondary-border)] bg-[var(--cmd-palette-bg)] text-[var(--msg-assistant-text)] dark:border-[var(--confirm-btn-secondary-border)] dark:bg-[var(--chat-input-chip-bg)]'
                          : 'border-transparent bg-transparent text-[var(--cmd-palette-item-meta)] hover:text-[var(--msg-assistant-text)] dark:text-[var(--settings-section-desc)] dark:hover:text-[var(--msg-assistant-text)]',
                      )}
                    >
                      {t(`scheduler.editor.fields.${m}`)}
                    </button>
                  );
                })}
              </div>
              {/* 自动模式:cron chip + 一次(recurring 反向)。手动模式:两者全部隐藏——cron 占位值仍在 form 里,提交合法。 */}
              {!form.manual && (
                <>
                  <ScheduleChip
                    cronExpr={form.cronExpr}
                    intervalMs={form.intervalMs}
                    onChangeSchedule={(value) => {
                      setField('cronExpr', value.cronExpr);
                      setField('intervalMs', value.intervalMs);
                    }}
                  />
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={!form.recurring}
                    onClick={() => setField('recurring', !form.recurring)}
                    className={cn(
                      'inline-flex h-[34px] items-center gap-2 rounded-md px-1.5',
                      'text-13 leading-none text-[var(--settings-btn-secondary-text)]',
                      'transition-colors hover:bg-[var(--surface-hover)]',
                      'focus:outline-none',
                    )}
                  >
                    <span
                      className={cn(
                        'inline-flex h-[14px] w-[14px] shrink-0 items-center justify-center rounded-[3px] border-[1.5px] transition-colors',
                        !form.recurring
                          ? 'border-[var(--lightbox-cta-bg)] bg-[var(--lightbox-cta-bg)] text-[var(--lightbox-cta-fg)]'
                          : 'border-[var(--cmd-palette-item-meta)] bg-transparent dark:border-[var(--settings-section-desc)]',
                      )}
                      aria-hidden
                    >
                      {!form.recurring && (
                        <svg
                          viewBox="0 0 16 16"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth={2.5}
                          className="h-[10px] w-[10px]"
                        >
                          <path d="M3 8l3.5 3.5L13 5" />
                        </svg>
                      )}
                    </span>
                    {t('scheduler.editor.fields.once')}
                  </button>
                </>
              )}
            </div>

            {!isScriptMode && (
            <div className="flex flex-col gap-2.5">
            <div className="flex flex-wrap items-center gap-2.5">
              {/* "运行会话"三态:合并了旧 persistentSession 开关与手绑会话两个概念。
                  fresh = 每次新建;persistent = 持续会话(首次 fire 创建后续绑,归档自动重建);
                  bound = 绑定已有会话(picker 选,会话不可用时任务自动 pause)。
                  project 自动化模式只显 fresh/persistent —— schedules.json 没有
                  targetSessionId 通道,bound 在该模式无法落库。 */}
              <span className="text-13 leading-none text-[var(--settings-btn-secondary-text)]">
                {t('scheduler.editor.runSession.label')}
              </span>
              <div className="flex h-[34px] shrink-0 items-center gap-0.5 rounded-full bg-[var(--chat-input-chip-bg)] p-[3px] dark:border dark:border-[var(--cmd-palette-border)] dark:bg-[var(--cmd-palette-bg)]">
                {(['fresh', 'persistent', ...(isProjectAutomationMode ? [] : ['bound' as const])] as RunMode[]).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setRunMode(m)}
                    aria-pressed={runMode === m}
                    className={cn(
                      'h-full rounded-full border px-3 text-12 font-medium transition-colors',
                      runMode === m
                        ? 'border-[var(--confirm-btn-secondary-border)] bg-[var(--cmd-palette-bg)] text-[var(--msg-assistant-text)] dark:border-[var(--confirm-btn-secondary-border)] dark:bg-[var(--chat-input-chip-bg)]'
                        : 'border-transparent bg-transparent text-[var(--cmd-palette-item-meta)] hover:text-[var(--msg-assistant-text)] dark:text-[var(--settings-section-desc)] dark:hover:text-[var(--msg-assistant-text)]',
                    )}
                  >
                    {t(`scheduler.editor.runSession.${m}`)}
                  </button>
                ))}
              </div>
              <div className="inline-flex h-[34px] items-center gap-1.5">
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={form.silentWhenIdle}
                  onClick={() => setField('silentWhenIdle', !form.silentWhenIdle)}
                  className={cn(
                    'inline-flex h-full items-center gap-2 rounded-md px-1.5',
                    'text-13 leading-none text-[var(--settings-btn-secondary-text)]',
                    'transition-colors hover:bg-[var(--surface-hover)]',
                    'focus:outline-none',
                  )}
                >
                  <span
                    className={cn(
                      'inline-flex h-[14px] w-[14px] shrink-0 items-center justify-center rounded-[3px] border-[1.5px] transition-colors',
                      form.silentWhenIdle
                        ? 'border-[var(--lightbox-cta-bg)] bg-[var(--lightbox-cta-bg)] text-[var(--lightbox-cta-fg)]'
                        : 'border-[var(--cmd-palette-item-meta)] bg-transparent dark:border-[var(--settings-section-desc)]',
                    )}
                    aria-hidden
                  >
                    {form.silentWhenIdle && (
                      <Check size={10} strokeWidth={3} aria-hidden />
                    )}
                  </span>
                  {t('scheduler.editor.fields.silentRun')}
                </button>
                <Tip
                  text={t('scheduler.editor.fields.silentRunTooltip')}
                  side="top"
                  contentClassName="z-[10020]"
                >
                  <span
                    tabIndex={0}
                    className={cn(
                      'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full',
                      'text-[var(--cmd-palette-item-meta)] outline-none transition-colors',
                      'hover:bg-[var(--surface-hover)] hover:text-[var(--msg-assistant-text)]',
                      'focus:bg-[var(--surface-hover)] focus:text-[var(--msg-assistant-text)]',
                    )}
                    aria-label={t('scheduler.editor.fields.silentRunInfoAria')}
                  >
                    <Info size={13} />
                  </span>
                </Tip>
              </div>
              {feishuBotReady ? (
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={form.notifyFeishu}
                  onClick={() => setField('notifyFeishu', !form.notifyFeishu)}
                  className={cn(
                    'inline-flex h-[34px] items-center gap-2 rounded-md px-1.5',
                    'text-13 leading-none text-[var(--settings-btn-secondary-text)]',
                    'transition-colors hover:bg-[var(--surface-hover)]',
                    'focus:outline-none',
                  )}
                >
                  <span
                    className={cn(
                      'inline-flex h-[14px] w-[14px] shrink-0 items-center justify-center rounded-[3px] border-[1.5px] transition-colors',
                      form.notifyFeishu
                        ? 'border-[var(--lightbox-cta-bg)] bg-[var(--lightbox-cta-bg)] text-[var(--lightbox-cta-fg)]'
                        : 'border-[var(--cmd-palette-item-meta)] bg-transparent dark:border-[var(--settings-section-desc)]',
                    )}
                    aria-hidden
                  >
                    {form.notifyFeishu && (
                      <svg
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={2.5}
                        className="h-[10px] w-[10px]"
                      >
                        <path d="M3 8l3.5 3.5L13 5" />
                      </svg>
                    )}
                  </span>
                  {t('scheduler.editor.fields.finishSendToFeishu')}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={goConfigFeishuBot}
                  className={cn(
                    'inline-flex h-[34px] items-center rounded-md px-2',
                    'text-13 leading-none text-[var(--settings-btn-secondary-text)]',
                    'transition-colors hover:bg-[var(--surface-hover)]',
                    'focus:outline-none underline-offset-2 hover:underline',
                  )}
                >
                  {t('scheduler.editor.fields.configFeishu')}
                </button>
              )}
              {wecomGroupReady ? (
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={form.notifyWecomGroup === true}
                  onClick={() => setField('notifyWecomGroup', form.notifyWecomGroup !== true)}
                  className={cn(
                    'inline-flex h-[34px] items-center gap-2 rounded-md px-1.5',
                    'text-13 leading-none text-[var(--settings-btn-secondary-text)]',
                    'transition-colors hover:bg-[var(--surface-hover)] focus:outline-none',
                  )}
                >
                  <span
                    className={cn(
                      'inline-flex h-[14px] w-[14px] shrink-0 items-center justify-center rounded-[3px] border-[1.5px] transition-colors',
                      form.notifyWecomGroup
                        ? 'border-[var(--lightbox-cta-bg)] bg-[var(--lightbox-cta-bg)] text-[var(--lightbox-cta-fg)]'
                        : 'border-[var(--cmd-palette-item-meta)] bg-transparent dark:border-[var(--settings-section-desc)]',
                    )}
                    aria-hidden
                  >
                    {form.notifyWecomGroup && <Check size={10} strokeWidth={3} aria-hidden />}
                  </span>
                  {t('scheduler.editor.fields.finishSendToWecomGroup')}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={goConfigWecomGroup}
                  className={cn(
                    'inline-flex h-[34px] items-center rounded-md px-2',
                    'text-13 leading-none text-[var(--settings-btn-secondary-text)]',
                    'transition-colors hover:bg-[var(--surface-hover)]',
                    'focus:outline-none underline-offset-2 hover:underline',
                  )}
                >
                  {t('scheduler.editor.fields.configWecomGroup')}
                </button>
              )}
            </div>
            {/* bound 态:单行会话选择器(换选即换绑,选择器旁带"打开会话")。
                不再叠加绑定卡片 —— 标题在 select 里已可见,单独的"解除绑定"
                也多余(换选 / 切三态即可,且切换非破坏性)。 */}
            {runMode === 'bound' && (
              <ThreadPickerInline
                value={form.targetSessionId}
                onSelect={selectBoundSession}
                onOpen={(id) => void openReferencedSession(id)}
                reference={boundSessionReference}
              />
            )}
            {/* persistent 已绑(runner 回写):无选择器,用卡片展示绑定信息。
                project 模式不传 onUnbind —— schedules.json 无 targetSessionId
                通道,解绑保存无法落库,按钮只会制造静默失败。 */}
            {runMode === 'persistent' && isBound && (
              <BoundSessionCard
                sessionId={form.targetSessionId}
                onUnbind={isProjectAutomationMode ? undefined : () => setRunMode('fresh')}
                onOpen={() => void openReferencedSession(form.targetSessionId)}
                reference={boundSessionReference}
              />
            )}
            </div>
            )}

            {/* 前置检查(Pre-run Hook):触发时先执行脚本,exit 0 放行 / exit 2 跳过本轮
                (不启动 agent、零 token);报错 / 超时会阻止本轮并记录失败。
                仅 agent 模式展示——script 模式任务本体就是脚本,再叠一层脚本闸门是套娃。 */}
            {!isScriptMode && (
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2.5">
                <span className="text-13 leading-none text-[var(--settings-btn-secondary-text)]">
                  {t('scheduler.editor.preRunHook.label')}
                </span>
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={form.preRunHookEnabled}
                  onClick={() => {
                    setHookTestResult(null);
                    setField('preRunHookEnabled', !form.preRunHookEnabled);
                  }}
                  className={cn(
                    'inline-flex h-[34px] items-center gap-2 rounded-md px-1.5',
                    'text-13 leading-none text-[var(--settings-btn-secondary-text)]',
                    'transition-colors hover:bg-[var(--surface-hover)]',
                    'focus:outline-none',
                  )}
                >
                  <span
                    className={cn(
                      'inline-flex h-[14px] w-[14px] shrink-0 items-center justify-center rounded-[3px] border-[1.5px] transition-colors',
                      form.preRunHookEnabled
                        ? 'border-[var(--lightbox-cta-bg)] bg-[var(--lightbox-cta-bg)] text-[var(--lightbox-cta-fg)]'
                        : 'border-[var(--cmd-palette-item-meta)] bg-transparent dark:border-[var(--settings-section-desc)]',
                    )}
                    aria-hidden
                  >
                    {form.preRunHookEnabled && <Check size={10} strokeWidth={3} aria-hidden />}
                  </span>
                  {t('scheduler.editor.preRunHook.enable')}
                </button>
                <Tip
                  text={t('scheduler.editor.preRunHook.tooltip')}
                  side="top"
                  contentClassName="z-[10020]"
                >
                  <span
                    tabIndex={0}
                    className={cn(
                      'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full',
                      'text-[var(--cmd-palette-item-meta)] outline-none transition-colors',
                      'hover:bg-[var(--surface-hover)] hover:text-[var(--msg-assistant-text)]',
                      'focus:bg-[var(--surface-hover)] focus:text-[var(--msg-assistant-text)]',
                    )}
                    aria-label={t('scheduler.editor.preRunHook.infoAria')}
                  >
                    <Info size={13} />
                  </span>
                </Tip>
                {form.preRunHookEnabled && (
                  <span className="text-xs leading-none text-[var(--cmd-palette-item-meta)] dark:text-[var(--settings-section-desc)]">
                    {t('scheduler.editor.preRunHook.protocol')}
                  </span>
                )}
              </div>
              {form.preRunHookEnabled && (
                <>
                  <div className="flex items-center gap-2">
                    <input
                      value={form.preRunHookCommand}
                      onChange={(e) => {
                        setHookTestResult(null);
                        // 手动改写命令后"脚本已生成:<path>"标签不再对应当前命令,一并清掉
                        setHookGenPath(null);
                        setField('preRunHookCommand', e.target.value);
                      }}
                      onDragOver={(e) => {
                        e.preventDefault();
                        setHookDragOver(true);
                      }}
                      onDragLeave={() => setHookDragOver(false)}
                      onDrop={(e) => {
                        e.preventDefault();
                        setHookDragOver(false);
                        const file = e.dataTransfer.files[0];
                        if (!file) return;
                        try {
                          applyHookScriptFile(window.electronAPI.getFilePath(file));
                        } catch (err) {
                          showHookErrorToast(err);
                        }
                      }}
                      placeholder={t('scheduler.editor.preRunHook.commandPlaceholder')}
                      spellCheck={false}
                      className={cn(
                        'h-[38px] min-w-0 flex-1 rounded-xl border bg-[var(--settings-input-bg)] px-3.5',
                        'font-mono text-xs text-[var(--settings-input-text)] placeholder-[var(--settings-input-placeholder)]',
                        'outline-none transition-colors focus:border-[var(--confirm-btn-secondary-border)]',
                        hookDragOver
                          ? 'border-[var(--confirm-btn-secondary-border)] bg-[var(--chat-input-chip-bg)]'
                          : 'border-[var(--settings-input-border)]',
                      )}
                    />
                    <button
                      type="button"
                      onClick={() => void browseHookScript()}
                      title={t('scheduler.editor.preRunHook.browse')}
                      aria-label={t('scheduler.editor.preRunHook.browse')}
                      className={cn(
                        'inline-flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-full border border-[var(--settings-input-border)]',
                        'text-[var(--settings-btn-secondary-text)] transition-colors',
                        'hover:bg-[var(--surface-hover)] focus:outline-none',
                      )}
                    >
                      <FolderOpen size={14} aria-hidden />
                    </button>
                    {/* 超时刻意不做进 UI(规则 20:高级细节):数据层仍支持 timeoutMs
                        (MCP / agent 可设),未设 = 不限时(无默认超时);
                        表单状态里隐形往返,编辑不丢 MCP 设过的值。 */}
                    <button
                      type="button"
                      onClick={() => {
                        setHookGenOpen((v) => !v);
                        setHookGenPath(null);
                        setHookGenFailure(null);
                      }}
                      aria-expanded={hookGenOpen}
                      className={cn(
                        'inline-flex h-[38px] shrink-0 items-center gap-1.5 rounded-full border px-3.5',
                        'text-12 font-medium transition-colors focus:outline-none',
                        hookGenOpen
                          ? 'border-[var(--confirm-btn-secondary-border)] bg-[var(--chat-input-chip-bg)] text-[var(--msg-assistant-text)]'
                          : 'border-[var(--settings-input-border)] text-[var(--settings-btn-secondary-text)] hover:bg-[var(--surface-hover)]',
                      )}
                    >
                      <Sparkles size={12} aria-hidden />
                      {form.preRunHookCommand.trim()
                        ? t('scheduler.editor.preRunHook.aiModify')
                        : t('scheduler.editor.preRunHook.aiCreate')}
                    </button>
                    <button
                      type="button"
                      onClick={() => void runHookTest()}
                      disabled={hookTesting || !form.preRunHookCommand.trim()}
                      className={cn(
                        'inline-flex h-[38px] shrink-0 items-center gap-1.5 rounded-full border border-[var(--settings-input-border)] px-3.5',
                        'text-12 font-medium text-[var(--settings-btn-secondary-text)] transition-colors',
                        'hover:bg-[var(--surface-hover)] focus:outline-none',
                        'disabled:cursor-not-allowed disabled:opacity-50',
                      )}
                    >
                      <Play size={12} aria-hidden />
                      {hookTesting
                        ? t('scheduler.editor.preRunHook.testing')
                        : t('scheduler.editor.preRunHook.test')}
                    </button>
                  </div>
                  {/* AI 生成内联面板:描述想要的检查条件 → 生成脚本落盘 → 命令回填 */}
                  {hookGenOpen && (
                    <div className="flex flex-col gap-2 rounded-xl border border-[var(--settings-input-border)] bg-[var(--settings-input-bg)] p-3">
                      <textarea
                        value={hookGenDesc}
                        onChange={(e) => setHookGenDesc(e.target.value)}
                        placeholder={t('scheduler.editor.preRunHook.aiPlaceholder')}
                        rows={2}
                        autoFocus
                        className={cn(
                          'w-full resize-none bg-transparent text-13 leading-[1.5] outline-none',
                          'text-[var(--settings-input-text)] placeholder-[var(--settings-input-placeholder)]',
                        )}
                      />
                      {hookGenFailure && (
                        <div
                          role="alert"
                          className="rounded-lg border border-[var(--error-border)] bg-[var(--error-bg)] px-3 py-2.5"
                        >
                          <p className="text-12 leading-[1.45] text-[var(--error-fg-strong)]">
                            {t(`scheduler.editor.preRunHook.aiFailure.${hookGenFailure.reason}`)}
                          </p>
                          {hookGenFailure.attempts.length > 0 && (
                            <div className="mt-2">
                              <p className="text-11 text-[var(--error-fg)]">
                                {t('scheduler.editor.preRunHook.aiFailure.checkedCandidates')}
                              </p>
                              <ul className="mt-1 space-y-0.5 text-11 leading-[1.4] text-[var(--error-fg)]">
                                {hookGenFailure.attempts.map((attempt, index) => (
                                  <li key={`${attempt.providerId}:${attempt.model}:${index}`}>
                                    <span className="font-mono">
                                      {attempt.providerId} · {attempt.model}
                                    </span>
                                    {' — '}
                                    {t(
                                      `scheduler.editor.preRunHook.aiFailure.attemptReason.${UTILITY_ATTEMPT_REASON_KEY[attempt.reason]}`,
                                      attempt.reason === 'http_error'
                                        ? { status: attempt.httpStatus ?? '?' }
                                        : undefined,
                                    )}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}
                          <button
                            type="button"
                            onClick={() => {
                              onOpenChange(false);
                              navigate('/settings?tab=providers');
                            }}
                            className={cn(
                              'mt-2 inline-flex h-7 select-none items-center rounded-full border px-3 text-11 font-medium',
                              'border-[var(--settings-btn-secondary-border)] bg-[var(--settings-btn-secondary-bg)]',
                              'text-[var(--settings-btn-secondary-text)] transition-colors hover:bg-[var(--settings-btn-secondary-hover-bg)]',
                            )}
                          >
                            {t('scheduler.editor.preRunHook.aiFailure.openProviders')}
                          </button>
                        </div>
                      )}
                      <div className="flex items-center justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            setHookGenOpen(false);
                            setHookGenDesc('');
                            setHookGenFailure(null);
                          }}
                          disabled={hookGenerating}
                          className={cn(
                            'inline-flex h-8 items-center rounded-full px-3 text-12',
                            'text-[var(--cmd-palette-item-meta)] transition-colors',
                            'hover:bg-[var(--surface-hover)] hover:text-[var(--msg-assistant-text)]',
                            'focus:outline-none disabled:opacity-50',
                          )}
                        >
                          {t('scheduler.editor.preRunHook.aiCancel')}
                        </button>
                        <button
                          type="button"
                          onClick={() => void runHookGenerate()}
                          disabled={hookGenerating || !hookGenDesc.trim()}
                          className={cn(
                            'inline-flex h-8 items-center gap-1.5 rounded-full px-4 text-12 font-medium',
                            'bg-[var(--lightbox-cta-bg)] text-[var(--lightbox-cta-fg)] transition-opacity',
                            'focus:outline-none disabled:cursor-not-allowed disabled:opacity-50',
                          )}
                        >
                          {hookGenerating && (
                            <span
                              aria-hidden
                              className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-current"
                            />
                          )}
                          {hookGenerating
                            ? t('scheduler.editor.preRunHook.aiGenerating')
                            : t('scheduler.editor.preRunHook.aiGenerate')}
                        </button>
                      </div>
                    </div>
                  )}
                  {hookGenPath && (
                    <span className="truncate font-mono text-11 text-[var(--cmd-palette-item-meta)]">
                      {t('scheduler.editor.preRunHook.aiDone', { path: hookGenPath })}
                    </span>
                  )}
                  {hookTestResult && (
                    <div className="flex flex-wrap items-center gap-2 rounded-lg bg-[var(--chat-input-chip-bg)] px-3 py-2 dark:bg-[var(--cmd-palette-bg)]">
                      <span className="text-xs text-[var(--settings-btn-secondary-text)]">
                        {hookTestResult.status === 'timed_out'
                          ? t('scheduler.editor.preRunHook.resultTimeout')
                          : hookTestResult.status === 'skipped'
                            ? t('scheduler.editor.preRunHook.resultSkip', {
                                ms: hookTestResult.durationMs,
                              })
                            : hookTestResult.status === 'passed'
                              ? t('scheduler.editor.preRunHook.resultRun', {
                                  code: hookTestResult.exitCode ?? 0,
                                  ms: hookTestResult.durationMs,
                                })
                              : t('scheduler.editor.preRunHook.resultError', {
                                  error:
                                    hookTestResult.error ??
                                    `exit ${hookTestResult.exitCode ?? '?'}`,
                                })}
                      </span>
                      {(hookTestResult.stdout.trim() || hookTestResult.stderr.trim()) && (
                        <span className="min-w-0 flex-1 truncate font-mono text-11 text-[var(--cmd-palette-item-meta)]">
                          {(hookTestResult.stdout.trim() || hookTestResult.stderr.trim()).split('\n')[0]}
                        </span>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
            )}

            {/* script 模式的提交行:agent 模式的提交按钮长在下方 prompt footer 里,
                script 模式不渲染 prompt 区块,需要独立的提交入口。 */}
            {isScriptMode && (
              <div className="flex shrink-0 justify-end">
                <button
                  type="button"
                  aria-label={isEdit ? t('scheduler.editor.promptDialog.saveAria') : t('scheduler.editor.promptDialog.createAria')}
                  onClick={() => void handleSubmit()}
                  disabled={submitting}
                  className={cn(
                    'flex h-[34px] min-w-[68px] shrink-0 items-center justify-center rounded-full px-4',
                    'text-sm font-medium leading-none',
                    'bg-[var(--chat-input-chip-bg)] text-[var(--msg-assistant-text)] transition-colors hover:bg-[var(--settings-btn-secondary-hover-bg)]',
                    'disabled:opacity-50',
                  )}
                >
                  {submitLabel}
                </button>
              </div>
            )}

            {/* 提示词编辑框固定高度(内容超出在 textarea 内滚动),不随其它区块展开被挤压;
                弹窗整体高度随内容自适应,超过 max-h 时由 body 滚动承接 */}
            {!isScriptMode && (
            <div className="flex shrink-0 flex-col gap-2">
              <div className="flex items-center gap-2">
                <span className="text-xs leading-[1.33] text-[var(--cmd-palette-item-meta)] dark:text-[var(--settings-section-desc)]">{t('scheduler.editor.fields.prompt')}</span>
              </div>
              <div className="flex h-[240px] flex-col overflow-hidden rounded-xl border border-[var(--settings-input-border)] bg-[var(--settings-input-bg)]">
                <div className="min-h-0 flex-1 p-4">
                  <textarea
                    value={form.prompt}
                    onChange={(e) => {
                      if (selectedTemplate) setPromptDirty(true);
                      setField('prompt', e.target.value);
                    }}
                    placeholder={t('scheduler.editor.promptDialog.promptPlaceholder')}
                    className={cn(
                      'h-full w-full resize-none overflow-y-auto bg-transparent text-sm leading-[1.43] outline-none',
                      'text-[var(--settings-input-text)] placeholder-[var(--settings-input-placeholder)]',
                      'select-text',
                    )}
                  />
                </div>
                <div className="flex h-[52px] shrink-0 items-center gap-0 border-t border-[var(--settings-input-border)] px-2.5 py-2">
                  <div className="flex min-w-0 flex-1 items-center gap-0">
                    {/* heartbeat 形态(hideWorkspaceFields)下目录 / worktree / fastMode
                        由绑定会话决定,runner 忽略 schedule 上的值 —— 直接隐藏,不渲染
                        一排改了也无效的控件。B 态未绑定时仍显示(首次 fire 要用)。 */}
                    {!hideWorkspaceFields && (
                      <ProjectChip
                        value={form.workingDir}
                        workspaceKind={form.workspaceKind}
                        onChange={(v) => setField('workingDir', v)}
                        onChangeWorkspaceKind={(v) => {
                          setField('workspaceKind', v);
                          if (v === 'dialogue') setField('useWorktree', false);
                        }}
                        projectOptions={projectOptions}
                        disabled={isProjectAutomationMode}
                        onChangeDestination={setDestination}
                      />
                    )}
                    {!hideWorkspaceFields && form.workspaceKind === 'project' && (
                      <>
                        <div className="w-0.5 shrink-0" aria-hidden />
                        <ScheduleSettingsButton
                          cwd={form.workingDir || null}
                          enabled={form.useWorktree}
                          onEnabledChange={(v) => setField('useWorktree', v)}
                        />
                      </>
                    )}
                    <div className="min-w-0 flex-1" />
                    {/* 有真实绑定时 agentKind 跟随绑定会话,切换只会造成 resume 错配 → 禁用 */}
                    <AgentTabs
                      value={form.agentKind}
                      disabled={isBound}
                      onChange={(v) => {
                        const prefs = getScheduleAgentPrefs(v);
                        setField('agentKind', v);
                        // model 走三级回退（含 prefs.model）,保证切 agent 后也是显式值
                        setField('model', getScheduleDefaultModel(v));
                        // providerId 沿用该 agent 的任务记忆;新 agent 未连同一来源时
                        // ModelSelectorContent 会回落到其原生默认(activeSourceId),不会错路由。
                        setField('providerId', prefs.providerId);
                        setField('effort', prefs.effort);
                        setField('fastMode', prefs.fastMode);
                      }}
                    />
                    <ModelEffortChip
                      agentKind={form.agentKind}
                      modelValue={form.model}
                      onChangeModel={(v) => setField('model', v)}
                      effortValue={form.effort}
                      onChangeEffort={(v) => setField('effort', v)}
                      followSession={isBound}
                      providerId={form.providerId}
                      onChangeProviderId={(v) => setField('providerId', v)}
                      onNavigateToProviders={() => navigate('/settings?tab=providers')}
                      fastMode={form.fastMode}
                      onChangeFast={hideWorkspaceFields ? undefined : (v) => setField('fastMode', v)}
                    />
                  </div>
                  <button
                    type="button"
                    aria-label={isEdit ? t('scheduler.editor.promptDialog.saveAria') : t('scheduler.editor.promptDialog.createAria')}
                    onClick={() => void handleSubmit()}
                    disabled={submitting}
                    className={cn(
                      'flex h-[34px] min-w-[68px] shrink-0 items-center justify-center rounded-full px-4',
                      'text-sm font-medium leading-none',
                      'bg-[var(--chat-input-chip-bg)] text-[var(--msg-assistant-text)] transition-colors hover:bg-[var(--settings-btn-secondary-hover-bg)]',
                      'disabled:opacity-50',
                    )}
                  >
                    {submitLabel}
                  </button>
                </div>
              </div>
              {/* 绑定形态下显式选了模型:把 runner setModel 的副作用说出口 ——
                  下次触发会把绑定会话切到该模型,这是用户决策需要的信息。 */}
              {isBound && form.model.trim() !== '' && (
                <p className="px-1 text-11 leading-[1.4] text-[var(--cmd-palette-item-meta)]">
                  {t('scheduler.editor.runSession.switchModelHint')}
                </p>
              )}
            </div>
            )}
          </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
