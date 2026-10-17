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

export function setJankMetricsEnabled(next: boolean): void {
  if (enabled === next) return;
  enabled = next;
  pushes = new Map();
  invokes = new Map();
  transfers = new Map();
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
export function recordInvokeTransfer(event: { channel: string; phase: 'sent' | 'result';
  payloadBytes?: number; notModified?: boolean; gzip?: boolean }): void {
  if (!enabled) return;
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
