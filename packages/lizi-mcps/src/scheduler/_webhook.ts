import { z } from 'zod';

import type { SchedulerMcpDeps } from '../types.js';

/** 发送方；具体校验在引擎里做，与界面同一份规则。 */
export const webhookSourceSchema = z
  .strictObject({
    preset: z.string().min(1).max(32),
    signed: z.boolean().optional(),
    format: z.record(z.string(), z.unknown()).optional(),
    repositories: z.array(z.string().min(1).max(140)).min(1).max(50).optional(),
    number: z.number().int().positive().optional().describe('仅 github-app：只看这个编号的 Issue（或 PR）的事件，此时 repositories 只能有一个。要按 PR 状态（合并、CI、评审）触发请改用 prTrigger'),
    sources: z.array(z.strictObject({
      plugin: z.string().min(1).max(512).describe('插件 id，取 schedule_list_event_sources 返回的 plugin'),
      events: z.array(z.string().min(1).max(128)).max(32).optional().describe('该插件声明的事件类型；省略 = 该插件的全部事件'),
      filters: z.array(z.strictObject({
        field: z.string().min(1).max(128).describe('插件声明的字段名'),
        operator: z.enum(['equals', 'contains', 'not-equals']),
        value: z.string().max(500),
      })).max(16).optional().describe('同一插件内的条件全部满足才触发；字段缺失时 equals / contains 不触发，not-equals 触发'),
    })).min(1).max(16).optional(),
  })
  .optional()
  .describe(
    '发送方。preset=plugin 使用本机已安装插件提供的事件（如收到消息、新邮件），sources 必填，先用 schedule_list_event_sources 查可选插件、事件与字段；'
      + '不需要 Cindy 账号、接收地址或密钥，事件只投给插件所在电脑上的自动化，此时不传顶层 events。插件不会替自动化过滤任何事件（包括自动化自己发出的消息），'
      + '要不要处理用 filters、前置检查或提示词决定；电脑休眠、关机或插件停用期间的事件收不到。'
      + 'preset=github-app 使用已连接的 Cindy GitHub App，repositories 必填仓库名列表（owner/repository），无需单独配置地址或密钥；'
      + '普通 Webhook 的 preset：github（默认）/ gitea / bitbucket / linear / gitlab / gitlab-token / standard-webhooks / stripe；'
      + 'signed=false 关闭签名（拿到地址的人都能触发）；preset=custom 时用 format 给出格式描述。省略 = 不修改',
  );

/**
 * 使用 Webhook 必须有 Cindy 账号；开启后收不到事件比直接报错更难发现。
 * 插件事件只在本机交接，不需要账号或接收服务。
 */
export function assertWebhookReceiverAvailable(
  deps: Pick<SchedulerMcpDeps, 'webhookReceiver'>,
  trigger?: { source?: { preset?: string } } | null,
): void {
  if (trigger?.source?.preset === 'plugin') return;
  const receiver = deps.webhookReceiver?.();
  if (receiver === 'signed-out') {
    throw new Error('invalid request: Webhook 触发需要登录 Cindy 账号');
  }
  if (receiver === 'unavailable') {
    throw new Error('invalid request: 当前环境没有可用的 Webhook 接收服务');
  }
}

export const schedulePrTriggerSchema = z.strictObject({
  url: z.string().url(),
  change: z.enum(['any', 'merged', 'review', 'ci']),
}).nullable().optional().describe('在指定 GitHub PR 变化时提前运行。any 包含评论和状态；merged 只在合并时，review 在评审时，ci 在检查变化时。可与重复定时检查并用。null 关闭 PR 提前触发。');
