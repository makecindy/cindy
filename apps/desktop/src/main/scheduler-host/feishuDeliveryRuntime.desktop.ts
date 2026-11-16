import { z } from 'zod';
import { eq } from 'drizzle-orm';
import type { FeishuIM } from '@cindy/im';
import type { Scheduler } from '@cindy/maker-scheduler';
import { activeOwnerScopeKey, isAppSessionBoundaryPending, ownerScopedUserDataPath } from '../appSessionState.js';
import { createOverrideSettingsFile } from '../maker-host/override-settings-file.js';
import { createLogger } from '../logger.js';
import { getDbClient } from '../localDb/client/current.js';
import { sessions } from '../localDb/schema.js';
import { captureTaskActionSyncGuard } from '../maker-ipc/taskActionAuthorization.js';
import { captureImAccountGeneration, isImAccountGenerationCurrent, runInImAccountGeneration } from '../im/accountBoundary.js';
import { getBotFeishuTransport } from '../im/shared/botImConnectionRuntime.js';
import { createFeishuTransportResolver } from '../mcp-integrations/feishuTransportRouting.js';
import { FeishuScheduleDelivery, type FeishuDeliveryState } from './feishuDelivery.js';

const log = createLogger('scheduler-feishu-delivery');
const identity = z.object({ appId: z.string().min(1), ownerOpenId: z.string().min(1), service: z.enum(['feishu', 'lark']) });
const binding = z.object({ revision: z.string().min(1), sessionId: z.string().min(1), identity,
  chatIds: z.array(z.string().regex(/^oc_[A-Za-z0-9_-]{1,128}$/)).max(10) });
const receipt = z.object({ scheduleId: z.string(), runId: z.string(), chatId: z.string(), revision: z.string(), uuid: z.string(),
  card: z.unknown().optional(), state: z.enum(['pending', 'sending', 'sent', 'failed', 'unknown']),
  attempts: z.number().int().nonnegative(), nextAt: z.number().finite(), firstAttemptAt: z.number().finite().optional(),
  leaseUntil: z.number().finite().optional(), messageId: z.string().optional(), code: z.number().optional(), error: z.string().optional() });
const schema = z.object({ bindings: z.record(z.string(), binding), receipts: z.record(z.string(), receipt) });
const store = createOverrideSettingsFile<FeishuDeliveryState>({
  filePath: () => ownerScopedUserDataPath('scheduler-feishu-delivery.json'), scopeKey: activeOwnerScopeKey,
  defaults: { bindings: {}, receipts: {} }, normalize: raw => schema.parse(raw),
  preserveUnreadableFile: true, logLoadedValue: false, logReadErrorDetails: false,
  log, label: 'scheduler-feishu-delivery', maxBytes: 8 * 1024 * 1024,
});

let service: FeishuScheduleDelivery | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let epoch = 0;
export function getFeishuScheduleDelivery(): FeishuScheduleDelivery {
  if (!service) throw new Error('Feishu scheduled delivery is unavailable on this host');
  return service;
}

/** Desktop adapter: the normal scheduler lifecycle owns recovery; no extra credentials. */
export function startFeishuScheduleDelivery(scheduler: Scheduler, personalIm: FeishuIM, passive: boolean): void {
  stopFeishuScheduleDelivery();
  const startedEpoch = epoch;
  const resolver = createFeishuTransportResolver({ readTurnScope: () => null,
    getCompanionTransport: getBotFeishuTransport, personalIm, includeBotLanes: true });
  service = new FeishuScheduleDelivery({
    captureConfigurationGuard: captureTaskActionSyncGuard,
    store: { read: () => store.readStrict(), update: async fn => {
      await store.updateAtomic(({ value }) => fn(value));
    } },
    captureGuard() {
      const owner = activeOwnerScopeKey();
      const generation = captureImAccountGeneration();
      const guard = () => {
        if (epoch !== startedEpoch || generation === null || !isImAccountGenerationCurrent(generation)
          || isAppSessionBoundaryPending() || activeOwnerScopeKey() !== owner)
          throw new Error('Feishu scheduled delivery account changed');
      };
      guard(); return guard;
    },
    getSchedule: async id => {
      const schedule = await scheduler.get(id);
      if (!schedule?.targetSessionId) return schedule;
      const [target] = await getDbClient().drizzle.select({ status: sessions.status })
        .from(sessions).where(eq(sessions.id, schedule.targetSessionId)).limit(1);
      return target?.status === 'active' ? schedule : null;
    },
    resolve: async sessionId => {
      const resolved = await resolver({ sessionId });
      resolved.assertCurrent();
      const im = resolved.im;
      const appId = im.getBotAppId();
      const ownerOpenId = im.getOwnerOpenId();
      const serviceKind = im.getService();
      if (!appId || !ownerOpenId) throw new Error('Feishu connection is unavailable');
      const assertCurrent = () => {
        resolved.assertCurrent();
        if (im.getBotAppId() !== appId || im.getOwnerOpenId() !== ownerOpenId || im.getService() !== serviceKind)
          throw new Error('Feishu connection changed');
      };
      return { identity: { appId, ownerOpenId, service: serviceKind }, assertCurrent,
        checkChat: async chatId => { await im.getChatInfo(chatId); assertCurrent(); },
        send: async (chatId, card, uuid) => {
          assertCurrent();
          const generation = captureImAccountGeneration();
          if (generation === null) throw new Error('Feishu connection is unavailable');
          return runInImAccountGeneration(generation, async () => {
            assertCurrent();
            try {
              const response = await im.callApi({ method: 'POST', path: '/open-apis/im/v1/messages',
                params: { receive_id_type: 'chat_id' }, data: { receive_id: chatId,
                  msg_type: 'interactive', content: JSON.stringify(card), uuid } });
              const data = response.data as { message_id?: unknown } | undefined;
              if (typeof response.code !== 'number') throw new Error('Feishu response has no business code');
              return { code: response.code,
                messageId: typeof data?.message_id === 'string' ? data.message_id : undefined };
            } catch (error) {
              const code = (error as { code?: unknown })?.code;
              if (typeof code === 'number') return { code };
              throw error;
            }
          });
        } };
    },
  });
  const flush = () => { void Promise.resolve().then(() => service?.flush())
    .catch(() => log.warn('Feishu scheduled delivery recovery deferred')); };
  if (!passive) { flush(); timer = setInterval(flush, 60_000); timer.unref(); }
}

export function stopFeishuScheduleDelivery(): void {
  epoch++;
  if (timer) clearInterval(timer);
  timer = undefined; service = undefined;
}
