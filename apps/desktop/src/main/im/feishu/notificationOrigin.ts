import { and, eq } from 'drizzle-orm';
import { createFeishuNotifications } from '@cindy/im-runtime/channels/feishu/notificationOrigin';
import { getDbClient } from '../../localDb/client/current';
import { imNotificationOrigins, sessions } from '../../localDb/schema';
import { createLogger } from '../../logger';
import * as account from '../accountBoundary';
const notifications = createFeishuNotifications({
  account, log: createLogger('im:feishu:notification'),
  captureStore: () => {
    const db = getDbClient();
    return {
      insert: async origin => { await db.drizzle.insert(imNotificationOrigins).values(origin); },
      find: async key => {
        const [row] = await db.drizzle.select({ sessionId: imNotificationOrigins.sessionId }).from(imNotificationOrigins).where(and(
          eq(imNotificationOrigins.channel, key.channel), eq(imNotificationOrigins.botContextId, key.botContextId),
          eq(imNotificationOrigins.userId, key.userId), eq(imNotificationOrigins.messageId, key.messageId), eq(imNotificationOrigins.chatId, key.chatId),
        )).limit(1);
        return row ?? null;
      },
      session: async id => {
        const [row] = await db.drizzle.select({ workingDir: sessions.workingDir, status: sessions.status, orcaRole: sessions.orcaRole })
          .from(sessions).where(eq(sessions.id, id)).limit(1);
        return row ?? null;
      },
    };
  },
});
export const { sendFeishuSessionNotification, resolveFeishuNotificationReply } = notifications;
