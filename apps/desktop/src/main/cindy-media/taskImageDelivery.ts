import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { getCurrentDbClientSnapshot } from '../localDb/client/current';
import type { DbClient } from '../localDb/client/DbClient';
import { messages, sessions } from '../localDb/schema';
import { ingestMedia } from './ingest';
import { hasRef, removeRefById, withSessionMediaRefLock } from './ledger';
import {
  captureMediaRefCompensationScope,
  withMediaRefCompensation,
} from './refCompensationJournal';
import { sniffMediaMime } from './sniffMediaMime';
import {
  hasLocalTaskImages,
  isPathWithin,
  materializeTaskImageMarkdown,
} from './taskImageMarkdown';

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export function claudeScratchpadTempBase(platform: NodeJS.Platform = process.platform): string {
  // Claude uses /tmp on Unix, including macOS where os.tmpdir() differs.
  return process.env.CLAUDE_CODE_TMPDIR || (platform === 'win32' ? os.tmpdir() : '/tmp');
}
type SessionImageScope = Pick<
  typeof sessions.$inferSelect,
  'id' | 'workingDir' | 'sdkSessionId' | 'agentKind' | 'remoteHostId' | 'status' | 'clearedAt'
>;
type ImageMessage = Pick<
  typeof messages.$inferSelect,
  'id' | 'sessionId' | 'role' | 'content' | 'createdAt' | 'rewindAt'
>;

/** CC 2.1.280's scratchpad layout. Identity comes from the Host session, never the URL.
 * Long project keys use a native hash; do not guess that hash or scan other tasks.
 */
export function claudeScratchpadPath(
  session: Pick<SessionImageScope, 'workingDir' | 'sdkSessionId' | 'agentKind'>,
  tempBase = claudeScratchpadTempBase(),
  uid = process.getuid?.() ?? 0,
): string | null {
  if (
    session.agentKind !== 'cc' ||
    !session.workingDir ||
    session.workingDir.length > 200 ||
    !session.sdkSessionId ||
    !/^[a-f0-9-]{36}$/i.test(session.sdkSessionId)
  )
    return null;
  return path.join(
    tempBase,
    `claude-${uid}`,
    session.workingDir.replace(/[^a-zA-Z0-9]/g, '-'),
    session.sdkSessionId,
    'scratchpad',
  );
}

export async function taskImageRoots(session: SessionImageScope): Promise<string[]> {
  if (session.remoteHostId || session.status === 'deleted' || !session.workingDir) return [];
  const roots: string[] = [];
  try {
    roots.push(await fs.realpath(session.workingDir));
  } catch {
    /* missing workdir */
  }
  const configuredTempBase = claudeScratchpadTempBase();
  const scratchpad = claudeScratchpadPath(session, configuredTempBase);
  if (scratchpad) {
    try {
      // /tmp may itself alias /private/tmp. No task-owned path component may redirect elsewhere.
      const tempBase = await fs.realpath(configuredTempBase);
      const expected = path.join(tempBase, path.relative(configuredTempBase, scratchpad));
      const actual = await fs.realpath(scratchpad);
      if (actual === expected) roots.push(actual);
    } catch {
      /* native scratchpad has not been created (or was cleaned) */
    }
  }
  return roots;
}

/** Read through one handle, rejecting escapes and replacement during validation. */
export async function readTaskImage(
  source: string,
  roots: readonly string[],
): Promise<{ buffer: Buffer; mimeType: string }> {
  // Reject Windows UNC / WebDAV / device namespaces before realpath can contact
  // a remote server. Apply to decoded paths too, independent of the host OS.
  if (/^[\\/]{2}|^[\\/]\?\?[\\/]/.test(source))
    throw new Error('task-image: network or device path');
  const real = await fs.realpath(source);
  if (!roots.some((root) => isPathWithin(root, real))) throw new Error('task-image: outside task');
  const handle = await fs.open(
    real,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size <= 0 || before.size > MAX_IMAGE_BYTES)
      throw new Error('task-image: invalid file');
    const checked = await fs.realpath(source);
    const named = await fs.stat(checked);
    if (
      checked !== real ||
      named.ino !== before.ino ||
      named.dev !== before.dev ||
      !roots.some((root) => isPathWithin(root, checked))
    )
      throw new Error('task-image: changed source');
    const buffer = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) throw new Error('task-image: truncated');
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs)
      throw new Error('task-image: changed source');
    const mimeType = sniffMediaMime(buffer);
    if (!mimeType?.startsWith('image/')) throw new Error('task-image: not an image');
    return { buffer, mimeType };
  } finally {
    await handle.close();
  }
}

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
export async function materializeTaskImageText(sessionId: string, text: string): Promise<string> {
  return (await materializeTaskImageTextResult(sessionId, text)).text;
}

/** Keep the existing replacement table so projections share the same imported bytes. */
export async function materializeTaskImageTextResult(sessionId: string, text: string) {
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
export async function restoreTaskImageRows<T extends ImageMessage>(
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
