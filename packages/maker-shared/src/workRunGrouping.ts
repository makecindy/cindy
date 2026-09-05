import { HISTORY_GAP_SPLIT_MS } from "./historyGap.js";

/** Platform projections own item shapes, card visibility, timestamps and stable keys. */
export interface WorkRunGroupingAdapter<TItem, TChild extends TItem> {
  isUserBoundary(item: TItem): boolean;
  isAnswer(item: TItem): boolean;
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
  const flushTurn = (activeTail: boolean) => {
    if (turn.length === 0) return;
    if (activeTail && isSessionStreaming) {
      // A new run's status can arrive before its user row. A durable done seal still
      // closes the loaded work before it; only subsequent content may stay active.
      const completedIndex = turn.findLastIndex(
        (item) => adapter.isAnswer(item) && adapter.isSealedAnswer(item),
      );
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
      ...(groupAnsweredTurn(turn, turnStart, adapter) ??
        groupActivityRuns(turn, turnStart, false, adapter)),
    );
    turn = [];
  };
  for (const item of items) {
    if (adapter.isUserBoundary(item)) {
      flushTurn(false);
      out.push(item);
      previousEnd = adapter.userBoundaryEnd(item, previousEnd);
      turnStart = adapter.startTimestamp(item);
      continue;
    }
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
): TItem[] | null {
  const answers = new Set<number>();
  let lastAnswer = -1;
  for (let index = 0; index < items.length; index++) {
    if (!adapter.isAnswer(items[index])) continue;
    lastAnswer = index;
    if (adapter.isSealedAnswer(items[index])) answers.add(index);
  }
  if (lastAnswer < 0) return null;

  if (answers.size > 0) {
    let segmentStart = 0;
    for (const sealedIndex of [...answers]) {
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
        adapter.isAnswer(items[answerStart - 1])
      ) {
        answerStart--;
      }
      for (let index = answerStart; index <= sealedIndex; index++) {
        if (adapter.isAnswer(items[index])) answers.add(index);
      }
      segmentStart = sealedIndex + 1;
    }
  } else {
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
        adapter.isAnswer(items[answerStart - 1])
      )
        answerStart--;
    }
    for (let index = answerStart; index <= lastAnswer; index++) {
      if (adapter.isAnswer(items[index])) answers.add(index);
    }
  }

  const out: TItem[] = [];
  let run: TChild[] = [];
  let previousBoundary = turnStart;
  const flushRun = (next?: TItem) => {
    if (run.length === 0) return;
    out.push(adapter.createCompletedGroup(run, next, previousBoundary));
    run = [];
  };
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (!answers.has(index) && adapter.isArchivable(item)) {
      run.push(item);
    } else {
      flushRun(item);
      out.push(item);
      previousBoundary = adapter.boundaryTimestamp(item);
    }
  }
  flushRun();
  return out;
}
