/**
 * 新建任务按模式选来源的桌面装配(sessionStart.ts)：选路用本机的模型组解析器，说明写在第一轮那条用户消息下面。
 * 依赖都是顶层静态导入(architecture-invariants §2)；端口都在调用时转调(§5)，模块加载时不取任何依赖的值。
 */
import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';

import { getResolvedMainLocale, t } from '../i18n.desktop.js';
import { createLogger } from '../logger.js';
import { getDbClient } from '../localDb/client/current.js';
import { createMessage } from '../localDb/ipc/messages.js';
import { messages } from '../localDb/schema.js';
import { resolver } from './desktopResolver.js';
import { bindModelGroupSession } from './sessionBindings.js';
import { createModelGroupSessionStart } from './sessionStart.js';

const log = createLogger('model-groups:session-start');

async function userMessageAt(sessionId: string, clientId: string): Promise<number | null> {
  const [row] = await getDbClient().drizzle.select({ createdAt: messages.createdAt }).from(messages)
    .where(and(eq(messages.sessionId, sessionId), eq(messages.clientId, clientId), eq(messages.role, 'user')))
    .limit(1);
  const value = row?.createdAt as unknown;
  const at = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(at) ? at : null;
}

export const modelGroupSessionStart = createModelGroupSessionStart({
  resolve: (request) => resolver.resolve(request),
  commit: (decisionId) => {
    try {
      resolver.commit(decisionId);
    } catch (error) {
      log.warn('model group start commit failed', { error: String(error) });
    }
  },
  bind: (sessionId, selection, pickedKey) => bindModelGroupSession(sessionId, selection, pickedKey),
  // 派发钩子在那条用户消息落库之后才调，直接按 clientId 找。
  writeNote: (sessionId, note, { clientId, anchorClientId }) => {
    void (async () => {
      const userAt = await userMessageAt(sessionId, anchorClientId).catch(() => null);
      await createMessage(sessionId, {
        clientId,
        role: 'assistant',
        content: '',
        agentMeta: { pluginModelRoute: note } as never,
        ...(userAt !== null ? { createdAt: userAt + 1 } : {}),
      });
    })().catch((error: unknown) => log.warn('model group start note failed', { sessionId, error: String(error) }));
  },
  t: (key, values) => t(key as never, values as never) as string,
  locale: () => getResolvedMainLocale(),
  // 主进程没有其他电脑的名单：写「另一台电脑」，与界面里名单查不到时的写法相同。
  locationName: () => t('bots.cloud.unknownDevice' as never) as string,
  now: () => Date.now(),
  createToken: () => randomUUID(),
});
