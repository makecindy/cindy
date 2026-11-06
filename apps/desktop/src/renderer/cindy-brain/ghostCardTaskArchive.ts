/**
 * 插件卡片上的归档任务按钮(data-ghost-task-archive,见 ghostCardPrStatus)与任务页之间的约定。
 *
 * - 点按钮:卡片只发出「归档这个任务」的请求,由打开这个任务的任务页走与标题栏、侧边栏
 *   同一套归档流程(运行中、接管、绑定的定时任务、worktree 预检与确认)。插件拿不到这个能力。
 * - 合并后自动归档:普通任务页登记「这里离开时可以自动归档」;卡片上有宿主自己查到已合并、
 *   插件标了 -auto 的 PR 时,自动归档进入待生效,卡片上显示提示和「本次不归档」。
 *   - 卡片在用户眼前显示过就记下「看过」;用户离开这个任务时任务页取走它,条件都满足才归档。
 *   - 用户点了「本次不归档」,或待生效之后这个任务里出现了用户发的消息(本机、手机、IM 都算,
 *     自动化与插件代发的不算),本次就取消:提示消失,离开时不归档,手动的归档按钮照旧可用。
 *   状态只在内存里,重启或刷新后不保留:没有确定看过就不归档。
 */

type Listener = (sessionId: string) => void;

const archiveRequests = new Set<Listener>();
const changeListeners = new Set<Listener>();
/** 可以自动归档的任务页(按任务计数:同一任务可能有不止一个视图)。 */
const enabledViews = new Map<string, number>();
/** 待生效:值是进入待生效时最后一条用户消息的 clientId;undefined = 当时还不知道。 */
const armed = new Map<string, { baseline: string | null | undefined }>();
/** 任务里最后一条用户发的消息(由任务页在历史加载完成后报告)。 */
const lastUserMessage = new Map<string, string | null>();
const seen = new Set<string>();
const cancelled = new Set<string>();

function changed(sessionId: string): void {
  for (const listener of changeListeners) listener(sessionId);
}

/** 卡片上的归档按钮被点了:交给打开这个任务的任务页。 */
export function requestGhostCardTaskArchive(sessionId: string): void {
  for (const listener of archiveRequests) listener(sessionId);
}

export function onGhostCardTaskArchiveRequest(listener: Listener): () => void {
  archiveRequests.add(listener);
  return () => { archiveRequests.delete(listener); };
}

/** 自动归档的状态变了(登记、待生效、取消):卡片据此重画提示。 */
export function onGhostCardTaskAutoArchiveChange(listener: Listener): () => void {
  changeListeners.add(listener);
  return () => { changeListeners.delete(listener); };
}

/** 普通任务页登记:离开这里时可以自动归档。返回注销函数。 */
export function enableGhostCardTaskAutoArchive(sessionId: string): () => void {
  enabledViews.set(sessionId, (enabledViews.get(sessionId) ?? 0) + 1);
  changed(sessionId);
  return () => {
    const count = (enabledViews.get(sessionId) ?? 1) - 1;
    if (count > 0) enabledViews.set(sessionId, count);
    else enabledViews.delete(sessionId);
    changed(sessionId);
  };
}

/** 卡片上出现(或不再有)可自动归档的已合并 PR。 */
export function setGhostCardTaskAutoArchiveArmed(sessionId: string, on: boolean): void {
  if (on === armed.has(sessionId)) return;
  if (on) armed.set(sessionId, { baseline: lastUserMessage.get(sessionId) });
  else {
    armed.delete(sessionId);
    seen.delete(sessionId);
  }
  changed(sessionId);
}

/** 卡片上该不该显示「离开后自动归档」与「本次不归档」。 */
export function isGhostCardTaskAutoArchivePending(sessionId: string): boolean {
  return enabledViews.has(sessionId) && armed.has(sessionId) && !cancelled.has(sessionId);
}

/** 本次不自动归档(用户点了取消,或在任务里发了消息)。 */
export function cancelGhostCardTaskAutoArchive(sessionId: string): void {
  seen.delete(sessionId);
  if (cancelled.has(sessionId)) return;
  cancelled.add(sessionId);
  changed(sessionId);
}

/**
 * 任务页报告最后一条用户发的消息。待生效之后它变了就取消本次;待生效时还不知道的,以第一次
 * 报告为准。只在历史加载完成后报告,免得「还没读到」被当成「来了新消息」。
 */
export function noteGhostCardTaskUserMessage(sessionId: string, clientId: string | null): void {
  lastUserMessage.set(sessionId, clientId);
  const entry = armed.get(sessionId);
  if (!entry) return;
  if (entry.baseline === undefined) entry.baseline = clientId;
  else if (entry.baseline !== clientId) cancelGhostCardTaskAutoArchive(sessionId);
}

/** 待生效的卡片在用户眼前显示过。 */
export function markGhostCardTaskSeen(sessionId: string): void {
  if (isGhostCardTaskAutoArchivePending(sessionId)) seen.add(sessionId);
}

/** 离开任务时取走「看过」标记;只取一次,没有自动归档成就要等用户再看一次。 */
export function takeGhostCardTaskSeen(sessionId: string): boolean {
  return seen.delete(sessionId) && isGhostCardTaskAutoArchivePending(sessionId);
}
