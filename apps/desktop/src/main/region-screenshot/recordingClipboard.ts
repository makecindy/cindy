import { integrationCachePut } from '../cindy-media/integrationCache';
import { removeRefsExceptHash } from '../cindy-media/ledger';
import { sniffMediaMime } from '../cindy-media/sniffMediaMime';
import { getCurrentDbClientSnapshot } from '../localDb/client/current';
import { captureDataOwnerBroadcastScope, isDataOwnerBroadcastScopeCurrent } from '../device-link/broadcast-tap';
import { copyFileToClipboardMacOS, copyFileToClipboardWindows } from '../fileClipboard';
import { createLogger } from '../logger';
import { validRecordingBytes } from '../../shared/regionCapture';

const log = createLogger('region-screenshot:clipboard');
const REF = 'recording-clipboard:latest';

/** Retain the last successfully copied clip beyond preview close/app exit.
 * Replacement releases only our old reference; shared bytes use normal recycling. */
export async function copyRegionRecording(bytes: Uint8Array, format: 'webm' | 'gif', isCurrent: () => boolean): Promise<void> {
  if (process.platform !== 'win32' && process.platform !== 'darwin') throw new Error('Recording clipboard unavailable');
  const mimeType = sniffMediaMime(bytes);
  if (!validRecordingBytes(bytes, format) || mimeType !== (format === 'gif' ? 'image/gif' : 'video/webm'))
    throw new Error('Invalid recording');
  const snapshot = getCurrentDbClientSnapshot();
  if (!snapshot) throw new Error('Recording storage unavailable');
  const owner = captureDataOwnerBroadcastScope();
  const assertStillValid = () => {
    if (!isCurrent() || getCurrentDbClientSnapshot() !== snapshot || !isDataOwnerBroadcastScopeCurrent(owner))
      throw new Error('Recording clipboard cancelled');
  };
  assertStillValid();
  const db = snapshot.client.drizzle;
  const media = await integrationCachePut({
    buffer: bytes, mimeType, isCache: false,
    cacheKey: REF, integration: 'recording-clipboard', assertStillValid,
  }, db);
  try {
    assertStillValid();
    if (process.platform === 'win32') await copyFileToClipboardWindows(media.absPath);
    else await copyFileToClipboardMacOS(media.absPath);
  } catch (error) {
    await media.rollbackRef().catch(() => { log.warn('recording clipboard reference rollback failed'); });
    throw error;
  }
  // Clipboard now points to these bytes. Retain them even if the page closes or
  // owner changes while the OS helper finishes. Cleanup stays on the captured DB.
  await removeRefsExceptHash({ refKind: 'integration-cache', refId: REF, keepHash: media.hash }, db)
    .catch(() => { log.warn('old recording clipboard reference cleanup failed'); });
}
