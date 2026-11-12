/** 进程级入口：把账号、端点清单和代理接到 ScheduleWebhookHost。 */
import { app, BrowserWindow, Notification } from 'electron';
import type { Scheduler } from '@cindy/maker-scheduler';
import { ScheduleWebhookHost, type ScheduleWebhookReceiver } from './index.js';
import type { RemoteWebhookQuota } from './remote.js';
import { deviceName } from '../../device-link/deviceName.js';

type Logger = ConstructorParameters<typeof ScheduleWebhookHost>[1];

let host: ScheduleWebhookHost | null = null;
let generation = 0;
let stopWatchingAuth: (() => void) | null = null;
/** 持有引用，否则通知对象被回收后点击事件不会触发。 */
let quotaNotification: Notification | null = null;

/** 本机接收服务只给开发联调：正式版没有这个入口，使用 Webhook 必须有 Cindy 账号。 */
function localIngressEnabled(): boolean {
  return !app.isPackaged && process.env.XDT_SCHEDULE_WEBHOOK_LOCAL === '1';
}

/** 发送方的 429 用户看不到，不主动提醒的话任务会悄悄停到第二天。 */
async function notifyQuotaExhausted({ limit, resetAt }: RemoteWebhookQuota): Promise<void> {
  const [{ getDesktopNotificationsEnabled }, { t }] = await Promise.all([
    import('../../notificationService.js'),
    import('../../i18n.desktop.js'),
  ]);
  if (!getDesktopNotificationsEnabled() || !Notification.isSupported()) return;
  const body = t('scheduler.webhook.quotaExhausted')
    .replaceAll('{{limit}}', String(limit))
    .replaceAll('{{time}}', new Date(resetAt).toLocaleString());
  const notification = new Notification({ title: t('scheduler.webhook.quotaNotifyTitle'), body });
  quotaNotification = notification;
  const release = () => {
    if (quotaNotification === notification) quotaNotification = null;
  };
  notification.on('click', () => {
    const window = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
    if (window?.isMinimized()) window.restore();
    window?.show();
    window?.focus();
    release();
  });
  notification.on('close', release);
  notification.on('failed', release);
  notification.show();
}

export async function startScheduleWebhooks(scheduler: Scheduler, logger: Logger): Promise<void> {
  if (host) return;
  const startingGeneration = generation;
  // 账号模块在加载时就读 Electron 路径；调度器不该因此依赖它们的初始化顺序。
  const [authManager, { getAppCapabilities }, { getClientEndpoint }, { createOutboundHttpAgent, outboundFetch }] =
    await Promise.all([
      import('../../authManager.js'),
      import('../../appCapabilities.js'),
      import('../../clientEndpointsService.js'),
      import('../../maker-host/outbound-fetch.desktop.js'),
    ]);
  if (host || startingGeneration !== generation) return;
  const isSignedIn = (): boolean => getAppCapabilities().canUseCindyAccountServices;
  const next = new ScheduleWebhookHost(scheduler, logger, {
    local: localIngressEnabled(),
    onQuotaExhausted: (quota) => {
      void notifyQuotaExhausted(quota).catch((error: unknown) => {
        logger.warn?.('[schedule-webhook] quota notification failed', { error: String(error) });
      });
    },
    remote: {
      githubPrHeads: async urls => {
        const { githubPrHeads } = await import('../../git-context/ipc.js');
        return githubPrHeads(urls);
      },
      onGithubPrs: async (urls, isCurrent, refresh) => {
        const { notifyGithubPrEvents } = await import('../../git-context/ipc.js');
        await notifyGithubPrEvents(urls, isCurrent, refresh);
      },
      deviceName,
      isSignedIn,
      baseUrl: () => getClientEndpoint('webhookApiBaseUrl'),
      getAccessToken: async () => {
        if (!isSignedIn()) return null;
        const token = authManager.getAccessToken();
        if (token) return token;
        const refreshed = await authManager.refresh().catch(() => false);
        return refreshed ? authManager.getAccessToken() : null;
      },
      refreshAccessToken: () => (isSignedIn() ? authManager.refresh().catch(() => false) : Promise.resolve(false)),
      fetch: outboundFetch,
      socketOptions: async (url) => ({ agent: await createOutboundHttpAgent(url) }),
      logger,
    },
  });
  host = next;
  let ownerGeneration = authManager.getAuthState().ownerGeneration;
  stopWatchingAuth = authManager.onAuthStateChange((state) => {
    const changed = ownerGeneration !== state.ownerGeneration || !state.isAuthenticated;
    ownerGeneration = state.ownerGeneration;
    next.authChanged(changed);
  });
  try {
    await next.start();
  } catch (error) {
    // A delayed rejection from a stopped owner must not tear down its successor.
    if (host === next) {
      try {
        await stopScheduleWebhooks();
      } catch (stopError) {
        logger.warn?.('[schedule-webhook] failed startup cleanup failed', { error: String(stopError) });
      }
    }
    throw error;
  }
}

export async function stopScheduleWebhooks(): Promise<void> {
  generation += 1;
  const current = host;
  host = null;
  stopWatchingAuth?.();
  stopWatchingAuth = null;
  await current?.stop();
}

export function getScheduleWebhookHost(): ScheduleWebhookHost | null {
  return host;
}

export function scheduleWebhookReceiver(): ScheduleWebhookReceiver {
  return host?.receiver() ?? 'unavailable';
}
