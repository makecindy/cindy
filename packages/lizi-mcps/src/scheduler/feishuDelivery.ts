import { z } from 'zod';
import type { SchedulerMcpDeps } from '../types.js';
import type { SchedulerToolRegistry } from '../cindy_schedulerToolRegistry.js';
import { withScheduler } from './_shared.js';

export function registerScheduleFeishuDeliveryTools(registry: SchedulerToolRegistry, deps: SchedulerMcpDeps): void {
  registry.register({
    name: 'schedule_set_feishu_delivery', category: 'scheduler',
    description: '设置本机自动化成功结果的飞书群投递。必须先获用户对这些群的明确授权；只发最终结果，不带任务上下文。宿主持久绑定该自动化所绑定任务的机器人身份，按群记录真实 message_id 和失败重试，不依赖飞书消息触发。chatIds=[] 撤销并取消待发内容；重新绑定不补发历史。须先绑定 targetSessionId；不改时间、模型或个人通知。其它电脑或旧宿主不支持时明确报错。',
    inputShape: { id: z.string().min(1), chatIds: z.array(z.string().regex(/^oc_[A-Za-z0-9_-]{1,128}$/)).max(10) },
    handler: ({ id, chatIds }) => withScheduler(deps, async () => {
      if (!deps.feishuDelivery) throw new Error('Feishu scheduled delivery is unavailable on this host');
      return { binding: await deps.feishuDelivery.configure(id, chatIds) };
    }),
  });
  registry.register({
    name: 'schedule_get_feishu_delivery', category: 'scheduler',
    description: '只读查看本机自动化已授权飞书群及最近 100 个按群的投递回执（code、messageId、重试、失败或结果未知），不读取群聊天、不返回报告正文。未收到回执不能当作已送达；结果未知且超出去重时限时不自动重发。',
    inputShape: { id: z.string().min(1) },
    handler: ({ id }) => withScheduler(deps, async () => {
      if (!deps.feishuDelivery) throw new Error('Feishu scheduled delivery is unavailable on this host');
      return deps.feishuDelivery.status(id);
    }),
  });
}
