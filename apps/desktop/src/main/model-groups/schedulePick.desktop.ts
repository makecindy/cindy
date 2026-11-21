/**
 * 定时任务按模式选来源的桌面装配：选路用本机的模型组解析器，说明写在这次运行发出的那条消息下面。
 * 依赖都是顶层静态导入(architecture-invariants §2)；解析器只在端口函数里读，模块加载时不调用。
 */
import { and, eq } from 'drizzle-orm';

import { getResolvedMainLocale, t } from '../i18n.desktop.js';
import { createLogger } from '../logger.js';
import { getDbClient } from '../localDb/client/current.js';
import { createMessage } from '../localDb/ipc/messages.js';
import { messages, sessions } from '../localDb/schema.js';
import { resolver } from './desktopResolver.js';
import { bindModelGroupSession } from './sessionBindings.js';
import { createScheduleModelGroupPicker } from './schedulePick.js';

const log = createLogger('model-groups:schedule');

/** 这次运行的消息由 main 在开跑时才落库：最多等 10 秒。 */
const NOTE_WAIT_ATTEMPTS = 40;
const NOTE_WAIT_STEP_MS = 250;

async function userMessageAt(sessionId: string, clientId: string): Promise<number | null> {
  const [row] = await getDbClient().drizzle.select({ createdAt: messages.createdAt }).from(messages)
    .where(and(eq(messages.sessionId, sessionId), eq(messages.clientId, clientId), eq(messages.role, 'user')))
    .limit(1);
  const value = row?.createdAt as unknown;
  const at = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(at) ? at : null;
}

export function createDesktopScheduleModelGroupPicker() {
  return createScheduleModelGroupPicker({
    resolve: (request) => resolver.resolve(request),
    commit: (decisionId) => {
      try {
        resolver.commit(decisionId);
      } catch (error) {
        log.warn('schedule model group commit failed', { error: String(error) });
      }
    },
    bind: bindModelGroupSession,
    sessionLocation: async (sessionId) => {
      const [row] = await getDbClient().drizzle
        .select({ agentDeviceId: sessions.agentDeviceId, remoteHostId: sessions.remoteHostId, status: sessions.status })
        .from(sessions).where(eq(sessions.id, sessionId)).limit(1);
      // 已删除的任务 runner 不复用(持续任务会新建)：按新建任务选。
      return row && row.status !== 'deleted'
        ? { agentDeviceId: row.agentDeviceId ?? null, ssh: !!row.remoteHostId }
        : undefined;
    },
    writeNote: (sessionId, note, { clientId, messageClientId }) => {
      void (async () => {
        let createdAt: number | undefined;
        for (let attempt = 0; attempt < NOTE_WAIT_ATTEMPTS && createdAt === undefined; attempt += 1) {
          const anchorId = messageClientId();
          const userAt = anchorId ? await userMessageAt(sessionId, anchorId).catch(() => null) : null;
          if (userAt !== null) createdAt = userAt + 1;
          else await new Promise((resolve) => setTimeout(resolve, NOTE_WAIT_STEP_MS));
        }
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
