/**
 * fileContentCache — 模块级 LRU + chokidar-aware,服务于 useFileContent。
 *
 * 设计要点:
 *   - Key = `${workdir}|${relPath}`。
 *   - LRU: Map 的插入顺序天然就是访问顺序; get 命中时 delete + set 一遍,
 *     最旧的就漂到队首,evict 时直接砍队首。
 *   - 双约束: 条数上限 (MAX_ITEMS) + 字节上限 (MAX_BYTES)。两者都触发 evict。
 *   - 失效: 由 useFileContent 监听 chokidar 'change'/'unlink' 事件主动 evict。
 *     这样命中后 setState 直接用 cached 内容、零 IPC、零 GC 压力。
 *   - 仅 cache 'text' 内容; binary / error / loading 不入 cache (binary 要走
 *     不同分支, error 重试要 hit 真 IPC, loading 是过渡态)。
 *
 * 为什么不在 hook 里用 useState 持有 cache:
 *   组件级 cache 跟着 mount/unmount 一起销毁, 用户切 tab → 切回来时 cache
 *   就没了; 模块级才能跨实例 / 跨重渲染保活。同一 workdir 的不同 hook 实例
 *   也共享同一份, 切 sidebar/route 视图时无重复 IPC。
 */
import type { FileContent } from '../hooks/useFileContent';

interface CachedText {
  kind: 'text';
  content: string;
  relPath: string;
  size: number;
  mtimeMs: number;
  truncated: boolean;
  resolvedPath?: string;
  /** 估算的字节占用 (utf-16 char × 2), 用来做总字节上限 evict。 */
  byteSize: number;
}

const MAX_ITEMS = 8;
const MAX_BYTES = 16 * 1024 * 1024; // 16 MiB

const cache = new Map<string, CachedText>();
let totalBytes = 0;

function makeKey(workdir: string, relPath: string): string {
  return `${workdir}|${relPath}`;
}

/** 命中返回 FileContent (text 分支); 未命中返回 null。 命中会 LRU bump。 */
export function getCachedFileContent(
  workdir: string,
  relPath: string,
): FileContent | null {
  const key = makeKey(workdir, relPath);
  const hit = cache.get(key);
  if (!hit) return null;
  // LRU bump: 删后重加, 沉到末尾。
  cache.delete(key);
  cache.set(key, hit);
  return {
    kind: 'text',
    content: hit.content,
    relPath: hit.relPath,
    size: hit.size,
    mtimeMs: hit.mtimeMs,
    truncated: hit.truncated,
    resolvedPath: hit.resolvedPath,
  };
}

/** 写入 cache, 触发条数 / 字节上限 evict。 */
export function setCachedFileContent(
  workdir: string,
  data: {
    content: string;
    relPath: string;
    size: number;
    mtimeMs: number;
    truncated: boolean;
    resolvedPath?: string;
  },
): void {
  const key = makeKey(workdir, data.relPath);
  // 已存在: 先扣旧 byteSize 再覆写, 避免同 key 重复入队 + bytes 双计。
  const prev = cache.get(key);
  if (prev) {
    totalBytes -= prev.byteSize;
    cache.delete(key);
  }
  const byteSize = data.content.length * 2;
  const entry: CachedText = {
    kind: 'text',
    content: data.content,
    relPath: data.relPath,
    size: data.size,
    mtimeMs: data.mtimeMs,
    truncated: data.truncated,
    resolvedPath: data.resolvedPath,
    byteSize,
  };
  cache.set(key, entry);
  totalBytes += byteSize;
  evictIfNeeded();
}

/** chokidar 'change'/'unlink' 时主动 evict。Key 不存在则 no-op。 */
export function invalidateCachedFile(workdir: string, relPath: string): void {
  const key = makeKey(workdir, relPath);
  // Watch events do not distinguish directories. Evict descendants too, with
  // a path-separator boundary so "alias" cannot evict "alias-other".
  for (const [candidate, entry] of cache) {
    if (candidate === key || candidate.startsWith(`${key}/`)) {
      totalBytes -= entry.byteSize;
      cache.delete(candidate);
    }
  }
}

/** workdir 整体下线时 (用户切到别的 project) — 一次性清掉该 workdir 全部 entry。 */
export function invalidateWorkdirCache(workdir: string): void {
  const prefix = `${workdir}|`;
  for (const [key, entry] of cache) {
    if (key.startsWith(prefix)) {
      totalBytes -= entry.byteSize;
      cache.delete(key);
    }
  }
}

function evictIfNeeded(): void {
  // 先按条数砍 (从队首 = 最旧), 再按字节砍。两层独立, 任意一层超了都砍。
  while (cache.size > MAX_ITEMS) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    const entry = cache.get(oldestKey);
    if (entry) totalBytes -= entry.byteSize;
    cache.delete(oldestKey);
  }
  while (totalBytes > MAX_BYTES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    const entry = cache.get(oldestKey);
    if (!entry) break;
    totalBytes -= entry.byteSize;
    cache.delete(oldestKey);
  }
}
