import { createHash } from 'node:crypto';
import { getDbClient } from '../localDb/client/current.js';
import { ingestMedia } from '../cindy-media/ingest.js';
import { hasRef, removeRefs } from '../cindy-media/ledger.js';
import { captureMediaRefCompensationScope } from '../cindy-media/refCompensationJournal.js';
import { sniffMediaMime } from '../cindy-media/sniffMediaMime.js';
import { CompanionImportError } from './types.js';

const reference = (botId: string) => ({ refKind: 'import' as const, refId: `companion-memory:${botId}` });

/** Import originals through the media ledger; retries reuse this companion's reference. */
export async function importMemoryMedia(botId: string, sessionId: string, bytes: Buffer, assertOwner: () => void): Promise<string> {
  assertOwner();
  const db = getDbClient().drizzle;
  const scope = captureMediaRefCompensationScope();
  const mimeType = sniffMediaMime(bytes);
  if (!mimeType) throw new CompanionImportError('MEMORY_ATTACHMENT_UNSUPPORTED');
  const hash = createHash('sha256').update(bytes).digest('hex');
  const exists = await hasRef({ hash, ...reference(botId) }, db);
  assertOwner();
  const media = await ingestMedia({ buffer: bytes, mimeType, isCache: false,
    refs: exists ? [] : [{ ...reference(botId), originSessionId: sessionId, originKind: 'user' }],
    assertStillValid: assertOwner, refCompensationScope: scope }, db);
  assertOwner();
  return media.url;
}

/** The import owns originals until companion deletion, independent of editable memory text. */
export async function removeImportedMemoryMedia(botId: string, assertOwner: () => void): Promise<void> {
  assertOwner();
  const db = getDbClient().drizzle;
  await removeRefs(reference(botId), db);
  assertOwner();
}
