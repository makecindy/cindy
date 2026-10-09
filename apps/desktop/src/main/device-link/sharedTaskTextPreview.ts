import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { readFileBytesForPreview } from '../fileReadBytes.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { resolveAuthorizedMedia } from './mediaFetch.js';
import { sharedTaskFileSnapshot, sharedTaskFileUrl } from './sharedTaskMediaAccess.js';
import type { SharedTaskPeerCapture } from './sharedTaskDispatch.js';

/** Mobile's existing absolute-path preview, with the same task ownership and
 * SSH provenance checks as media downloads. Never invokes the unscoped local IPC. */
export async function readSharedTaskTextPreview(filePath: string, capture: SharedTaskPeerCapture) {
  const limitMb = 10;
  const snapshot = await sharedTaskFileSnapshot(capture);
  // SDK file links on Windows may use /c/path; SSH paths stay POSIX.
  if (!snapshot.remoteHostId && process.platform === 'win32') {
    filePath = filePath.replace(/^\/([a-zA-Z])\//, (_match, drive: string) => `${drive.toUpperCase()}:\\`);
  }
  const url = sharedTaskFileUrl(filePath, snapshot, capture.author.sessionId);
  const assertCurrent = () => {
    if (!capture.isCurrent() || !capture.authorize('attachment.read')) {
      throwIpcError('PERMISSION_DENIED', 'Shared task access revoked');
    }
  };
  let absPath: string;
  try {
    ({ absPath } = await resolveAuthorizedMedia({ url }, limitMb * 1024 * 1024));
  } catch (error) {
    assertCurrent();
    const failure = error as { code?: string; size?: number };
    if (failure?.code === 'OVERSIZE' && typeof failure.size === 'number') {
      return { success: false, reason: 'oversize' as const, size: failure.size, limitMb };
    }
    throw error;
  }
  const result = await readFileBytesForPreview({ filePath: absPath, maxSize: limitMb * 1024 * 1024 }, {
    isPathAllowed: (candidate) => candidate === absPath,
    realpath,
    stat: (candidate) => stat(candidate, { bigint: true }),
    open: async (candidate) => {
      assertCurrent();
      const handle = await open(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      return {
        stat: () => handle.stat({ bigint: true }),
        read: (buffer, offset, length, position) => {
          assertCurrent();
          return handle.read(buffer, offset, length, position);
        },
        close: () => handle.close(),
      };
    },
  });
  assertCurrent();
  const data = Buffer.from(result.bytes).toString('utf8');
  // Match remote-op's relay budget, including JSON escaping overhead.
  if (Buffer.byteLength(JSON.stringify(data), 'utf8') > 1_800_000) {
    return { success: false, reason: 'oversize' as const, size: result.size, limitMb };
  }
  return { success: true, data, size: result.size, limitMb };
}
