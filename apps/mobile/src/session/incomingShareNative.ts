import { requireOptionalNativeModule } from 'expo-modules-core';
import { Directory } from 'expo-file-system';
import type { SharePayload } from 'expo-sharing';
import { mobileDebugLog } from '@/debug/mobileDebugLog';

const native = requireOptionalNativeModule<{
  readSnapshot(): string | null;
  clearSnapshot(expected: string): boolean;
  readDiagnostic?(): string | null;
  clearDiagnostic?(expected: string): boolean;
}>('CindyIncomingShare');
const snapshots = new WeakMap<SharePayload[], string>();

/**
 * Shares that fail inside the extension leave a diagnostic in the App Group:
 * the failing step, the provider's type identifiers and the error domain/code —
 * never a file name or path. Logging it here is what makes a field report
 * diagnosable, because an App Store build cannot be attached to a debugger.
 * Best effort throughout: the diagnostic must never break reading the inbox, and
 * a stale one is simply logged again after a failed clear.
 */
function reportIncomingShareDiagnostic(): void {
  const read = native?.readDiagnostic;
  if (!read) return;
  let diagnostic: string | null = null;
  try {
    diagnostic = read.call(native) ?? null;
  } catch {
    return;
  }
  if (!diagnostic) return;
  try {
    const parsed: unknown = JSON.parse(diagnostic);
    const fields = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
    mobileDebugLog('warn', 'files', 'incoming share failed', {
      step: typeof fields.step === 'string' ? fields.step : undefined,
      types: Array.isArray(fields.types)
        ? fields.types.filter((value): value is string => typeof value === 'string')
        : undefined,
      error: typeof fields.error === 'string' ? fields.error : undefined,
    });
  } catch {
    mobileDebugLog('warn', 'files', 'incoming share failed', { unreadable: true });
  }
  try {
    native?.clearDiagnostic?.(diagnostic);
  } catch {
    /* keep the record until the next successful clear */
  }
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
  reportIncomingShareDiagnostic();
  const snapshot = native?.readSnapshot();
  if (!snapshot) return [];
  const raw: SharePayload[] = JSON.parse(snapshot).map((item: { value: string; type: SharePayload['shareType']; mimeType?: string }) => ({
    value: item.value, shareType: item.type, mimeType: item.mimeType,
  }));
  const payloads = raw.filter((payload) => !isMissingShareCopy(payload.value));
  snapshots.set(payloads, snapshot);
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
