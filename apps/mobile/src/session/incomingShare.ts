/**
 * iOS Share Extension → 新建任务附件信箱。
 *
 * expo-sharing 把扩展收到的文件复制进 App Group，并在主 App 激活后提供本地
 * payload。根导航只负责把 payload 放进这个进程内信箱；新建会话页领取后复用现有
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
}

export interface IncomingShareUploadSelection {
  candidates: MobileLocalAttachmentUploadCandidate[];
  rejectedUris: string[];
}

let currentBatch: IncomingShareBatch | null = null;
const pendingBatches: IncomingShareBatch[] = [];
const listeners = new Set<() => void>();
let unsubscribeOwner: (() => void) | undefined;

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

function isFirstShareLogin(owner: MobileAuthOwnerGeneration): boolean {
  const current = getMobileAuthOwner();
  return !owner.accountKey && !!current.accountKey
    && current.generation === owner.generation + 1;
}

function updateIncomingShareOwner(): void {
  const owner = getMobileAuthOwner();
  const discarded = pendingBatches.filter((batch) => {
    // A share received while logged out may follow the first login only.
    if (isFirstShareLogin(batch.owner)) {
      batch.owner = owner;
    }
    return !isMobileAuthOwnerCurrent(batch.owner);
  });
  if (!discarded.length) return;
  for (const batch of discarded) {
    pendingBatches.splice(pendingBatches.indexOf(batch), 1);
    acknowledgeBatch(batch);
    void deleteIncomingSharedFiles(batch.payloads.map((payload) => payload.contentUri ?? payload.value))
      .catch(() => undefined);
  }
  currentBatch = pendingBatches[0] ?? null;
  emit();
}

type IncomingShareNative = {
  getSharedPayloads(): SharePayload[];
  clearSharedPayloads(): void;
};

/** Also clear a native payload not yet observed by the JS mailbox on logout/switch. */
export function watchIncomingShareAccount(
  native: IncomingShareNative,
  previous = getMobileAuthOwner(),
): () => void {
  const changed = () => {
    const current = getMobileAuthOwner();
    if (!isMobileAuthOwnerCurrent(previous) && !isFirstShareLogin(previous)) {
      try {
        const raw = native.getSharedPayloads();
        native.clearSharedPayloads();
        void deleteIncomingSharedFiles(raw.map((payload) => payload.value)).catch(() => undefined);
      } catch { /* Sharing is unavailable in older native binaries. */ }
    }
    previous = current;
  };
  changed();
  return subscribeMobileAuthOwner(changed);
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
): IncomingShareBatch | null {
  if (payloads.length === 0) return null;
  const id = incomingShareBatchId(payloads);
  const existing = pendingBatches.find((batch) => batch.id === id);
  if (existing) return existing;
  unsubscribeOwner ??= subscribeMobileAuthOwner(updateIncomingShareOwner);
  const batch = { id, payloads: [...payloads], acknowledge, owner: getMobileAuthOwner() };
  pendingBatches.push(batch);
  currentBatch = pendingBatches[0]!;
  emit();
  return batch;
}

export function consumeIncomingShareBatch(id: string): boolean {
  if (!currentBatch || currentBatch.id !== id
    || !currentBatch.owner.accountKey || !isMobileAuthOwnerCurrent(currentBatch.owner)) return false;
  const consumed = currentBatch;
  pendingBatches.shift();
  currentBatch = pendingBatches[0] ?? null;
  emit();
  acknowledgeBatch(consumed);
  return true;
}

/** Raw local files need no asynchronous resolver; the uploader stats their size. */
export function receiveIncomingShare(native: IncomingShareNative): void {
  const raw = native.getSharedPayloads();
  if (raw.length === 0) return;
  const key = JSON.stringify(raw);
  const payloads = raw.map((payload): ResolvedSharePayload => ({
    ...payload,
    contentUri: payload.value,
    contentType: payload.shareType === 'image' ? 'image' : 'file',
    contentMimeType: payload.mimeType ?? null,
    originalName: basenameFromUri(payload.value),
    contentSize: null,
  }));
  stageIncomingShareBatch(payloads, () => {
    // A second share may replace the native slot while login is pending.
    if (JSON.stringify(native.getSharedPayloads()) === key) native.clearSharedPayloads();
  });
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
    const uri = payload.contentUri?.trim()
      || (payload.shareType === 'file' || payload.shareType === 'image'
        ? payload.value.trim()
        : '');
    if (!uri || !uri.startsWith('file://')) continue;

    const name = payload.originalName?.trim() || basenameFromUri(uri);
    const category = name ? categorizeMobileAttachment(name) : null;
    const isImage = payload.contentType === 'image' || payload.shareType === 'image';
    if (!name || (!category && !isImage)) {
      rejectedUris.push(uri);
      continue;
    }

    const size = typeof payload.contentSize === 'number'
      && Number.isFinite(payload.contentSize)
      && payload.contentSize > 0
      ? payload.contentSize
      : 0;
    if (!category && isImage) {
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
      kind: candidateKind(category!),
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
}
