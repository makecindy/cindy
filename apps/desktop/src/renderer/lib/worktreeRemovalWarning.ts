/**
 * 删除/归档确认框的 worktree 脏状态预检(P1)。
 *
 * 本机会话直调 preload；device-link 远程会话把同名只读 IPC 隧道到被控端，
 * 由持有 worktree store 的设备返回真实状态。查询失败(老被控端 / IPC 异常)
 * 一律降级为"无警告",不阻塞确认流程。
 */
export async function fetchDirtyWorktreeForRemoval(
  sessionId: string,
  deviceLinkDeviceId?: string | null,
): Promise<boolean> {
  try {
    const preview = deviceLinkDeviceId
      ? await window.electronAPI.deviceLink.invoke(
          deviceLinkDeviceId,
          'worktree:removal-preview',
          [sessionId],
        ) as { hasWorktree: boolean; dirty: boolean }
      : await window.electronAPI.worktreeRemovalPreview(sessionId);
    return preview.hasWorktree && preview.dirty;
  } catch {
    return false;
  }
}

/**
 * 预取窗口内的预检结果缓存。
 *
 * 这次查询是「点了归档、行还没消失」里剩下的最大一块等待:有 worktree 的会话
 * 要在 main 侧跑一次 git status。但每个归档入口在真正执行前都有一段人类操作
 * 空窗 —— 列表行内是两步确认(点归档图标 → 点 Confirm 胶囊),菜单入口是先
 * 打开菜单再点条目 —— 空窗至少一次反应时间(数百毫秒),足够预检跑完。于是在
 * 进入空窗时就 prefetch,真正执行时 resolve 命中缓存,await 只花一个 microtask。
 *
 * TTL 取 8s:略长于行内 Confirm 胶囊 4s 自动撤回的窗口,又短到不会把「用户刚
 * 提交/stash 完改动」的旧结论留太久。这个结论只决定确认文案里是否追加一行未
 * 提交改动警告,过期读到旧值的代价很低。
 */
const DIRTY_PREFLIGHT_TTL_MS = 8_000;

const dirtyPreflightCache = new Map<string, { at: number; promise: Promise<boolean> }>();

/** 预热某个会话的 dirty 预检；重复调用在 TTL 内只发一次查询。 */
export function prefetchDirtyWorktreeForRemoval(
  sessionId: string,
  deviceLinkDeviceId?: string | null,
): void {
  void resolveDirtyWorktreeForRemoval(sessionId, deviceLinkDeviceId);
}

/**
 * 取 dirty 预检结论：命中未过期的预取则直接复用，否则即时查询。
 * 归档/删除的执行路径都应该走这个而不是 fetch，才能吃到预取的收益。
 */
export function resolveDirtyWorktreeForRemoval(
  sessionId: string,
  deviceLinkDeviceId?: string | null,
): Promise<boolean> {
  const now = Date.now();
  const cached = dirtyPreflightCache.get(sessionId);
  if (cached && now - cached.at < DIRTY_PREFLIGHT_TTL_MS) return cached.promise;
  const promise = fetchDirtyWorktreeForRemoval(sessionId, deviceLinkDeviceId);
  dirtyPreflightCache.set(sessionId, { at: now, promise });
  // 过期条目没有别的清理时机(会话可能已经被归档/删除),顺手扫一遍,
  // 别让 Map 随会话数无限长大。
  for (const [id, entry] of dirtyPreflightCache) {
    if (now - entry.at >= DIRTY_PREFLIGHT_TTL_MS) dirtyPreflightCache.delete(id);
  }
  return promise;
}

/** 仅供测试：清掉预取缓存。 */
export function resetDirtyWorktreePreflightCache(): void {
  dirtyPreflightCache.clear();
}

export interface WorktreeRemovalTarget {
  id: string;
  deviceLinkDeviceId?: string | null;
}

/** 批量删除/归档确认共用的 dirty worktree 计数，保持本机与远程路由口径一致。 */
export async function countDirtyWorktreesForRemoval(
  targets: readonly WorktreeRemovalTarget[],
): Promise<number> {
  const flags = await Promise.all(
    targets.map((target) =>
      fetchDirtyWorktreeForRemoval(target.id, target.deviceLinkDeviceId),
    ),
  );
  return flags.filter(Boolean).length;
}
