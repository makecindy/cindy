import { parseFsWatchTopic } from '@cindy/device-link';
import { getSessionFsSnapshot } from '../localDb/ipc/sessions.js';
import { normalizeWorkingDirForStorage } from '../../shared/workingDir.js';
import { MAX_SHARED_TASK_TOPICS, sharedTaskWorkdirGeneration, type SharedTaskPeerCapture } from './sharedTaskDispatch.js';

function deny(): never { throw new Error('[PERMISSION_DENIED] Working directory does not belong to this shared task'); }

/** The task workdir as recorded on this host; guest-supplied paths are only compared to it. */
async function sharedTaskWorkdir(capture: SharedTaskPeerCapture): Promise<{ workingDir: string; recorded: string; remoteHostId: string | null } | null> {
  const snapshot = await getSessionFsSnapshot(capture.author.sessionId);
  const workingDir = normalizeWorkingDirForStorage(snapshot?.workingDir);
  return snapshot?.workingDir && workingDir
    ? { workingDir, recorded: snapshot.workingDir, remoteHostId: snapshot.remoteHostId } : null;
}

/**
 * Run before any file access for a shared-task guest: the requested workdir
 * must be this task's own workdir, and membership is rechecked after the DB read.
 * Returns the task's SSH host so the caller can refuse a different endpoint.
 */
export async function assertSharedTaskWorkdir(
  capture: SharedTaskPeerCapture, workdir: string, operation: 'file.read' | 'file.write',
): Promise<{ remoteHostId: string | null }> {
  if (!capture.isCurrent() || !capture.authorize(operation)) deny();
  const own = await sharedTaskWorkdir(capture);
  if (!own || normalizeWorkingDirForStorage(workdir) !== own.workingDir ||
      !capture.isCurrent() || !capture.authorize(operation)) deny();
  return { remoteHostId: own.remoteHostId };
}

/**
 * Admit fs-watch topics only for this task's workdir. Mismatches are dropped
 * rather than failing the frame: reconnect replay merges them with the task
 * stream, which must keep working if the watch is no longer valid.
 * `isFresh` must be checked synchronously right before installing the topics:
 * it turns false when the task workdir changed during the lookup.
 */
export async function admitSharedTaskFsWatchTopics(
  capture: SharedTaskPeerCapture, topics: readonly unknown[],
): Promise<{ topics: unknown[]; verified: Set<string>; isFresh: () => boolean }> {
  const generation = sharedTaskWorkdirGeneration(capture.author.sessionId);
  const isFresh = () => sharedTaskWorkdirGeneration(capture.author.sessionId) === generation;
  // Oversized frames are rejected by the synchronous gate; never look them up.
  if (topics.length > MAX_SHARED_TASK_TOPICS) return { topics: [...topics], verified: new Set(), isFresh };
  const watched = new Set(topics.filter((topic): topic is string => typeof topic === 'string' && parseFsWatchTopic(topic) !== null));
  if (watched.size === 0) return { topics: [...topics], verified: new Set(), isFresh };
  const own = capture.isCurrent() && capture.authorize('file.read') ? await sharedTaskWorkdir(capture) : null;
  const verified = new Set<string>();
  if (own && capture.isCurrent()) {
    // Each topic spelling starts its own host watcher, so admit only the exact
    // recorded path (and its canonical form) that the guest client receives
    // from the host. Aliases such as `/task/` or `/task//` would let a guest
    // accumulate unbounded watchers across frames.
    const allowed = new Set([own.recorded, own.workingDir]);
    for (const topic of watched) {
      if (allowed.has(parseFsWatchTopic(topic)!)) verified.add(topic);
    }
  }
  return { topics: topics.filter((topic) => typeof topic !== 'string' || !watched.has(topic) || verified.has(topic)), verified, isFresh };
}
