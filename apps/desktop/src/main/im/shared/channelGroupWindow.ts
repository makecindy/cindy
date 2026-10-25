import { eq, sql } from 'drizzle-orm';
import { getDbClient } from '../../localDb/client/current';
import { hookGroupMessages } from '../../localDb/schema';
import { createLogger } from '../../logger';
import * as core from './groupWindowCore';
import { createChannelGroupWindow as createSharedWindow } from '@cindy/im-runtime/channelGroupWindow';
export { sanitizeGroupWindowName } from '@cindy/im-runtime/channelGroupWindow';
export type { ChannelGroupWindow, ChannelGroupWindowEntry, ChannelGroupContextArgs } from '@cindy/im-runtime/channelGroupWindow';
export function createChannelGroupWindow(options: Parameters<typeof createSharedWindow>[0]) {
  return createSharedWindow(options, { core, listKnownGroups: async provider => {
    const rows = await getDbClient().drizzle.select({ chatId: hookGroupMessages.chatId, chatName: sql<string | null>`max(${hookGroupMessages.chatName})` })
      .from(hookGroupMessages).where(eq(hookGroupMessages.provider, provider)).groupBy(hookGroupMessages.chatId)
      .orderBy(sql`max(${hookGroupMessages.sentAt}) desc`).limit(50);
    return rows.map(r => ({ chatId: r.chatId, chatName: r.chatName }));
  } });
}
export const WECOM_PERSONAL_GROUP_WINDOW = createChannelGroupWindow({ providerPrefix: 'wecom-personal', retention: { ...core.DEFAULT_GROUP_WINDOW_RETENTION }, log: createLogger('wecom-group-window') });
export const DINGTALK_PERSONAL_GROUP_WINDOW = createChannelGroupWindow({ providerPrefix: 'dingtalk-personal', retention: { ...core.DEFAULT_GROUP_WINDOW_RETENTION }, log: createLogger('dingtalk-group-window') });
export async function resetChannelGroupContextCursors(options?: { clearPersisted?: boolean }): Promise<void> {
  await Promise.all([WECOM_PERSONAL_GROUP_WINDOW.resetCursors(options), DINGTALK_PERSONAL_GROUP_WINDOW.resetCursors(options)]);
}
