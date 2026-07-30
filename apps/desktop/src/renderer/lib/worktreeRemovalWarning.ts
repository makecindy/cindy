/**
 * 删除/归档前的 worktree 脏状态预检(P1)。
 *
 * 本机会话直调 preload；device-link 远程会话把同名只读 IPC 隧道到被控端，
 * 由持有 worktree store 的设备返回真实状态。
 *
 * **三态,不是布尔**(greptile review):查询失败(老被控端 / IPC 异常 / 隧道断)
 * 必须与「确认干净」区分开。早期只有布尔,失败降级成 `false`,那时所有入口都一定
 * 会弹确认框,`false` 的后果只是文案里少一行警告;但归档改成「干净就免确认」之后,
 * 同一个 `false` 会变成**静默放行** —— 预检失败时归档会不打招呼地回收带未提交改动
 * 的 worktree(main 侧只会 auto-stash 兜底,用户拿不到告警和取消机会)。
 * 所以免确认的判据必须是「确认干净」,而不是「不是脏的」。
 */
export type WorktreeRemovalPreflight = 'clean' | 'dirty' | 'unknown';

async function queryWorktreeRemovalPreflight(
  sessionId: string,
  deviceLinkDeviceId?: string | null,
): Promise<WorktreeRemovalPreflight> {
  try {
    const preview = deviceLinkDeviceId
      ? await window.electronAPI.deviceLink.invoke(
          deviceLinkDeviceId,
          'worktree:removal-preview',
          [sessionId],
        ) as { hasWorktree: boolean; dirty: boolean }
      : await window.electronAPI.worktreeRemovalPreview(sessionId);
    return preview.hasWorktree && preview.dirty ? 'dirty' : 'clean';
  } catch {
    return 'unknown';
  }
}

/**
 * 布尔版:仅供**总是会弹确认框**的路径用(批量计数、doc 模式关闭标签页、删除),
 * 那里 `false` 只影响文案是否追加警告,不会变成静默放行。
 * 会跳过确认的路径必须用 `resolveWorktreeRemovalPreflight` 的三态。
 */
export async function fetchDirtyWorktreeForRemoval(
  sessionId: string,
  deviceLinkDeviceId?: string | null,
): Promise<boolean> {
  return (await queryWorktreeRemovalPreflight(sessionId, deviceLinkDeviceId)) === 'dirty';
}

/**
 * 预取窗口内的预检结果缓存 —— **只复用 'dirty',clean 与 unknown 一律重新查**。
 *
 * 每个归档入口在真正执行前都有一段人类操作空窗:列表行内是两步确认(点归档
 * 图标 → 点 Confirm 胶囊),菜单入口是先打开菜单再点条目。在那一刻 prefetch,
 * 可以把 main 侧那次 git status 挪出用户等待。
 *
 * 但复用**必须是非对称的**(greptile / codex 都按 P1 指出过):
 *   - cached 'dirty' → 安全。这个结论只会让确认弹窗多出现一次;就算 worktree
 *     期间被清干净了,用户看到警告仍可取消或继续,保护不会失效。
 *   - cached 'clean' → **不安全,不能复用**。归档会顺带回收 worktree,如果预取之后
 *     外部编辑器或收尾中的 agent 写脏了工作区,复用 clean 就会整个跳过 dirty 确认,
 *     用户拿不到承诺的「先提交或取消」机会(main 侧回收前会 auto-stash 兜住数据,
 *     所以不至于丢改动,但用户不会知道改动已被 stash 带走)。
 *   - cached 'unknown' → 不复用。它代表查询失败,重试一次可能就拿到真结论了,
 *     把失败缓存起来只会让保守分支多留 8 秒。
 *
 * 因此只有 'dirty' 被复用,连仍在飞的预取也不复用其非 dirty 结果。这几乎不损失
 * 收益:实测本仓 `git status --porcelain` 只要 20~40ms,加 IPC 往返远低于感知阈值;
 * 预取真正的价值变成「提前把 git 的索引/文件系统 cache 热起来 + dirty 会话零等待」。
 * TTL 8s 略长于行内 Confirm 胶囊 4s 自动撤回窗口,只对 'dirty' 生效。
 */
const DIRTY_PREFLIGHT_TTL_MS = 8_000;

interface PreflightEntry {
  at: number;
  promise: Promise<WorktreeRemovalPreflight>;
  /** promise 已 settle 时的结论；undefined = 仍在飞。只有 'dirty' 允许被复用。 */
  result?: WorktreeRemovalPreflight;
}

const preflightCache = new Map<string, PreflightEntry>();

/** 预热某个会话的 worktree 预检。 */
export function prefetchDirtyWorktreeForRemoval(
  sessionId: string,
  deviceLinkDeviceId?: string | null,
): void {
  void resolveWorktreeRemovalPreflight(sessionId, deviceLinkDeviceId);
}

/**
 * 取 worktree 预检三态：只有未过期且为 'dirty' 的预取结果会被复用，其余情况
 * (无缓存 / 已过期 / 'clean' / 'unknown' / 仍在飞)一律重新查询，理由见上方注释。
 *
 * **会跳过确认的路径必须用这个,并且只在结论为 'clean' 时才免确认** ——
 * `'unknown'` 要和 `'dirty'` 一样走确认框(见类型定义处的说明)。
 */
export function resolveWorktreeRemovalPreflight(
  sessionId: string,
  deviceLinkDeviceId?: string | null,
): Promise<WorktreeRemovalPreflight> {
  const now = Date.now();
  const cached = preflightCache.get(sessionId);
  if (cached && cached.result === 'dirty' && now - cached.at < DIRTY_PREFLIGHT_TTL_MS) {
    return cached.promise;
  }
  const promise = queryWorktreeRemovalPreflight(sessionId, deviceLinkDeviceId);
  const entry: PreflightEntry = { at: now, promise };
  preflightCache.set(sessionId, entry);
  // 回填结论:只有 'dirty' 会被后续 resolve 复用。用 entry 身份守卫,避免旧查询
  // 覆盖同一会话更新的那次(query 内部已 swallow 异常,不会 reject)。
  void promise.then((result) => {
    if (preflightCache.get(sessionId) === entry) entry.result = result;
  });
  // 过期条目没有别的清理时机(会话可能已经被归档/删除),顺手扫一遍,
  // 别让 Map 随会话数无限长大。
  for (const [id, item] of preflightCache) {
    if (now - item.at >= DIRTY_PREFLIGHT_TTL_MS) preflightCache.delete(id);
  }
  return promise;
}

/** 仅供测试：清掉预取缓存。 */
export function resetDirtyWorktreePreflightCache(): void {
  preflightCache.clear();
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
