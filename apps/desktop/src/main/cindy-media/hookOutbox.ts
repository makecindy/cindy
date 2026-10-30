/** X's durable outbox borrows managed media; the transport ledger never owns bytes. */
import fs from 'node:fs/promises';
import { and, eq, lt } from 'drizzle-orm';
import type { TurnEndPayload } from '@cindy/slack-hook-protocol';
import { activeOwnerScopeKey } from '../appSessionState';
import { getCurrentDbClientSnapshot } from '../localDb/client/current';
import { mediaRefs, sessions } from '../localDb/schema';
import { HOOK_TERMINAL_DELIVERY_TTL_MS, type HookMediaReference } from '../hook-control/requestLedger';
import { ingestMedia } from './ingest';
import { parseBlobUrl, resolveSafe } from './blobStore';
import { removeRefById, withSessionMediaRefLock } from './ledger';
import { captureMediaRefCompensationScope, withMediaRefCompensation } from './refCompensationJournal';

const ORIGIN = 'hook-outbox';

export interface HookMediaStore {
  prepare(turn: TurnEndPayload, assertCurrent: () => void): Promise<HookMediaReference[]>;
  restore(turn: TurnEndPayload, media: HookMediaReference[]): Promise<TurnEndPayload | null>;
  release(media: HookMediaReference[]): Promise<void>;
  prune(): Promise<void>;
}

export function createHookMediaStore(): HookMediaStore {
  const owner = activeOwnerScopeKey();
  function capture() {
    const snapshot = getCurrentDbClientSnapshot();
    if (!snapshot || activeOwnerScopeKey() !== owner) throw new Error('hook-media: owner unavailable');
    const journal = captureMediaRefCompensationScope(owner);
    const assertStillValid = () => {
      journal.assertStillValid();
      if (getCurrentDbClientSnapshot() !== snapshot) throw new Error('hook-media: owner changed');
    };
    return { db: snapshot.client.drizzle, journal, assertStillValid };
  }
  return {
    async prepare(turn, assertCurrent) {
      const sessionId = turn.sessionId;
      if (!sessionId) throw new Error('hook-media: task missing');
      const { db, journal, assertStillValid } = capture();
      return withSessionMediaRefLock(db, sessionId, async () => {
        const check = () => { assertStillValid(); assertCurrent(); };
        check();
        const [session] = await db.select({ status: sessions.status, clearedAt: sessions.clearedAt })
          .from(sessions).where(eq(sessions.id, sessionId)).limit(1);
        check();
        if (!session || session.status === 'deleted') throw new Error('hook-media: task deleted');
        const refs: HookMediaReference[] = [];
        try {
          for (const attachment of turn.attachments ?? []) {
            const saved = await ingestMedia({
              buffer: Buffer.from(attachment.dataBase64, 'base64'), mimeType: attachment.mimeType,
              refs: [{ refKind: 'message', refId: `hook-outbox:${turn.requestId}`,
                originSessionId: sessionId, originKind: 'integration', originId: ORIGIN }],
              assertStillValid: check, refCompensationScope: journal,
            }, db);
            refs.push({ url: saved.url, refId: saved.refIds[0]!, name: attachment.name,
              mimeType: saved.mimeType, bytes: saved.bytes });
          }
          const [current] = await db.select({ status: sessions.status, clearedAt: sessions.clearedAt })
            .from(sessions).where(eq(sessions.id, sessionId)).limit(1);
          check();
          if (!current || current.status === 'deleted' || current.clearedAt !== session.clearedAt)
            throw new Error('hook-media: task changed');
          return refs;
        } catch (error) {
          // Exact ids and the captured owner survive a worker/account boundary.
          if (refs.length) await withMediaRefCompensation({
            scope: { ...journal, assertStillValid: () => {} }, refIds: refs.map((ref) => ref.refId),
            perform: async () => { for (const ref of refs) await removeRefById(ref.refId, db); },
            compensate: (id) => removeRefById(id, db),
          });
          throw error;
        }
      });
    },
    async restore(turn, media) {
      const sessionId = turn.sessionId;
      if (!sessionId) return null;
      const { db, assertStillValid } = capture();
      return withSessionMediaRefLock(db, sessionId, async () => {
        const [session] = await db.select({ status: sessions.status }).from(sessions)
          .where(eq(sessions.id, sessionId)).limit(1);
        assertStillValid();
        if (!session || session.status === 'deleted') return null;
        const attachments = [];
        for (const ref of media) {
          const parsed = parseBlobUrl(ref.url);
          if (!parsed) return null;
          const rows = await db.select({ id: mediaRefs.id }).from(mediaRefs).where(and(
            eq(mediaRefs.id, ref.refId), eq(mediaRefs.hash, parsed.hash),
            eq(mediaRefs.originSessionId, sessionId), eq(mediaRefs.originId, ORIGIN),
          )).limit(1);
          assertStillValid();
          if (!rows.length) return null; // Business deletion already released the pin.
          const bytes = await fs.readFile(resolveSafe(ref.url).absPath);
          assertStillValid();
          if (bytes.length !== ref.bytes) throw new Error('hook-media: changed blob');
          attachments.push({ name: ref.name, mimeType: ref.mimeType, dataBase64: bytes.toString('base64') });
        }
        return { ...turn, attachments };
      });
    },
    async release(media) {
      const { db, journal, assertStillValid } = capture();
      await withMediaRefCompensation({
        scope: journal, refIds: media.map((ref) => ref.refId),
        perform: async () => {
          for (const ref of media) { assertStillValid(); await removeRefById(ref.refId, db); }
        },
        compensate: (id) => removeRefById(id, db),
      });
    },
    async prune() {
      const { db, assertStillValid } = capture();
      assertStillValid();
      // Also reclaims staged pins left by a crash before the JSON commit. Shared
      // message references are removed by the existing task-deletion lifecycle.
      await db.delete(mediaRefs).where(and(eq(mediaRefs.refKind, 'message'),
        eq(mediaRefs.originKind, 'integration'), eq(mediaRefs.originId, ORIGIN),
        lt(mediaRefs.createdAt, Date.now() - HOOK_TERMINAL_DELIVERY_TTL_MS))).run();
    },
  };
}
