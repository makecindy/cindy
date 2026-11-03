import type { HistoryWorkLine } from './historyWorkLines.js';

/** Reading projections never replace persisted messages or the agent transcript. */
export const HISTORY_VIEW_VERSION = 1 as const;
export const HISTORY_VIEW_PAGE_ITEMS = 20;
export const HISTORY_VIEW_PAGE_BYTES = 1024 * 1024;
export const HISTORY_DETAIL_PAGE_BYTES = 256 * 1024;

/** Local ordering only: the run changes on restart, and order never uses the wall clock. */
export interface HistoryCacheReceipt { run: string; order: number }
const cacheReceiptRun = `${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
let cacheReceiptOrder = 0;
export function nextHistoryCacheReceipt(): HistoryCacheReceipt {
  return { run: cacheReceiptRun, order: ++cacheReceiptOrder };
}
export function isHistoryCacheReceipt(value: unknown): value is HistoryCacheReceipt {
  const receipt = value as HistoryCacheReceipt | null;
  return !!receipt && typeof receipt.run === 'string' && Number.isSafeInteger(receipt.order) && receipt.order > 0;
}
/** Only a current-run push can supersede a restored page from another run. */
export function historyCacheReceiptFollows(receipt: unknown, read: unknown, restored = false): boolean {
  if (!isHistoryCacheReceipt(receipt)) return false;
  if (!isHistoryCacheReceipt(read)) return true;
  return receipt.run === read.run ? receipt.order > read.order : restored && receipt.run === cacheReceiptRun;
}

export function isHistoryViewUnavailable(error: unknown): boolean {
  return /CHANNEL_NOT_ALLOWED|UNSUPPORTED_CAPABILITY|not registered|No handler/i.test(String(error));
}

/** Visible file candidates, independent of the folded tool body that produced them. */
export interface HistoryFileArtifact {
  path: string;
  source: 'tool' | 'command';
  createdAt: string;
  toolUseId?: string;
  ready?: boolean;
  /** Preserve file-card suppression when the editing tool body is deferred. */
  exclude?: 'command' | 'all';
}

export interface HistoryMessageSource {
  id: string;
  clientId: string;
  role: string;
  content: unknown;
  createdAt: string;
  rowid?: number;
  /** Controller-local order of a durable push; never a Host revision. */
  cacheReceipt?: HistoryCacheReceipt;
  toolUseId?: string | null;
  agentMeta?: object | null;
  /** Host outline only; transferred in work summaries, never as a replacement body. */
  historyArtifacts?: HistoryFileArtifact[];
  /** Host outline only: changes when the hidden body is rewritten; hashed into revisions. */
  historyContentStamp?: string;
}

/** Both endpoints are real host message IDs, inclusive, in host database order. */
export interface HistoryWorkReference {
  key: string;
  firstMessageId: string;
  lastMessageId: string;
  /** Stored upper bound when the range ends in a recoverable in-flight block. */
  firstStoredMessageId?: string;
  lastStoredMessageId?: string;
  liveMessageIds?: string[];
  /** Restricts a subagent detail range to this tool and its descendants. */
  parentToolUseId?: string;
}

export interface HistoryWorkSummary extends HistoryWorkReference {
  /** Original activity anchor; stable when its body has not been read yet. */
  anchorClientId?: string;
  artifacts?: HistoryFileArtifact[];
  /** Actual child model from persisted metadata; not the requested model. */
  model?: string;
  /** Existing detail endpoint can read just the visible desktop tail. */
  preview?: HistoryWorkSummary;
  /**
   * Latest single-line activities of a running range, already projected by the Host.
   * Present only when the controller asked for `workLines`; old Hosts omit it.
   */
  lines?: HistoryWorkLine[];
  startedAtMs: number;
  endedAtMs: number;
  isStreaming: boolean;
  messageCount: number;
  toolCount: number;
  /** Changes when the source range or its persisted contents change. */
  revision: string;
}

/** Controller-local actions; never serialized into the host reading protocol. */
export interface DeferredHistoryWork {
  owner?: object;
  key?: string;
  revision?: string;
  /**
   * Holds detail interest for a mounted surface; call the returned release on unmount.
   * `preview` says the surface can show a folded running tail; the Host's own range
   * state decides whether one is read, never the regrouped render it would change.
   */
  setVisible?(expanded: boolean, preview: boolean): () => void;
  /** The Host range is running without projected lines, so a folded tail is read. */
  livePreview?: boolean;
  previewComplete?: boolean;
  /** Host-projected running lines; when present a folded preview needs no detail read. */
  lines?: readonly HistoryWorkLine[];
  /** No detail rows are in hand yet; an expanded group keeps showing `lines` until they arrive. */
  awaitingDetails?: boolean;
  expanded: boolean;
  loading: boolean;
  failed: boolean;
  toggle(): void;
  retry(): void;
}

export type HistoryViewItem<TMessage extends HistoryMessageSource> =
  | { type: 'messages'; key: string; messages: TMessage[]; deferred?: HistoryWorkSummary }
  | { type: 'work'; key: string; summary: HistoryWorkSummary; children?: HistoryViewItem<TMessage>[] };

/** Outer summaries retain only prose and action references, never hidden bodies. */
export function historyViewLeaves<T extends HistoryMessageSource>(items: readonly HistoryViewItem<T>[]): HistoryViewItem<T>[] {
  return items.flatMap((item) => item.type === 'work' && item.children ? historyViewLeaves(item.children) : [item]);
}

export function historyWorkSummaries<T extends HistoryMessageSource>(items: readonly HistoryViewItem<T>[]): HistoryWorkSummary[] {
  return historyViewLeaves(items).flatMap((item) => item.type === 'work'
    ? [item.summary, ...(item.summary.preview ? [item.summary.preview] : [])] : item.deferred ? [item.deferred] : []);
}

export function mapHistoryViewMessages<T extends HistoryMessageSource, U extends HistoryMessageSource>(
  items: readonly HistoryViewItem<T>[], map: (rows: T[]) => U[],
): HistoryViewItem<U>[] {
  return items.map((item) => item.type === 'messages' ? { ...item, messages: map(item.messages) }
    : { ...item, children: item.children ? mapHistoryViewMessages(item.children, map) : undefined });
}

export interface HistoryViewPage<TMessage extends HistoryMessageSource> {
  version: typeof HISTORY_VIEW_VERSION;
  /** Chronological; the cursor advances independently of the rendered item count. */
  items: HistoryViewItem<TMessage>[];
  nextCursor: string | null;
  hasMore: boolean;
}

function historyPrefixBoundary<T extends HistoryMessageSource>(
  page: HistoryViewPage<T>, previous: readonly HistoryViewItem<T>[],
): number {
  const firstSourceId = (item: HistoryViewItem<T> | undefined) => item?.type === 'work'
    ? item.summary.firstMessageId : item?.messages[0]?.id;
  const first = page.items[0];
  const sourceId = firstSourceId(first);
  return previous.findIndex(item => item.key === first?.key
    || (sourceId !== undefined && firstSourceId(item) === sourceId));
}

/** Keep already read pages only when the latest page proves a continuous source boundary. */
export function retainHistoryViewPrefix<T extends HistoryMessageSource>(
  page: HistoryViewPage<T>,
  previous: { items: readonly HistoryViewItem<T>[]; hasMore: boolean; nextCursor: string | null } | null | undefined,
): HistoryViewPage<T> {
  if (!page.hasMore || !previous?.items.length) return page;
  const boundary = historyPrefixBoundary(page, previous.items);
  // Completed groups can replace a running key while keeping its exact source start.
  // A later overlap cannot prove continuity; a full page/rewind replaces the old view.
  if (boundary <= 0) return page;
  return { ...page, items: [...previous.items.slice(0, boundary), ...page.items],
    hasMore: previous.hasMore, nextCursor: previous.nextCursor };
}

/** Fill a missed-page gap before replacing a cached reading window. Never join on time alone. */
export async function readContinuousHistoryPage<T extends HistoryMessageSource>(
  latest: HistoryViewPage<T>,
  previous: { items: readonly HistoryViewItem<T>[]; hasMore: boolean; nextCursor: string | null } | null | undefined,
  readOlder: (before: string) => Promise<HistoryViewPage<T> | null | undefined>,
  isCurrent: () => boolean,
): Promise<HistoryViewPage<T> | null> {
  let page = latest;
  const startedAt = (item: HistoryViewItem<T> | undefined) => item?.type === 'work'
    ? item.summary.startedAtMs : Date.parse(item?.messages[0]?.createdAt ?? '');
  const seen = new Set<string>();
  while (isCurrent() && previous?.items.length && page.hasMore
    && historyPrefixBoundary(page, previous.items) < 0
    // Equal timestamps can still contain later rows in the Host's rowid order.
    && startedAt(page.items[0]) >= startedAt(previous.items[0])) {
    const cursor = page.nextCursor;
    if (!cursor || seen.has(cursor)) throw new Error('History page cursor did not advance');
    seen.add(cursor);
    const older = await readOlder(cursor);
    if (!isCurrent()) return null;
    if (!older) throw new Error('History page is unavailable while filling a gap');
    const keys = new Set(page.items.map(item => item.key));
    page = { ...older, items: [...older.items.filter(item => !keys.has(item.key)), ...page.items] };
  }
  return isCurrent() ? page : null;
}

/**
 * Host → controller replacement of one running top-level work item. The Host sends it
 * only when everything else on the latest page is unchanged since its last delivery to
 * that controller; `baseRevision` is the item revision that delivery carried.
 */
export interface HistoryWorkPatch {
  version: typeof HISTORY_VIEW_VERSION;
  sessionId: string;
  baseRevision: string;
  item: { type: 'work'; key: string; summary: HistoryWorkSummary };
}

export const HISTORY_WORK_PATCH_CHANNEL = 'maker:history-work-patch';

export interface HistoryDetailPage<TMessage extends HistoryMessageSource> {
  version: typeof HISTORY_VIEW_VERSION;
  messages: TMessage[];
  nextCursor: string | null;
  hasMore: boolean;
}

/** Shared by all controllers. A page boundary is never a user-facing "load more" step. */
export async function readHistoryWorkDetails<TMessage extends HistoryMessageSource>(options: {
  readPage(cursor: string | null): Promise<HistoryDetailPage<TMessage>>;
  initialCursor?: string | null;
  isCurrent(): boolean;
  onPage(messages: readonly TMessage[]): void;
}): Promise<void> {
  let cursor: string | null = options.initialCursor ?? null;
  const seen = new Set<string>();
  while (options.isCurrent()) {
    const page = await options.readPage(cursor);
    if (!options.isCurrent()) return;
    options.onPage(page.messages);
    if (!page.hasMore) return;
    if (!page.nextCursor || seen.has(page.nextCursor)) {
      throw new Error('History detail cursor did not advance');
    }
    seen.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}
