/**
 * Interval counters for the local diagnostic log, aimed at "the app got slower the longer it ran".
 *
 * A `js stall` alone cannot tell which work starved the JS thread. While diagnostics are recording,
 * this keeps per-channel push handling time, business request counts and the remote session store's
 * retained size, and the diagnostic tick logs and resets them. Only fixed channel names and numbers
 * are kept: no payloads, arguments, device ids or session ids.
 *
 * Field names must survive `serializeMobileDebugRecord`, which redacts keys such as `messages` and
 * anything containing `token`; channel names are therefore values, never object keys.
 *
 * Disabled (the default) every record call is a single boolean check.
 */

export interface RemoteSessionStoreSizeMetrics {
  /** Sessions holding an in-memory message window. */
  sessionCount: number;
  messageCount: number;
  /** Largest single in-memory window, the one every push to that task re-sorts. */
  maxSessionMessageCount: number;
  /** Full-store subscribers: every store change notifies each of them. */
  subscriberCount: number;
  /** Home rows' status channel, separate from the full store. */
  homeStatusSubscriberCount: number;
  /** Per-task message preview listeners, summed across tasks. */
  previewSubscriberCount: number;
}

interface ChannelTiming {
  count: number;
  totalMs: number;
  maxMs: number;
}

type ChannelTimingRow = { channel: string } & ChannelTiming;
type ChannelCountRow = { channel: string; count: number };

const TOP_CHANNELS = 6;

let enabled = false;
let pushes = new Map<string, ChannelTiming>();
let invokes = new Map<string, number>();
type TransferCounters = { sent: number; results: number; payloadBytes: number; notModified: number; gzip: number };
let transfers = new Map<string, TransferCounters>();
let storeSizeSource: (() => RemoteSessionStoreSizeMetrics) | null = null;

/** `inflateMs` is wall time, not thread time, when inflated off the JS thread; JSON.parse always blocks it. */
type DecodeTiming = { count: number; inflateMs: number; parseMs: number };
let decodes = new Map<string, DecodeTiming>();

/** Where gunzip ran. `onThreadMs` is the part that actually blocked the JS thread. */
const emptyGunzip = () => ({ offThread: 0, onThread: 0, onThreadMs: 0, fallbacks: 0 });
/** Delay of a short JS timer: one large `maxMs` is a long task, many small ones are starvation. */
const emptyLoopLag = () => ({ maxMs: 0, over250: 0, over1000: 0 });
/** Time for a message to reach the native main thread, measured independently of JS busyness. */
const emptyUiThread = () => ({ pings: 0, maxLagMs: 0, over250: 0 });
let gunzip = emptyGunzip();
let loopLag = emptyLoopLag();
let uiThread = emptyUiThread();

function resetCounters(): void {
  pushes = new Map();
  invokes = new Map();
  transfers = new Map();
  decodes = new Map();
  gunzip = emptyGunzip();
  loopLag = emptyLoopLag();
  uiThread = emptyUiThread();
}

export function setJankMetricsEnabled(next: boolean): void {
  if (enabled === next) return;
  enabled = next;
  resetCounters();
}

export function jankMetricsEnabled(): boolean {
  return enabled;
}

export function recordPushHandled(channel: string, durationMs: number): void {
  if (!enabled) return;
  const entry = pushes.get(channel) ?? { count: 0, totalMs: 0, maxMs: 0 };
  entry.count += 1;
  entry.totalMs += durationMs;
  entry.maxMs = Math.max(entry.maxMs, durationMs);
  pushes.set(channel, entry);
}

export function recordInvokeSent(channel: string): void {
  if (!enabled) return;
  invokes.set(channel, (invokes.get(channel) ?? 0) + 1);
}

/** Relay requests that actually wrote to the socket, and encoded response payloads.
 * Excludes peer-direct traffic, frame headers and retransmissions; not a wire-byte total.
 */
export function recordInvokeTransfer(event: { channel: string; phase: 'sent' | 'result' | 'decoded';
  payloadBytes?: number; notModified?: boolean; gzip?: boolean; inflateMs?: number; parseMs?: number }): void {
  if (!enabled) return;
  if (event.phase === 'decoded') {
    const timing = decodes.get(event.channel) ?? { count: 0, inflateMs: 0, parseMs: 0 };
    timing.count++;
    timing.inflateMs += event.inflateMs ?? 0;
    timing.parseMs += event.parseMs ?? 0;
    decodes.set(event.channel, timing);
    return;
  }
  const entry = transfers.get(event.channel) ?? { sent: 0, results: 0, payloadBytes: 0, notModified: 0, gzip: 0 };
  if (event.phase === 'sent') entry.sent++;
  else {
    entry.results++;
    entry.payloadBytes += event.payloadBytes ?? 0;
    if (event.notModified) entry.notModified++;
    if (event.gzip) entry.gzip++;
  }
  transfers.set(event.channel, entry);
}

// Request fields are supplied by the host or a plugin, so a name that merely looks harmless is not
// safe to persist. Only identifiers this app itself sends are written; everything else is `?`.
const KNOWN_COLLECTIONS: ReadonlySet<string> = new Set([
  'teammates', 'bot-groups', 'plugins', 'plugin-results', 'session-import', 'companion-import',
]);
const KNOWN_ACTIONS: ReadonlySet<string> = new Set([
  'create', 'import', 'cancel', 'delete', 'archive', 'hide', 'mask-mentions', 'nickname', 'avatar',
  'transfer', 'bot-access', 'set-member-role', 'remove-member', 'enable', 'disable',
  'management:settings', 'settings:open', 'todo-update', 'todo-daily-check', 'close', 'suspend', 'answer',
]);
const KNOWN_OPS: ReadonlySet<string> = new Set(['caps', 'channels.im.list', 'channels.im.listLanes']);
const known = (set: ReadonlySet<string>, value: unknown) =>
  typeof value === 'string' && set.has(value) ? value : '?';

/**
 * `maker:remote-resources:invoke` multiplexes many actions, so its channel alone cannot name a
 * large response. The label is built only from the allowlists above; resource refs and free-form
 * input never reach the log.
 */
export function invokeMetricLabel(channel: string, args: unknown[] | undefined): string {
  if (channel !== 'maker:remote-resources:invoke') return channel;
  const request = args?.[0] as { collectionId?: unknown; actionId?: unknown; input?: { op?: unknown } } | undefined;
  const op = request?.input?.op;
  return `${channel}#${known(KNOWN_COLLECTIONS, request?.collectionId)}/${known(KNOWN_ACTIONS, request?.actionId)}`
    + (op === undefined ? '' : `/${known(KNOWN_OPS, op)}`);
}

export function recordGunzip(event: { offThread: boolean; onThreadMs?: number; fallback?: boolean }): void {
  if (!enabled) return;
  if (event.offThread) gunzip.offThread++;
  else gunzip.onThread++;
  gunzip.onThreadMs += event.onThreadMs ?? 0;
  if (event.fallback) gunzip.fallbacks++;
}

export function recordLoopLag(lagMs: number): void {
  if (!enabled) return;
  loopLag.maxMs = Math.max(loopLag.maxMs, lagMs);
  if (lagMs > 250) loopLag.over250++;
  if (lagMs > 1000) loopLag.over1000++;
}

export function recordUiThreadLag(lagMs: number): void {
  if (!enabled) return;
  uiThread.pings++;
  uiThread.maxLagMs = Math.max(uiThread.maxLagMs, lagMs);
  if (lagMs > 250) uiThread.over250++;
}

/** The store registers itself so this module does not import the store's module graph. */
export function setRemoteSessionStoreSizeSource(
  source: () => RemoteSessionStoreSizeMetrics,
): void {
  storeSizeSource = source;
}

function topChannels<T extends { channel: string }>(
  rows: T[],
  weight: (row: T) => number,
): T[] {
  return rows
    .sort((left, right) => weight(right) - weight(left))
    .slice(0, TOP_CHANNELS);
}

/** Read and reset the interval counters. */
export function takeJankMetrics(): {
  store: RemoteSessionStoreSizeMetrics | null;
  pushCount: number;
  pushMs: number;
  pushes: ChannelTimingRow[];
  invokeCount: number;
  invokes: ChannelCountRow[];
  relayTransfers: ({ channel: string } & TransferCounters)[];
  relayTransfersOmitted: number;
} {
  let pushCount = 0;
  let pushMs = 0;
  const pushRows: ChannelTimingRow[] = [];
  for (const [channel, entry] of pushes) {
    pushCount += entry.count;
    pushMs += entry.totalMs;
    pushRows.push({
      channel,
      count: entry.count,
      totalMs: Math.round(entry.totalMs),
      maxMs: Math.round(entry.maxMs),
    });
  }
  let invokeCount = 0;
  const invokeRows: ChannelCountRow[] = [];
  for (const [channel, count] of invokes) {
    invokeCount += count;
    invokeRows.push({ channel, count });
  }
  const snapshot = {
    store: storeSizeSource?.() ?? null,
    pushCount,
    pushMs: Math.round(pushMs),
    pushes: topChannels(pushRows, (row) => row.totalMs),
    invokeCount,
    invokes: topChannels(invokeRows, (row) => row.count),
    // Six rows per list keep the complete record below the writer's 120-value
    // budget. Rank by bytes so a late large response cannot disappear behind noise.
    relayTransfers: topChannels(
      [...transfers].map(([channel, counts]) => ({ channel, ...counts })),
      (row) => row.payloadBytes,
    ),
    relayTransfersOmitted: Math.max(0, transfers.size - TOP_CHANNELS),
  };
  pushes = new Map();
  invokes = new Map();
  transfers = new Map();
  return snapshot;
}

/**
 * Read and reset where JS and main-thread time went. Logged as its own line because `jank metrics`
 * already sits close to the writer's 120-value budget.
 */
export function takeSyncWorkMetrics() {
  const snapshot = {
    decodes: topChannels(
      [...decodes].map(([channel, timing]) => ({
        channel, count: timing.count, inflateMs: Math.round(timing.inflateMs), parseMs: Math.round(timing.parseMs),
      })),
      (row) => row.inflateMs + row.parseMs,
    ),
    gunzip: { ...gunzip, onThreadMs: Math.round(gunzip.onThreadMs) },
    loopLag: { ...loopLag, maxMs: Math.round(loopLag.maxMs) },
    uiThread: { ...uiThread, maxLagMs: Math.round(uiThread.maxLagMs) },
  };
  decodes = new Map();
  gunzip = emptyGunzip();
  loopLag = emptyLoopLag();
  uiThread = emptyUiThread();
  return snapshot;
}
