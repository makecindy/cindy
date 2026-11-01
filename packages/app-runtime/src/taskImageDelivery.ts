import { createHash } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { DbClient } from '@cindy/runtime-db';
import { messages, sessions } from '@cindy/runtime-db/schema';
import {
  hasLocalTaskImages,
  materializeTaskImageMarkdown,
} from '@cindy/media-core/task-image-markdown';

import { taskImageRoots, readTaskImage } from '@cindy/media-core/task-image-source';
export { claudeScratchpadTempBase, claudeScratchpadPath, taskImageRoots, readTaskImage } from '@cindy/media-core/task-image-source';
import type { createCurrentDbClient } from '@cindy/runtime-db/client/current';
import type { createMediaLedger } from '@cindy/runtime-db/mediaLedger';
import type { createMediaIngest } from './mediaIngest.js';
import type { createMediaRefCompensationJournal } from './mediaRefCompensationJournal.js';

type ImageMessage = Pick<typeof messages.$inferSelect, 'id' | 'sessionId' | 'role' | 'content' | 'createdAt' | 'rewindAt'>;
export function createTaskImageDelivery(host: { getCurrentDbClientSnapshot: ReturnType<typeof createCurrentDbClient>['getCurrentDbClientSnapshot']; ingestMedia: ReturnType<typeof createMediaIngest>['ingestMedia']; ledger: Pick<ReturnType<typeof createMediaLedger>, 'hasRef' | 'removeRefById' | 'withSessionMediaRefLock'>; journal: Pick<ReturnType<typeof createMediaRefCompensationJournal>, 'captureMediaRefCompensationScope' | 'withMediaRefCompensation'> }) {
const { getCurrentDbClientSnapshot, ingestMedia, ledger: { hasRef, removeRefById, withSessionMediaRefLock }, journal: { captureMediaRefCompensationScope, withMediaRefCompensation } } = host;


function markdownContent(value: string): { text: string; serialize(text: string): string } | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'string' ? { text: parsed, serialize: JSON.stringify } : null;
  } catch {
    return { text: value, serialize: (text) => text };
  }
}

async function captureTaskImages(sessionId: string, client?: DbClient) {
  const snapshot = getCurrentDbClientSnapshot();
  if (!snapshot || (client && client !== snapshot.client)) return null;
  const db = snapshot.client.drizzle;
  const journal = captureMediaRefCompensationScope();
  const assertStillValid = () => {
    journal.assertStillValid();
    if (getCurrentDbClientSnapshot() !== snapshot) throw new Error('task-image: owner changed');
  };
  const [session] = await db
    .select({
      id: sessions.id,
      workingDir: sessions.workingDir,
      sdkSessionId: sessions.sdkSessionId,
      agentKind: sessions.agentKind,
      remoteHostId: sessions.remoteHostId,
      status: sessions.status,
      clearedAt: sessions.clearedAt,
    })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  assertStillValid();
  if (!session || session.remoteHostId || session.status === 'deleted') return null;
  const roots = await taskImageRoots(session);
  assertStillValid();
  const newRefs: string[] = [];
  return {
    session,
    db,
    assertStillValid,
    rollback: async () => {
      if (!newRefs.length) return;
      const remove = (id: string) => removeRefById(id, db);
      await withMediaRefCompensation({
        // Rollback must remain possible AFTER an owner switch. Only these exact
        // newly created ids are removed, using the captured owner's directory
        // and DB; never resolve either against the now-active account.
        scope: { ...journal, assertStillValid: () => {} },
        refIds: newRefs,
        perform: async () => {
          for (const id of newRefs) await remove(id);
        },
        compensate: remove,
      });
    },
    materialize: (text: string) =>
      materializeTaskImageMarkdown(text, {
        importImage: async (source) => {
          const image = await readTaskImage(source, roots);
          assertStillValid();
          const hash = createHash('sha256').update(image.buffer).digest('hex');
          const existing = await hasRef(
            { hash, refKind: 'session-attachment', refId: sessionId },
            db,
          );
          assertStillValid();
          const saved = await ingestMedia(
            {
              ...image,
              refs: existing
                ? []
                : [
                    {
                      refKind: 'session-attachment',
                      refId: sessionId,
                      originSessionId: sessionId,
                      originKind: 'tool',
                    },
                  ],
              assertStillValid,
              refCompensationScope: journal,
            },
            db,
          );
          newRefs.push(...saved.refIds);
          return saved.url;
        },
      }),
  };
}

/** Channel adapter: same source validation/import as durable chat. Never rewrites Agent history. */
async function materializeTaskImageText(sessionId: string, text: string): Promise<string> {
  return (await materializeTaskImageTextResult(sessionId, text)).text;
}

/** Keep the existing replacement table so projections share the same imported bytes. */
async function materializeTaskImageTextResult(sessionId: string, text: string) {
  const client = getCurrentDbClientSnapshot()?.client;
  const unchanged = { text, replacements: new Map<string, string>(), failures: [] as string[] };
  if (!client || !hasLocalTaskImages(text)) return unchanged;
  return withSessionMediaRefLock(client.drizzle, sessionId, () =>
    materializeTaskImageTextUnlocked(client, sessionId, unchanged),
  );
}

async function materializeTaskImageTextUnlocked(
  client: DbClient,
  sessionId: string,
  unchanged: Awaited<ReturnType<typeof materializeTaskImageMarkdown>>,
) {
  let scope: Awaited<ReturnType<typeof captureTaskImages>> = null;
  try {
    scope = await captureTaskImages(sessionId, client);
    if (!scope) return unchanged;
    const result = await scope.materialize(unchanged.text);
    scope.assertStillValid();
    const [current] = await scope.db
      .select({
        clearedAt: sessions.clearedAt,
        workingDir: sessions.workingDir,
        status: sessions.status,
        sdkSessionId: sessions.sdkSessionId,
        remoteHostId: sessions.remoteHostId,
      })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    scope.assertStillValid();
    if (
      !current ||
      current.remoteHostId ||
      current.sdkSessionId !== scope.session.sdkSessionId ||
      current.status === 'deleted' ||
      current.clearedAt !== scope.session.clearedAt ||
      current.workingDir !== scope.session.workingDir
    )
      throw new Error('task-image: task changed');
    return result;
  } catch {
    await scope?.rollback().catch(() => {});
    return unchanged;
  }
}

/** Only completed, durable assistant rows are eligible. CAS protects edits, rewind and clear.
 * Called on publication and the existing history read path, never on token deltas or a timer.
 */
async function restoreTaskImageRows<T extends ImageMessage>(
  client: DbClient,
  rows: T[],
): Promise<T[]> {
  const output: T[] = [];
  for (const row of rows) {
    if (row.role !== 'assistant' || !hasLocalTaskImages(markdownContent(row.content)?.text)) {
      output.push(row);
      continue;
    }
    output.push(
      ...(await withSessionMediaRefLock(client.drizzle, row.sessionId, () =>
        restoreTaskImageRowsUnlocked(client, [row]),
      )),
    );
  }
  return output;
}

async function restoreTaskImageRowsUnlocked<T extends ImageMessage>(
  client: DbClient,
  rows: T[],
): Promise<T[]> {
  const output: T[] = [];
  for (const row of rows) {
    const parsed =
      row.role === 'assistant' && row.rewindAt === null ? markdownContent(row.content) : null;
    if (!parsed || !hasLocalTaskImages(parsed.text)) {
      output.push(row);
      continue;
    }
    let scope: Awaited<ReturnType<typeof captureTaskImages>> = null;
    let publicationMayHaveCommitted = false;
    try {
      scope = await captureTaskImages(row.sessionId, client);
      if (
        !scope ||
        (scope.session.clearedAt !== null && row.createdAt <= scope.session.clearedAt)
      ) {
        output.push(row);
        continue;
      }
      const result = await scope.materialize(parsed.text);
      scope.assertStillValid();
      if (result.text === parsed.text) {
        output.push(row);
        continue;
      }
      const content = parsed.serialize(result.text);
      // A disposed worker can lose the ACK after committing. Until a definite
      // CAS miss is returned, preserve pins rather than risk breaking history.
      publicationMayHaveCommitted = true;
      const updated = await scope.db
        .update(messages)
        .set({ content })
        .where(
          and(
            eq(messages.id, row.id),
            eq(messages.sessionId, row.sessionId),
            eq(messages.role, 'assistant'),
            eq(messages.content, row.content),
            isNull(messages.rewindAt),
            sql`EXISTS (SELECT 1 FROM ${sessions} WHERE ${sessions.id} = ${row.sessionId}
          AND ${sessions.status} != 'deleted' AND ${sessions.remoteHostId} IS NULL
          AND ${sessions.workingDir} IS ${scope.session.workingDir}
          AND ${sessions.sdkSessionId} IS ${scope.session.sdkSessionId}
          AND ${sessions.clearedAt} IS ${scope.session.clearedAt})`,
          ),
        )
        .returning({ id: messages.id });
      if (!updated.length) {
        publicationMayHaveCommitted = false;
        throw new Error('task-image: message changed');
      }
      scope.assertStillValid();
      output.push({ ...row, content });
    } catch {
      // Preserve the readable original on failure. Never claim the bytes were deleted.
      if (!publicationMayHaveCommitted) await scope?.rollback().catch(() => {});
      output.push(row);
    }
  }
  return output;
}
return {
  materializeTaskImageText,
  materializeTaskImageTextResult,
  restoreTaskImageRows
};
}
