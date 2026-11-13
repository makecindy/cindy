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
import { parseProviderSharePeer } from './providerSharePeer.js';
import { parseSharedTaskPeer } from './sharedTaskPeer.js';
import { shortDeviceRef } from './stallDiagnostics.js';

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
  /** Last physical path; direct frames do not occupy the shared relay socket. */
  path?: string;
}

export interface BacklogPeer {
  pending: ReadonlyMap<number, BacklogEntry>;
  pendingBytes: number;
}

/** Registered channel names only; anything else is logged (and remembered) as unknown. */
export function isBacklogChannel(channel: unknown): channel is string {
  return typeof channel === 'string'
    && (REMOTE_INVOKE_ALLOWLIST.has(channel) || PUSH_FORWARD_ALLOWLIST.has(channel));
}

function knownChannel(channel: unknown): string {
  return isBacklogChannel(channel) ? channel : 'unknown';
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

/**
 * Provider-share and shared-task peers use long internal keys whose first
 * characters are identical across devices. Name them by the real device prefix;
 * share, task and member identifiers stay out of the log.
 */
export function backlogPeerTag(id: string): string {
  const share = parseProviderSharePeer(id);
  if (share) return `share:${shortDeviceRef(share.deviceId)}`;
  const task = parseSharedTaskPeer(id);
  if (task) return `task:${shortDeviceRef(task.deviceId)}`;
  return shortDeviceRef(id);
}

/** Split a peer's queue into frames last written directly and those using the relay socket. */
function splitByPath(peer: BacklogPeer): { relayCount: number; relayBytes: number; directCount: number; directBytes: number } {
  const split = { relayCount: 0, relayBytes: 0, directCount: 0, directBytes: 0 };
  for (const entry of peer.pending.values()) {
    if (entry.path === 'direct') {
      split.directCount++;
      split.directBytes += entry.bytes;
    } else {
      split.relayCount++;
      split.relayBytes += entry.bytes;
    }
  }
  return split;
}

/** One line: the congested peer by channel, then the other peers sharing the relay socket. */
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
  const focusSplit = focus ? splitByPath(focus) : { directCount: 0, directBytes: 0 };
  // Only frames not on a direct path compete for the shared relay socket.
  const others = [...peers]
    .filter(([id]) => id !== dst)
    .map(([id, peer]) => ({ tag: backlogPeerTag(id), ...splitByPath(peer) }));
  const relayOthers = others.filter(peer => peer.relayCount > 0).sort((a, b) => b.relayBytes - a.relayBytes);
  const relayBytes = relayOthers.reduce((sum, peer) => sum + peer.relayBytes, 0);
  const directCount = others.reduce((sum, peer) => sum + peer.directCount, 0);
  const directBytes = others.reduce((sum, peer) => sum + peer.directBytes, 0);
  const relayTop = relayOthers
    .slice(0, TOP_PEERS)
    .map(peer => `${peer.tag}=${peer.relayCount}/${kib(peer.relayBytes)}KiB`);
  return `device-link send backlog ${reason} dst=${backlogPeerTag(dst)}`
    + ` pending=${focus?.pending.size ?? 0}/${kib(focus?.pendingBytes ?? 0)}KiB`
    + ` direct=${focusSplit.directCount}/${kib(focusSplit.directBytes)}KiB`
    + ` top=[${top.join(',')}]`
    + ` otherPeers=${relayOthers.length}/${kib(relayBytes)}KiB [${relayTop.join(',')}]`
    + ` otherDirect=${directCount}/${kib(directBytes)}KiB`;
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
