/**
 * scheduler/update.ts — schedule_update tool
 *
 * Patch 形态：UpdateScheduleInput = Partial<CreateScheduleInput>。
 * 改 cronExpr / timezone 时 scheduler 自动重算 nextFireAt。
 */

import { z } from 'zod';

import { AGENT_KIND, EFFORT, EXECUTION_MODE, SCRIPT_CAPABILITY } from './_enums.js';
import { assertCronAndTimezoneValid, withScheduler } from './_shared.js';
import type { LiziMcpSessionContext, SchedulerMcpDeps } from '../types.js';
import type { SchedulerToolRegistry } from '../cindy_schedulerToolRegistry.js';
import { stabilizePreRunHookForUpdate, type UpdateScheduleInput } from '@cindy/maker-scheduler';

export function registerScheduleUpdateTool(
  registry: SchedulerToolRegistry,
  deps: SchedulerMcpDeps,
  getSessionContext?: () => LiziMcpSessionContext,
): void {
  registry.register({
    name: 'schedule_update',
    category: 'scheduler',
    description:
      '修改一条 schedule 的部分字段（patch 形态）。改 cronExpr / timezone 时 nextFireAt 会自动重算。要暂停 / 恢复请用 schedule_pause / schedule_resume，不要直接 patch status。把任务改成跟进**当前对话**的 heartbeat 请传 bindToCurrentSession=true（代码自动绑定本会话,无需也不要自己查 / 传 session id）。' +
      '**目标值缺失时先问用户，禁止盲猜**：用户指令模糊（如"改一下时间"没说改到几点、"换个模型"没说换哪个）时，先用 AskUserQuestion（或一句话追问）确认目标值再 patch；只改用户点名的字段，不要顺手"优化"其它字段。',
    inputShape: {
      id: z.string().min(1).describe('Schedule id'),
      name: z.string().min(1).optional(),
      prompt: z.string().min(1).optional(),
      cronExpr: z.string().min(1).optional(),
      intervalMs: z
        .number()
        .int()
        .positive()
        .nullable()
        .optional()
        .describe('相对间隔毫秒。设置后优先于 cronExpr。省略 = 不修改（真 partial：只改 prompt / cronExpr 不会动它）；传 null = 清空，调度回到 cronExpr 壁钟槽位语义。'),
      timezone: z.string().min(1).optional(),
      recurring: z.boolean().optional(),
      agentKind: z.enum(AGENT_KIND).optional(),
      kind: z.literal('cron').optional(),
      model: z.string().optional(),
      providerId: z.string().optional(),
      effort: z.enum(EFFORT).optional(),
      workingDir: z.string().optional(),
      useWorktree: z.boolean().optional(),
      targetSessionId: z
        .string()
        .min(1)
        .nullable()
        .optional()
        .describe('显式绑定到某条已存 session。跟进**当前对话**请改用 bindToCurrentSession,不要自己查 / 抄 session id。传 null = 解绑(清除会话绑定,比如把已绑定任务切成 script 模式前必须先解绑);省略 = 不修改。'),
      bindToCurrentSession: z
        .boolean()
        .optional()
        .describe('true → 由代码把 targetSessionId 改绑为**当前调用方会话**(跟进"这条对话"的标准用法)。设了它就别再传 targetSessionId,也无需调 get_current_session_id —— 避免 agent 复用上下文里过期的 session id 绑错会话。无法识别当前会话时本工具报错而非绑错。'),
      persistentSession: z.boolean().optional(),
      silentWhenIdle: z
        .boolean()
        .optional()
        .describe('静默运行开关,语义见 schedule_create 同名字段'),
      executionMode: z
        .enum(EXECUTION_MODE)
        .optional()
        .describe('执行方式：agent / script（仅运行脚本，零 token），语义见 schedule_create 同名字段。切到 script 时任务须已有（或本次 patch 同时带）scriptConfig，且 workingDir 是本地项目目录、未绑会话未开 worktree，否则报 INVALID_PARAMS'),
      scriptConfig: z
        .object({
          command: z.string().min(1),
          timeoutMs: z.number().int().positive().optional(),
          capabilities: z.array(z.enum(SCRIPT_CAPABILITY)).default([]),
        })
        .nullable()
        .optional()
        .describe('script 模式的脚本配置，语义见 schedule_create 同名字段。传 null = 清空（先/同时把 executionMode 切回 agent）；省略 = 不修改'),
      preRunHook: z
        .object({
          command: z.string().min(1),
          timeoutMs: z
            .number()
            .int()
            .positive()
            .nullable()
            .optional()
            .describe('省略 = 沿用任务现有 timeoutMs(只改 command 不用重传超时);传 null = 显式清除超时(不限时)。'),
        })
        .nullable()
        .optional()
        .describe('前置检查脚本,语义见 schedule_create 同名字段。传 null = 关闭前置检查(清空);省略 = 不修改。**新建/改写脚本请走 schedule_set_pre_run_hook**(统一落盘+自测),本字段只用于关闭或挂载已知命令。'),
      notify: z
        .object({
          desktop: z.boolean(),
          feishu: z.boolean(),
        })
        .optional(),
      expireAt: z.number().int().optional(),
    },
    handler: async ({ id, bindToCurrentSession, ...patch }) =>
      withScheduler(deps, async (scheduler) => {
        let input = patch as UpdateScheduleInput;
        if ((patch as { targetSessionId?: string | null }).targetSessionId === null) {
          // JSON 边界的"解绑"表达:null → 归一成 undefined 但保留 key(storage patch
          // 按 hasOwnProperty 判定,key 在且 undefined = 清列 NULL,同 preRunHook 约定)。
          // 没有这条翻译,已绑定的任务经 MCP 永远拼不出"解绑 + 切 script"的合法 patch
          // (schema 只收 string 或缺省,而缺省 = 不修改)。
          input = { ...input, targetSessionId: undefined };
        }
        if ((patch as { intervalMs?: number | null }).intervalMs === null) {
          // 同 targetSessionId:null → 带 key 的 undefined = 显式清空,调度回到
          // cronExpr 壁钟槽位语义。引擎遵循真 partial 契约(没带 key 就不动),
          // 这是 JSON 边界唯一的清空表达。
          input = { ...input, intervalMs: undefined };
        }
        // 无条件校验本次 patch 显式带的 cronExpr / timezone(函数对缺省字段是
        // no-op)。不能只在 patch 带 intervalMs 数值时校验:任务已有 intervalMs、
        // patch 只改 cronExpr 时,真 partial 语义保留原 interval,引擎按
        // now + intervalMs 重排、全程不解析 cron——无效表达式会被静默写入,等
        // 切回 cron 模式才爆(codex review 发现)。
        assertCronAndTimezoneValid(input.cronExpr, input.timezone);
        if (bindToCurrentSession) {
          // 与 schedule_create 对称:把"改绑当前对话"翻成 targetSessionId,杜绝 agent
          // 复用上下文里过期的 session id。识别不到当前会话时报 INVALID_PARAMS,不静默绑错。
          const sessionId = getSessionContext?.().sessionId;
          if (!sessionId) {
            throw new Error(
              'invalid request: bindToCurrentSession 无法解析当前会话(没有可用的 session 上下文);如确需绑定,请改用显式 targetSessionId',
            );
          }
          input = { ...input, targetSessionId: sessionId };
        }
        return scheduler.updateFromCurrent(id, async (existing) => {
          // preRunHook.timeoutMs 的真 partial 表达:只改 command 时沿用任务现有超时
          // (此前整对象替换会把省略的 timeoutMs 静默清成"不限时");传 null 才显式清除。
          // null 在进入引擎前剥掉 —— 引擎/storage 只认 number | undefined。
          const rawHook = (patch as { preRunHook?: { command: string; timeoutMs?: number | null } | null })
            .preRunHook;
          if (rawHook && typeof rawHook === 'object') {
            if (rawHook.timeoutMs === null) {
              input = { ...input, preRunHook: { command: rawHook.command } };
            } else if (
              // 「没提供」= 缺 key 或值为 undefined:MCP 走 JSON 表达不出带 key 的
              // undefined,但进程内调用能;两种形态都视作缺省沿用现有超时,只有
              // null 是清除(copilot review 指出带 key undefined 会漏进清空分支)。
              rawHook.timeoutMs === undefined &&
              existing.preRunHook?.timeoutMs !== undefined
            ) {
              input = {
                ...input,
                preRunHook: { command: rawHook.command, timeoutMs: existing.preRunHook.timeoutMs },
              };
            }
          }
          const nextHook = Object.prototype.hasOwnProperty.call(input, 'preRunHook')
            ? input.preRunHook
            : existing.preRunHook;
          if (!nextHook?.command?.trim()) return input;
          if (!deps.hookScript?.stabilizeCommand) {
            throw new Error(
              'invalid request: 当前 host 未提供 pre-run hook 路径稳定化服务，拒绝更新带 hook 的任务',
            );
          }
          return stabilizePreRunHookForUpdate(existing, input, {
            resolveSessionWorkDir:
              deps.hookScript.resolveSessionWorkDir ?? (async () => undefined),
            stabilizeCommand: deps.hookScript.stabilizeCommand,
          });
        });
      }),
  });
}
