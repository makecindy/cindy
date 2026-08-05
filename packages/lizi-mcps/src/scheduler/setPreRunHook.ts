/**
 * scheduler/setPreRunHook.ts — schedule_set_pre_run_hook tool
 *
 * 前置检查脚本(preRunHook)的**唯一创建/修改通道**:聊天路径的 agent 与 UI
 * 「AI 生成」按钮共用 host 注入的同一套安装服务(落盘路径规范、命令拼装、
 * 落盘后自测全部由 host 代码保证)——agent 不需要也不应该自己 Write 脚本
 * 文件再手填 preRunHook.command。
 *
 * 两种输入模式(至少给一个,都给时 script 优先):
 *   - script:      agent 自己写好的脚本内容(有项目上下文,通常更准)
 *   - description: 自然语言需求,由 host 侧 utility model 生成(与 UI 同通道)
 *
 * 传 scheduleId 时:自动从该任务继承 workingDir / scheduleName / 现有命令
 * (修改流覆写同一文件),安装成功后直接把命令挂载到任务上——上下文继承与
 * 挂载都是代码确定性完成,不依赖 agent 传对参数。
 *
 * host 未注入 hookScript 服务时本工具不注册(见 cindy_schedulerMcpServer.ts)。
 */

import { z } from 'zod';

import { withScheduler } from './_shared.js';
import type { SchedulerMcpDeps } from '../types.js';
import type { SchedulerToolRegistry } from '../cindy_schedulerToolRegistry.js';

/** 返回给 agent 的脚本内容上限:自测结果与命令才是关键,正文超长截断防刷上下文。 */
const CONTENT_PREVIEW_CAP = 4000;

export function registerScheduleSetPreRunHookTool(
  registry: SchedulerToolRegistry,
  deps: SchedulerMcpDeps,
): void {
  const hookScript = deps.hookScript;
  if (!hookScript) return;
  registry.register({
    name: 'schedule_set_pre_run_hook',
    category: 'scheduler',
    description:
      '创建/修改一条 schedule 的前置检查脚本(preRunHook)的**唯一通道**——不要自己写脚本文件再手填 preRunHook.command,本工具由宿主代码统一保证:脚本协议(exit 0 放行 / exit 2 跳过 / 其它异常 fail-closed 阻止本轮)、落盘路径规范(项目任务进 scripts/schedule-checks/,无目录任务进应用数据目录)、落盘后**立即自测**并返回完整结果。' +
      '用法:(1) 传 scheduleId → 自动继承该任务的目录/名称/现有脚本(修改流覆写同一文件),安装成功后直接挂载到任务;不传则只落盘返回 command,由你随后在 schedule_create 里带上。' +
      '(2) script 与 description 至少给一个:你有项目上下文时**优先自己写好 script**(Node ESM,只用 node 内置模块,外部 CLI 用 child_process；意外失败必须非零退出以阻止本轮);只有需求很通用时才用 description 让宿主生成。' +
      '(3) 返回的 test 字段是刚跑完的自测结果——决策不符合预期(比如该放行却 skip)就修了再来,不要把没自测通过的脚本留给任务。',
    inputShape: {
      scheduleId: z
        .string()
        .optional()
        .describe('目标任务 id。传了 → 自动继承任务的 workingDir/名称/现有命令,并在安装后直接挂载;不传 → 只落盘返回 command'),
      script: z
        .string()
        .optional()
        .describe('你写好的脚本内容(Node ESM)。协议:exit 0 放行 / exit 2 跳过 / 其它异常阻止本轮;只用 node 内置模块;外部 CLI 意外失败必须非零退出'),
      description: z
        .string()
        .optional()
        .describe('自然语言需求(如"仓库有新的未处理 PR 才运行"),由宿主 utility model 生成脚本。与 script 二选一,都给时 script 优先'),
      workingDir: z
        .string()
        .optional()
        .describe('落盘/执行目录(绝对路径)。传了 scheduleId 时自动继承,无需再传'),
      scheduleName: z
        .string()
        .optional()
        .describe('任务名(用于脚本文件命名)。传了 scheduleId 时自动继承'),
    },
    handler: async (args) => {
      const {
        scheduleId,
        script,
        description,
        workingDir: argWorkingDir,
        scheduleName: argScheduleName,
      } = args as {
        scheduleId?: string;
        script?: string;
        description?: string;
        workingDir?: string;
        scheduleName?: string;
      };
      return withScheduler(deps, async (scheduler) => {
        // 校验放在 withScheduler 回调内:registry 只对回调内的异常走
        // classifySchedulerError('invalid' → INVALID_PARAMS),与 create.ts 同模式。
        if (!script?.trim() && !description?.trim()) {
          throw new Error('invalid request: script 与 description 至少提供一个');
        }
        // scheduleId 上下文继承:目录/名称/现有命令由代码从任务读,不靠 agent 传对
        let workingDir = argWorkingDir;
        let scheduleName = argScheduleName;
        let currentCommand: string | undefined;
        let currentTimeoutMs: number | undefined;
        let providerId: string | undefined;
        let agentKind: 'codex' | 'claude-code' | 'pi' | undefined;
        let model: string | undefined;
        if (scheduleId) {
          const schedule = await scheduler.get(scheduleId);
          if (!schedule) throw new Error(`Schedule not found: ${scheduleId}`);
          // 目录优先级:显式入参 > 绑定会话的 meta.workDir > schedule.workingDir。
          // 绑定会话(heartbeat)任务的 schedule.workingDir 通常为空(或"project
          // 任务改绑会话"后过期),不解析会话目录会把脚本落进 fallbackDir、自测
          // cwd 也与生产运行不一致。解析失败回落旧行为。
          if (!workingDir && schedule.targetSessionId && hookScript.resolveSessionWorkDir) {
            const sessionDir = await hookScript
              .resolveSessionWorkDir(schedule.targetSessionId)
              .catch(() => undefined);
            if (sessionDir?.trim()) workingDir = sessionDir;
          }
          workingDir = workingDir ?? schedule.workingDir;
          scheduleName = scheduleName ?? schedule.name;
          currentCommand = schedule.preRunHook?.command;
          currentTimeoutMs = schedule.preRunHook?.timeoutMs;
          providerId = schedule.providerId;
          agentKind = schedule.agentKind;
          model = schedule.model;
        }

        const installed = await hookScript.install({
          script,
          description,
          scheduleName,
          workingDir,
          currentCommand,
          providerId,
          agentKind,
          model,
        });

        let attached = false;
        if (scheduleId) {
          // preRunHook 是整对象替换语义(mapper 对 timeoutMs 缺失写 NULL):修改脚本
          // 不该动超时,显式带上任务现有 timeoutMs,否则用户显式设过的超时会被
          // 静默清掉(未配置 = 不限时,无默认超时)。
          await scheduler.update(scheduleId, {
            preRunHook: { command: installed.command, timeoutMs: currentTimeoutMs },
          });
          attached = true;
        }
        return {
          command: installed.command,
          filePath: installed.filePath,
          attached,
          test: installed.test,
          content:
            installed.content.length > CONTENT_PREVIEW_CAP
              ? `${installed.content.slice(0, CONTENT_PREVIEW_CAP)}…(truncated)`
              : installed.content,
          hint: attached
            ? '已挂载到任务。test 是刚执行的自测结果,决策不符合预期请修正脚本后重调本工具。'
            : '尚未挂载:在 schedule_create 的 preRunHook.command 里带上返回的 command,或传 scheduleId 重调本工具。',
        };
      });
    },
  });
}
