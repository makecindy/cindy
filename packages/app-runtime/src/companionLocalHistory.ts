import { and, asc, desc, eq, gt, gte, inArray, isNull, or, sql } from 'drizzle-orm';
import type { DbClient } from '@cindy/runtime-db';
import { messages } from '@cindy/runtime-db/schema';
import type { CompanionMirrorCursor, CompanionMirrorRow } from '@cindy/companion-core/mirror';
import type { CompanionMaterializeHost } from '@cindy/companion-core/materialize';
import type { createMessageService } from './messageService.js';
import type { createChatAttachments } from './chatAttachments.js';

/** Original local history contract for cloud mirroring and restoring a home. */
export function createCompanionLocalHistory(host: {
  getDbClient(): DbClient;
  createMessage: ReturnType<typeof createMessageService>['createMessage'];
  commitChatImageUrls: ReturnType<typeof createChatAttachments>['commitChatImageUrls'];
}) {
  const { getDbClient, createMessage, commitChatImageUrls } = host;
const mirrorColumns = {
  id: messages.id, clientId: messages.clientId, role: messages.role, content: messages.content,
  agentMeta: messages.agentMeta, createdAt: messages.createdAt,
};
const visibleRows = (sessionId: string) => and(eq(messages.sessionId, sessionId), isNull(messages.rewindAt),
  inArray(messages.role, ['user', 'assistant']));

async function readMirrorRowsAfter(sessionId: string, cursor: CompanionMirrorCursor, limit: number): Promise<CompanionMirrorRow[]> {
  return getDbClient().drizzle.select(mirrorColumns).from(messages)
    .where(and(visibleRows(sessionId), or(gt(messages.createdAt, cursor.createdAt),
      and(eq(messages.createdAt, cursor.createdAt), gt(messages.id, cursor.id)))))
    .orderBy(asc(messages.createdAt), asc(messages.id)).limit(limit);
}

async function readLatestMirrorRows(sessionId: string, limit: number,
  options: { excludeClientIdPrefix?: string } = {}): Promise<CompanionMirrorRow[]> {
  const prefix = options.excludeClientIdPrefix;
  return getDbClient().drizzle.select(mirrorColumns).from(messages)
    .where(prefix ? and(visibleRows(sessionId), or(isNull(messages.clientId), sql`substr(${messages.clientId}, 1, ${prefix.length}) <> ${prefix}`)) : visibleRows(sessionId))
    .orderBy(desc(messages.createdAt), desc(messages.id)).limit(limit);
}

  const materialize: Pick<CompanionMaterializeHost, 'localMessageTimes' | 'insertHistory'> = {
    // Rewound and deleted rows are included (`removed`): removed here means never re-imported.
    localMessageTimes: async (sessionId, fromMs) => (await getDbClient().drizzle
      .select({ role: messages.role, createdAt: messages.createdAt, clientId: messages.clientId, rewindAt: messages.rewindAt }).from(messages)
      .where(and(eq(messages.sessionId, sessionId), inArray(messages.role, ['user', 'assistant', 'message_tombstone']), gte(messages.createdAt, fromMs))))
      .map(row => ({ role: row.role, createdAt: row.createdAt, clientId: row.clientId,
        ...(row.rewindAt !== null || row.role === 'message_tombstone' ? { removed: true } : {}) })),
    // Same row shape as ordinary messages; the client id keeps it out of the mirror.
    insertHistory: async (sessionId, row, fence) => {
      fence.assertCurrent();
      // Files brought from the room open like any attachment of the message.
      const files = row.attachments ?? [];
      const images = files.flatMap(file => file.url ? [{ url: file.url, mimeType: file.mimeType, originalName: file.name, size: file.size }] : []);
      const others = files.flatMap(file => !file.url && file.path ? [{ name: file.name, path: file.path }] : []);
      const names = row.role === 'assistant' ? files.map(file => `[附件: ${file.name}]`) : [];
      // The room's image copies were cached only: they belong to this task before the message is
      // written. A failed commit fails the import while the message is still absent, so the retry
      // downloads and commits again instead of treating it as imported with recyclable images.
      if (images.length) {
        const commit = await commitChatImageUrls({ sessionId, urls: images.map(image => image.url) });
        if (commit.failed > 0) throw new Error('HISTORY_IMAGE_COMMIT_FAILED');
        fence.assertCurrent();
      }
      await createMessage(sessionId, { clientId: row.clientId, role: row.role, createdAt: row.createdAt,
        content: row.role === 'user' ? { text: row.text, images, files: others }
          : [{ type: 'text', text: [row.text, ...names].filter(Boolean).join('\n') }] });
    },
  };
  return { readMirrorRowsAfter, readLatestMirrorRows, ...materialize };
}
