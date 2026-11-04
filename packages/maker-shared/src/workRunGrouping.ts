import { HISTORY_GAP_SPLIT_MS } from "./historyGap.js";

/** Platform projections own item shapes, card visibility, timestamps and stable keys. */
export interface WorkRunGroupingAdapter<TItem, TChild extends TItem> {
  isUserBoundary(item: TItem): boolean;
  /** A recovery closes the interrupted attempt without requiring a final answer. */
  isContinuationBoundary?(item: TItem): boolean;
  isAnswer(item: TItem): boolean;
  /** Explicit progress cannot be prepended to an adjacent final answer run. */
  canPrependToAnswer?(item: TItem): boolean;
  isSealedAnswer(item: TItem): boolean;
  isCompactBoundary(item: TItem): boolean;
  isActivity(item: TItem): item is TChild;
  /** Excludes running tasks, delivery prose and platform-specific persistent cards. */
  isArchivable(item: TItem): item is TChild;
  startTimestamp(item: TItem): number | null;
  endTimestamp(item: TItem): number | null;
  boundaryTimestamp(item: TItem | undefined): number | null;
  /** Preserve each projection's treatment of reordered user rows. */
  userBoundaryEnd(item: TItem, previousEnd: number | null): number | null;
  createGroup(
    run: TChild[],
    next: TItem | undefined,
    streaming: boolean,
    boundary: number | null,
  ): TItem;
  createCompletedGroup(
    run: TChild[],
    next: TItem | undefined,
    boundary: number | null,
  ): TItem;
  /** Only the mobile plan projection currently needs a streaming flag on standalone cards. */
  activeStandalone?(item: TItem, afterCompletedBoundary: boolean): TItem;
  /**
   * Folding an activity that started before the answer into the run above it can leave that
   * run's row range ending after the answer row. Renderers regroup rows they already hold,
   * but a pager that cuts by message id must keep ranges monotonic: set false there.
   */
  foldAnswerTail?: boolean;
}

/**
 * Shared turn/answer grouping, independent of React, transport and source message shapes.
 * User rows and unloaded history gaps split turns; only the active tail stays streaming.
 * Input items retain their identity unless the platform decorates a standalone card.
 */
export function groupWorkRuns<TItem, TChild extends TItem>(
  items: readonly TItem[],
  isSessionStreaming: boolean,
  adapter: WorkRunGroupingAdapter<TItem, TChild>,
): TItem[] {
  const out: TItem[] = [];
  let turn: TItem[] = [];
  let turnStart: number | null = null;
  let previousEnd: number | null = null;
  const flushTurn = (activeTail: boolean, resumed = false) => {
    if (turn.length === 0) return;
    if (activeTail && isSessionStreaming) {
      // A new run's status can arrive before its user row. A durable done seal still
      // closes the loaded work before it; only subsequent content may stay active.
      let completedIndex = -1;
      for (let index = turn.length - 1; index >= 0; index--) {
        if (adapter.isAnswer(turn[index]) && adapter.isSealedAnswer(turn[index])) {
          completedIndex = index;
          break;
        }
      }
      const activeStart =
        completedIndex >= 0
          ? adapter.boundaryTimestamp(turn[completedIndex])
          : turnStart;
      if (completedIndex >= 0) {
        const completed = turn.slice(0, completedIndex + 1);
        out.push(
          ...(groupAnsweredTurn(completed, turnStart, adapter) ?? completed),
        );
      }
      out.push(
        ...groupActivityRuns(
          turn.slice(completedIndex + 1),
          activeStart,
          true,
          adapter,
        ),
      );
      turn = [];
      return;
    }
    out.push(
      ...(groupAnsweredTurn(turn, turnStart, adapter, resumed) ??
        groupActivityRuns(turn, turnStart, false, adapter)),
    );
    turn = [];
  };
  for (const item of items) {
    const start = adapter.startTimestamp(item);
    if (
      previousEnd !== null &&
      start !== null &&
      start - previousEnd > HISTORY_GAP_SPLIT_MS
    ) {
      flushTurn(false);
      // The user boundary on the far side of a gap cannot contribute to this duration.
      turnStart = null;
    }
    // A recovery closes only the contiguous loaded turn, never work across a gap.
    if (adapter.isUserBoundary(item)) {
      flushTurn(false, adapter.isContinuationBoundary?.(item) === true);
      out.push(item);
      previousEnd = adapter.userBoundaryEnd(item, previousEnd);
      turnStart = start;
      continue;
    }
    turn.push(item);
    const end = adapter.endTimestamp(item);
    // Parallel tasks can finish out of order; missing timestamps must not erase the anchor.
    if (end !== null)
      previousEnd = previousEnd === null ? end : Math.max(previousEnd, end);
  }
  flushTurn(true);
  return out;
}

/** Active and legacy turns both fold contiguous activities, with different tail status. */
function groupActivityRuns<TItem, TChild extends TItem>(
  items: readonly TItem[],
  turnStart: number | null,
  active: boolean,
  adapter: WorkRunGroupingAdapter<TItem, TChild>,
): TItem[] {
  let lastCompletedBoundary = -1;
  if (active) {
    for (let index = 0; index < items.length; index++) {
      if (
        adapter.isAnswer(items[index]) ||
        adapter.isCompactBoundary(items[index])
      ) {
        lastCompletedBoundary = index;
      }
    }
  }
  const out: TItem[] = [];
  let run: TChild[] = [];
  let runLastIndex = -1;
  let previousBoundary = turnStart;
  const flushRun = (next?: TItem) => {
    if (run.length === 0) return;
    out.push(
      adapter.createGroup(
        run,
        next,
        active && runLastIndex > lastCompletedBoundary,
        previousBoundary,
      ),
    );
    run = [];
  };
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (adapter.isActivity(item)) {
      run.push(item);
      runLastIndex = index;
    } else {
      flushRun(item);
      out.push(
        active && adapter.activeStandalone
          ? adapter.activeStandalone(item, index > lastCompletedBoundary)
          : item,
      );
      previousBoundary = adapter.boundaryTimestamp(item);
    }
  }
  flushRun();
  return out;
}

/** Seal-aware final answers remain visible; old histories fall back to the last answer. */
function groupAnsweredTurn<TItem, TChild extends TItem>(
  items: readonly TItem[],
  turnStart: number | null,
  adapter: WorkRunGroupingAdapter<TItem, TChild>,
  resumed = false,
): TItem[] | null {
  const answers = new Set<number>();
  const sealed: number[] = [];
  let lastAnswer = -1;
  for (let index = 0; index < items.length; index++) {
    if (!adapter.isAnswer(items[index])) continue;
    lastAnswer = index;
    if (adapter.isSealedAnswer(items[index])) sealed.push(index);
  }
  if (lastAnswer < 0) return null;

  if (sealed.length > 0) {
    // Background wake-ups (async agents, background shells) seal several SDK turns under
    // one user row. Unless recovery supersedes this attempt, the last seal is its answer.
    // Other seals stay visible only when their answer run carries a delivery, and then
    // the whole run stays together so an intro is never split from its report.
    let segmentStart = 0;
    for (const sealedIndex of sealed) {
      let lastActivity = -1;
      for (let index = sealedIndex - 1; index >= segmentStart; index--) {
        if (adapter.isActivity(items[index])) {
          lastActivity = index;
          break;
        }
      }
      let answerStart = sealedIndex;
      while (
        answerStart > lastActivity + 1 &&
        answerStart > segmentStart &&
        adapter.isAnswer(items[answerStart - 1]) &&
        adapter.canPrependToAnswer?.(items[answerStart - 1]) !== false
      ) {
        answerStart--;
      }
      let keep = !resumed && sealedIndex === sealed[sealed.length - 1];
      for (let index = answerStart; index <= sealedIndex && !keep; index++) {
        keep =
          adapter.isAnswer(items[index]) && !adapter.isArchivable(items[index]);
      }
      if (keep) {
        for (let index = answerStart; index <= sealedIndex; index++) {
          if (adapter.isAnswer(items[index])) answers.add(index);
        }
      }
      segmentStart = sealedIndex + 1;
    }
  } else if (!resumed) {
    if (
      items.some(
        (item, index) => index > lastAnswer && adapter.isActivity(item),
      )
    )
      return null;
    let lastActivity = -1;
    for (let index = lastAnswer - 1; index >= 0; index--) {
      if (adapter.isActivity(items[index])) {
        lastActivity = index;
        break;
      }
    }
    let answerStart = lastAnswer;
    if (lastActivity >= 0) {
      while (
        answerStart > lastActivity + 1 &&
        adapter.isAnswer(items[answerStart - 1]) &&
        adapter.canPrependToAnswer?.(items[answerStart - 1]) !== false
      )
        answerStart--;
    }
    for (let index = answerStart; index <= lastAnswer; index++) {
      if (adapter.isAnswer(items[index])) answers.add(index);
    }
  }

  // Recovery has superseded the interrupted attempt. Its short progress prose belongs
  // in the work fold even when the last activity never produced a final answer.
  // Error/interaction cards and delivery prose still follow isArchivable.
  const out: TItem[] = [];
  let run: TChild[] = [];
  let previousBoundary = turnStart;
  // A thinking block is persisted when it closes, so one that spans the answer text lands
  // behind it. Those items still started before the answer, so they belong to the run above
  // it: fold them back instead of opening a second, few-second "已工作" beneath the answer.
  let beforeAnswer: {
    index: number;
    run: TChild[];
    next: TItem;
    boundary: number | null;
    /** 连续多段最终回答时取最后一段:比它更早开始的尾随动作仍属于上方那一组。 */
    answerMs: number | null;
  } | null = null;
  const foldTail = (tail: TChild[]): boolean => {
    const target = beforeAnswer;
    if (target === null || target.answerMs === null || adapter.foldAnswerTail === false) return false;
    for (const child of tail) {
      const startMs = adapter.startTimestamp(child);
      if (startMs === null || startMs > target.answerMs) return false;
    }
    out[target.index] = adapter.createCompletedGroup(
      [...target.run, ...tail],
      target.next,
      target.boundary,
    );
    beforeAnswer = null;
    return true;
  };
  const flushRun = (next?: TItem): TChild[] => {
    const flushed = run;
    run = [];
    if (flushed.length === 0) return flushed;
    if (!foldTail(flushed)) {
      out.push(adapter.createCompletedGroup(flushed, next, previousBoundary));
    }
    return flushed;
  };
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (!answers.has(index) && adapter.isArchivable(item)) {
      run.push(item);
      continue;
    }
    const groupIndex = out.length;
    const flushed = flushRun(item);
    const grouped = out.length > groupIndex;
    out.push(item);
    if (!answers.has(index)) {
      beforeAnswer = null;
    } else if (grouped) {
      beforeAnswer = {
        index: groupIndex,
        run: flushed,
        next: item,
        boundary: previousBoundary,
        answerMs: adapter.boundaryTimestamp(item),
      };
    } else if (beforeAnswer !== null) {
      // 连续的多段最终回答之间没有动作:合入目标仍是它们上方那一组,边界取后一段。
      beforeAnswer.answerMs = adapter.boundaryTimestamp(item);
    }
    previousBoundary = adapter.boundaryTimestamp(item);
  }
  flushRun();
  return out;
}


/** Teammate-only presentation: join progress and activity under one stable disclosure.
 * Keep opaque history groups intact so their existing lazy loaders remain authoritative.
 * Replies, interactive cards, real user rows and history gaps are never swallowed.
 */
export function groupTeammateProcess<T extends { key: string }>(
  items: readonly T[],
  adapter: {
    isProgress(item: T): boolean;
    isRecovery(item: T): boolean;
    children(item: T): readonly T[] | undefined;
    start(item: T): number | null;
    end(item: T): number | null;
    streaming(item: T): boolean;
    create(children: T[], key: string, streaming: boolean, start: number | null, end: number | null): T;
  },
): T[] {
  const result: T[] = [];
  let pending: T[] = [];
  let previousEnd: number | null = null;
  let anchor: string | undefined;
  // The history placeholder keeps its outer key when children arrive. Deriving the
  // journal key from loaded descendants would close the very disclosure that loaded them.
  const firstKey = (item: T): string => item.key.replace(/^work-(?:summary-)?/, '').replace(/^(?:msg|thinking|tools)-/, '');
  const flush = () => {
    if (!pending.length) return;
    const starts = pending.map(adapter.start).filter((v): v is number => v !== null);
    const ends = pending.map(adapter.end).filter((v): v is number => v !== null);
    result.push(adapter.create(pending, `work-journal-${anchor ?? firstKey(pending[0]!)}`,
      pending.some(adapter.streaming), starts.length ? Math.min(...starts) : null, ends.length ? Math.max(...ends) : null));
    pending = [];
  };
  for (const item of items) {
    const start = adapter.start(item);
    if (previousEnd !== null && start !== null && start - previousEnd > HISTORY_GAP_SPLIT_MS) { flush(); anchor = undefined; }
    if (adapter.children(item) || adapter.isProgress(item) || adapter.isRecovery(item)) pending.push(item);
    else { flush(); result.push(item); anchor = item.key; }
    const end = adapter.end(item);
    if (end !== null) previousEnd = previousEnd === null ? end : Math.max(previousEnd, end);
  }
  flush();
  return result;
}
