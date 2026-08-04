/**
 * sentAttachmentThumbStore — 已发送本机图片附件的本地缩略图兜底映射。
 * ---------------------------------------------------------------------------
 * 手机端上传的图片在消息里持久化为 `cindy-oss-attach://` 中转引用;该引用要等被控端
 * (桌面)取走消息、物化进 image cache 后才被改写成可远程取件的 `xdt-image://`。
 * 改写结果不会回推,所以「发出后停留在当前界面」期间(以及桌面端离线、消息压在
 * 队列里的整个窗口)气泡只能显示「暂不能直接预览」占位卡——图明明就在手机本地。
 *
 * 本 store 补上这个空档:上传成功时把实际 PUT 的文件(降采样产物,通常几百 KB)
 * 拷贝进 app 自有目录,记录「ossRef → 本地相对文件名」映射并持久化;渲染用户消息
 * 图片时 url 仍是 `cindy-oss-attach://` 且映射命中 → 用本地图当缩略图。桌面端物化后
 * url 变成 `xdt-image://`,兜底自然退场,条目由过期清理回收。
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
import { isAttachmentOssRef } from '@/session/attachmentOssRef';
import { isPayloadDesktopLocalMediaUrl } from '@cindy/maker-shared/payload-summary';

const STORAGE_KEY = 'xdt.sentAttachmentThumbs.v1';
/** documentDirectory 下的自有子目录(不放 cache:系统清缓存会把兜底图清裂)。 */
const THUMB_DIR_NAME = 'sent-attachment-thumbs';
/** 条目上限(LRU,按注册时间淘汰)。窗口期本来就短,64 条覆盖极端连发场景。 */
const MAX_ENTRIES = 64;
/** 过期时长:桌面端物化通常秒级完成,7 天足够覆盖「电脑长期离线」的长尾。 */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * 单文件体积上限:降采样产物典型几百 KB;gif / 原样直传可到 30MB(上传上限),
 * 超限的不做本地兜底(气泡回落占位卡,可接受降级),防兜底目录无界膨胀。
 */
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;

/** 拷贝产物扩展名白名单(其余回落 .jpg;只影响文件名,不影响渲染)。 */
const KNOWN_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp']);

interface ThumbEntry {
  /** THUMB_DIR_NAME 下的相对文件名。 */
  file: string;
  /** 注册时间戳(LRU 淘汰 + 过期清理用)。 */
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
};

const entries = new Map<string, ThumbEntry>();
const listeners = new Set<() => void>();
let version = 0;
/** hydrate 后缓存的 documentDirectory(以 / 结尾),同步查询拼路径用。 */
let cachedDocDir: string | null = null;
let hydratePromise: Promise<void> | null = null;
let fileSeq = 0;
let persistQueue: Promise<void> = Promise.resolve();

function bump(): void {
  version += 1;
  for (const listener of [...listeners]) listener();
}

function thumbDir(): string | null {
  return cachedDocDir ? `${cachedDocDir}${THUMB_DIR_NAME}` : null;
}

/**
 * 冷启动回填:读持久化映射进内存,顺带清过期条目与目录孤儿文件。幂等,
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
  const raw = await AsyncStorage.getItem(STORAGE_KEY).catch(() => null);
  const now = Date.now();
  const keep: Array<[string, ThumbEntry]> = [];
  let dropped = 0;
  for (const [ossRef, entry] of parseStoredEntries(raw)) {
    if (now - entry.at > MAX_AGE_MS) {
      dropped += 1;
      continue;
    }
    keep.push([ossRef, entry]);
  }
  // 内存以磁盘为底、保留 hydrate 期间已注册的新条目(register 先 await hydrate,
  // 实际不会先写;防御性合并保证后写胜)。
  for (const [ossRef, entry] of keep) {
    if (!entries.has(ossRef)) entries.set(ossRef, entry);
  }
  // 目录孤儿清理:磁盘上存在但映射不再引用的文件(过期条目的文件也在此统一删)。
  const dir = thumbDir();
  if (dir) {
    const kept = new Set([...entries.values()].map((entry) => entry.file));
    const names = await deps.readDirectory(dir).catch(() => [] as string[]);
    for (const name of names) {
      if (!kept.has(name)) void deps.remove(`${dir}/${name}`).catch(() => undefined);
    }
  }
  if (dropped > 0) schedulePersist();
  bump();
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
  return isAttachmentOssRef(value) || isPayloadDesktopLocalMediaUrl(value);
}

/**
 * 注册一条兜底映射:把 sourceUri(实际上传的文件,降采样产物或原图)拷贝进
 * 自有目录并持久化 ossRef → 文件名。全程静默失败——兜底是增强,不挡主流程。
 */
export async function registerSentAttachmentThumb(
  ossRef: string | undefined,
  sourceUri: string,
  deps: SentAttachmentThumbFsDeps = defaultFsDeps,
): Promise<void> {
  if (!isThumbBackedRef(ossRef) || !sourceUri) return;
  try {
    await ensureSentAttachmentThumbsHydrated(deps);
    if (entries.has(ossRef)) return;
    const dir = thumbDir();
    if (!dir) return;
    const size = await deps.statSize(sourceUri).catch(() => 0);
    if (size > MAX_SOURCE_BYTES) return;
    const at = Date.now();
    fileSeq += 1;
    const file = `thumb-${at}-${fileSeq}.${extForUri(sourceUri)}`;
    await deps.makeDirectory(dir);
    await deps.copy(sourceUri, `${dir}/${file}`);
    // LRU 淘汰:超上限先删最老条目(含其文件),再入新条目。
    while (entries.size >= MAX_ENTRIES) {
      let oldestKey: string | null = null;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [key, entry] of entries) {
        if (entry.at < oldestAt) {
          oldestAt = entry.at;
          oldestKey = key;
        }
      }
      if (!oldestKey) break;
      const evicted = entries.get(oldestKey);
      entries.delete(oldestKey);
      if (evicted) void deps.remove(`${dir}/${evicted.file}`).catch(() => undefined);
    }
    entries.set(ossRef, { file, at });
    schedulePersist();
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
  if (!hydratePromise) void ensureSentAttachmentThumbsHydrated();
  const dir = thumbDir();
  if (!dir) return null;
  const entry = entries.get(ossRef);
  return entry ? `${dir}/${entry.file}` : null;
}

/**
 * 渲染层 overlay:用户消息图片附件 url 仍是 `cindy-oss-attach://`(previewable=false)
 * 且本地兜底命中时,替换成本地 file:// 并标记可直接预览;其余原样返回。
 * 泛型约束按 NormalizedAttachment 的最小形状,不反向依赖 messageNormalize。
 */
export function applySentAttachmentThumbOverlay<
  T extends { kind: string; uri?: string; previewable: boolean },
>(item: T): T {
  if (item.kind !== 'image' || item.previewable || !item.uri || !isAttachmentOssRef(item.uri)) {
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

function parseStoredEntries(raw: string | null): Array<[string, ThumbEntry]> {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: Array<[string, ThumbEntry]> = [];
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
      ) {
        out.push([record.ossRef, { file: record.file, at: record.at }]);
      }
    }
    return out;
  } catch {
    return [];
  }
}

function schedulePersist(): void {
  const snapshot = [...entries.entries()].map(([ossRef, entry]) => ({
    ossRef,
    file: entry.file,
    at: entry.at,
  }));
  persistQueue = persistQueue
    .catch(() => undefined)
    .then(() => AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot)))
    .catch(() => undefined);
}

export const __testing = {
  maxAgeMs: MAX_AGE_MS,
  maxEntries: MAX_ENTRIES,
  maxSourceBytes: MAX_SOURCE_BYTES,
  storageKey: STORAGE_KEY,
  thumbDirName: THUMB_DIR_NAME,
  /** 等持久化队列排空(测试断言 AsyncStorage 内容前调用)。 */
  flushPersist(): Promise<void> {
    return persistQueue;
  },
  reset(): void {
    entries.clear();
    listeners.clear();
    version = 0;
    cachedDocDir = null;
    hydratePromise = null;
    fileSeq = 0;
    persistQueue = Promise.resolve();
  },
};
