/**
 * useProjectFileList — 拉一次项目级所有文件名扁平列表,内存缓存,供 fuzzy filter 用。
 *
 * 走 main 进程 `maker:file-browser:list-all`(ripgrep `--files` honor .gitignore)。
 * 缓存策略:
 *  - **惰性拉取**:`options.enabled=false`(筛选框为空)时不发 IPC —— 索引只服务
 *    文件名筛选,用户没在筛选时拉全量清单纯属浪费。2026-07 实测:切会话即拉的
 *    旧行为一天打满 30000-cap 扫描 68 次,大 workdir 场景是会话切换卡顿的主要
 *    renderer 侧成本。enabled 翻 true(用户输入首字符)才启动首次拉取,
 *    FilterResultList 的 isLoading 占位天然承接这段等待。
 *  - 模块级 Map<workdir, Snapshot> singleton —— 跨 component 实例共享(同 workdir
 *    不同 file-browser tab 共享一份索引,省一次 rg 子进程开销)。
 *  - 30 秒内同 workdir 直接命中缓存,不重发 IPC;打满 cap 的截断快照放宽到
 *    5 分钟 —— 重扫也不会更完整,却是最贵的一种扫描。
 *  - hook 暴露 `refresh()`,文件树点刷新按钮时调用 → 强制失效;正在筛选才立即
 *    重拉,否则留给下次 enabled 时自然拉新。
 *
 * 性能:大型 monorepo 实测 rg --files < 500ms / 数万文件,前端只持有路径字符串
 * 数组,5w 路径 × ~80 bytes ≈ 4MB,可接受。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { createLogger } from '@/lib/logger';
import { fileBrowserApiFor } from '@/lib/fileBrowserTransport';

const log = createLogger('useProjectFileList');

/** 缓存有效期 ms。超过就重新拉 —— 配合文件树点刷新可以手动 invalidate。 */
const CACHE_TTL_MS = 30_000;

/**
 * 打满 cap 的截断快照的缓存有效期。截断意味着 rg 扫到上限被 kill,重扫一遍
 * 结果同样不完整,但扫描本身却是最贵的(30000 条收集 + IPC + 前端建索引)。
 * 手动 refresh() 不受此 TTL 影响,仍然立即失效。
 */
const TRUNCATED_CACHE_TTL_MS = 5 * 60_000;

export interface ProjectFileListState {
  files: readonly string[];
  /** ripgrep 命中上限被截断(默认 30000 文件)。 */
  truncated: boolean;
  /** 加载中状态:首次访问 / refresh 触发时为 true。 */
  isLoading: boolean;
  /** 拉取出错时的 error message;非空意味着 files 是上次 cache 或 []。 */
  error: string | null;
}

interface Snapshot {
  files: readonly string[];
  truncated: boolean;
  fetchedAt: number;
  /**
   * 上次拉取的 error token(如 'RG_UNAVAILABLE':远端无 rg,files 为空但拉取
   * "成功")。必须随快照缓存并在命中时还原 —— 否则空 files + null error 会让
   * FilterResultList 的"未索引/失败"占位退化成误导性的"无匹配"。
   */
  error: string | null;
}

// Module-level singleton cache —— 同 workdir 跨 component 实例 / 跨 RSB tab 共享。
const cache = new Map<string, Snapshot>();
// inflight 携带结果本身:piggyback 方直接消费 promise 的解析值,不从 cache 回读
// —— fetch 失败(catch 分支)或被 refresh 失效(gen 不匹配)时都不写 cache,回读
// 会拿到空快照,把搭车方的 UI 置空、丢掉 error。
const inflight = new Map<string, Promise<{ snap: Snapshot; error: string | null }>>();
// 失效代数:refresh 失效缓存时递增。fetchOnce 只在"启动以来没有新的失效"时才
// 把结果写回缓存 —— 防止 refresh 删掉缓存后,在途请求完成又把旧快照写回,
// 让下次筛选把刷新前的数据当成新鲜缓存。
const invalidationGen = new Map<string, number>();

function bumpInvalidation(cacheKey: string): void {
  invalidationGen.set(cacheKey, (invalidationGen.get(cacheKey) ?? 0) + 1);
}

function isStale(snap: Snapshot, now: number): boolean {
  const ttl = snap.truncated ? TRUNCATED_CACHE_TTL_MS : CACHE_TTL_MS;
  return now - snap.fetchedAt > ttl;
}

async function fetchOnce(
  workdir: string,
  remoteHostId: string | null,
  deviceId: string | null,
  cacheKey: string,
): Promise<{ snap: Snapshot; error: string | null }> {
  const ipc = window.electronAPI?.fileBrowser?.listAllFiles;
  if (!ipc) {
    // 未挂 preload / SSR — 直接给空数组兜底。
    return {
      snap: { files: [], truncated: false, fetchedAt: Date.now(), error: 'fileBrowser IPC not available' },
      error: 'fileBrowser IPC not available',
    };
  }
  const genAtStart = invalidationGen.get(cacheKey) ?? 0;
  try {
    const res = await fileBrowserApiFor(deviceId).listAllFiles({ workdir, remoteHostId });
    const snap: Snapshot = {
      files: res.files,
      truncated: res.truncated,
      fetchedAt: Date.now(),
      error: res.error ?? null,
    };
    // 启动以来发生过 refresh 失效 → 这份结果已过期,只用于本次展示,不进缓存。
    if ((invalidationGen.get(cacheKey) ?? 0) === genAtStart) {
      cache.set(cacheKey, snap);
    }
    return { snap, error: res.error ?? null };
  } catch (err) {
    log.error('listAllFiles failed', { workdir, err });
    // 回退复用缓存时 truncated 一并保留:截断快照拉取失败后丢标志会让
    // "结果过多"提示静默消失,列表却仍是截断的。
    const cached = cache.get(cacheKey);
    const snap: Snapshot = {
      files: cached?.files ?? [],
      truncated: cached?.truncated ?? false,
      fetchedAt: Date.now(),
      error: String(err),
    };
    return { snap, error: String(err) };
  }
}

export interface UseProjectFileListOptions {
  /**
   * false = 用户当前没在筛选(筛选框为空),不发 IPC、不跑 rg;有缓存(含过期)
   * 就静态展示,没有就空数组。翻回 true(输入首字符)时按缓存新鲜度决定是否
   * 拉取。默认 true 保持旧语义。
   */
  enabled?: boolean;
}

/**
 * @param remoteHostId 非空 = SSH remote 会话:索引在远端 daemon 内跑远端 rg;
 *   远端无 rg 时返回空 + error(筛选面板显示"未索引"占位)。cache key 对远程
 *   会话编入传输端点(dev:/ssh: 前缀)——不同端点可能暴露相同绝对路径
 *   workdir,裸 workdir 键会让 A 机的文件清单被 B 机复用(与 fileContentCache
 *   同一教训)。
 */
export function useProjectFileList(
  workdir: string,
  remoteHostId: string | null = null,
  deviceId: string | null = null,
  options?: UseProjectFileListOptions,
): ProjectFileListState & {
  refresh: () => void;
} {
  const enabled = options?.enabled ?? true;
  const cacheKey = deviceId
    ? `dev:${deviceId}|${workdir}`
    : remoteHostId
      ? `ssh:${remoteHostId}|${workdir}`
      : workdir;
  const initial = cache.get(cacheKey);
  const [state, setState] = useState<ProjectFileListState>(() => ({
    files: initial?.files ?? [],
    truncated: initial?.truncated ?? false,
    isLoading: enabled && !initial,
    error: initial?.error ?? null,
  }));
  // 用 ref 防止 useEffect deps 漂移导致重复 fetch(workdir 不变情况下)。
  const lastFetchedWorkdirRef = useRef<string | null>(null);
  // in-flight 完成体的端点保鲜:切端点后旧 fetch 的 setState 必须丢弃,
  // 否则 A 机的文件清单会短暂顶进 B 机会话的筛选面板。
  const cacheKeyRef = useRef(cacheKey);
  useEffect(() => {
    cacheKeyRef.current = cacheKey;
  }, [cacheKey]);
  // 异步回调里读最新 enabled:失效后的"追新"只在用户仍在筛选时进行,
  // 否则会在 enabled=false 时发起违背惰性原则的扫描。
  const enabledRef = useRef(enabled);
  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  const doFetch = useCallback((wd: string, key: string) => {
    setState((prev) => ({ ...prev, isLoading: true }));
    // 捕获发起时的失效代数:期间发生 refresh 时丢弃本回调的 setState —— 刷新后
    // 的新请求会带最新数据,旧数据闪现一帧再被覆盖是可感知的视觉抖动。
    const genAtStart = invalidationGen.get(key) ?? 0;
    // dedupe 并发 fetch:同 (端点, workdir) 在 inflight 中就 piggyback。发起方与
    // 搭车方消费同一个解析值(fetchOnce 内部全兜底,永不 reject),不从 cache
    // 回读 —— fetch 失败或被 refresh 失效时结果不进 cache,回读会拿到空快照。
    let p = inflight.get(key);
    if (!p) {
      const started = fetchOnce(wd, remoteHostId, deviceId, key);
      p = started;
      inflight.set(key, started);
      // 只清理自己:refresh 可能已把 inflight 换成了新请求,无条件 delete 会把
      // 新请求的 entry 误删,让后续并发 doFetch 重复 spawn rg。
      void started.finally(() => {
        if (inflight.get(key) === started) inflight.delete(key);
      });
    }
    void p.then(({ snap, error }) => {
      if (cacheKeyRef.current !== key) return; // 端点/目录已切换:丢弃过期结果
      if ((invalidationGen.get(key) ?? 0) !== genAtStart) {
        // 期间被 refresh 失效。不能只丢弃:refresh 可能来自共享同一份缓存的
        // 另一个实例(doc sidebar / RSB 同 workdir),本实例已置 isLoading 且
        // 没有别的回调会再喂它 —— 直接 return 会永久卡在加载态。
        if (enabledRef.current) {
          // 仍在筛选:重新走 doFetch 追上刷新后的新请求(有 inflight 就
          // piggyback,已完成则命中新缓存路径重新捕获代数)。
          doFetch(wd, key);
        } else {
          // 已退出筛选:追新会发起违背惰性原则的扫描,只防御性退出 loading
          // (disabled effect 通常已把 state 置为缓存/空)。
          setState((prev) => (prev.isLoading ? { ...prev, isLoading: false } : prev));
        }
        return;
      }
      setState({
        files: snap.files,
        truncated: snap.truncated,
        isLoading: false,
        error,
      });
    });
  }, [remoteHostId, deviceId]);

  useEffect(() => {
    if (!workdir) {
      setState({ files: [], truncated: false, isLoading: false, error: null });
      return;
    }
    if (!enabled) {
      // 惰性模式:不发 IPC。有缓存(哪怕 stale)静态展示,没有就空。
      const snap = cache.get(cacheKey);
      setState({
        files: snap?.files ?? [],
        truncated: snap?.truncated ?? false,
        isLoading: false,
        error: snap?.error ?? null,
      });
      // 清防重 ref:翻回 enabled 后 stale 缓存才能触发重拉。
      if (lastFetchedWorkdirRef.current === cacheKey) lastFetchedWorkdirRef.current = null;
      return;
    }
    const snap = cache.get(cacheKey);
    const now = Date.now();
    if (snap && !isStale(snap, now)) {
      // cache hit & fresh:同步上 snapshot(含上次的 error token —— 空 files +
      // 丢失 error 会把"未索引"占位误显示成"无匹配"),跳过 IPC。
      setState({
        files: snap.files,
        truncated: snap.truncated,
        isLoading: false,
        error: snap.error,
      });
      lastFetchedWorkdirRef.current = cacheKey;
      return;
    }
    if (lastFetchedWorkdirRef.current === cacheKey) return;
    lastFetchedWorkdirRef.current = cacheKey;
    doFetch(workdir, cacheKey);
  }, [workdir, cacheKey, doFetch, enabled]);

  const refresh = useCallback(() => {
    if (!workdir) return;
    cache.delete(cacheKey);
    // 同时递增失效代数:refresh 时可能仍有在途请求,不 bump 的话它完成后会把
    // 刷新前的旧快照写回缓存,下次筛选被当成新鲜数据。
    bumpInvalidation(cacheKey);
    // 在途请求也一并作废:留在 inflight 里会被紧随的 doFetch piggyback,用户
    // 看到旧数据闪现后变空,且永远拿不到刷新后的新快照。
    inflight.delete(cacheKey);
    if (!enabled) {
      // 树刷新时用户并没在筛选:只失效缓存,不触发扫描 —— 下次 enabled 自然拉新。
      // state 一并清空:留着旧 files 会让下次 doFetch 的 isLoading 期间闪 stale
      // 结果(FilterResultList 只在 files 为空时才显示"正在索引"占位)。
      setState({ files: [], truncated: false, isLoading: false, error: null });
      lastFetchedWorkdirRef.current = null;
      return;
    }
    lastFetchedWorkdirRef.current = cacheKey;
    doFetch(workdir, cacheKey);
  }, [workdir, cacheKey, doFetch, enabled]);

  return { ...state, refresh };
}

/** 测试 / 登出清理用,生产不应调用。 */
export function _resetProjectFileListCache(): void {
  cache.clear();
  inflight.clear();
  invalidationGen.clear();
}
