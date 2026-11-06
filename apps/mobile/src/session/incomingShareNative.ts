import { requireOptionalNativeModule } from 'expo-modules-core';
import { Directory } from 'expo-file-system';
import type { SharePayload } from 'expo-sharing';
import { mobileDebugLog } from '@/debug/mobileDebugLog';

const native = requireOptionalNativeModule<{
  readSnapshot(): string | null;
  readSnapshotAsync?(): Promise<string | null>;
  clearSnapshot(expected: string): boolean;
  discardSnapshot?(expected: string): boolean;
  rejectUnreadableSnapshot?(): void;
}>('CindyIncomingShare');
const snapshots = new WeakMap<SharePayload[], string>();
const shareIds = new WeakMap<SharePayload[], string>();

export function getSharedPayloadId(payloads: SharePayload[]): string | undefined {
  return shareIds.get(payloads);
}
let rejectedSnapshot: string | null = null;

/** Account-boundary discard persists an exact tombstone before App Group I/O. */
export function discardSharedPayloads(expected: SharePayload[]): void {
  const snapshot = snapshots.get(expected);
  if (snapshot === undefined) return;
  rejectedSnapshot = snapshot;
  if (native?.discardSnapshot) {
    native.discardSnapshot(snapshot);
    rejectedSnapshot = null;
    return;
  }
  clearSharedPayloads(expected);
  rejectedSnapshot = null;
}

/** Account changed while the App Group was unreadable: fence its next snapshot. */
export function rejectUnreadableSharedPayloads(): void {
  native?.rejectUnreadableSnapshot?.();
}

/** Only discard a managed copy when a successful directory listing proves it is gone.
 * File.exists alone also returns false for inaccessible files (e.g. device protection).
 */
function isMissingShareCopy(uri: string): boolean {
  const match = /^(file:\/\/.*)\/(cindy-share-[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})\/([^/]+)$/i.exec(uri);
  if (!match) return false;
  try {
    const root = new Directory(match[1]!);
    const directory = root.list().find((entry) => entry.name === match[2]);
    if (!directory) return true;
    if (!(directory instanceof Directory)) return false;
    const entries = directory.list();
    const decodedUri = decodeURIComponent(uri);
    return !entries.some((entry) => decodeURIComponent(entry.uri) === decodedUri);
  } catch {
    // An unreadable container is not proof of deletion; preserve the share.
    return false;
  }
}

export function getSharedPayloads(): SharePayload[] {
  return parseSnapshot(native?.readSnapshot());
}

/** Routine receipt waits off the JS thread; old installed binaries keep working. */
export async function getSharedPayloadsAsync(): Promise<SharePayload[]> {
  return parseSnapshot(native?.readSnapshotAsync ? await native.readSnapshotAsync() : native?.readSnapshot());
}

function parseSnapshot(snapshot: string | null | undefined): SharePayload[] {
  if (!snapshot) { rejectedSnapshot = null; return []; }
  if (snapshot === rejectedSnapshot) {
    // Fence before filtering deleted files: surviving text is still old content.
    try { if (native?.clearSnapshot(snapshot)) rejectedSnapshot = null; } catch { /* Retry on refresh. */ }
    return [];
  }
  rejectedSnapshot = null;
  const decoded = JSON.parse(snapshot);
  const legacy = Array.isArray(decoded);
  if (!legacy && (decoded?.version !== 1 || typeof decoded.id !== 'string' || !Array.isArray(decoded.payloads))) {
    throw new Error('INCOMING_SHARE_INVALID_SNAPSHOT');
  }
  const raw: SharePayload[] = (legacy ? decoded : decoded.payloads).map((item: { value: string; type: SharePayload['shareType']; mimeType?: string }) => ({
    value: item.value, shareType: item.type, mimeType: item.mimeType,
  }));
  const payloads = raw.filter((payload) => payload.shareType === 'text' || payload.shareType === 'url' || !isMissingShareCopy(payload.value));
  snapshots.set(payloads, snapshot);
  if (!legacy) shareIds.set(payloads, decoded.id);
  if (raw.length > 0 && payloads.length === 0) {
    // Do not navigate to an empty draft, even when native acknowledgement fails.
    // The next foreground/start checks again without retaining a JS-only tombstone.
    try { clearSharedPayloads(payloads); } catch { /* Diagnosed by the adapter below. */ }
  }
  return payloads;
}

export function clearSharedPayloads(expected: SharePayload[]): void {
  const snapshot = snapshots.get(expected);
  if (snapshot === undefined) return;
  try {
    if (native?.clearSnapshot(snapshot)) return;
    // False normally means a newer share replaced this one. Never clear it.
    if (native?.readSnapshot() !== snapshot) return;
  } catch {
    mobileDebugLog('warn', 'files', 'Incoming share acknowledgement failed');
  }
  // Never hand off an unacknowledged batch or mutate individual copies: a partial
  // filesystem fallback could hide unclaimed files after a failed rollback.
  throw new Error('INCOMING_SHARE_ACK_FAILED');
}
