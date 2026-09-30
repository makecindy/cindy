/**
 * useSkillFolderHash.ts — 调 IPC 算 folderHash + 30s 缓存 (R2)
 *
 * - module-level Map<absolutePath, { hash: string; at: number }>，TTL 30s
 * - publish 成功后 invalidateHash(absolutePath) 清掉本 path 缓存
 *   并通过订阅机制通知所有挂载的 hook 实例 re-fetch
 *   (否则发布完 hook 的 useEffect 不会重跑,localHash 维持旧值)
 */

import { useEffect, useState } from 'react';
import { invalidatePublishComparison } from './useSkillPublishComparison';

const HASH_TTL_MS = 30_000;

interface FolderManifestEntry {
  path: string;
  sha256: string;
}

interface HashCacheEntry {
  hash: string;
  manifest: FolderManifestEntry[] | null;
  at: number;
}

const hashCache = new Map<string, HashCacheEntry>();

// 订阅机制:invalidateHash 时通知所有 hook 实例重新算
const invalidationListeners = new Map<string, Set<() => void>>();

function notifyInvalidation(absolutePath: string): void {
  invalidationListeners.get(absolutePath)?.forEach((cb) => cb());
}

export function invalidateHash(absolutePath: string): void {
  invalidatePublishComparison(absolutePath);
  hashCache.delete(absolutePath);
  notifyInvalidation(absolutePath);
}

/**
 * 预拉 folderHash 写入缓存。供 sidebar 点击 cell 时在 navigate 之前调用,
 * 让 detail view 第一帧就能从 hashCache 同步拿到值,避免「click → 闪一帧 →
 * 数据到 → 重渲染」的视觉抖动。30s TTL 内已有缓存就 no-op,不重拉。
 * 失败静默(只是预热,失败由真正进 detail 的 useEffect 报错)。
 */
export async function prefetchFolderHash(absolutePath: string): Promise<void> {
  if (!absolutePath) return;
  const cached = hashCache.get(absolutePath);
  if (cached && Date.now() - cached.at < HASH_TTL_MS) return;
  try {
    const res = await window.electronAPI.skillhub.getFolderHash(absolutePath);
    if (res.success && res.folderHash) {
      hashCache.set(absolutePath, {
        hash: res.folderHash,
        manifest: res.manifest ?? null,
        at: Date.now(),
      });
    }
  } catch {
    /* swallow — 真正进 detail 时 useEffect 还会再试一次 */
  }
}

interface UseSkillFolderHashResult {
  folderHash: string | null;
  /** 参与 hash 的文件清单(含每个文件 sha256) — 排查 dirty 用 */
  manifest: FolderManifestEntry[] | null;
  loading: boolean;
  error: string | null;
}

export function useSkillFolderHash(
  absolutePath: string | null | undefined,
  options?: { force?: boolean },
): UseSkillFolderHashResult {
  const [folderHash, setFolderHash] = useState<string | null>(null);
  const [manifest, setManifest] = useState<FolderManifestEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // bump 用来强制 useEffect 重跑 (invalidateHash 时通过订阅触发)
  const [invalidationBump, setInvalidationBump] = useState(0);
  // force=true 时绕过 30s cache,每次 path 变都重 fetch (detail view 用)
  const force = options?.force ?? false;

  // 同步重置:absolutePath 变化时立刻把 hash/manifest 切到新 path 的缓存值,
  // 让 detail view 切 skill 时 header 不再闪。SWR 模式:
  //   - 30s 内访问过 → 用缓存值同步渲染,后台 useEffect 决定要不要重拉
  //   - miss(首访 / 过期 / invalidate 后) → 退回到 null + loading=true
  // 否则同 feature 内切 skill 第一帧会拿"新 path + 旧 hash"算出错误状态。
  const [trackedPath, setTrackedPath] = useState(absolutePath ?? null);
  if ((absolutePath ?? null) !== trackedPath) {
    setTrackedPath(absolutePath ?? null);
    const cached = absolutePath ? hashCache.get(absolutePath) : null;
    const fresh = cached && Date.now() - cached.at < HASH_TTL_MS ? cached : null;
    setFolderHash(fresh?.hash ?? null);
    setManifest(fresh?.manifest ?? null);
    setError(null);
    // 命中缓存就不进 loading;miss 时如果 absolutePath 存在就 loading
    setLoading(absolutePath != null && fresh === null);
  }

  // 注册 invalidation 订阅:有人调 invalidateHash(absolutePath) 时,
  // 触发本 hook 的 useEffect 重新读 cache / 重新算 hash
  useEffect(() => {
    if (!absolutePath) return;
    const listener = () => setInvalidationBump((n) => n + 1);
    let set = invalidationListeners.get(absolutePath);
    if (!set) {
      set = new Set();
      invalidationListeners.set(absolutePath, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
      if (set && set.size === 0) invalidationListeners.delete(absolutePath);
    };
  }, [absolutePath]);

  useEffect(() => {
    if (!absolutePath) {
      setFolderHash(null);
      setManifest(null);
      setLoading(false);
      setError(null);
      return;
    }

    // force=true 时跳过 cache,直接 IPC fetch
    if (!force) {
      const cached = hashCache.get(absolutePath);
      if (cached && Date.now() - cached.at < HASH_TTL_MS) {
        setFolderHash(cached.hash);
        setManifest(cached.manifest);
        setLoading(false);
        setError(null);
        return;
      }
    }

    let cancelled = false;
    // SWR:有缓存(render 阶段已 seed)就不显示 loading,后台静默刷;
    // 没缓存才进 loading 态。否则会盖掉同步 seed 的 loading=false → 闪一下。
    const seeded = hashCache.get(absolutePath);
    const seededFresh = seeded && Date.now() - seeded.at < HASH_TTL_MS ? seeded : null;
    if (seededFresh === null) setLoading(true);
    setError(null);

    window.electronAPI.skillhub
      .getFolderHash(absolutePath)
      .then((res) => {
        if (cancelled) return;
        if (res.success && res.folderHash) {
          const m = res.manifest ?? null;
          hashCache.set(absolutePath, { hash: res.folderHash, manifest: m, at: Date.now() });
          setFolderHash(res.folderHash);
          setManifest(m);
        } else {
          setError(res.error ?? 'hash computation failed');
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // 依赖加 invalidationBump:invalidateHash 触发后 effect 重跑,fetch 新 hash
    // force 也在 deps 里防止外部切换 force 行为时不更新
  }, [absolutePath, invalidationBump, force]);

  return { folderHash, manifest, loading, error };
}
