import { projectKeyComparisonKey } from '../shared/projectKeys.js';
import sharp from 'sharp';
import { createBlobStore } from './cindy-media/blobStore.js';
import { createMediaIngest } from './cindy-media/ingestCore.js';
import { createMediaRefCompensationJournal } from './cindy-media/refCompensationJournal.js';
import { removeRefs, removeRefsExceptHash } from './cindy-media/ledger.js';
import { getUserDataDir } from './userDataPath.js';
import {
  activeOwnerScopeKey,
  getActiveAppSession,
  isAppSessionBoundaryPending,
} from './appSessionState.js';
import { getDbClient } from './localDb/client/current.js';
import { isProjectImageDraft, isProjectImage } from '@cindy/maker-shared/project-alias-sync';
import { throwIpcError } from './utils/ipcValidate.js';
function mediaProjectKey(key: string): string {
  return key.startsWith('auto:')
    ? `auto:${projectKeyComparisonKey(key.slice(5), process.platform) ?? key.slice(5)}`
    : (projectKeyComparisonKey(key, process.platform) ?? key);
}
const blobs = createBlobStore({ getUserDataDir });
const journal = createMediaRefCompensationJournal({
  getUserDataDir,
  activeOwnerScopeKey,
  getActiveAppSession,
  isAppSessionBoundaryPending,
});
const media = createMediaIngest({
  blobStore: blobs,
  withMediaRefCompensation: journal.withMediaRefCompensation,
});
export async function importProjectIcon(
  value: string,
  projectKey: string,
  assertCurrent: () => void,
): Promise<string> {
  if (!isProjectImageDraft(value)) throwIpcError('INVALID_PARAMS', 'Invalid project image');
  const db = getDbClient().drizzle;
  const scope = journal.captureMediaRefCompensationScope();
  const input = Buffer.from(value.slice(value.indexOf(',') + 1), 'base64');
  let buffer: Buffer;
  try {
    const decoder = sharp(input, { limitInputPixels: 16_000_000, animated: false });
    const info = await decoder.metadata();
    if (!['png', 'jpeg', 'webp'].includes(info.format ?? '')) throw new Error('Unsupported image');
    buffer = await decoder.rotate().resize(256, 256, { fit: 'cover' }).png().toBuffer();
    if (buffer.length > 300_000) throw new Error('Image too large');
  } catch {
    throwIpcError('INVALID_PARAMS', 'Unable to decode project image');
  }
  assertCurrent();
  const result = await media.ingestMedia(
    {
      buffer,
      mimeType: 'image/png',
      isCache: false,
      refs: [
        { refKind: 'integration-cache', refId: `project-icon:${mediaProjectKey(projectKey)}` },
      ],
      assertStillValid: assertCurrent,
      refCompensationScope: scope,
    },
    db,
  );
  return result.url;
}
/** Only called after the profile is persisted, under its owner write lock. */
export async function releasePreviousProjectImages(
  projectKey: string,
  icon: string | null,
  assertCurrent: () => void,
) {
  assertCurrent();
  const db = getDbClient().drizzle;
  const params = {
    refKind: 'integration-cache' as const,
    refId: `project-icon:${mediaProjectKey(projectKey)}`,
  };
  if (isProjectImage(icon))
    await removeRefsExceptHash({ ...params, keepHash: blobs.parseBlobUrl(icon)!.hash }, db);
  else await removeRefs(params, db);
}
export async function readProjectIconBytes(icon: string): Promise<string> {
  const result = await blobs.readFile(icon);
  if (result.buffer.length > 300_000)
    throwIpcError('INVALID_PARAMS', 'Project image exceeds thumbnail limit');
  return `data:image/png;base64,${result.buffer.toString('base64')}`;
}
