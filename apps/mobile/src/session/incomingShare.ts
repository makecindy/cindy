/**
 * iOS Share Extension → 任务/伙伴的内容信箱。
 *
 * expo-sharing 把扩展收到的文件复制进 App Group，并在主 App 激活后提供本地
 * payload。根导航把 payload 放进这个进程内信箱；用户选择的目标编辑器领取后复用现有
 * MobileLocalAttachmentUpload 管线。原生 payload 在领取成功前不清，避免登录/导航
 * 期间丢文件。
 */
import { useSyncExternalStore } from 'react';
import type { ResolvedSharePayload, SharePayload } from 'expo-sharing';
import {
  getMobileAuthOwner,
  isMobileAuthOwnerCurrent,
  subscribeMobileAuthOwner,
  type MobileAuthOwnerGeneration,
} from '@/auth/authOwnerGeneration';

import {
  categorizeMobileAttachment,
  extractRemoteFileExt,
  type MobileAttachmentCategory,
} from '@/session/attachments';
import type { MobileLocalAttachmentUploadCandidate } from '@/session/mobileLocalAttachmentUpload';
import { resolvePastedImageAsset } from '@/session/pastedImageAttachment';

export interface IncomingShareBatch {
  id: string;
  payloads: readonly ResolvedSharePayload[];
  acknowledge: () => void;
  owner: MobileAuthOwnerGeneration;
  destination?: string;
}

export interface IncomingShareUploadSelection {
  candidates: MobileLocalAttachmentUploadCandidate[];
  rejectedUris: string[];
}

let currentBatch: IncomingShareBatch | null = null;
const pendingBatches: IncomingShareBatch[] = [];
const listeners = new Set<() => void>();
let unsubscribeOwner: (() => void) | undefined;
let rejectedNativeSnapshots = new WeakMap<IncomingShareNative, string | null>();
// Retain completion IDs only for reads that can still return an older snapshot.
// A later share with the same legacy content-derived ID remains eligible.
const pendingNativeReads = new Set<Set<string>>();

function isFilePayload(payload: Pick<SharePayload, 'shareType'>): boolean {
  return payload.shareType !== 'text' && payload.shareType !== 'url';
}

export async function deleteIncomingSharedFiles(uris: readonly string[]): Promise<void> {
  const FileSystem = await import('expo-file-system/legacy');
  await Promise.all([...new Set(uris)].filter((uri) => uri.startsWith('file://')).map((uri) => (
    FileSystem.deleteAsync(
      // Each native input owns one UUID directory; converted images are files.
      uri.match(/^(file:\/\/.*\/cindy-share-[\da-f-]{36})\/[^/]+$/i)?.[1] ?? uri,
      { idempotent: true },
    ).catch(() => undefined)
  )));
}

function acknowledgeBatch(batch: IncomingShareBatch): void {
  try { batch.acknowledge(); } catch {
    // Older native binaries may not expose the App Group.
  }
}

function canRetainShareOwner(
  owner: MobileAuthOwnerGeneration,
  current: MobileAuthOwnerGeneration,
  restored?: MobileAuthOwnerGeneration,
): boolean {
  if (owner.switching || current.switching) return false;
  return (owner.accountKey === current.accountKey && owner.generation === current.generation)
    || (!owner.accountKey && !!current.accountKey && current.generation === owner.generation + 1)
    || (!!restored && owner.accountKey === restored.accountKey && owner.generation === restored.generation);
}

/** Only unclaimed shares wait for a reversible switch; other auth listeners still cancel immediately. */
function observeIncomingShareOwner(
  listener: (previous: MobileAuthOwnerGeneration, current: MobileAuthOwnerGeneration,
    restored?: MobileAuthOwnerGeneration) => void,
  previous = getMobileAuthOwner(),
): () => void {
  let switching = !!previous.switching;
  const changed = () => {
    const current = getMobileAuthOwner();
    if (current.switching) { switching = true; return; }
    // An observer installed mid-switch has no known source account: fail closed.
    const restored = switching && !previous.switching && previous.accountKey === current.accountKey
      ? previous : undefined;
    listener(previous, current, restored);
    previous = current;
    switching = false;
  };
  changed();
  return subscribeMobileAuthOwner(changed);
}

function updateIncomingShareOwner(
  _previous: MobileAuthOwnerGeneration,
  owner: MobileAuthOwnerGeneration,
  restored?: MobileAuthOwnerGeneration,
): void {
  const discarded = pendingBatches.filter((batch) => {
    return !canRetainShareOwner(batch.owner, owner, restored);
  });
  for (const batch of discarded) {
    pendingBatches.splice(pendingBatches.indexOf(batch), 1);
    acknowledgeBatch(batch);
    void deleteIncomingSharedFiles(batch.payloads.filter(isFilePayload).map((payload) => payload.contentUri ?? payload.value))
      .catch(() => undefined);
  }
  // New snapshots also wake the focused consumer after a rollback/first login.
  for (let index = 0; index < pendingBatches.length; index += 1) {
    const batch = pendingBatches[index]!;
    if (batch.owner !== owner) pendingBatches[index] = { ...batch, owner };
  }
  currentBatch = pendingBatches[0] ?? null;
  emit();
}

type IncomingShareNative = {
  getSharedPayloads(): SharePayload[];
  getSharedPayloadsAsync?(): Promise<SharePayload[]>;
  getSharedPayloadId?(payloads: SharePayload[]): string | undefined;
  clearSharedPayloads(expected: SharePayload[]): void;
  discardSharedPayloads?(expected: SharePayload[]): void;
  rejectUnreadableSharedPayloads?(): void;
};

function nativeSnapshotKey(native: IncomingShareNative, raw: SharePayload[]): string {
  return native.getSharedPayloadId?.(raw) ?? JSON.stringify(raw);
}

function discardNativeShare(native: IncomingShareNative, raw: SharePayload[]): void {
  if (native.discardSharedPayloads) native.discardSharedPayloads(raw);
  else native.clearSharedPayloads(raw);
}

/** Also clear a native payload not yet observed by the JS mailbox on logout/switch. */
export function watchIncomingShareAccount(
  native: IncomingShareNative,
  previous = getMobileAuthOwner(),
): () => void {
  return observeIncomingShareOwner((previous, current, restored) => {
    if (!canRetainShareOwner(previous, current, restored)) {
      let raw: SharePayload[] | undefined;
      try {
        raw = native.getSharedPayloads();
        discardNativeShare(native, raw);
        rejectedNativeSnapshots.delete(native);
        void deleteIncomingSharedFiles(raw.filter(isFilePayload).map((payload) => payload.value)).catch(() => undefined);
      } catch {
        // Also fence older binaries, or a failure to persist the native tombstone.
        // null means the slot was unreadable: its first readable batch must clear.
        rejectedNativeSnapshots.set(native, raw ? nativeSnapshotKey(native, raw) : null);
        if (raw === undefined) {
          // Persist without touching the unavailable App Group. A fresh process
          // must reject its first readable slot before the new owner can see it.
          try { native.rejectUnreadableSharedPayloads?.(); } catch { /* Keep the in-process fence too. */ }
        }
      }
    }
  }, previous);
}

function emit(): void {
  for (const listener of listeners) listener();
}

function getSnapshot(): IncomingShareBatch | null {
  return currentBatch;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useIncomingShareBatch(): IncomingShareBatch | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function incomingShareBatchId(payloads: readonly ResolvedSharePayload[]): string {
  return JSON.stringify(payloads.map((payload) => ({
    value: payload.value,
    shareType: payload.shareType,
    mimeType: payload.mimeType ?? null,
    contentUri: payload.contentUri,
    contentType: payload.contentType,
    contentMimeType: payload.contentMimeType,
    originalName: payload.originalName,
    contentSize: payload.contentSize,
  })));
}

export function stageIncomingShareBatch(
  payloads: readonly ResolvedSharePayload[],
  acknowledge: () => void,
  id = incomingShareBatchId(payloads),
): IncomingShareBatch | null {
  if (payloads.length === 0 || getMobileAuthOwner().switching) return null;
  const existing = pendingBatches.find((batch) => batch.id === id);
  if (existing) return existing;
  unsubscribeOwner ??= observeIncomingShareOwner(updateIncomingShareOwner);
  const batch = { id, payloads: [...payloads], acknowledge, owner: getMobileAuthOwner() };
  pendingBatches.push(batch);
  currentBatch = pendingBatches[0]!;
  emit();
  return batch;
}

/** Only the destination explicitly chosen by the user may claim this batch. */
export function selectIncomingShareDestination(id: string, destination: string): boolean {
  if (!currentBatch || currentBatch.id !== id || !isMobileAuthOwnerCurrent(currentBatch.owner)) return false;
  currentBatch = { ...currentBatch, destination };
  pendingBatches[0] = currentBatch;
  emit();
  return true;
}

export function incomingShareText(payloads: readonly ResolvedSharePayload[]): string {
  return payloads.filter(payload => payload.shareType === 'text' || payload.shareType === 'url')
    .map(payload => payload.value).filter(value => value.trim()).join('\n\n');
}

export function incomingShareDestination(deviceId: string, sessionId: string,
  resource?: { collectionId: string; kind: string; id: string }): string {
  return resource?.collectionId && resource.kind && resource.id
    ? JSON.stringify([deviceId, 'resource', resource.collectionId, resource.kind, resource.id])
    : JSON.stringify([deviceId, sessionId]);
}

export function consumeIncomingShareBatch(id: string): boolean {
  if (getMobileAuthOwner().switching || !currentBatch || currentBatch.id !== id
    || !currentBatch.owner.accountKey || !isMobileAuthOwnerCurrent(currentBatch.owner)) return false;
  const consumed = currentBatch;
  // Do not expose a removable attachment until consumption is durable. On failure
  // keep the mailbox entry so focusing the screen again can retry the handoff.
  consumed.acknowledge();
  for (const completed of pendingNativeReads) completed.add(consumed.id);
  pendingBatches.shift();
  currentBatch = pendingBatches[0] ?? null;
  emit();
  return true;
}

/** Cancelling the chooser discards only this share, never the source app's files. */
export function discardIncomingShareBatch(id: string): boolean {
  const batch = currentBatch;
  if (!batch || !consumeIncomingShareBatch(id)) return false;
  void deleteIncomingSharedFiles(batch.payloads.filter(isFilePayload).map(payload => payload.contentUri ?? payload.value)).catch(() => undefined);
  return true;
}

/** A failed native acknowledgement retains the batch, but must not trap navigation. */
export function leaveIncomingShareChooser(cancelBatchId: string | null, leave: () => void): void {
  try { if (cancelBatchId) discardIncomingShareBatch(cancelBatchId); }
  catch { /* Keep the unacknowledged batch and owned files available for retry. */ }
  leave();
}

/** Raw local files need no asynchronous resolver; the uploader stats their size. */
export function receiveIncomingShare(native: IncomingShareNative): void | Promise<void> {
  const owner = getMobileAuthOwner();
  if (owner.switching) return;
  if (native.getSharedPayloadsAsync) {
    const completed = new Set<string>();
    pendingNativeReads.add(completed);
    return (async () => {
      try {
        const raw = await native.getSharedPayloadsAsync!();
        // A slow native read must not assign the previous account's share to the
        // account that became active while it was waiting. Its observer owns cleanup.
        if (isMobileAuthOwnerCurrent(owner)) receiveNativePayloads(native, raw, completed);
      } finally { pendingNativeReads.delete(completed); }
    })();
  }
  receiveNativePayloads(native, native.getSharedPayloads());
}

function receiveNativePayloads(native: IncomingShareNative, raw: SharePayload[], completed?: ReadonlySet<string>): void {
  if (rejectedNativeSnapshots.has(native)) {
    const rejected = rejectedNativeSnapshots.get(native);
    if (rejected === null || rejected === nativeSnapshotKey(native, raw)) {
      try { discardNativeShare(native, raw); } catch { return; }
      rejectedNativeSnapshots.delete(native);
      return;
    }
    // A different snapshot (or a durably empty slot) cannot expose old content.
    rejectedNativeSnapshots.delete(native);
  }
  if (raw.length === 0) return;
  const payloads = raw.map((payload): ResolvedSharePayload => {
    const common = { ...payload, contentMimeType: payload.mimeType ?? null,
      originalName: basenameFromUri(payload.value), contentSize: null };
    return payload.shareType === 'text'
      ? { ...common, contentUri: null, contentType: 'text' }
      : { ...common, contentUri: payload.value,
        contentType: payload.shareType === 'url' ? 'website' : payload.shareType === 'image' ? 'image' : 'file' };
  });
  const id = native.getSharedPayloadId?.(raw) ?? incomingShareBatchId(payloads);
  if (completed?.has(id)) return;
  stageIncomingShareBatch(payloads, () => {
    // Native compares the captured bytes and clears under the writer's lock.
    native.clearSharedPayloads(raw);
  }, id);
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function basenameFromUri(uri: string): string {
  const withoutQuery = uri.split(/[?#]/)[0] ?? uri;
  const slash = Math.max(withoutQuery.lastIndexOf('/'), withoutQuery.lastIndexOf('\\'));
  return safeDecode(slash >= 0 ? withoutQuery.slice(slash + 1) : withoutQuery);
}

function candidateKind(
  category: MobileAttachmentCategory,
): MobileLocalAttachmentUploadCandidate['kind'] {
  return category === 'image' ? 'image' : 'file';
}

function replaceImageExtension(name: string): string {
  const ext = extractRemoteFileExt(name);
  return ext ? `${name.slice(0, -ext.length)}.jpg` : `${name}.jpg`;
}

export function selectIncomingShareUploadCandidates(
  payloads: readonly ResolvedSharePayload[],
): IncomingShareUploadSelection {
  const candidates: MobileLocalAttachmentUploadCandidate[] = [];
  const rejectedUris: string[] = [];

  for (const payload of payloads) {
    if (!isFilePayload(payload)) continue;
    const uri = payload.contentUri?.trim()
      || (payload.shareType === 'file' || payload.shareType === 'image'
        ? payload.value.trim()
        : '');
    if (!uri || !uri.startsWith('file://')) continue;

    const name = payload.originalName?.trim() || basenameFromUri(uri);
    if (!name) {
      rejectedUris.push(uri);
      continue;
    }
    const category = categorizeMobileAttachment(name);
    const isImage = payload.contentType === 'image' || payload.shareType === 'image';

    const size = typeof payload.contentSize === 'number'
      && Number.isFinite(payload.contentSize)
      && payload.contentSize > 0
      ? payload.contentSize
      : 0;
    // Convert known raster encodings only. Vector/source images such as SVG or
    // PSD remain original files rather than failing UIKit's raster decoder.
    const imageExtension = extractRemoteFileExt(name).replace(/^\./, '');
    const convertibleImage = isImage && (!imageExtension || ['heic', 'heif', 'tif', 'tiff', 'bmp'].includes(imageExtension));
    if (category === 'file' && convertibleImage) {
      const index = candidates.length;
      candidates.push({
        kind: 'image',
        uri,
        name,
        size,
        mimeType: payload.contentMimeType?.trim() || payload.mimeType?.trim() || undefined,
        resolve: async () => {
          const resolved = await resolvePastedImageAsset(uri, index);
          return {
            uri: resolved.uri,
            name: replaceImageExtension(name),
            mimeType: resolved.mimeType,
            size: 0,
            skipPreprocess: true,
          };
        },
      });
      continue;
    }
    candidates.push({
      kind: candidateKind(category),
      uri,
      name,
      size,
      mimeType: payload.contentMimeType?.trim() || payload.mimeType?.trim() || undefined,
    });
  }

  return { candidates, rejectedUris };
}

export function __resetIncomingShareForTest(): void {
  unsubscribeOwner?.();
  unsubscribeOwner = undefined;
  currentBatch = null;
  pendingBatches.length = 0;
  listeners.clear();
  rejectedNativeSnapshots = new WeakMap();
  pendingNativeReads.clear();
}
