import { historyViewLeaves, type HistoryMessageSource, type HistoryWorkSummary, type DeferredHistoryWork } from './historyView.js';
import type { HistoryViewController, HistoryViewSnapshot } from './historyViewController.js';
import { liveContentWithHistoryOrder } from './historyViewHandoff.js';

/** The original renderer owns all grouping. References only substitute unread bodies. */
export function renderHistoryView<T extends HistoryMessageSource, TItem>(options: {
  view: HistoryViewController<T>;
  snapshot: HistoryViewSnapshot<T>;
  liveMessages: readonly T[];
  build(messages: readonly T[], streaming: boolean): TItem[];
  streaming: boolean;
  isLive?(message: T): boolean;
  /** Already displayed assistant identities in observation order, awaiting history. */
  pendingHandoff?: ReadonlySet<string>;
  isLocalUser?(message: T): boolean;
  structure: {
    placeholder(summary: HistoryWorkSummary): T;
    children(item: TItem): readonly TItem[] | undefined;
    sourceIds(item: TItem): readonly string[];
    rebuild(item: TItem, children: TItem[], deferred?: DeferredHistoryWork): TItem;
  };
}): TItem[] {
  const { view, snapshot, structure } = options;
  const rows: T[] = [];
  const seen = new Set<string>();
  const placeholders = new Set<string>();
  const references = new Map<string, HistoryWorkSummary>();
  const isPendingHandoff = (row: T) => row.role === 'assistant' && options.pendingHandoff?.has(row.clientId) === true;
  const isLive = (row: T) => options.isLive?.(row) || isPendingHandoff(row);
  const live = new Map(options.liveMessages.filter(isLive).map((row) => [row.clientId, row]));
  const leaves = historyViewLeaves(snapshot.items);
  const sourceIds = new Set(leaves.flatMap((item) => item.type === 'messages' ? item.messages.map((row) => row.clientId) : []));
  let endMs = 0;
  for (const item of leaves) {
    if (item.type === 'messages') {
      for (const row of item.messages) {
        const current = live.get(row.clientId);
        rows.push(current ? liveContentWithHistoryOrder(current, row) : row);
        seen.add(row.clientId);
        endMs = Math.max(endMs, Date.parse(row.createdAt));
      }
      continue;
    }
    const summary = item.summary;
    const full = snapshot.details.get(summary.key);
    const preview = !(full?.complete && full.revision === summary.revision)
      && summary.preview && snapshot.expanded.has(summary.preview.key);
    const range = preview ? summary.preview! : summary;
    const state = snapshot.details.get(range.key);
    const cached = state?.messages ?? [];
    const matchesReference = (row: T, id: string) => row.id === id
      || (id.startsWith('history-live:') && row.clientId === id.slice('history-live:'.length));
    const first = cached.findIndex((row) => matchesReference(row, range.firstMessageId));
    const last = cached.findIndex((row) => matchesReference(row, range.lastMessageId));
    // A visible result can split a previously cached range. Retain only this
    // reference's prefix while its replacement pages are being fetched.
    const body = (first < 0 ? [] : cached.slice(first, last < first ? undefined : last + 1))
      .filter((row) => !sourceIds.has(row.clientId));
    const placeholder = structure.placeholder(summary);
    if (!body.some((row) => row.clientId === placeholder.clientId)) {
      rows.push(placeholder);
      placeholders.add(placeholder.clientId);
    }
    references.set(placeholder.clientId, summary);
    for (const row of body) {
      rows.push(row);
      references.set(row.clientId, summary);
      seen.add(row.clientId);
    }
    endMs = Math.max(endMs, summary.endedAtMs);
  }
  // Durable pushes can change a pending row's provisional timestamp before the
  // history page includes it. Preserve the handoff's observation order for those
  // rows, without moving other live rows or changing authoritative history order.
  const pendingTail = [...(options.pendingHandoff ?? [])].flatMap((id) => {
    const row = live.get(id);
    return row?.role === 'assistant' && !seen.has(id) ? [row] : [];
  });
  let pendingIndex = 0;
  for (const source of options.liveMessages) {
    const row = isPendingHandoff(source) && !seen.has(source.clientId)
      ? pendingTail[pendingIndex++] : source;
    if (isLive(row) && !seen.has(row.clientId) && (row.role === 'assistant' || row.role === 'user')
      && (Date.parse(row.createdAt) >= endMs
        || isPendingHandoff(row))) rows.push(row);
  }
  // Local pending/blocked user bubbles belong to the current UI store, not
  // persisted history. Keep their store order without trusting device clocks.
  const renderedIds = new Set(rows.map((row) => row.clientId));
  let beforeClientId: string | undefined;
  for (let index = options.liveMessages.length - 1; index >= 0; index--) {
    const row = options.liveMessages[index];
    if (renderedIds.has(row.clientId)) {
      beforeClientId = row.clientId;
    } else if (row.role === 'user' && options.isLocalUser?.(row)) {
      const before = beforeClientId === undefined ? -1 : rows.findIndex((item) => item.clientId === beforeClientId);
      rows.splice(before < 0 ? rows.length : before, 0, row);
      renderedIds.add(row.clientId);
      beforeClientId = row.clientId;
    }
  }
  const bind = (item: TItem): TItem => {
    const children = structure.children(item);
    if (!children) return item;
    const refs = new Map<string, HistoryWorkSummary>();
    const next: TItem[] = [];
    for (const child of children) {
      if (structure.children(child)) { next.push(bind(child)); continue; }
      const ids = structure.sourceIds(child);
      for (const id of ids) {
        const summary = references.get(id);
        if (summary) refs.set(summary.key, summary);
      }
      if (!ids.some((id) => placeholders.has(id))) next.push(child);
    }
    if (!refs.size) return structure.rebuild(item, next);
    const summaries = [...refs.values()];
    const expanded = summaries.some((summary) => snapshot.expanded.has(summary.key));
    const states = summaries.map((summary) => snapshot.details.get(
      summary.preview && snapshot.expanded.has(summary.preview.key) ? summary.preview.key : summary.key));
    const setVisible = (full: boolean, preview: boolean) => {
      for (const summary of summaries) {
        view.setExpanded(summary.key, full);
        if (summary.preview) view.setExpanded(summary.preview.key, !full && preview);
      }
    };
    return structure.rebuild(item, next, {
      owner: view, key: summaries.map((summary) => summary.key).join('|'), expanded,
      previewComplete: summaries.every((summary) => summary.preview?.firstMessageId === summary.firstMessageId),
      loading: states.some((state) => state?.loading), failed: states.some((state) => !!state?.error),
      setVisible,
      toggle: () => setVisible(!expanded, false),
      retry: () => { for (const summary of summaries) void view.loadDetails(
        summary.preview && view.getSnapshot().expanded.has(summary.preview.key) ? summary.preview : summary); },
    });
  };
  return options.build(rows, options.streaming).map(bind);
}
