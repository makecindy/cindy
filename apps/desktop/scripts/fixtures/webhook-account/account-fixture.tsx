import { mountPage } from '../../ui-page/harness';
import { WebhookAccountManager } from '../../../src/renderer/features/scheduler/components/WebhookAccountManager';

const entries = [
  { id: 'whk_current', scheduleId: 'current', scheduleName: '仓库动态提醒', deviceId: 'current-pc', deviceName: '工作电脑', currentDevice: true, lastReceivedAt: '2026-11-04T07:45:00.000Z' },
  { id: 'whk_old', scheduleId: 'old', scheduleName: '每日项目巡检', deviceId: 'old-pc', deviceName: '以前的电脑', currentDevice: false, lastReceivedAt: '2026-10-01T02:00:00.000Z' },
  { id: 'whk_unknown', scheduleId: 'unnamed', scheduleName: null, deviceId: 'old-pc', deviceName: '以前的电脑', currentDevice: false, lastReceivedAt: null },
].map((item) => ({ ...item, url: `https://webhook.example.test/hooks/${item.id}`, status: 'active' }));
let endpoints = [...entries];
mountPage({
  route: '/cc-agent/scheduled',
  host: { maker: { schedule: {
    webhookReceiver: async () => 'cloud',
    webhookAccount: async () => ({ used: endpoints.length, limit: 10, endpoints }),
    releaseWebhookEndpoint: async (id: string) => { endpoints = endpoints.filter((item) => item.id !== id); },
  } } },
  render: () => <div className="mx-auto mt-8 max-w-xl p-4"><WebhookAccountManager /></div>,
});
