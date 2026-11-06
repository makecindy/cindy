import { z } from 'zod';
import type { SchedulerMcpDeps } from '../types.js';
import type { SchedulerToolRegistry } from '../cindy_schedulerToolRegistry.js';
import { withScheduler } from './_shared.js';
import { runOnDevice, writeDeviceShape } from './_devices.js';

export function registerScheduleWebhookTools(registry: SchedulerToolRegistry, deps: SchedulerMcpDeps): void {
  const service = deps.webhookManagement;
  if (!service) return;
  registry.register({
    name: 'schedule_webhook_list', category: 'scheduler',
    description: '查看当前账号所有电脑的 Webhook 接收地址、已用与上限、所属自动化和最近接收时间，不含密钥。电脑离线也能查。',
    inputShape: {}, handler: () => withScheduler(deps, () => service.list()),
  });
  registry.register({
    name: 'schedule_webhook_release', category: 'scheduler',
    description: '释放账号清单中的一个 Webhook 接收地址及名额，旧电脑离线也能执行。旧地址、密钥和服务器暂存事件失效，旧电脑重连不会自动恢复；自动化和运行记录保留。核对目标与授权后调用，结果未知时先重新查清单。',
    inputShape: { id: z.string().regex(/^whk_[A-Za-z0-9_-]{1,128}$/).describe('schedule_webhook_list 返回的地址 id') },
    handler: ({ id }) => withScheduler(deps, async () => { await service.release(id); return { released: id }; }),
  });
  registry.register({
    name: 'schedule_webhook_restore', category: 'scheduler',
    description: '为已释放地址的自动化重新连接 Webhook，需有剩余名额。生成新地址后要在界面配置密钥并更新发送方；不读取或返回密钥。默认本机，其它电脑传 device，目标电脑需在线。',
    inputShape: { id: z.string().min(1).max(128).describe('自动化的 schedule id'), ...writeDeviceShape },
    handler: ({ id, device }) => runOnDevice(deps, device, async () => {
      await service.restore(id); return { restored: id };
    }, { op: 'webhook-restore', args: [id], map: () => ({ restored: id }) }),
  });
}
