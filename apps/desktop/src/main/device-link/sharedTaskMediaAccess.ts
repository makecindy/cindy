import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { parseBlobUrl } from '../cindy-media/blobStore.js';
import { sessionCanRead } from '../cindy-media/ledger.js';
import { getSessionFsSnapshot } from '../localDb/ipc/sessions.js';
import { getDbClient } from '../localDb/client/current.js';
import { getSensitiveMediaBlocklist, isPathAllowedAgainst } from '../filePathPolicy.js';
import type { SharedTaskPeerCapture } from './sharedTaskDispatch.js';

function deny(): never { throw new Error('[PERMISSION_DENIED] Media does not belong to this shared task'); }

export async function sharedTaskFileSnapshot(capture: SharedTaskPeerCapture) {
  if (!capture.isCurrent() || !capture.authorize('attachment.read')) deny();
  const snapshot = await getSessionFsSnapshot(capture.author.sessionId);
  if (!snapshot?.workingDir || !capture.isCurrent()) deny();
  return { ...snapshot, workingDir: snapshot.workingDir };
}

/** Host-owned provenance for a file reference, including nested SSH tasks. */
export function sharedTaskFileUrl(file: string, snapshot: Awaited<ReturnType<typeof sharedTaskFileSnapshot>>, sessionId: string): string {
  const url = new URL('xdt-file://open');
  url.searchParams.set('path', file);
  if (snapshot.remoteHostId) {
    url.searchParams.set('sessionId', sessionId);
    url.searchParams.set('remoteHostId', snapshot.remoteHostId);
    url.searchParams.set('workdir', snapshot.workingDir);
  }
  return url.toString();
}

/** Only structured, Host-persisted attachments are evidence; prose is never a grant.
 * Shared input validates files and parsed persistedContent before writing these rows. */
async function isTaskFileAttachment(sessionId: string, requested: string): Promise<boolean> {
  const rows = await getDbClient().query<{ content: string }>(
    "SELECT content FROM messages WHERE session_id = ? AND role = 'user' AND rewind_at IS NULL AND instr(content, '\"files\"') > 0",
    [sessionId],
  );
  return rows.some(({ content }) => {
    try {
      const parsed = JSON.parse(content);
      return Array.isArray(parsed?.files) && parsed.files.some((file: { path?: unknown }) => {
        if (!file || typeof file.path !== 'string') return false;
        if (file.path === requested) return true;
        if (!file.path.startsWith('xdt-file:')) return false;
        const url = new URL(file.path);
        return !url.searchParams.has('remoteHostId') && url.searchParams.get('path') === requested;
      });
    } catch { return false; }
  });
}

export interface SharedTaskMediaScope {
  /** Physical target pinned by the ownership check, never a caller-supplied root. */
  file: string;
  root?: string;
}

/** Run before any local read/SSH transfer, and recheck membership after awaits. */
export async function assertSharedTaskMedia(url: string, capture: SharedTaskPeerCapture): Promise<SharedTaskMediaScope | undefined> {
  if (!capture.isCurrent() || !capture.authorize('attachment.read')) deny();
  const sessionId = capture.author.sessionId;
  const blob = parseBlobUrl(url);
  if (blob) {
    if (!await sessionCanRead(blob.hash, sessionId) || !capture.isCurrent()) deny();
    return;
  }
  const parsed = new URL(url);
  // Frozen legacy per-task cache, still resolved by the existing safe resolver.
  if (parsed.protocol === 'xdt-image:' && decodeURIComponent(parsed.hostname) === sessionId) return;
  if (parsed.protocol === 'xdt-video:' || parsed.protocol === 'xdt-image:') {
    // Older generated caches predate the media ledger and use global hosts.
    // Only a complete URL already emitted into this task's host-authored history
    // grants access; guest/user text is not evidence of cache ownership.
    const rows = await getDbClient().query<{ content: string }>(
      "SELECT content FROM messages WHERE session_id = ? AND role IN ('assistant', 'tool_use', 'tool_result') AND instr(content, ?) > 0",
      [sessionId, url],
    );
    const present = rows.some((row) => row.content.match(/xdt-(?:image|video):\/\/[^\s"'<>\x60\\)\]}]+/g)?.includes(url) === true);
    if (!present || !capture.isCurrent()) deny();
    return;
  }
  if (!['xdt-file:', 'xdt-audio:'].includes(parsed.protocol)) deny();
  const snapshot = await sharedTaskFileSnapshot(capture);
  if (snapshot.remoteHostId) {
    if (parsed.searchParams.get('sessionId') !== sessionId ||
        parsed.searchParams.get('remoteHostId') !== snapshot.remoteHostId ||
        parsed.searchParams.get('workdir') !== snapshot.workingDir) deny();
    // The remote file-service stat/readFileChunk both check real ancestry under
    // workdir (file-browser-core/scanner.ts); no controller-supplied root is used.
    return;
  }
  if (parsed.searchParams.has('remoteHostId')) deny();
  const requested = parsed.searchParams.get('path');
  if (!requested || !path.isAbsolute(requested)) deny();
  const blocklist = getSensitiveMediaBlocklist();
  if (!isPathAllowedAgainst(requested, blocklist)) deny();
  const [file, root] = await Promise.all([realpath(requested), realpath(snapshot.workingDir)]);
  if (!isPathAllowedAgainst(file, blocklist) || !capture.isCurrent()) deny();
  const relative = path.relative(root, file);
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) return { root, file };
  // A path within the workdir cannot gain an external grant through a symlink.
  const lexical = path.relative(snapshot.workingDir, requested);
  if (!lexical.startsWith('..') && !path.isAbsolute(lexical)) deny();
  if (!await isTaskFileAttachment(sessionId, requested) || !capture.isCurrent()) deny();
  // Historical attachments authorize this physical file, never its whole parent.
  if (file !== path.join(await realpath(path.dirname(requested)), path.basename(requested)) || !capture.isCurrent()) deny();
  return { file };
}
