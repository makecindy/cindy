/**
 * scheduleFormLogic — Schedule 表单的纯函数层(无 React / window 依赖)
 * ---------------------------------------------------------------------------
 * 从 useScheduleForm 抽出,@vitest-environment node 可直接测。包含:
 *
 *   - ScheduleFormState 类型与 effort 白名单(原 useScheduleForm 迁入,
 *     原处 re-export 保持既有 import 不变)
 *   - RunMode 三态("运行会话"概念,合并 persistentSession 与手绑会话):
 *       fresh      每次新建会话(persistentSession=false, targetSessionId='')
 *       persistent 持续会话·自动创建(persistentSession=true;首次 fire 后
 *                  runner 回写 targetSessionId,归档自动重建续绑)
 *       bound      绑定已有会话(targetSessionId=<id>, persistentSession=false;
 *                  会话不可用时 runner 自动 pause)
 *   - buildScheduleInput:表单 → CreateScheduleInput(原 toInput 迁入)
 */

import type { CreateScheduleInput, ScheduleTemplate, ScheduleWorkspaceKind, ScriptCapability } from '@cindy/maker-scheduler';
import {
  effectiveSourceIdForModel,
  getModel,
  type AgentKind,
  type ProviderView,
} from '@cindy/model-providers';
import type { SessionReference } from '../../../../shared/sessionReference';

/** Effort 白名单 — 与 Phase 2 mapper enum 一致;UI 提交前的最后一道关卡。 */
export const EFFORT_VALUES = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
export type EffortValue = (typeof EFFORT_VALUES)[number];

export function isEffortValue(v: string): v is EffortValue {
  return (EFFORT_VALUES as readonly string[]).includes(v);
}

/**
 * 已完成 capabilities 加载后，判断显式 schedule model 是否已从目录移除。
 * availableModels 为 undefined 表示快照尚未就绪，此时保留表单值等待联合刷新完成。
 */
export function isExplicitScheduleModelUnavailable(
  model: string,
  availableModels: readonly { id: string }[] | undefined,
): boolean {
  const explicitModel = model.trim();
  return availableModels !== undefined
    && explicitModel.length > 0
    && !availableModels.some((candidate) => candidate.id === explicitModel);
}

/**
 * Resolve the provider represented by the schedule picker. An empty stored
 * providerId means "use the effective source", not "use the utility fallback
 * chain", so generation must materialize that source before crossing IPC.
 */
export function resolveScheduleGenerationProviderId(input: {
  providers: ProviderView[];
  providerId: string;
  model: string;
  agentKind: AgentKind;
}): string | null {
  const model = input.model.trim();
  if (!model) return null;
  const explicitProviderId = input.providerId.trim();
  // An explicit provider is a routing boundary, even while disconnected.
  // Preserve it so main can report that provider's credential/model failure
  // instead of silently selecting another connected source for the same id.
  if (explicitProviderId) return explicitProviderId;
  return effectiveSourceIdForModel(
    input.providers,
    null,
    model,
    input.agentKind,
  );
}

/**
 * Resolve effort options without crossing an explicit provider boundary.
 * A stale pinned provider preserves its effort until the provider is repaired;
 * only an unpinned selection may follow the effective fallback.
 */
export function resolveScheduleModelEfforts(input: {
  providers: ProviderView[];
  providerId: string;
  model: string;
  agentKind: AgentKind;
  fallbackEfforts?: readonly string[];
}): readonly string[] | undefined {
  const model = input.model.trim();
  if (!model) return undefined;
  const explicitProviderId = input.providerId.trim();
  const sourceId = effectiveSourceIdForModel(
    input.providers,
    explicitProviderId || null,
    model,
    input.agentKind,
  );
  if (explicitProviderId && sourceId !== explicitProviderId) return undefined;
  const source = sourceId
    ? input.providers.find((provider) => provider.id === sourceId)
    : undefined;
  return source
    ? getModel(source, model, input.agentKind)?.efforts
    : input.fallbackEfforts;
}

export interface ScheduleFormState {
  name: string;
  prompt: string;
  /** agent = run an AI turn; script = host executes scriptConfig without an AI turn. */
  executionMode?: 'agent' | 'script';
  scriptCommand?: string;
  scriptTimeoutSec?: string;
  scriptCapabilities?: ScriptCapability[];
  cronExpr: string;
  /**
   * 相对间隔模式的权威间隔。非空 = 上次完成后等待 N 毫秒；undefined = Cron 槽位模式。
   * cronExpr 在 interval 模式下只保留兼容/切换用的表达式，不能反向覆盖本字段。
   */
  intervalMs?: number;
  timezone: string;
  recurring: boolean;
  /** 手动模式:true → 创建后永不自动 fire,只能 Run now。UI 上需要 recurring=false 才能勾。 */
  manual: boolean;
  agentKind: 'claude-code' | 'codex' | 'pi';
  model: string;
  /**
   * 显式选定的来源(供应商)id。'' = 跟随该 agent 原生默认来源（no-break，与未升级
   * 行为一致）；非空才把任务钉在该来源（如 'anthropic' 订阅档）。UI 显示时用
   * `form.providerId || nativeDefaultSourceId(agentKind)` 算出当前高亮的来源。
   */
  providerId: string;
  effort: EffortValue | '';
  /** Codex Fast 模式开关。仅 Codex 有意义;切到 Claude / 不支持 fast 的模型时自动清为 false。 */
  fastMode: boolean;
  workspaceKind: ScheduleWorkspaceKind;
  workingDir: string;
  useWorktree: boolean;
  /** 非空 → heartbeat 模式;'__pending__' = bound 态已选中但还没挑会话的占位 */
  targetSessionId: string;
  /**
   * 持续会话:true → runner 首次 fire 完把新建 sessionId 回写 targetSessionId,
   * 后续每次 fire 都在同一 session 中接着跑;会话被归档后自动重建续绑。
   * RunMode 三态中它是 persistent 与 bound 的判别器(bound 恒为 false)。
   */
  persistentSession: boolean;
  /** 静默运行:true → 成功 run 默认不提醒;AI 主动上报时才按通知渠道提醒。 */
  silentWhenIdle: boolean;
  /** 前置检查脚本开关。false = 未启用,保存时 preRunHook 清空(写 NULL)。 */
  preRunHookEnabled: boolean;
  /** 前置检查脚本命令(经系统 shell 执行;exit 0 放行 / exit 2 跳过本轮)。 */
  preRunHookCommand: string;
  /** 前置检查超时(秒,文本输入,无 UI 入口)。空/非法 → 不限时。 */
  preRunHookTimeoutSec: string;
  notifyDesktop: boolean;
  notifyFeishu: boolean;
  notifyWecomGroup?: boolean;
}

/** bound 态"已选绑定但尚未挑会话"的占位 id;validate 用 selectThread 拦截。 */
export const PENDING_SESSION_ID = '__pending__';

/** "运行会话"三态。 */
export type RunMode = 'fresh' | 'persistent' | 'bound';

/**
 * Agent-mode bound schedules may only be persisted after the selected session
 * has resolved as available and active. Archived sessions remain openable, so
 * their reference state is still `available`, but the runner cannot use them as
 * ordinary heartbeat targets. Script mode intentionally clears targetSessionId,
 * so a stale binding must not block that mode conversion.
 */
export function canSubmitSessionBinding(
  executionMode: ScheduleFormState['executionMode'],
  runMode: RunMode,
  reference: SessionReference | undefined,
): boolean {
  return executionMode === 'script'
    || runMode !== 'bound'
    || (reference?.state === 'available' && reference.status !== 'archived');
}

/** targetSessionId 是真实会话 id(非空且非占位)。 */
export function hasRealBinding(form: Pick<ScheduleFormState, 'targetSessionId'>): boolean {
  const tgt = form.targetSessionId.trim();
  return !!tgt && tgt !== PENDING_SESSION_ID;
}

/**
 * A bound schedule follows its session route when model and provider are both
 * inherited. Effort is an independent runtime override and must not alter the
 * generation route predicate.
 */
export function isFollowingSessionSelection(input: {
  followSession?: boolean;
  model: string;
  providerId: string;
  effort: string;
}): boolean {
  return Boolean(
    input.followSession &&
      !input.model.trim() &&
      !input.providerId.trim() &&
      !input.effort.trim(),
  );
}

/**
 * 前置脚本生成是否应沿用绑定会话的模型。
 *
 * model 是绑定任务的继承维度；provider/effort 可以独立覆盖，不能因为这两个
 * 覆盖值存在就把空 model 当成“没有可生成的模型”。
 */
export function usesBoundSessionGenerationModel(
  form: Pick<ScheduleFormState, 'persistentSession' | 'targetSessionId' | 'model'>,
): boolean {
  return deriveRunMode(form) === 'bound'
    && hasRealBinding(form)
    && !form.model.trim();
}

/** bound 任务生成前置脚本时，是否需要 main 用会话路由补齐缺省维度。 */
export function needsBoundSessionGenerationRouteResolution(
  form: Pick<
    ScheduleFormState,
    'persistentSession' | 'targetSessionId' | 'providerId' | 'model'
  >,
): boolean {
  return deriveRunMode(form) === 'bound'
    && hasRealBinding(form)
    && (!form.model.trim() || !form.providerId.trim());
}

/** 前置脚本生成沿用绑定会话的完整模型/来源路由(努力强度是独立覆盖)。 */
export function shouldFollowBoundSessionGenerationRoute(
  form: Pick<
    ScheduleFormState,
    'persistentSession' | 'targetSessionId' | 'providerId' | 'model' | 'effort'
  >,
): boolean {
  return needsBoundSessionGenerationRouteResolution(form)
    && usesBoundSessionGenerationModel(form)
    && !form.providerId.trim();
}

/** 绑定任务 model 为空时，运行模型仍来自绑定会话；provider/effort 可独立覆盖。 */
export function usesBoundSessionModel(input: {
  followSession?: boolean;
  model: string;
}): boolean {
  return Boolean(input.followSession && !input.model.trim());
}

/**
 * 从 form 派生当前 RunMode。persistentSession flag 是 persistent 与 bound 的
 * 唯一判别器:B 已绑(runner 回写)是 persistentSession=true + targetSessionId 真实 id,
 * C 手绑(MCP / picker)是 persistentSession=false + targetSessionId 非空。
 */
export function deriveRunMode(
  form: Pick<ScheduleFormState, 'persistentSession' | 'targetSessionId'>,
): RunMode {
  if (form.persistentSession) return 'persistent';
  if (form.targetSessionId.trim()) return 'bound';
  return 'fresh';
}

/**
 * "上一次真实绑定"的完整快照。只记 id 不够:切到 fresh 后,空 model 回填
 * effect 会把"跟随会话"(model='')填成显式默认模型,切回绑定态若只还原 id,
 * 保存就会把默认模型 patch 给任务、下次 fire setModel 反向改掉绑定会话的
 * 模型(PR #103 review 发现的逃逸路径)。所以离开绑定态时连 model/effort/
 * fastMode/agentKind 一起快照,还原时整组恢复。
 */
export interface RememberedBinding {
  targetSessionId: string;
  model: string;
  providerId: string;
  effort: EffortValue | '';
  fastMode: boolean;
  agentKind: ScheduleFormState['agentKind'];
}

/** 从 form 提取绑定快照;无真实绑定返回 null。 */
export function captureBinding(form: ScheduleFormState): RememberedBinding | null {
  if (!hasRealBinding(form)) return null;
  return {
    targetSessionId: form.targetSessionId,
    model: form.model,
    providerId: form.providerId,
    effort: form.effort,
    fastMode: form.fastMode,
    agentKind: form.agentKind,
  };
}

/**
 * 切换 RunMode 的状态转换(纯函数)。
 *
 * 切换是**非破坏性**的:表单里的绑定只有保存才真正生效/丢失。
 *   fresh      → persistentSession=false + targetSessionId 清空(form 值清掉,
 *                但调用方 hook 会把真实绑定快照进 remembered,切回来可还原)
 *   persistent → persistentSession=true;现有真实绑定保留,没有则整组还原
 *                remembered(没有 remembered = 空,等 runner 首次 fire 回写)
 *   bound      → persistentSession=false;现有真实绑定保留,没有则整组还原
 *                remembered,再没有才置占位
 *
 * @param remembered hook 层维护的"上一次真实绑定"快照,用于 fresh/persistent
 *   ↔ bound 来回切换不丢绑定(含 model/effort 等关联字段,见 RememberedBinding)。
 */
export function applyRunMode(
  form: ScheduleFormState,
  mode: RunMode,
  remembered: RememberedBinding | null = null,
): ScheduleFormState {
  // 还原 remembered 时整组恢复,杜绝"id 还原了但 model 已被回填成显式值"的撕裂态
  const restored = (f: ScheduleFormState): ScheduleFormState =>
    remembered
      ? {
          ...f,
          targetSessionId: remembered.targetSessionId,
          model: remembered.model,
          providerId: remembered.providerId,
          effort: remembered.effort,
          fastMode: remembered.fastMode,
          agentKind: remembered.agentKind,
        }
      : f;

  let next: ScheduleFormState;
  switch (mode) {
    case 'fresh':
      next = { ...form, persistentSession: false, targetSessionId: '' };
      break;
    case 'persistent':
      next = hasRealBinding(form)
        ? { ...form, persistentSession: true }
        : restored({ ...form, persistentSession: true, targetSessionId: '' });
      break;
    case 'bound':
      next = hasRealBinding(form)
        ? { ...form, persistentSession: false }
        : remembered
          ? restored({ ...form, persistentSession: false })
          : { ...form, persistentSession: false, targetSessionId: PENDING_SESSION_ID };
      break;
  }
  // 无字段变化时返回原引用,避免 React 无谓重渲染
  const unchanged = (Object.keys(next) as Array<keyof ScheduleFormState>).every(
    (k) => next[k] === form[k],
  );
  return unchanged ? form : next;
}

/** renderer Session.agentKind('cc'|'codex')→ schedule agentKind 映射。 */
export function sessionAgentKindToScheduleAgentKind(
  kind: 'cc' | 'codex' | 'pi',
): ScheduleFormState['agentKind'] {
  if (kind === 'codex') return 'codex';
  if (kind === 'pi') return 'pi';
  return 'claude-code';
}

interface TemplateAgentDefaults {
  getDefaultModel: (agentKind: ScheduleFormState['agentKind']) => string;
  getAgentPrefs: (
    agentKind: ScheduleFormState['agentKind'],
  ) => Pick<ScheduleFormState, 'providerId' | 'effort' | 'fastMode'>;
}

export function resolveTemplateAgentFields(
  form: ScheduleFormState,
  template: Pick<ScheduleTemplate, 'agentKind' | 'model' | 'providerId' | 'effort' | 'fastMode'>,
  defaults: TemplateAgentDefaults,
): Pick<ScheduleFormState, 'agentKind' | 'model' | 'providerId' | 'effort' | 'fastMode'> {
  const agentKind = template.agentKind ?? form.agentKind;
  const agentChanged = agentKind !== form.agentKind;
  const agentPrefs = agentChanged ? defaults.getAgentPrefs(agentKind) : null;
  const templateModel = typeof template.model === 'string' ? template.model.trim() : '';
  const templateProviderId = typeof template.providerId === 'string' ? template.providerId.trim() : undefined;
  const templateEffort = template.effort && isEffortValue(template.effort) ? template.effort : undefined;

  return {
    agentKind,
    model: templateModel || (agentChanged ? defaults.getDefaultModel(agentKind) : form.model),
    providerId: templateProviderId ?? (agentChanged ? (agentPrefs?.providerId ?? '') : form.providerId),
    effort: templateEffort ?? (agentChanged ? (agentPrefs?.effort ?? '') : form.effort),
    fastMode: template.fastMode ?? (agentChanged ? (agentPrefs?.fastMode ?? false) : form.fastMode),
  };
}

/**
 * 表单 → CreateScheduleInput。
 *
 * Heartbeat 分支(targetSessionId 非空)的 key 语义:
 *   - workingDir 不带、useWorktree 强制 false(runner 从 SessionMeta 取,传了也被忽略)
 *   - model / effort **恒带 key**(空值为 undefined):update patch 走
 *     schedulePatchToRow 的 hasKey 判定,key 在且值 undefined → 写 NULL,
 *     这是"跟随会话"(清掉显式模型)能落库的唯一通道。
 *     ⚠️ 依赖 IPC 链路对 undefined-valued own key 的保真(structured clone +
 *     engine spread),链路中间不许加 JSON 序列化,否则清列静默失效。
 *   - 显式 model 优先于 session meta,且下次 fire runner 会 setModel 推给绑定会话。
 * 非 heartbeat 分支保持历史行为:model/effort 空值省略 key(GUI 路径 model 永远非空)。
 */
/**
 * 用户选中/拖入的脚本文件 → preRunHook 调用命令(纯函数,规则 9:映射全在代码里)。
 *   - 解释器按扩展名判定:js/mjs/cjs→node;py→python(win)/python3(其它);
 *     sh→bash;ps1→powershell -File;bat/cmd/exe→直接执行;其它→直接执行
 *     (POSIX 依赖 shebang/可执行位,Windows 依赖扩展名关联)。
 *   - 文件在任务工作目录之下 → 相对路径(正斜杠,随项目走;Windows 大小写不敏感比较);
 *     否则绝对路径。含空格或绝对路径一律加引号。
 * 与 main 侧 hook-script-generator.buildHookCommand 的路径口径一致。
 */
export function buildHookCommandForScriptFile(
  filePath: string,
  opts: { workingDir?: string; platform: string },
): string {
  const win = opts.platform === 'win32';
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '');
  const file = norm(filePath.trim());
  let ref = file;
  const wd = opts.workingDir?.trim() ? norm(opts.workingDir) : '';
  if (wd) {
    const fileCmp = win ? file.toLowerCase() : file;
    const wdCmp = win ? wd.toLowerCase() : wd;
    if (fileCmp.startsWith(`${wdCmp}/`)) ref = file.slice(wd.length + 1);
  }
  const isRelative = ref !== file || (!/^[a-zA-Z]:\//.test(ref) && !ref.startsWith('/'));
  // 命令经 shell:true 执行,只有"纯安全字符"的相对路径才免包裹;其余必须做
  // **平台 shell 转义**(双引号不是转义:POSIX 双引号内 $()/`` /$var/\ 照样展开):
  //   - POSIX  → 单引号包裹(单引号内无任何解释),内嵌单引号按 '\'' 拼接;
  //   - Windows → 双引号包裹(文件名不允许含 "),cmd 引号内 & ( ) ^ 均为字面量;
  //     `%VAR%` 命中已存在环境变量时的展开是 cmd 关不掉的边缘,接受。
  // Windows 反斜杠是路径分隔符属安全字符,POSIX 反斜杠是转义符必须包裹。
  const safeRe = win ? /^[A-Za-z0-9_\-.\\/]+$/ : /^[A-Za-z0-9_\-./]+$/;
  const quote = (p: string): string => {
    if (isRelative && safeRe.test(p)) return p;
    return win ? `"${p}"` : `'${p.replace(/'/g, `'\\''`)}'`;
  };
  const ext = /\.([a-zA-Z0-9]+)$/.exec(ref)?.[1]?.toLowerCase() ?? '';
  switch (ext) {
    case 'js':
    case 'mjs':
    case 'cjs':
      // 路径作为解释器的**参数**,正斜杠双平台都安全
      return `node ${quote(ref)}`;
    case 'py':
      // macOS 无裸 `python`(仅 python3);Windows 官方安装器装的是 `python`
      return `${win ? 'python' : 'python3'} ${quote(ref)}`;
    case 'sh':
      // Windows 下依赖 git-bash 在 PATH;缺失时执行器会阻止本轮并展示错误
      return `bash ${quote(ref)}`;
    case 'ps1':
      // Windows 内置 powershell;macOS/Linux 只有 PowerShell Core(pwsh)
      return `${win ? 'powershell' : 'pwsh'} -ExecutionPolicy Bypass -File ${quote(ref)}`;
    default: {
      // bat / cmd / exe / 无扩展名等:路径就是**命令本身**。cmd.exe 对命令位置的
      // 正斜杠不可靠(参数位置才安全),Windows 必须回写反斜杠。
      const direct = win ? ref.replace(/\//g, '\\') : ref;
      return quote(direct);
    }
  }
}

/** 秒文本 → 毫秒;空 / 非法 / ≤0 → undefined(不限时)。 */
export function parsePreRunHookTimeoutMs(sec: string): number | undefined {
  const n = Number(sec.trim());
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.floor(n * 1000);
}

export function buildPreRunHook(
  form: Pick<ScheduleFormState, 'preRunHookEnabled' | 'preRunHookCommand' | 'preRunHookTimeoutSec'>,
): CreateScheduleInput['preRunHook'] {
  const command = form.preRunHookCommand.trim();
  if (!form.preRunHookEnabled || !command) return undefined;
  // 显式填写的超时原样落库;空 / 非法 → undefined = 不限时(与 main 侧
  // resolvePreRunHookTimeoutMs 语义一致)。不再对任何值做"等于默认就不落库"
  // 的过滤——默认超时已移除,undefined 的含义是不限时而非跟随默认。
  return {
    command,
    timeoutMs: parsePreRunHookTimeoutMs(form.preRunHookTimeoutSec),
  };
}


export function buildScriptConfig(
  form: Pick<ScheduleFormState, 'executionMode' | 'scriptCommand' | 'scriptTimeoutSec' | 'scriptCapabilities'>,
): CreateScheduleInput['scriptConfig'] {
  if (form.executionMode !== 'script' || !form.scriptCommand?.trim()) return undefined;
  const timeoutMs = parseScriptTimeoutMs(form.scriptTimeoutSec ?? '');
  return {
    command: form.scriptCommand.trim(),
    capabilities: [...new Set(form.scriptCapabilities ?? [])],
    ...(timeoutMs ? { timeoutMs } : {}),
  };
}

export function parseScriptTimeoutMs(sec: string): number | undefined {
  const n = Number(sec.trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n * 1000) : undefined;
}

export function buildScheduleInput(form: ScheduleFormState): CreateScheduleInput {
  const isHeartbeat = !!form.targetSessionId.trim();
  const isScript = (form.executionMode ?? 'agent') === 'script';
  const cronExpr = form.cronExpr.trim();
  const base: CreateScheduleInput = {
    name: form.name.trim(),
    prompt: form.prompt,
    executionMode: form.executionMode ?? 'agent',
    scriptConfig: buildScriptConfig(form),
    kind: 'cron',
    cronExpr,
    timezone: form.timezone.trim(),
    recurring: form.recurring,
    manual: form.manual,
    // 恒带 key：编辑 Cron 任务时 undefined 会沿 storage patch 契约清空旧 intervalMs；
    // 相对间隔任务则原样保留权威值，不能从可能陈旧的 cronExpr 重新推导。
    intervalMs: form.intervalMs,
    agentKind: form.agentKind,
    workspaceKind: form.workspaceKind,
    useWorktree: !isScript && form.workspaceKind === 'project' && form.useWorktree,
    persistentSession: !isScript && form.persistentSession,
    silentWhenIdle: !isScript && form.silentWhenIdle,
    targetSessionId: !isScript ? (form.targetSessionId.trim() || undefined) : undefined,
    preRunHook: buildPreRunHook(form),
    notify: {
      desktop: form.notifyDesktop,
      feishu: form.notifyFeishu,
      wecomGroup: form.notifyWecomGroup === true,
    },
  };

  if (isScript) {
    base.workspaceKind = 'project';
    base.workingDir = form.workingDir.trim();
    base.useWorktree = false;
    // script 模式不叠前置检查(任务本体就是脚本,UI 也不展示该区块);保留 key,
    // 编辑保存时按 hasKey + undefined = 写 NULL 契约把历史 hook 清列。
    base.preRunHook = undefined;
    return base;
  }

  if (isHeartbeat) {
    base.useWorktree = false;
    base.model = form.model.trim() || undefined;
    base.providerId = form.providerId.trim() || undefined;
    base.effort = form.effort && isEffortValue(form.effort) ? form.effort : undefined;
    return base;
  }
  if (form.workspaceKind === 'project') base.workingDir = form.workingDir.trim();
  else base.useWorktree = false;
  if (form.model.trim()) base.model = form.model.trim();
  // providerId 是可清除的来源 override：表单选回原生默认来源时值为空，仍须保留 key，
  // 让 update patch 按「key 在 + undefined」把旧 provider_id 清成 NULL。
  base.providerId = form.providerId.trim() || undefined;
  if (form.effort && isEffortValue(form.effort)) base.effort = form.effort;
  // fastMode 对 Codex / Pi 都生效(runner.ts:665 明确 claude-code 忽略此字段);只序列化
  // codex 会让用户在 Pi 任务里开的 Fast 被静默丢弃(codex review)。表单侧 Fast 开关已按
  // capability × 模型 supportsFastMode 门控,Pi 只有真支持时才可能为 true。
  if (form.agentKind === 'codex' || form.agentKind === 'pi') base.fastMode = form.fastMode;
  return base;
}
