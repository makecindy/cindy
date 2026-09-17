import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { parseBlobUrl } from '../cindy-media/blobStore.js';
import { sessionCanRead } from '../cindy-media/ledger.js';
import { getSessionFsSnapshot } from '../localDb/ipc/sessions.js';
import { getDbClient } from '../localDb/client/current.js';
import type { SessionMeetingPeerCapture } from './sessionMeetingDispatch.js';

function deny(): never { throw new Error('[PERMISSION_DENIED] Media does not belong to this shared task'); }

/** Run before any local read/SSH transfer, and recheck membership after awaits. */
export async function assertSharedTaskMedia(url: string, capture: SessionMeetingPeerCapture): Promise<string | undefined> {
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
  const snapshot = await getSessionFsSnapshot(sessionId);
  if (!snapshot?.workingDir || !capture.isCurrent()) deny();
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
  const [file, root] = await Promise.all([realpath(requested), realpath(snapshot.workingDir)]);
  const relative = path.relative(root, file);
  if (relative.startsWith('..') || path.isAbsolute(relative) || !capture.isCurrent()) deny();
  return root;
}
