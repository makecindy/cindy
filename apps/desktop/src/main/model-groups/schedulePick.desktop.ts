/**
 * 定时任务按模式选来源的桌面装配：选路用本机的模型组解析器；选路模块在第一次用到时才加载，
 * 不拖慢定时任务的启动。说明写在这次运行发出的那条消息下面。
 */
import { and, asc, eq, gte } from 'drizzle-orm';

import { getResolvedMainLocale, t } from '../i18n.desktop.js';
import { createLogger } from '../logger.js';
import { getDbClient } from '../localDb/client/current.js';
import { messages, sessions } from '../localDb/schema.js';
import { bindModelGroupSession } from './sessionBindings.js';
import { createScheduleModelGroupPicker } from './schedulePick.js';

const log = createLogger('model-groups:schedule');

/** 这次运行的消息由 main 在开跑时才落库：最多等 10 秒。 */
const NOTE_WAIT_ATTEMPTS = 40;
const NOTE_WAIT_STEP_MS = 250;

const loadResolver = () => import('./desktopResolver.js').then((module) => module.resolver);

async function userMessageAtOrAfter(sessionId: string, sinceMs: number): Promise<number | null> {
  const [row] = await getDbClient().drizzle.select({ createdAt: messages.createdAt }).from(messages)
    .where(and(eq(messages.sessionId, sessionId), eq(messages.role, 'user'), gte(messages.createdAt, sinceMs)))
    .orderBy(asc(messages.createdAt)).limit(1);
  const value = row?.createdAt as unknown;
  const at = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(at) ? at : null;
}

export function createDesktopScheduleModelGroupPicker() {
  return createScheduleModelGroupPicker({
    resolve: async (request) => (await loadResolver()).resolve(request),
    commit: (decisionId) => {
      void loadResolver().then((resolver) => resolver.commit(decisionId))
        .catch((error: unknown) => log.warn('schedule model group commit failed', { error: String(error) }));
    },
    bind: bindModelGroupSession,
    sessionLocation: async (sessionId) => {
      const [row] = await getDbClient().drizzle.select({ agentDeviceId: sessions.agentDeviceId }).from(sessions)
        .where(eq(sessions.id, sessionId)).limit(1);
      return row ? (row.agentDeviceId ?? null) : undefined;
    },
    writeNote: (sessionId, note, { clientId, sinceMs }) => {
      void (async () => {
        let createdAt: number | undefined;
        for (let attempt = 0; attempt < NOTE_WAIT_ATTEMPTS && createdAt === undefined; attempt += 1) {
          const userAt = await userMessageAtOrAfter(sessionId, sinceMs).catch(() => null);
          if (userAt !== null) createdAt = userAt + 1;
          else await new Promise((resolve) => setTimeout(resolve, NOTE_WAIT_STEP_MS));
        }
        const { createMessage } = await import('../localDb/ipc/messages.js');
        await createMessage(sessionId, {
          clientId,
          role: 'assistant',
          content: '',
          agentMeta: { pluginModelRoute: note } as never,
          ...(createdAt !== undefined ? { createdAt } : {}),
        });
      })().catch((error: unknown) => log.warn('schedule model group note failed', { sessionId, error: String(error) }));
    },
    t: (key, values) => t(key as never, values as never) as string,
    locale: getResolvedMainLocale,
    // 主进程没有其他电脑的名单：写「另一台电脑」，与界面里名单查不到时的写法相同。
    locationName: () => t('bots.cloud.unknownDevice' as never) as string,
    now: Date.now,
  });
}
