import * as FileSystem from "expo-file-system/legacy";
import { Directory } from "expo-file-system";
import AsyncStorage from '@react-native-async-storage/async-storage';
import { DURABLE_OUTBOX_PREFIX, type DurableOutboxRecord, type DurableUpload } from "./durableOutbox";
import type { MobileLocalAttachmentUploadCandidate } from "./mobileLocalAttachmentUpload";
import { isAttachmentOssRef } from './attachmentOssRef';
import { isPeerAttachmentRef } from '@cindy/device-link';
import { sanitizeAnnotationRegions, summarizeAnnotationRegions } from '@cindy/maker-shared/image-annotation';

/** Desktop path references already have their source on the controlled device. */
export function outboxAttachmentNeedsLocalBytes(attachment: { path: string }): boolean {
  return isAttachmentOssRef(attachment.path) || isPeerAttachmentRef(attachment.path);
}

function segment(value: string): string {
  return encodeURIComponent(value).replace(/\./g, "%2E");
}
export function durableOutboxDirectory(
  record: Pick<DurableOutboxRecord, "accountId" | "deviceId" | "item" | "storageSessionId">,
): string {
  if (!FileSystem.documentDirectory)
    throw new Error("OUTBOX_STORAGE_UNAVAILABLE");
  return `${FileSystem.documentDirectory}message-outbox/${[record.accountId, record.deviceId, record.storageSessionId ?? record.item.sessionId, record.item.clientId].map(segment).join("/")}/`;
}
export function durableOutboxUploadUri(
  record: DurableOutboxRecord,
  upload: DurableUpload,
): string {
  if (!/^slot-\d+(?:-[a-z0-9]+)?\.[a-z0-9]{1,12}$/.test(upload.fileName))
    throw new Error("OUTBOX_FILE_INVALID");
  return durableOutboxDirectory(record) + upload.fileName;
}
/**
 * 重新留存时可以传入已落盘的 DurableUpload(恢复新建任务时 new.tsx 以
 * `{ ...oldUpload, uri }` 再次留存),它没有 candidate.annotation,但带着上一次落盘的
 * 标注字段——这些字段必须原样沿用,否则恢复后的同一条消息会丢掉 annotated 标与区域。
 */
type RetainSource = MobileLocalAttachmentUploadCandidate &
  Partial<Pick<DurableUpload, "annotated" | "annotationRegions">>;

/** 标注字段随发件箱落盘(区域与乐观上传路径同一归纳算法),重投时照样带给被控端。 */
function annotationFieldsFor(
  source: RetainSource,
): Pick<DurableUpload, "annotated" | "annotationRegions"> {
  if (source.annotation) {
    // 底图已是烧录图(旧红线位置不可知)时不带区域,见 annotationRegionsForUpload。
    if (source.annotation.baseAnnotated) return { annotated: true };
    const regions = summarizeAnnotationRegions(source.annotation.strokes);
    return { annotated: true, ...(regions.length > 0 ? { annotationRegions: regions } : {}) };
  }
  if (source.annotated !== true) return {};
  const regions = sanitizeAnnotationRegions(source.annotationRegions);
  return { annotated: true, ...(regions ? { annotationRegions: regions } : {}) };
}

export async function retainOutboxFile(
  record: DurableOutboxRecord,
  slot: number,
  source: RetainSource,
): Promise<DurableUpload> {
  await initializeOutboxFiles();
  const extension =
    source.name.match(/\.([a-z0-9]{1,12})$/i)?.[1]?.toLowerCase() ?? "bin";
  const upload: DurableUpload = {
    slot,
    fileName: `slot-${slot}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.${extension}`,
    name: source.name,
    mimeType: source.mimeType,
    kind: source.kind,
    size: source.size,
    ...annotationFieldsFor(source),
  };
  await FileSystem.makeDirectoryAsync(durableOutboxDirectory(record), {
    intermediates: true,
  });
  const target = durableOutboxUploadUri(record, upload);
  return { ...upload, size: await copyRetainedBytes(source.uri, target, source.size) };
}

/** Keep the once marker across Fast Refresh: mounted composers can still own stage files. */
const runtime = globalThis as typeof globalThis & {
  __cindyOutboxStageInitialized?: boolean;
  __cindyOutboxFilesInitialized?: Promise<void>;
};

/** Before any new copies, reconcile previous-runtime files against ALL accounts' ledgers.
 * No current-runtime writer runs until this completes; keep the promise over Fast Refresh.
 */
export function initializeOutboxFiles(): Promise<void> {
  if (runtime.__cindyOutboxFilesInitialized) return runtime.__cindyOutboxFilesInitialized;
  const pending = (async () => {
    if (!FileSystem.documentDirectory) throw new Error('OUTBOX_STORAGE_UNAVAILABLE');
    const root = `${FileSystem.documentDirectory}message-outbox/`;
    const retained = new Set<string>();
    const keys = await AsyncStorage.getAllKeys();
    for (const key of keys.filter((key) => key.startsWith(DURABLE_OUTBOX_PREFIX))) {
      const raw = await AsyncStorage.getItem(key);
      if (raw === null) continue;
      const record = JSON.parse(raw) as DurableOutboxRecord;
      if (record.version !== 1 || !record.accountId || !record.deviceId
        || !record.item?.sessionId || !record.item.clientId || !Array.isArray(record.uploads)) {
        throw new Error('OUTBOX_STORAGE_INVALID');
      }
      for (const upload of record.uploads) retained.add(durableOutboxUploadUri(record, upload));
    }
    // Read/validate every ledger before deleting anything. Unknown storage never means empty.
    const visit = async (directory: string, depth: number): Promise<void> => {
      const info = await FileSystem.getInfoAsync(directory);
      if (!info.exists || !info.isDirectory) return;
      for (const name of await FileSystem.readDirectoryAsync(directory)) {
        if (!name || name === '.' || name === '..' || /[\\/]/.test(name)) continue;
        // Native listings return decoded names, while the ledger contains URI-encoded
        // segments. Re-encode before comparison or a realm-qualified account's retained
        // files look unreferenced after restart. Keep the same encoding as the writer.
        const uri = directory + (depth < 4 ? segment(name) : encodeURIComponent(name));
        if (depth < 4) await visit(uri + '/', depth + 1);
        else if (/^slot-\d+(?:-[a-z0-9]+)?\.[a-z0-9]{1,12}$/.test(name) && !retained.has(uri)) {
          await FileSystem.deleteAsync(uri, { idempotent: true });
        }
      }
    };
    await visit(root, 0);
  })();
  runtime.__cindyOutboxFilesInitialized = pending;
  void pending.catch(() => {
    if (runtime.__cindyOutboxFilesInitialized === pending) delete runtime.__cindyOutboxFilesInitialized;
  });
  return pending;
}
export function initializeComposerAttachmentStage(): void {
  if (runtime.__cindyOutboxStageInitialized) return;
  if (!FileSystem.documentDirectory) throw new Error('OUTBOX_STORAGE_UNAVAILABLE');
  const directory = new Directory(`${FileSystem.documentDirectory}outbox-attachment-stage/`);
  // No await: old-runtime cleanup must finish before any current composer may write.
  if (directory.exists) directory.delete();
  runtime.__cindyOutboxStageInitialized = true;
}

/** Composer-owned PUT bytes must survive OS cache eviction until outbox handoff or disposal. */
export async function retainComposerAttachmentFile(owner: string, attachmentId: string, uri: string, size: number): Promise<string> {
  if (!FileSystem.documentDirectory) throw new Error('OUTBOX_STORAGE_UNAVAILABLE');
  initializeComposerAttachmentStage();
  const directory = `${FileSystem.documentDirectory}outbox-attachment-stage/${segment(owner)}/`;
  await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
  const target = directory + segment(attachmentId);
  await copyRetainedBytes(uri, target, size);
  return target;
}

async function copyRetainedBytes(uri: string, target: string, size: number): Promise<number> {
  try {
    await FileSystem.copyAsync({ from: uri, to: target });
    const stat = await FileSystem.getInfoAsync(target);
    if (
      !stat.exists ||
      stat.isDirectory ||
      stat.size <= 0 ||
      (size > 0 && stat.size !== size)
    ) {
      throw new Error("OUTBOX_FILE_COPY_FAILED");
    }
    return stat.size;
  } catch (error) {
    await FileSystem.deleteAsync(target, { idempotent: true }).catch(() => undefined);
    throw error;
  }
}
/** Roll back only this revision's copies; recovery may share the directory with older bytes. */
export async function removeRetainedOutboxFiles(record: DurableOutboxRecord): Promise<void> {
  await Promise.all(record.uploads.map((upload) =>
    FileSystem.deleteAsync(durableOutboxUploadUri(record, upload), { idempotent: true }),
  ));
}
export async function removeOutboxFiles(
  record: DurableOutboxRecord,
): Promise<void> {
  await FileSystem.deleteAsync(durableOutboxDirectory(record), {
    idempotent: true,
  });
}
