/**
 * 插件卡片上的归档任务按钮(data-ghost-task-archive,见 ghostCardPrStatus)与任务页之间的约定。
 *
 * - 点按钮:卡片只发出「归档这个任务」的请求,由打开这个任务的任务页走与标题栏、侧边栏
 *   同一套归档流程(运行中、接管、绑定的定时任务、worktree 预检与确认)。插件拿不到这个能力。
 * - 合并后自动归档:卡片在用户眼前显示过已合并状态(宿主自己查到的,且插件标了 -auto),
 *   就记下「看过」;用户离开这个任务时任务页取走这个标记,条件都满足才归档。
 *   标记只在内存里,重启或刷新后不保留:没有确定看过就不归档。
 */

type Listener = (sessionId: string) => void;

const archiveRequests = new Set<Listener>();
const seen = new Set<string>();

/** 卡片上的归档按钮被点了:交给打开这个任务的任务页。 */
export function requestGhostCardTaskArchive(sessionId: string): void {
  for (const listener of archiveRequests) listener(sessionId);
}

export function onGhostCardTaskArchiveRequest(listener: Listener): () => void {
  archiveRequests.add(listener);
  return () => { archiveRequests.delete(listener); };
}

/** 已合并、可自动归档的卡片在用户眼前显示过。 */
export function markGhostCardTaskSeen(sessionId: string): void {
  seen.add(sessionId);
}

/** 卡片不再满足自动归档(PR 重新打开、用户关了开关):忘掉之前的「看过」。 */
export function forgetGhostCardTaskSeen(sessionId: string): void {
  seen.delete(sessionId);
}

/** 离开任务时取走「看过」标记;只取一次,没有自动归档成就要等用户再看一次。 */
export function takeGhostCardTaskSeen(sessionId: string): boolean {
  return seen.delete(sessionId);
}
