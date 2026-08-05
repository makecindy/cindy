/**
 * pluginScheduleCreateIntent — 插件请求「新建自动化」的意图与预填构造(纯函数层)。
 * ---------------------------------------------------------------------------
 * 链路:插件面板上用户点「提醒我 XXXX」→ 管子 schedule-request → main 的
 * scheduleSlot(资格审/净化/钳制/限速)→ 广播 → 订阅点导航到自动化页并带上本
 * intent → SchedulerPage 读出来转成表单预填 → 面板打开,用户选模型后**亲手保存**。
 *
 * 形态与 usageLimitScheduleCreateIntent 逐条同构(同一套 navigation state 通道 +
 * Partial<ScheduleFormState> 预填),不另发明一条路。
 *
 * 落成的任务是一条**普通 agent 自动化**:执行者是 AI 会话,插件只是这条任务到点
 * 去调用的目标(靠已有的 tool 槽 + ghost_call)。所以这里不碰 executionMode,也
 * 没有任何插件专属的执行配置。
 */

import type { ScheduleFormState } from './scheduleFormLogic';

export interface PluginScheduleCreateIntent {
  kind: 'plugin-schedule-draft';
  /** main 铸的请求 id;renderer 用它去重(同一次请求重复推送不叠开面板)。 */
  requestId: string;
  /**
   * 发起插件。目前只用于面板上的来源标注(让用户看清是谁请求建这条任务),
   * **不落库** —— 把它写进 schedule 需要新增 DB 列 + migration,而 migration
   * 一旦进 main 就拆不掉(仓规红线)。等"插件详情页列出自己建的任务"这个需求
   * 真的要做时再一并加,不为一个展示字段先欠一笔不可回退的 schema 债。
   */
  ghostId: string;
  /** 插件展示名(main 按已装清单填,不信沙箱自报)。 */
  ghostName: string;
  /** 预填任务名(main 已净化截断)。 */
  name: string;
  /** 预填提示词:这条任务到点要干什么(插件用自然语言写)。 */
  prompt: string;
  /** 建议触发间隔 ms(main 已钳到 30 分钟之上);缺省 = 用面板默认频率。 */
  intervalMs?: number;
}

export function pluginScheduleNavigationState(intent: PluginScheduleCreateIntent): {
  pluginScheduleDraft: PluginScheduleCreateIntent;
} {
  return { pluginScheduleDraft: intent };
}

/**
 * 从导航 state 读回 intent。**所有字段逐个校验** —— 这条 state 的源头是插件沙箱
 * 提供的内容(main 已净化,但 renderer 不假设上游一定干净),形状不对就当没有。
 */
export function readPluginScheduleCreateIntent(
  state: unknown,
): PluginScheduleCreateIntent | null {
  if (!state || typeof state !== 'object') return null;
  const candidate = (state as { pluginScheduleDraft?: unknown }).pluginScheduleDraft;
  if (!candidate || typeof candidate !== 'object') return null;
  const value = candidate as Partial<PluginScheduleCreateIntent>;
  if (
    value.kind !== 'plugin-schedule-draft' ||
    typeof value.requestId !== 'string' ||
    !value.requestId ||
    typeof value.ghostId !== 'string' ||
    !value.ghostId ||
    typeof value.ghostName !== 'string' ||
    !value.ghostName ||
    typeof value.name !== 'string' ||
    !value.name ||
    typeof value.prompt !== 'string' ||
    !value.prompt ||
    (value.intervalMs !== undefined &&
      (typeof value.intervalMs !== 'number' ||
        !Number.isFinite(value.intervalMs) ||
        value.intervalMs <= 0))
  ) {
    return null;
  }
  return value as PluginScheduleCreateIntent;
}

/** 本机时区(与 usageLimit 那条同实现,失败兜底 UTC)。 */
function systemTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * intent → 表单预填。
 *
 * 刻意留空的两项:
 * - `model` / `providerId` / `effort` 全空 = **用默认模型**。插件不该替用户选模型,
 *   用户在面板上想改就改(Chris 定案:"用户选模型或者默认模型")。
 *
 *   ⚠️ 留空**不会**让"显示的模型"与"实际执行的模型"漂移(review #1715 曾按此判为
 *   缺陷,实测不成立):ScheduleFormDialog 有一个专门的 effect —— `form.model` 为空
 *   且非 heartbeat 形态时,立即回填 `getScheduleDefaultModel(agentKind)` 的三级回退
 *   显式值(见该文件"form.model 为空时回填默认模型"那段,它正是为 2026-06 那次
 *   "看着选了 Opus 4.8、实际每次跑 4.7"加的)。本 intent 的 `targetSessionId: ''`
 *   满足回填条件,所以表单打开那一刻 model 就已是显式值,保存时不会被省略。
 *   端到端行为由 schedulerTemplateEntry 的「所见即所存」用例钉住。
 *   `providerId` / `effort` / `fastMode` 留空则本就是**合法语义**(跟随原生默认来源 /
 *   用模型默认思考强度 / 不开 Fast),不是缺失值。
 * - `cronExpr` 保留表单默认值:intervalMs 有值时引擎按 interval 语义走,cronExpr
 *   只是占位(见 Schedule.intervalMs 注释);没给建议频率时就用面板默认。
 *
 * `workspaceKind: 'dialogue'` —— 这类任务是"去查点东西再更新插件",不属于任何
 * 项目目录,落 app 管理的对话工作区(与 usageLimit 那条同口径)。
 */
export function buildPluginScheduleFormOverrides(
  intent: PluginScheduleCreateIntent,
): Partial<ScheduleFormState> {
  return {
    name: intent.name,
    prompt: intent.prompt,
    executionMode: 'agent',
    ...(intent.intervalMs !== undefined ? { intervalMs: intent.intervalMs } : {}),
    timezone: systemTimeZone(),
    recurring: true,
    manual: false,
    model: '',
    providerId: '',
    effort: '',
    fastMode: false,
    workspaceKind: 'dialogue',
    workingDir: '',
    useWorktree: false,
    targetSessionId: '',
    persistentSession: false,
  };
}
