import { createHash } from 'node:crypto';
import {
  HISTORY_VIEW_DELTA_SAME, HISTORY_VIEW_DELTA_VERSION,
  type HistoryViewDeltaInfo, type HistoryViewDeltaOptions,
} from '@cindy/device-link';
import type { HistoryMessageSource, HistoryViewPage } from '@cindy/maker-shared/message-window';
import type { HistoryPageShape } from '../localDb/ipc/historyViewReader';

/**
 * Host side of history-view-delta-v1 (see packages/device-link historyViewDelta.ts).
 *
 * For each delivered latest page the Host keeps only the per-item fingerprints the reader
 * already computes (taken before the outline revision suffix), never the page itself.
 * Running leaf items are never `same`: their fingerprint names only their start, and their
 * contents are what changes. The token is derived from those fingerprints, so it names
 * exactly the non-running contents a `same` can refer to, costs no extra serialization,
 * and repeats for an unchanged page (an identical re-read can still end as `notModified`).
 * Dropping bases is never needed for correctness: a base only names content that
 * controller already holds. A controller's bases are released when this Host closes it on
 * purpose (revoked, kicked, remote control off, quit; `DeviceLinkClient.onInboundPeerReleased`,
 * together with the list delta bases). An ordinary disconnect or transport timeout keeps
 * them, so the reconnecting controller still reads deltas; logout and losing ownership drop
 * all of them (`dropAllControllers(…, 'shutdown')`). LRU bounds the rest.
 */
/** Per controller and task, across read options: a prefetch without work lines can serve the open view. */
const BASES_PER_VIEW = 4;
const MAX_VIEWS = 128;

interface Base {
  token: string;
  suffix?: string;
  /** Page order, so unchanged runs can be named by index. */
  keys: readonly string[];
  fingerprints: ReadonlyMap<string, string>;
}
const views = new Map<string, Base[]>();

const viewKey = (controller: string, sessionId: string) => `${controller}\u0000${sessionId}`;

function remember(key: string, base: Base): void {
  const list = (views.get(key) ?? []).filter((value) => value.token !== base.token);
  list.push(base);
  views.delete(key);
  views.set(key, list.slice(-BASES_PER_VIEW));
  while (views.size > MAX_VIEWS) views.delete(views.keys().next().value!);
}

/** Drop every base this controller (or every controller) could name. */
export function clearHistoryViewDeltas(controller?: string): void {
  if (controller === undefined) {
    views.clear();
    return;
  }
  for (const key of [...views.keys()]) if (key.startsWith(`${controller}\u0000`)) views.delete(key);
}

/**
 * Turn a latest page into its delta form for one same-account controller. Without a
 * shape (or with a page the shape does not describe) the page is returned unchanged.
 */
export function encodeHistoryViewDelta<T extends HistoryMessageSource>(
  controller: string,
  sessionId: string,
  variant: string,
  request: HistoryViewDeltaOptions,
  page: HistoryViewPage<T>,
  shape: HistoryPageShape | undefined,
): HistoryViewPage<T> & { historyDelta?: HistoryViewDeltaInfo } {
  if (!shape || shape.keys.length !== page.items.length
    || page.items.some((item, index) => item.key !== shape.keys[index])
    || new Set(shape.keys).size !== shape.keys.length) return page;
  const fingerprints = new Map<string, string>();
  shape.keys.forEach((key, index) => {
    if (!shape.running.has(key)) fingerprints.set(key, shape.fingerprints[index]);
  });
  const token = createHash('sha256').update(JSON.stringify([variant, shape.revisionSuffix ?? null, shape.keys,
    shape.keys.map((key) => fingerprints.get(key) ?? null)])).digest('base64url').slice(0, 32);
  // The variant stays in the token; fingerprints decide whether an item from another variant is `same`.
  const key = viewKey(controller, sessionId);
  const base = request.base ? views.get(key)?.find((value) => value.token === request.base) : undefined;
  remember(key, { token, keys: shape.keys, fingerprints, ...(shape.revisionSuffix ? { suffix: shape.revisionSuffix } : {}) });
  const historyDelta: HistoryViewDeltaInfo = {
    version: HISTORY_VIEW_DELTA_VERSION, token,
    ...(shape.revisionSuffix ? { revisionSuffix: shape.revisionSuffix } : {}),
  };
  // A suffix can only be swapped between two suffixed pages.
  if (!base || !!base.suffix !== !!shape.revisionSuffix) return { ...page, historyDelta };
  const baseIndex = new Map(base.keys.map((value, index) => [value, index]));
  const items: typeof page.items = [];
  let same = 0;
  let run: { type: typeof HISTORY_VIEW_DELTA_SAME; from: number; count: number } | null = null;
  for (const item of page.items) {
    const previous = base.fingerprints.get(item.key);
    const at = baseIndex.get(item.key);
    if (previous === undefined || at === undefined || previous !== fingerprints.get(item.key)) {
      items.push(item);
      run = null;
      continue;
    }
    same += 1;
    if (run && run.from + run.count === at) run.count += 1;
    else {
      run = { type: HISTORY_VIEW_DELTA_SAME, from: at, count: 1 };
      items.push(run as unknown as (typeof page.items)[number]);
    }
  }
  return same ? { ...page, items, historyDelta: { ...historyDelta, base: base.token } } : { ...page, historyDelta };
}

/**
 * A result rewritten to fit a frame no longer matches what a full read returns, so the
 * controller must not keep it as a base. `same` items still resolve against its old base.
 */
export function withoutHistoryViewDeltaToken(page: Record<string, unknown>): Record<string, unknown> {
  const delta = page.historyDelta;
  if (!delta || typeof delta !== 'object' || Array.isArray(delta) || !('token' in delta)) return page;
  const { token: _token, ...rest } = delta as Record<string, unknown>;
  return { ...page, historyDelta: rest };
}
