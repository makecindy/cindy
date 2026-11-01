/**
 * scheduler/listModels.ts — schedule_list_models tool
 *
 * 新建 / 修改本机定时任务前查可选的运行位置与模型:本机,以及同账号其它电脑与分享来的
 * 供应商(与模型面板同一份候选)。schedule_create / schedule_update 的 agentDeviceId、
 * model、providerId 取这里列出的值。host 未注入 listModels 时不注册。
 */

import { z } from 'zod';

import { AGENT_KIND } from './_enums.js';
import { buildJsonResult } from './_shared.js';
import type { SchedulerMcpDeps } from '../types.js';
import type { SchedulerToolRegistry } from '../cindy_schedulerToolRegistry.js';

/** MCP 侧本机位置的写法,与 schedule_create / schedule_update 的 agentDeviceId 同一口径。 */
export const LOCAL_SCHEDULE_AGENT_DEVICE = 'local';

export function registerScheduleListModelsTool(
  registry: SchedulerToolRegistry,
  deps: SchedulerMcpDeps,
): void {
  const listModels = deps.listModels;
  if (!listModels) return;
  registry.register({
    name: 'schedule_list_models',
    category: 'scheduler',
    description:
      '查本机定时任务可用的 Agent 运行位置与模型。不传 agentDeviceId 列本机的模型，并在 locations 里给出同账号其它在线电脑与分享来的供应商；传 locations[].agentDeviceId 列那里的模型。' +
      '要让任务每次新建时在别处运行：schedule_create / schedule_update 传同一个 agentDeviceId；model 取 codex / claude_code / pi 列表项的 id，providerId 取该模型 providers[].id（名称为 providers[].name，默认来源为 defaultProviderId）。' +
      '伙伴例行任务通过 cindy_helper 调用本工具，将同一组合保存到 routine_save.modelOverride（本机 agentDeviceId 用 null）；sessionMode 选 persistent 沿用上下文或 fresh 每次新建。' +
      'providers[].modelDetails 是该来源的实际目录资料，包含可用推理档位、速度及已知价格；cost 固定为 USD/百万 token；currency 只对应 displayPricing，优先按该来源展示报价与适用折扣比较。按任务能力与同币种价格推荐经济型号，不凭名称或前缀猜价格，缺价不等于免费，订阅参考价不等于实际扣费。保留用户已有选择，不批量改自动化。' +
      '只用于本机的定时任务；其它电脑上的定时任务不能设运行位置。',
    inputShape: {
      agent: z.enum(AGENT_KIND).optional().describe('只列某个 agent 的模型；不传列全部'),
      agentDeviceId: z
        .string()
        .min(1)
        .optional()
        .describe('列哪里的模型：locations[].agentDeviceId，或 "local"（本机，默认）'),
    },
    handler: async ({ agent, agentDeviceId }) => {
      const location = !agentDeviceId || agentDeviceId === LOCAL_SCHEDULE_AGENT_DEVICE ? null : agentDeviceId;
      try {
        const result = await listModels({ ...(agent ? { agent } : {}), agentDeviceId: location });
        if (!result.ok) {
          return buildJsonResult({ ok: false, code: result.errorCode, message: result.message }, true);
        }
        const { ok: _ok, agentDeviceId: listed, locations, ...models } = result;
        return buildJsonResult({
          ok: true,
          data: {
            agentDeviceId: listed ?? LOCAL_SCHEDULE_AGENT_DEVICE,
            locations: [
              { agentDeviceId: LOCAL_SCHEDULE_AGENT_DEVICE, name: 'local' },
              ...(locations ?? []),
            ],
            ...models,
          },
        });
      } catch (err) {
        return buildJsonResult(
          { ok: false, code: 'INTERNAL', message: err instanceof Error ? err.message : String(err) },
          true,
        );
      }
    },
  });
}
