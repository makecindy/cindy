/**
 * Diagnostics for the reliable send backlog. Every peer shares this device's one
 * relay socket, so one peer's large replies can stall writes to all others
 * (2026-11-04: replies to two controllers filled their queues and every other
 * peer's requests expired before socket write). The existing logs named the
 * blocked replies, never what filled the queue. This module only labels and
 * summarizes; it never affects admission, ordering or retries.
 *
 * The summary is uploaded with the `device-link` scope, so it carries only
 * allowlisted channel names (anything else is "unknown"), counts, byte totals
 * and the 8-character peer prefix the existing transport logs already use.
 */
import { PUSH_FORWARD_ALLOWLIST, REMOTE_INVOKE_ALLOWLIST } from './allowlist.js';
import type { Envelope } from './protocol.js';

/** Warn before the queue is full: 3/4 of the message cap, or 4 MiB pending. */
export const BACKLOG_WARN_MESSAGES = 48;
export const BACKLOG_WARN_BYTES = 4 * 1024 * 1024;
/** One summary per peer per window; a stuck queue must not flood the log. */
export const BACKLOG_WARN_INTERVAL_MS = 30_000;
const TOP_CHANNELS = 6;
const TOP_PEERS = 5;

export interface BacklogEntry {
  bytes: number;
  diagChannel?: string;
}

export interface BacklogPeer {
  pending: ReadonlyMap<number, BacklogEntry>;
  pendingBytes: number;
}

function knownChannel(channel: unknown): string {
  return typeof channel === 'string'
    && (REMOTE_INVOKE_ALLOWLIST.has(channel) || PUSH_FORWARD_ALLOWLIST.has(channel))
    ? channel
    : 'unknown';
}

/**
 * Label a queued envelope. Replies carry no channel; the caller passes the
 * channel of the inbound invoke it answers.
 */
export function backlogLabel(env: Envelope, replyChannel?: string): string {
  if (env.kind === 'invoke-result') return `result:${knownChannel(replyChannel)}`;
  if (env.kind === 'invoke' || env.kind === 'push') {
    return `${env.kind}:${knownChannel((env.payload as { channel?: unknown } | undefined)?.channel)}`;
  }
  return env.kind;
}

const kib = (bytes: number) => Math.round(bytes / 1024);

/** One line: the congested peer by channel, then the other peers sharing the socket. */
export function summarizeBacklog(
  dst: string,
  peers: ReadonlyMap<string, BacklogPeer>,
  reason: 'high' | 'full',
): string {
  const focus = peers.get(dst);
  const channels = new Map<string, { count: number; bytes: number }>();
  for (const entry of focus?.pending.values() ?? []) {
    const label = entry.diagChannel ?? 'unlabeled';
    const total = channels.get(label) ?? { count: 0, bytes: 0 };
    total.count++;
    total.bytes += entry.bytes;
    channels.set(label, total);
  }
  const top = [...channels]
    .sort((a, b) => b[1].bytes - a[1].bytes)
    .slice(0, TOP_CHANNELS)
    .map(([label, total]) => `${label}=${total.count}/${kib(total.bytes)}KiB`);
  const others = [...peers]
    .filter(([id, peer]) => id !== dst && peer.pending.size > 0)
    .sort((a, b) => b[1].pendingBytes - a[1].pendingBytes);
  const otherBytes = others.reduce((sum, [, peer]) => sum + peer.pendingBytes, 0);
  const otherTop = others
    .slice(0, TOP_PEERS)
    .map(([id, peer]) => `${id.slice(0, 8)}=${peer.pending.size}/${kib(peer.pendingBytes)}KiB`);
  return `device-link send backlog ${reason} dst=${dst.slice(0, 8)}`
    + ` pending=${focus?.pending.size ?? 0}/${kib(focus?.pendingBytes ?? 0)}KiB`
    + ` top=[${top.join(',')}]`
    + ` otherPeers=${others.length}/${kib(otherBytes)}KiB [${otherTop.join(',')}]`;
}

/** Rate limit for backlog warnings, keyed by peer (and reason). */
export class BacklogWarnLimiter {
  private readonly lastAt = new Map<string, number>();

  constructor(private readonly intervalMs = BACKLOG_WARN_INTERVAL_MS) {}

  shouldWarn(key: string, now: number): boolean {
    const last = this.lastAt.get(key);
    if (last !== undefined && now - last < this.intervalMs) return false;
    this.lastAt.delete(key);
    this.lastAt.set(key, now);
    // Bound memory to peers seen recently; a peer id map never grows without limit.
    if (this.lastAt.size > 256) this.lastAt.delete(this.lastAt.keys().next().value!);
    return true;
  }
}
