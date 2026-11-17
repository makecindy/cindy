/**
 * 插件卡片上的归档任务按钮(data-ghost-task-archive)与任务页之间的约定,电脑端与手机端共用。
 * 每个客户端用 createGhostCardTaskAutoArchive() 建一份自己的状态(只在内存)。
 *
 * - 点按钮:卡片只发出「归档这个任务」的请求,由打开这个任务的任务页走与该端其它入口
 *   同一套归档流程(带确认)。插件拿不到这个能力。
 * - 合并后自动归档:普通任务页登记「这里离开时可以自动归档」;任务里有卡片(可以不止一张)
 *   上有插件标了 -auto 的 PR，且宿主确认任务全部关联 PR 已合并时，自动归档进入待生效，卡片上显示提示和
 *   「取消」。
 *   - 待生效的卡片在用户眼前显示过就记下「看过」;用户离开这个任务时任务页取走它,条件都满足
 *     才归档。
 *   - 用户点了「取消」,或待生效之后这个任务里出现了用户发的消息(电脑、手机、IM 都算,
 *     自动化与插件代发的不算),本次就取消:提示改为「本次不会自动归档」,离开时不归档,手动的归档按钮照旧可用。
 *     取消一直保留到任务里不再有符合条件的卡片(PR 重新打开、关了开关),之后重新开始。
 *   状态只在内存里,重启或刷新后不保留:没有确定看过就不归档。
 */

type Listener = (sessionId: string) => void;

export type GhostCardTaskAutoArchiveState = 'inactive' | 'pending' | 'cancelled';

export interface GhostCardTaskAutoArchive {
  /** 卡片上的归档按钮被点了:交给打开这个任务的任务页。 */
  requestArchive(sessionId: string): void;
  onArchiveRequest(listener: Listener): () => void;
  /** 自动归档的状态变了(登记、待生效、取消):卡片据此重画提示。 */
  onChange(listener: Listener): () => void;
  /** 普通任务页登记:离开这里时可以自动归档。返回注销函数。 */
  enable(sessionId: string): () => void;
  /** 一张卡片是否(不再)符合自动归档:宿主查到已合并、插件标了 -auto。 */
  setArmed(sessionId: string, cardId: string, on: boolean): void;
  /** 当前符合条件的卡片(手机离开时据此重新核对宿主的最新判断)。 */
  armedCards(sessionId: string): string[];
  /** 展示沿用现有取消记录；不新增持久状态，也不改变离开任务时的归档判据。 */
  getState(sessionId: string): GhostCardTaskAutoArchiveState;
  /** 当前是否等待离开后自动归档。 */
  isPending(sessionId: string): boolean;
  /** 本次不自动归档(用户点了取消,或在任务里发了消息)。 */
  cancel(sessionId: string): void;
  /** 用户在这个任务里发了消息:只取消已经待生效的自动归档;还没待生效的不受影响。 */
  cancelPending(sessionId: string): void;
  /**
   * 任务页报告最后一条用户发的消息。待生效之后它变了就取消本次;待生效时还不知道的,以第一次
   * 报告为准。只在历史加载完成后报告,免得「还没读到」被当成「来了新消息」。
   */
  noteUserMessage(sessionId: string, clientId: string | null): void;
  /** 待生效的卡片在用户眼前显示过。 */
  markSeen(sessionId: string): void;
  /** 离开任务时取走「看过」标记;只取一次,没有自动归档成就要等用户再看一次。 */
  takeSeen(sessionId: string): boolean;
}

export function createGhostCardTaskAutoArchive(): GhostCardTaskAutoArchive {
  const archiveRequests = new Set<Listener>();
  const changeListeners = new Set<Listener>();
  /** 可以自动归档的任务页(按任务计数:同一任务可能有不止一个视图)。 */
  const enabledViews = new Map<string, number>();
  /**
   * 待生效:按任务记着哪些卡片符合条件(任一张符合就待生效,一张退出不影响其它张),以及进入
   * 待生效时最后一条用户消息的 clientId(undefined = 当时还不知道)。
   */
  const armed = new Map<string, { cards: Set<string>; baseline: string | null | undefined }>();
  /** 任务里最后一条用户发的消息(由任务页在历史加载完成后报告)。 */
  const lastUserMessage = new Map<string, string | null>();
  const seen = new Set<string>();
  const cancelled = new Set<string>();

  const changed = (sessionId: string): void => {
    for (const listener of changeListeners) listener(sessionId);
  };
  const getState = (sessionId: string): GhostCardTaskAutoArchiveState => {
    if (!enabledViews.has(sessionId) || !armed.has(sessionId)) return 'inactive';
    return cancelled.has(sessionId) ? 'cancelled' : 'pending';
  };
  const isPending = (sessionId: string) => getState(sessionId) === 'pending';
  const cancel = (sessionId: string): void => {
    seen.delete(sessionId);
    if (cancelled.has(sessionId)) return;
    cancelled.add(sessionId);
    changed(sessionId);
  };

  return {
    requestArchive(sessionId) {
      for (const listener of archiveRequests) listener(sessionId);
    },
    onArchiveRequest(listener) {
      archiveRequests.add(listener);
      return () => { archiveRequests.delete(listener); };
    },
    onChange(listener) {
      changeListeners.add(listener);
      return () => { changeListeners.delete(listener); };
    },
    enable(sessionId) {
      enabledViews.set(sessionId, (enabledViews.get(sessionId) ?? 0) + 1);
      changed(sessionId);
      return () => {
        const count = (enabledViews.get(sessionId) ?? 1) - 1;
        if (count > 0) enabledViews.set(sessionId, count);
        else enabledViews.delete(sessionId);
        changed(sessionId);
      };
    },
    setArmed(sessionId, cardId, on) {
      const entry = armed.get(sessionId);
      if (on) {
        if (!entry) {
          armed.set(sessionId, { cards: new Set([cardId]), baseline: lastUserMessage.get(sessionId) });
          changed(sessionId);
        } else entry.cards.add(cardId);
        return;
      }
      if (!entry?.cards.delete(cardId) || entry.cards.size > 0) return;
      // 任务里最后一张符合条件的卡片也退出了:忘掉看过和取消,下次重新开始。
      armed.delete(sessionId);
      seen.delete(sessionId);
      cancelled.delete(sessionId);
      changed(sessionId);
    },
    armedCards(sessionId) {
      return [...(armed.get(sessionId)?.cards ?? [])];
    },
    getState,
    isPending,
    cancel,
    cancelPending(sessionId) {
      if (isPending(sessionId)) cancel(sessionId);
    },
    noteUserMessage(sessionId, clientId) {
      lastUserMessage.set(sessionId, clientId);
      const entry = armed.get(sessionId);
      if (!entry) return;
      if (entry.baseline === undefined) entry.baseline = clientId;
      else if (entry.baseline !== clientId) cancel(sessionId);
    },
    markSeen(sessionId) {
      if (isPending(sessionId)) seen.add(sessionId);
    },
    takeSeen(sessionId) {
      return seen.delete(sessionId) && isPending(sessionId);
    },
  };
}
