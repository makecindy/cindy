/**
 * remoteMediaDiskCache.ts — 远程图片的本地持久缓存(LRU,按源 url 键控)。
 * ---------------------------------------------------------------------------
 * 取件队列(remoteMediaResolveQueue)解决的是同屏内的去重;本模块解决**跨会话屏 /
 * 跨启动**的重复取件:每次取件都要让桌面端把图片重新上传一次 OSS,而聊天历史里的
 * 图片内容是不可变的(xdt-image:// key 即内容标识)。首次取件成功后把字节落盘,
 * 之后同一张图直接用本地 file:// 渲染——零网络、零桌面上传、桌面离线也能看。
 *
 * 结构:缓存目录下 index.json(条目元数据)+ 以 url 哈希命名的图片文件。
 * LRU:超出 maxBytes 时按 lastUsedAt 淘汰最旧;lookup 只更新内存中的 lastUsedAt,
 * index 持久化在下次 store/evict 时顺带落盘(轻微的 LRU 不精确换掉高频写)。
 * 目录放系统 cache 区,OS 低存储时可整体清掉,丢了就当冷缓存重新取件,无一致性负担。
 *
 * 纯逻辑 + 注入 IO(RemoteMediaDiskCacheIO),node 环境可单测;Expo 适配见
 * remoteMediaDiskCacheExpo.ts。
 */

export interface RemoteMediaDiskCacheIO {
  /** 确保缓存目录存在(幂等)。 */
  ensureDir(): void | Promise<void>;
  readIndexText(): Promise<string | null>;
  writeIndexText(text: string): void | Promise<void>;
  fileExists(name: string): boolean | Promise<boolean>;
  fileUri(name: string): string;
  deleteFile(name: string): void | Promise<void>;
  /**
   * 下载 url 到缓存文件;成功返回字节数,失败返回 null(不抛)。
   * 契约:落位必须原子(临时位置下载、成功后移入)——失败时不得破坏已存在的
   * 同名文件,store 的失败清理依赖这一点区分「半成品」与「现存好文件」。
   */
  download(url: string, name: string): Promise<number | null>;
  /**
   * 把 base64 字节写入缓存文件(inline 缩略图落盘用);成功返回字节数,失败返回
   * null(不抛)。契约与 download 相同:落位必须原子,失败不得破坏既有同名文件。
   * 可选:IO 不支持时 storeBytes 静默跳过(缓存是纯优化)。
   */
  writeFileBase64?(name: string, base64: string): number | null | Promise<number | null>;
  /** 列出缓存目录下的数据文件名(不含 index 自身与临时文件),init 对账用。 */
  listFiles(): string[] | Promise<string[]>;
}

export interface RemoteMediaDiskCacheOptions {
  /** 缓存总量上限(字节),默认 150MB。 */
  maxBytes?: number;
  now?(): number;
}

export interface RemoteMediaDiskCacheHit {
  uri: string;
  mimeType: string;
  size: number;
}

export interface RemoteMediaDiskCache {
  /** 命中返回本地 file:// 引用并刷新 LRU 时间;未命中 / 文件丢失返回 null。 */
  lookup(sourceUrl: string): Promise<RemoteMediaDiskCacheHit | null>;
  /**
   * 把已取件成功的图片落盘(同 url 并发只下载一次;失败静默,缓存是纯优化)。
   * expectedSize(已知对象字节数)超过 maxBytes 时直接跳过——落盘只会立刻被
   * LRU 逐出,没必要为此把整个对象下载到手机。
   */
  store(sourceUrl: string, downloadUrl: string, mimeType: string, expectedSize?: number): Promise<void>;
  /**
   * 把已在内存里的字节(base64,inline 缩略图回包)落盘,不经网络下载。
   * 与 store 共用同键串行化,防止同源并发写撕;IO 不支持 writeFileBase64 时静默跳过。
   */
  storeBytes(sourceUrl: string, base64: string, mimeType: string): Promise<void>;
}

const DEFAULT_MAX_BYTES = 150 * 1024 * 1024;
const INDEX_VERSION = 1;

interface IndexEntry {
  name: string;
  mimeType: string;
  size: number;
  lastUsedAt: number;
}

interface IndexShape {
  version: number;
  entries: Record<string, IndexEntry>;
}

export function createRemoteMediaDiskCache(
  io: RemoteMediaDiskCacheIO,
  options: RemoteMediaDiskCacheOptions = {},
): RemoteMediaDiskCache {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const now = options.now ?? (() => Date.now());

  let entries: Map<string, IndexEntry> | null = null;
  let initPromise: Promise<void> | null = null;
  /** 进行中的落盘任务(按缓存键):记录 downloadUrl,同源不同地址不共用结果。 */
  const downloading = new Map<string, { downloadUrl: string; task: Promise<void> }>();

  async function init(): Promise<void> {
    if (entries) return;
    initPromise ??= (async () => {
      await io.ensureDir();
      const text = await io.readIndexText().catch(() => null);
      entries = new Map(Object.entries(parseIndex(text)));
      // 对账:删除 index 之外的孤儿文件。索引损坏当空缓存重建、store 半途落盘、
      // mime 变化换文件名都会留孤儿;LRU 只遍历 index,不对账它们永远不可回收,
      // 磁盘占用会悄悄突破 maxBytes(移动端后台被杀是常态,不是理论路径)。
      const known = new Set([...entries.values()].map((entry) => entry.name));
      const files = await Promise.resolve(io.listFiles()).catch(() => [] as string[]);
      for (const name of files) {
        if (known.has(name)) continue;
        await Promise.resolve(io.deleteFile(name)).catch(() => undefined);
      }
    })();
    await initPromise;
  }

  async function persistIndex(): Promise<void> {
    if (!entries) return;
    const shape: IndexShape = { version: INDEX_VERSION, entries: Object.fromEntries(entries) };
    await io.writeIndexText(JSON.stringify(shape));
  }

  /**
   * download / writeFileBase64 落位之后的共同收尾(两条写入路径同一套失败语义):
   *   - size === null:写入失败(IO 契约保证原子落位、失败不动现有文件)——同名
   *     刷新场景下 name 就是现存条目的好文件,不能误删;只清理并非现存条目的半成品;
   *   - size <= 0:0 字节文件已落位顶替,文件与同名旧条目一并作废,下次 lookup 重取;
   *   - 成功:mime 变化换扩展名时删除不再被引用的旧文件,登记条目并做配额回收。
   */
  async function commitWrittenFile(
    key: string,
    name: string,
    prev: IndexEntry | undefined,
    size: number | null,
    mimeType: string,
  ): Promise<void> {
    if (size === null) {
      if (!prev || prev.name !== name) {
        await Promise.resolve(io.deleteFile(name)).catch(() => undefined);
      }
      return;
    }
    if (size <= 0 || !entries) {
      await Promise.resolve(io.deleteFile(name)).catch(() => undefined);
      if (prev && prev.name === name && entries) {
        entries.delete(key);
        await persistIndex().catch(() => undefined);
      }
      return;
    }
    if (prev && prev.name !== name) {
      await Promise.resolve(io.deleteFile(prev.name)).catch(() => undefined);
    }
    entries.set(key, { name, mimeType, size, lastUsedAt: now() });
    await evictOverBudget();
    await persistIndex().catch(() => undefined);
  }

  /** 超出预算按 lastUsedAt 淘汰最旧(调用方随后统一 persistIndex)。 */
  async function evictOverBudget(): Promise<void> {
    if (!entries) return;
    let total = 0;
    for (const entry of entries.values()) total += entry.size;
    if (total <= maxBytes) return;
    const byOldest = [...entries.entries()].sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
    for (const [key, entry] of byOldest) {
      if (total <= maxBytes) break;
      entries.delete(key);
      total -= entry.size;
      await Promise.resolve(io.deleteFile(entry.name)).catch(() => undefined);
    }
  }

  return {
    async lookup(sourceUrl) {
      await init();
      const key = cacheKeyOf(sourceUrl);
      const entry = entries?.get(key);
      if (!entry) return null;
      const exists = await Promise.resolve(io.fileExists(entry.name)).catch(() => false);
      if (!exists) {
        // 文件被 OS 清掉 / 手动删除:丢弃条目自愈,当未命中处理。
        entries?.delete(key);
        return null;
      }
      entry.lastUsedAt = now();
      return { uri: io.fileUri(entry.name), mimeType: entry.mimeType, size: entry.size };
    },

    async store(sourceUrl, downloadUrl, mimeType, expectedSize) {
      await init();
      // 单对象就超预算:落盘立刻会被 LRU 逐出,整个下载都是白费,直接跳过。
      if (expectedSize !== undefined && expectedSize > maxBytes) return;
      const key = cacheKeyOf(sourceUrl);
      const run = async (): Promise<void> => {
        const name = `${key}.${extOfMime(mimeType)}`;
        const prev = entries?.get(key);
        const size = await io.download(downloadUrl, name);
        await commitWrittenFile(key, name, prev, size, mimeType);
      };
      const pending = downloading.get(key);
      // 只合并**同一下载地址**的并发 store。forceRefresh 自愈会带全新 presign 地址,
      // 若并入旧地址的 pending(常见:已证伪的 stale key),旧下载失败会让新图永远
      // 不落盘——退屏清理还会删掉新 OSS 对象,下次进会话被迫重传。不同地址排在
      // 旧任务之后串行执行(旧任务成败都不影响新写入)。
      if (pending && pending.downloadUrl === downloadUrl) return pending.task;
      const base = pending ? pending.task.catch(() => undefined).then(run) : run();
      const entry = { downloadUrl, task: base };
      entry.task = base.finally(() => {
        if (downloading.get(key) === entry) downloading.delete(key);
      });
      downloading.set(key, entry);
      return entry.task;
    },

    async storeBytes(sourceUrl, base64, mimeType) {
      if (!io.writeFileBase64 || !base64) return;
      await init();
      const key = cacheKeyOf(sourceUrl);
      const run = async (): Promise<void> => {
        const name = `${key}.${extOfMime(mimeType)}`;
        const prev = entries?.get(key);
        const size = await Promise.resolve(io.writeFileBase64!(name, base64)).catch(() => null);
        await commitWrittenFile(key, name, prev, size, mimeType);
      };
      // 与 store 共用同键串行化(防写撕);inline 写入无下载地址概念,不合并任何
      // 既有任务,一律排在其后执行(旧任务成败都不影响本次写入)。
      const pending = downloading.get(key);
      const base = pending ? pending.task.catch(() => undefined).then(run) : run();
      const entry = { downloadUrl: 'inline:bytes', task: base };
      entry.task = base.finally(() => {
        if (downloading.get(key) === entry) downloading.delete(key);
      });
      downloading.set(key, entry);
      return entry.task;
    },
  };
}

function parseIndex(text: string | null): Record<string, IndexEntry> {
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as IndexShape;
    if (!parsed || parsed.version !== INDEX_VERSION || typeof parsed.entries !== 'object' || !parsed.entries) {
      return {};
    }
    const out: Record<string, IndexEntry> = {};
    for (const [key, value] of Object.entries(parsed.entries)) {
      if (value
        && typeof value.name === 'string'
        && typeof value.mimeType === 'string'
        && typeof value.size === 'number'
        && typeof value.lastUsedAt === 'number') {
        out[key] = value;
      }
    }
    return out;
  } catch {
    return {}; // 索引损坏当空缓存;index 之外的旧文件由 init 对账统一清掉
  }
}

/** 源 url → 缓存键(FNV-1a 32bit ×2 轮 + 长度,十六进制;仅作文件名,无安全诉求)。 */
export function cacheKeyOf(sourceUrl: string): string {
  const h1 = fnv1a(sourceUrl, 0x811c9dc5);
  const h2 = fnv1a(sourceUrl, h1 || 0x811c9dc5);
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}${(sourceUrl.length % 0xff).toString(16).padStart(2, '0')}`;
}

function fnv1a(input: string, seed: number): number {
  let hash = seed >>> 0;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * 从 url 路径扩展名反推图片 mime(direct http 图分享时没有 resolved 记录,
 * mimeType 缺失;不推断会一律按 .jpg 落地,分享目标据扩展名误判 PNG/WebP/GIF)。
 * 未知扩展名返回 null,由调用方决定兜底。
 */
export function imageMimeFromUrl(url: string): string | null {
  const match = /\.([a-z0-9]+)(?:[?#]|$)/i.exec(url);
  const ext = match?.[1]?.toLowerCase();
  if (!ext) return null;
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'png') return 'image/png';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'svg') return 'image/svg+xml';
  if (ext === 'bmp') return 'image/bmp';
  return null;
}

/** mime → 文件扩展名(缓存 / 分享临时文件命名共用)。 */
export function extOfMime(mimeType: string): string {
  if (mimeType === 'image/jpeg') return 'jpg';
  if (mimeType === 'image/png') return 'png';
  if (mimeType === 'image/gif') return 'gif';
  if (mimeType === 'image/webp') return 'webp';
  if (mimeType === 'image/svg+xml') return 'svg';
  if (mimeType === 'image/bmp') return 'bmp';
  return 'img';
}

export const __testing = { parseIndex, fnv1a };
