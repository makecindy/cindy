/**
 * scheduler/create.ts — schedule_create tool
 *
 * 接收 CreateScheduleInput 同形 payload，透传给 scheduler.create()，返回新建
 * 出的 Schedule（含自动算好的 nextFireAt）。
 *
 * 注意：
 *  - kind 默认 'cron'（当前唯一支持的 kind）
 *  - effort 通过 zod enum 提前白名单校验（runner 也校验，UI 也校验，三道防线）
 *  - notify 是嵌套对象 `{desktop, feishu}`，与 Phase 1 Schedule 类型一致
 *  - timezone 必须是 IANA tz id（'Asia/Shanghai' / 'America/New_York' 等）；
 *    cron parser 验证不通过时 scheduler.create() 抛 'invalid timezone' →
 *    INVALID_PARAMS
 */

import { z } from 'zod';

import { AGENT_KIND, EFFORT, EXECUTION_MODE, SCRIPT_CAPABILITY } from './_enums.js';
import { assertCronAndTimezoneValid, withScheduler } from './_shared.js';
import type { LiziMcpSessionContext, SchedulerMcpDeps } from '../types.js';
import type { SchedulerToolRegistry } from '../cindy_schedulerToolRegistry.js';
import type { CreateScheduleInput } from '@cindy/maker-scheduler';
import { stabilizePreRunHookForCreate } from '@cindy/maker-scheduler';

export function registerScheduleCreateTool(
  registry: SchedulerToolRegistry,
  deps: SchedulerMcpDeps,
  getSessionContext?: () => LiziMcpSessionContext,
): void {
  registry.register({
    name: 'schedule_create',
    category: 'scheduler',
    description:
      '创建一条 schedule。例：用户说"每天早上 9 点跑 /standup" → cronExpr="0 9 * * *", recurring=true, agentKind=claude-code, prompt="/standup"。' +
      '约束：(1) cronExpr 是 5 字段 cron（minute hour day-of-month month day-of-week）；' +
      '(2) timezone 必须是 IANA id（如 "Asia/Shanghai"）；' +
      '(3) 一次性任务用 recurring=false（触发后 status 会自动置 expired）；' +
      '(4) heartbeat 模式（注入到已存 session）：**要跟进当前这条对话就传 bindToCurrentSession=true**（代码自动绑定本会话,无需也不要自己去查 / 传 session id）；只有要绑到另一条已知 session 时才显式传 targetSessionId。heartbeat 模式不传 workingDir / model / effort（runner 会从 session 取）；' +
      '(5) 默认 useWorktree=false / notify={desktop:true, feishu:false}；' +
      '(6) 删除前模型自己用 schedule_get / schedule_list 跟用户确认，不要静默删；' +
      '(7) 用户说"静默运行 / 没事别打扰我 / 只记录不用每次提醒"之类 → silentWhenIdle=true；如果用户定义了提醒条件，把条件保留在 prompt 里（如 CI 失败/新评论时提醒），runner 只会注入很短的主动上报协议；' +
      '(8) 轮询型任务（"有新 PR 才 review / CI 挂了才处理"）优先配 preRunHook 前置检查（exit 0=放行、exit 2=跳过本轮不烧 token；报错/超时 fail-closed 阻止本轮并记录失败）。**脚本一律经 schedule_set_pre_run_hook 创建/修改**（落盘路径、协议、自测由宿主代码统一保证），不要自己写脚本文件再手填 preRunHook.command——先调它拿 command 再来创建，或创建后传 scheduleId 让它直接挂载；' +
      '(9) **参数缺失时先问用户，禁止盲猜**：用户主动让你建任务时，凡是用户没说清、又会实质影响任务行为的参数——触发时间/频率、用哪个 agent（及模型）执行、prompt 里的关键实体（城市/仓库/监控对象等）、通知渠道、是否静默运行、要不要前置检查（轮询型才需要）——一律先用 AskUserQuestion（或一句话追问）确认后再创建，**不要自作主张填默认值再事后告知**。用户已明确说了的不重复问；由既有流程/脚本自动化创建（无人在线）的场景才允许用文档默认值。' +
      '(10) **仅运行脚本模式（零 token）**：executionMode="script" 时不启动 agent，宿主直接执行 scriptConfig.command（cwd=workingDir，必填本地项目目录）；脚本经 stdout/stdin 的 cindy-script/1 JSONL 协议回调宿主受限能力，能力按 scriptConfig.capabilities 白名单授予（默认全拒）。script 模式不需要 prompt（可省），且不支持 useWorktree / targetSessionId / bindToCurrentSession / persistentSession。与 preRunHook 的分工：preRunHook 只是"要不要跑"的闸门，script 模式是"任务本体就是脚本"。',
    inputShape: {
      name: z.string().min(1).describe('展示名（GUI / 通知里出现）'),
      prompt: z
        .string()
        .optional()
        .describe('触发时发给 agent 的第一条 user message。agent 模式必填（缺失报 INVALID_PARAMS）；executionMode="script" 时可省略'),
      executionMode: z
        .enum(EXECUTION_MODE)
        .optional()
        .describe('执行方式：agent（默认，起 agent 会话跑 prompt）/ script（仅运行脚本，零 token，任务本体是 scriptConfig.command）'),
      scriptConfig: z
        .object({
          command: z
            .string()
            .min(1)
            .describe('经系统 shell 执行的命令（cwd=workingDir）。命令须实现 cindy-script/1 协议：stdout 只能输出 JSONL 协议帧（call / complete），调试输出走 stderr'),
          timeoutMs: z
            .number()
            .int()
            .positive()
            .optional()
            .describe('整轮脚本超时毫秒，可选；超时杀进程树、run 记 failed'),
          capabilities: z
            .array(z.enum(SCRIPT_CAPABILITY))
            .default([])
            .describe('能力白名单（默认全拒）：jira.read=jira.get/jira.search_jql；jira.comment=jira.add_comment；sessions.dispatch=创建/唤醒会话。只勾脚本真正要用的'),
        })
        .optional()
        .describe('executionMode="script" 时必填。仅在 script 模式下生效'),
      cronExpr: z
        .string()
        .min(1)
        .describe('5 字段 cron，例 "0 9 * * *"（每天 9 点）/ "*/15 * * * *"（每 15 分钟）/ "0 9 * * 1-5"（工作日 9 点）'),
      intervalMs: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('相对间隔毫秒。设置后优先于 cronExpr：首次触发为创建时间 + intervalMs，后续为上次完成 + intervalMs；cronExpr 仍用于展示/档位表达。例：每 10 分钟传 600000。'),
      timezone: z
        .string()
        .min(1)
        .describe('IANA 时区 id，例 "Asia/Shanghai" / "America/New_York"'),
      recurring: z
        .boolean()
        .describe('true=循环触发；false=触发一次后置 expired'),
      agentKind: z.enum(AGENT_KIND).describe('claude-code 或 codex'),
      kind: z
        .literal('cron')
        .default('cron')
        .describe('调度类型（当前只有 cron）'),
      model: z
        .string()
        .optional()
        .describe('agent model，例 "claude-sonnet-4-6" / "gpt-5"。heartbeat 模式忽略此字段'),
      providerId: z
        .string()
        .optional()
        .describe(
          '可选：显式指定模型来源(供应商)id，例 "anthropic" / "openai" / "xd"。' +
            '省略 → 走该 agent 原生默认来源（与不带本字段的旧行为字节级一致）。' +
            '只有要把任务钉在某个非原生来源（如 Anthropic 订阅档）时才传；heartbeat 模式留空则沿用绑定会话的来源。',
        ),
      effort: z
        .enum(EFFORT)
        .optional()
        .describe('codex effort 档位；非白名单值会被 INVALID_ARGS 拦下。heartbeat 模式忽略'),
      workingDir: z
        .string()
        .optional()
        .describe('agent 工作目录（绝对路径）。heartbeat 模式忽略此字段'),
      useWorktree: z
        .boolean()
        .default(false)
        .describe('true 时给本次触发开 ephemeral git worktree；session.close 时自动清'),
      targetSessionId: z
        .string()
        .optional()
        .describe('heartbeat 模式：把 prompt 注入到已存 session（id 必须存在且 status=active）。跟进**当前对话**请改用 bindToCurrentSession,不要自己查 / 抄 session id。'),
      bindToCurrentSession: z
        .boolean()
        .optional()
        .describe('true → 由代码把 targetSessionId 自动绑定为**当前调用方会话**(跟进"这条对话"的标准用法)。设了它就别再传 targetSessionId,也无需调 get_current_session_id —— 避免 agent 复用上下文里过期的 session id 绑错会话。无法识别当前会话时本工具报错而非绑错。'),
      persistentSession: z
        .boolean()
        .optional()
        .describe('true → 第一次 fire 后自动把新建 session 的 id 回写到 targetSessionId,后续 fire 持续在同一 session 中运行（拥有完整上下文）。默认 false。'),
      silentWhenIdle: z
        .boolean()
        .optional()
        .describe('静默运行:true → 成功 run 默认不通知、不产生未读红点;任务 prompt 可自行说明哪些条件需要提醒,agent 满足条件时调用 schedule_notify_current_run 主动上报。失败轮仍会通知。默认 false。'),
      preRunHook: z
        .object({
          command: z
            .string()
            .min(1)
            .describe('经系统 shell 执行的命令（cwd=任务工作目录）。exit 0 放行本轮；exit 2 跳过本轮（不启动 agent、零 token，run 记 skipped）；其它异常/超时阻止本轮并将 run 记 failed。Windows 写显式解释器（node x.mjs）。'),
          timeoutMs: z
            .number()
            .int()
            .positive()
            .optional()
            .describe('超时毫秒，可选；未配置则不限时（脚本卡死会阻塞该轮触发）；超时会阻止本轮并将 run 记 failed'),
        })
        .optional()
        .describe('前置检查脚本（Pre-run Hook）。轮询型任务用它把"要不要跑"判断放到脚本里，空转轮次直接跳过不烧 token。建议流程：先写脚本→自测 exit code→再挂到任务上。'),
      notify: z
        .object({
          desktop: z.boolean().describe('完成时弹桌面通知'),
          feishu: z.boolean().describe('完成时发飞书消息（当前 desktop notifier 飞书分支只 log，详见 Phase 3 changelog L1296）'),
        })
        .describe('通知开关，必填；典型默认 {desktop:true, feishu:false}'),
      expireAt: z
        .number()
        .int()
        .optional()
        .describe('Unix ms 截止时间戳（可选）；超过后 scheduler 不再触发'),
    },
    handler: async (args) =>
      withScheduler(deps, async (scheduler) => {
        const { bindToCurrentSession, ...rest } = args as CreateScheduleInput & {
          bindToCurrentSession?: boolean;
        };
        let input = rest as CreateScheduleInput;
        // script 模式工具层前置校验(引擎也校验,这里保证报错落 INVALID_PARAMS 且
        // 消息可直接指导模型自纠;agent 模式则补回 prompt 非空校验——schema 里
        // prompt 已放宽为 optional 以兼容 script 模式)。
        if ((input.executionMode ?? 'agent') === 'script') {
          if (!input.scriptConfig?.command?.trim()) {
            throw new Error('invalid request: executionMode="script" 需要 scriptConfig.command');
          }
          if (!(input.workingDir ?? '').trim()) {
            throw new Error('invalid request: executionMode="script" 需要 workingDir(本地项目绝对路径)');
          }
          if (input.useWorktree || input.targetSessionId || bindToCurrentSession || input.persistentSession) {
            throw new Error(
              'invalid request: script 模式不支持 useWorktree / targetSessionId / bindToCurrentSession / persistentSession',
            );
          }
          input = { ...input, prompt: input.prompt ?? '', workspaceKind: 'project' };
        } else if (!input.prompt?.trim()) {
          throw new Error('invalid request: prompt 不能为空(agent 模式必填)');
        }
        if (input.intervalMs !== undefined) {
          // intervalMs 模式下引擎不解析 cronExpr / timezone,工具层补回这道校验,
          // 避免非法 cron / timezone 被静默落库(详见 assertCronAndTimezoneValid)。
          assertCronAndTimezoneValid(input.cronExpr, input.timezone);
        }
        if (bindToCurrentSession) {
          // 代码确定地把"跟进当前对话"翻成 targetSessionId,杜绝 agent 复用上下文里
          // 过期的 session id 绑错会话(fork / 接管场景尤其容易踩)。识别不到当前会话
          // 时报错(消息含 "invalid" → INVALID_PARAMS)而非静默绑错。
          const sessionId = getSessionContext?.().sessionId;
          if (!sessionId) {
            throw new Error(
              'invalid request: bindToCurrentSession 无法解析当前会话(没有可用的 session 上下文);如确需绑定,请改用显式 targetSessionId',
            );
          }
          input = { ...input, targetSessionId: sessionId };
        }
        if (input.preRunHook?.command?.trim()) {
          if (!deps.hookScript?.stabilizeCommand) {
            throw new Error(
              'invalid request: 当前 host 未提供 pre-run hook 路径稳定化服务，拒绝持久化可能随 cwd 漂移的脚本命令',
            );
          }
          input = await stabilizePreRunHookForCreate(input, {
            resolveSessionWorkDir:
              deps.hookScript.resolveSessionWorkDir ?? (async () => undefined),
            stabilizeCommand: deps.hookScript.stabilizeCommand,
          });
        }
        return scheduler.create(input);
      }),
  });
}
