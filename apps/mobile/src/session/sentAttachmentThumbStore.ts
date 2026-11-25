/**
 * sentAttachmentThumbStore — 已发送本机图片附件的本地缩略图兜底映射。
 * ---------------------------------------------------------------------------
 * 上传成功后保留实际发送的图片字节，同时接受 OSS 与直传引用。
 * 原引用继续持久化；从其中的完整性指纹重建查询索引，让消息换成 cindy-media
 * 内容地址后仍能使用同一副本。缩略图与原图查看共用这份已上传的完整图片。
 *
 * 设计要点:
 *   - 映射存**相对文件名**:iOS app 容器绝对路径会随更新变化,不能持久化绝对路径;
 *   - 渲染消费是同步内存查询(`getSentAttachmentThumbUri`),UI 经
 *     `useSentAttachmentThumbsVersion` 订阅版本号,hydrate / 新注册后自动刷新;
 *   - 兜底是纯增强:注册/清理全程静默失败,绝不影响上传与发送主流程;
 *   - fs 操作经 deps 注入(默认动态 import expo-file-system/legacy),node 可单测,
 *     模式与 mobileImagePreprocess / mobileAttachmentUpload 一致。
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';
import { getMobileAuthOwner, isMobileAuthOwnerCurrent, subscribeMobileAuthOwner } from '@/auth/authOwnerGeneration';
import { isAttachmentOssRef, parseAttachmentOssRef, isPeerAttachmentRef, parsePeerAttachmentRef } from '@cindy/device-link';
import { isPayloadDesktopLocalMediaUrl } from '@cindy/maker-shared/payload-summary';
import { extOfMime, imageMimeFromUrl, type RemoteMediaDiskCacheHit } from '@/session/remoteMediaDiskCache';

const STORAGE_KEY = 'xdt.sentAttachmentThumbs.v1';
/** documentDirectory 下的自有子目录(不放 cache:系统清缓存会把兜底图清裂)。 */
const THUMB_DIR_NAME = 'sent-attachment-thumbs';
const FILE_THUMB_DIR_NAME = 'sent-attachment-thumbs-v2';
const INDEX_FILE_NAME = 'sent-attachment-thumbs-v2.json';
/** 拷贝产物扩展名白名单(其余回落 .jpg;只影响文件名,不影响渲染)。 */
const KNOWN_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp']);

interface ThumbEntry {
  accountKey: string;
  /** 相对于各自底片目录的文件名。 */
  legacy: boolean;
  file: string;
  /** 注册时间戳。 */
  at: number;
}

/** fs 操作注入点(单测传假实现;默认走 expo-file-system/legacy)。 */
export interface SentAttachmentThumbFsDeps {
  documentDirectory(): Promise<string | null>;
  copy(from: string, to: string): Promise<void>;
  remove(uri: string): Promise<void>;
  readDirectory(dir: string): Promise<string[]>;
  makeDirectory(dir: string): Promise<void>;
  statSize(uri: string): Promise<number>;
  readIndex(docDir: string): Promise<string | null>;
  writeIndex(docDir: string, text: string): Promise<void>;
}

const defaultFsDeps: SentAttachmentThumbFsDeps = {
  async documentDirectory() {
    const FileSystem = await import('expo-file-system/legacy');
    return FileSystem.documentDirectory;
  },
  async copy(from, to) {
    const FileSystem = await import('expo-file-system/legacy');
    await FileSystem.copyAsync({ from, to });
  },
  async remove(uri) {
    const FileSystem = await import('expo-file-system/legacy');
    await FileSystem.deleteAsync(uri, { idempotent: true });
  },
  async readDirectory(dir) {
    const FileSystem = await import('expo-file-system/legacy');
    return FileSystem.readDirectoryAsync(dir);
  },
  async makeDirectory(dir) {
    const FileSystem = await import('expo-file-system/legacy');
    // intermediates 幂等;已存在时个别平台仍可能 throw,catch 后交给 copy 失败兜底。
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(() => undefined);
  },
  async statSize(uri) {
    const { statMobileAttachmentFileSize } = await import('@/session/mobileAttachmentUpload');
    return statMobileAttachmentFileSize(uri);
  },
  async readIndex(docDir) {
    const { File } = await import('expo-file-system');
    const file = new File(docDir, INDEX_FILE_NAME);
    return file.exists ? file.text() : null;
  },
  async writeIndex(docDir, text) {
    const { File } = await import('expo-file-system');
    const fs = await import('expo-file-system/legacy');
    const temporaryUri = `${docDir}${INDEX_FILE_NAME}.tmp`;
    const temporary = new File(temporaryUri);
    try {
      await fs.writeAsStringAsync(temporaryUri, text);
      temporary.moveSync(new File(docDir, INDEX_FILE_NAME), { overwrite: true });
    } finally {
      await fs.deleteAsync(temporaryUri, { idempotent: true }).catch(() => undefined);
    }
  },
};

const entries = new Map<string, ThumbEntry>();
/** Derived from the existing persisted refs; no second copy or persistence format. */
const entriesByHash = new Map<string, ThumbEntry>();
const listeners = new Set<() => void>();
let version = 0;
/** hydrate 后缓存的 documentDirectory(以 / 结尾),同步查询拼路径用。 */
let cachedDocDir: string | null = null;
let hydratePromise: Promise<void> | null = null;
let fileSeq = 0;
let persistQueue: Promise<void> = Promise.resolve();
let fileIndexLoaded = false;
let indexRevision = 0;
let savedIndexRevision = 0;

function bump(): void {
  version += 1;
  for (const listener of [...listeners]) listener();
}
subscribeMobileAuthOwner(bump);

function scopedKey(accountKey: string, ref: string): string {
  return JSON.stringify([accountKey, ref]);
}

function thumbDir(legacy = false): string | null {
  return cachedDocDir ? `${cachedDocDir}${legacy ? THUMB_DIR_NAME : FILE_THUMB_DIR_NAME}` : null;
}

function contentHash(ref: string): string | undefined {
  return /^cindy-media:\/\/blobs\/([a-f0-9]{64})\.[a-z0-9]+$/.exec(ref)?.[1]
    ?? parseAttachmentOssRef(ref)?.sha256 ?? parsePeerAttachmentRef(ref)?.sha256;
}

function imageMimeForRef(ref: string): string | undefined {
  return parseAttachmentOssRef(ref)?.mimeType ?? parsePeerAttachmentRef(ref)?.mimeType
    ?? imageMimeFromUrl(ref) ?? undefined;
}

function rememberEntry(ref: string, entry: ThumbEntry): void {
  entries.set(scopedKey(entry.accountKey, ref), entry);
  const hash = contentHash(ref);
  if (hash) entriesByHash.set(scopedKey(entry.accountKey, hash), entry);
}

/**
 * 冷启动回填:读持久化映射进内存,顺带清目录孤儿文件。幂等,
 * 首次查询 / 注册时惰性触发。
 */
export function ensureSentAttachmentThumbsHydrated(
  deps: SentAttachmentThumbFsDeps = defaultFsDeps,
): Promise<void> {
  if (!hydratePromise) {
    hydratePromise = hydrateInternal(deps).catch(() => undefined);
  }
  return hydratePromise;
}

async function hydrateInternal(deps: SentAttachmentThumbFsDeps): Promise<void> {
  cachedDocDir = await deps.documentDirectory().catch(() => null);
  if (!cachedDocDir) return;
  // Keep the old index and copies available to older clients. A failed SQLite
  // read (including an oversized row) cannot establish which copies are unused.
  await hydrateIndex(deps, true, () => AsyncStorage.getItem(STORAGE_KEY)).catch(() => undefined);
  const docDir = cachedDocDir;
  fileIndexLoaded = await hydrateIndex(deps, false, () => deps.readIndex(docDir))
    .then(() => true, () => false);
  bump();
}

async function hydrateIndex(
  deps: SentAttachmentThumbFsDeps,
  legacy: boolean,
  read: () => Promise<string | null>,
): Promise<void> {
  const raw = await read();
  if (raw === null) return;
  const { records, complete } = parseStoredEntries(raw, legacy);
  for (const [ref, entry] of records) rememberEntry(ref, entry);
  const dir = thumbDir(legacy);
  if (dir && complete) {
    const kept = new Set(records.map(([, entry]) => entry.file));
    const names = await deps.readDirectory(dir).catch(() => [] as string[]);
    await Promise.all(names.filter(name => !kept.has(name)).map(name =>
      deps.remove(`${dir}/${name}`).catch(() => undefined)));
  }
  // Never overwrite a partially read file index.
  if (!complete && !legacy) throw new Error('Invalid sent attachment index');
}

/**
 * 哪些引用值得留本地底片。
 *
 * 除了手机自己上传产生的 `xdt-oss-attach://`,还包括桌面本地媒体引用
 * (`cindy-media://blobs/<指纹>` 等):粘贴图片时字节会先进媒体总仓,附件 url 就是这种
 * 引用,手机本地没有对应文件。原先这里只认 OSS 引用,这类图一律不留底,于是发出后
 * 气泡只能画空占位格、必须等远端取件才有图。粘贴那一刻前端手里同时握着本地文件与远端
 * 引用,应当当场记下对应关系 —— 留底之后气泡第一帧就有图,远端取件退化为后备。
 */
function isThumbBackedRef(value: unknown): value is string {
  return isAttachmentOssRef(value) || isPeerAttachmentRef(value) || isPayloadDesktopLocalMediaUrl(value);
}

/**
 * 注册一条兜底映射:把 sourceUri(实际上传的文件,降采样产物或原图)拷贝进
 * 自有目录并持久化 ossRef → 文件名。全程静默失败——兜底是增强,不挡主流程。
 */
export async function registerSentAttachmentThumb(
  ossRef: string | undefined,
  sourceUri: string,
  deps: SentAttachmentThumbFsDeps = defaultFsDeps,
  isActive: () => boolean = () => true,
): Promise<void> {
  if (!isThumbBackedRef(ossRef) || !sourceUri) return;
  const owner = getMobileAuthOwner();
  const current = () => !!owner.accountKey && isMobileAuthOwnerCurrent(owner) && isActive();
  if (!current()) return;
  try {
    await ensureSentAttachmentThumbsHydrated(deps);
    if (!current() || !fileIndexLoaded || entries.has(scopedKey(owner.accountKey, ossRef))) return;
    const dir = thumbDir();
    const docDir = cachedDocDir;
    if (!dir || !docDir) return;
    const at = Date.now();
    fileSeq += 1;
    // Upload snapshots intentionally have no extension. Keep the image's actual
    // format so sharing a retained PNG/GIF does not label its bytes as JPEG.
    const mime = imageMimeForRef(ossRef);
    const file = `thumb-${at}-${fileSeq}.${mime?.startsWith('image/') ? extOfMime(mime) : extForUri(sourceUri)}`;
    await deps.makeDirectory(dir);
    if (!current()) return;
    await deps.copy(sourceUri, `${dir}/${file}`);
    if (!current()) {
      await deps.remove(`${dir}/${file}`);
      return;
    }
    rememberEntry(ossRef, { file, at, accountKey: owner.accountKey, legacy: false });
    schedulePersist(deps, docDir);
    bump();
  } catch {
    // 拷贝 / 持久化失败:放弃这条兜底,气泡回落占位卡(现状),不影响发送。
  }
}

/**
 * 同步查询:ossRef 命中且 hydrate 已就位 → 本地 file:// 绝对路径;否则 null。
 * 未 hydrate 时顺带惰性触发,完成后经版本订阅驱动重渲染。
 */
export function getSentAttachmentThumbUri(ossRef: string): string | null {
  const { accountKey } = getMobileAuthOwner();
  if (!accountKey) return null;
  if (!hydratePromise) void ensureSentAttachmentThumbsHydrated();
  const hash = contentHash(ossRef);
  const entry = entries.get(scopedKey(accountKey, ossRef))
    ?? (hash ? entriesByHash.get(scopedKey(accountKey, hash)) : undefined);
  const dir = entry && thumbDir(entry.legacy);
  return entry && dir ? `${dir}/${entry.file}` : null;
}

/** Original-image reads must wait for hydration and verify the retained file still exists. */
export async function resolveSentAttachmentThumb(
  ref: string,
  deps: SentAttachmentThumbFsDeps = defaultFsDeps,
): Promise<RemoteMediaDiskCacheHit | null> {
  const owner = getMobileAuthOwner();
  if (!owner.accountKey) return null;
  await ensureSentAttachmentThumbsHydrated(deps);
  if (!isMobileAuthOwnerCurrent(owner)) return null;
  const uri = getSentAttachmentThumbUri(ref);
  if (!uri) return null;
  const size = await deps.statSize(uri).catch(() => 0);
  if (size <= 0 || !isMobileAuthOwnerCurrent(owner)) return null;
  const mimeType = imageMimeForRef(ref) ?? imageMimeFromUrl(uri);
  return mimeType?.startsWith('image/') ? { uri, size, mimeType } : null;
}

/**
 * 渲染层 overlay:用户消息图片附件 url 仍是 `cindy-oss-attach://`(previewable=false)
 * 且本地兜底命中时,替换成本地 file:// 并标记可直接预览;其余原样返回。
 * 泛型约束按 NormalizedAttachment 的最小形状,不反向依赖 messageNormalize。
 */
export function applySentAttachmentThumbOverlay<
  T extends { kind: string; uri?: string; previewable: boolean },
>(item: T): T {
  if (item.kind !== 'image' || item.previewable || !item.uri
    || !(isAttachmentOssRef(item.uri) || isPeerAttachmentRef(item.uri))) {
    return item;
  }
  const local = getSentAttachmentThumbUri(item.uri);
  return local ? { ...item, uri: local, previewable: true } : item;
}

export function subscribeSentAttachmentThumbs(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getSentAttachmentThumbsVersion(): number {
  return version;
}

/**
 * React hook:订阅映射版本号。mount 即触发惰性 hydrate,数据变化(hydrate 完成 /
 * 新注册)时驱动消费组件重渲染;返回值本身通常无需使用。
 */
export function useSentAttachmentThumbsVersion(): number {
  return useSyncExternalStore(
    subscribeSentAttachmentThumbs,
    getSentAttachmentThumbsVersion,
    getSentAttachmentThumbsVersion,
  );
}

function extForUri(uri: string): string {
  const clean = uri.split('?')[0] ?? uri;
  const dotIdx = clean.lastIndexOf('.');
  const ext = dotIdx >= 0 ? clean.slice(dotIdx + 1).toLowerCase() : '';
  return KNOWN_EXTS.has(ext) ? ext : 'jpg';
}

function parseStoredEntries(raw: string, legacy: boolean) {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('Invalid sent attachment index');
  const records: Array<[string, ThumbEntry]> = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    if (
      typeof record.ossRef === 'string'
      && record.ossRef.length > 0
      && typeof record.file === 'string'
      && record.file.length > 0
      && typeof record.at === 'number'
      && Number.isFinite(record.at)
      && typeof record.accountKey === 'string'
      && record.accountKey.length > 0
    ) {
      records.push([record.ossRef, { file: record.file, at: record.at, accountKey: record.accountKey, legacy }]);
    }
  }
  return { records, complete: records.length === parsed.length };
}

function schedulePersist(deps: SentAttachmentThumbFsDeps, docDir: string): void {
  indexRevision += 1;
  persistQueue = persistQueue.then(async () => {
    const revision = indexRevision;
    if (revision === savedIndexRevision) return;
    const snapshot = [...entries].flatMap(([key, entry]) => entry.legacy ? [] : [{
      ossRef: (JSON.parse(key) as [string, string])[1],
      accountKey: entry.accountKey,
      file: entry.file,
      at: entry.at,
    }]);
    await deps.writeIndex(docDir, JSON.stringify(snapshot));
    savedIndexRevision = revision;
  }).catch(() => undefined);
}

export const __testing = {
  storageKey: STORAGE_KEY,
  thumbDirName: THUMB_DIR_NAME,
  fileThumbDirName: FILE_THUMB_DIR_NAME,
  /** 等持久化队列排空(测试断言索引内容前调用)。 */
  flushPersist(): Promise<void> {
    return persistQueue;
  },
  reset(): void {
    entries.clear();
    entriesByHash.clear();
    listeners.clear();
    version = 0;
    cachedDocDir = null;
    hydratePromise = null;
    fileSeq = 0;
    fileIndexLoaded = false;
    indexRevision = 0;
    savedIndexRevision = 0;
    persistQueue = Promise.resolve();
  },
};
