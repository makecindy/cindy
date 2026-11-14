import { z } from 'zod';

import type { SchedulerMcpDeps } from '../types.js';

/** 发送方；具体校验在引擎里做，与界面同一份规则。 */
export const webhookSourceSchema = z
  .strictObject({
    preset: z.string().min(1).max(32),
    signed: z.boolean().optional(),
    format: z.record(z.string(), z.unknown()).optional(),
    repositories: z.array(z.string().min(1).max(140)).min(1).max(50).optional(),
  })
  .optional()
  .describe(
    '发送方。preset=github-app 使用已连接的 Cindy GitHub App，repositories 必填仓库名列表（owner/repository），无需单独配置地址或密钥；'
      + '普通 Webhook 的 preset：github（默认）/ gitea / bitbucket / linear / gitlab / gitlab-token / standard-webhooks / stripe；'
      + 'signed=false 关闭签名（拿到地址的人都能触发）；preset=custom 时用 format 给出格式描述。省略 = 不修改',
  );

/** 使用 Webhook 必须有 Cindy 账号；开启后收不到事件比直接报错更难发现。 */
export function assertWebhookReceiverAvailable(deps: Pick<SchedulerMcpDeps, 'webhookReceiver'>): void {
  const receiver = deps.webhookReceiver?.();
  if (receiver === 'signed-out') {
    throw new Error('invalid request: Webhook 触发需要登录 Cindy 账号');
  }
  if (receiver === 'unavailable') {
    throw new Error('invalid request: 当前环境没有可用的 Webhook 接收服务');
  }
}
