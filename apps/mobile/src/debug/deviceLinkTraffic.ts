/**
 * Dev-only device-link traffic meter.
 *
 * Counts how many requests / pushes each channel produced and roughly how many UTF-8 bytes they
 * carried, so sync changes can be measured on a simulator instead of estimated. It only keeps
 * per-channel counters in memory: no channel arguments, payload content, device ids or session
 * ids are stored, and nothing is written to the diagnostic log files or upload pipeline.
 *
 * Production builds never enable it, so every record call is a single boolean check there.
 * Payload sizes are re-serialized JSON lengths (after the transport decoded them), which tracks
 * the wire size closely; `wire` is the raw WebSocket text frame total including envelopes,
 * chunk headers and transport ACKs.
 */

interface ChannelTraffic {
  invokes: number;
  requestBytes: number;
  resultBytes: number;
  pushes: number;
  pushBytes: number;
}

export interface DeviceLinkTrafficSnapshot {
  since: number;
  wire: { inBytes: number; inFrames: number; outBytes: number; outFrames: number };
  channels: Record<string, ChannelTraffic>;
}

let enabled = typeof __DEV__ !== 'undefined' && __DEV__;
let since = Date.now();
let wire = { inBytes: 0, inFrames: 0, outBytes: 0, outFrames: 0 };
let channels = new Map<string, ChannelTraffic>();

export function deviceLinkTrafficMeterEnabled(): boolean {
  return enabled;
}

/** Tests only; release builds keep the compile-time `__DEV__` decision. */
export function setDeviceLinkTrafficMeterEnabled(next: boolean): void {
  enabled = next;
}

function utf8Length(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

function jsonBytes(value: unknown): number {
  if (value === undefined) return 0;
  try {
    return utf8Length(JSON.stringify(value) ?? '');
  } catch {
    return 0;
  }
}

function channelEntry(channel: string): ChannelTraffic {
  let entry = channels.get(channel);
  if (!entry) {
    entry = { invokes: 0, requestBytes: 0, resultBytes: 0, pushes: 0, pushBytes: 0 };
    channels.set(channel, entry);
  }
  return entry;
}

export function recordDeviceLinkWireFrame(direction: 'in' | 'out', frame: unknown): void {
  if (!enabled) return;
  try {
    const bytes = utf8Length(String(frame ?? ''));
    if (direction === 'in') {
      wire.inBytes += bytes;
      wire.inFrames += 1;
    } else {
      wire.outBytes += bytes;
      wire.outFrames += 1;
    }
  } catch {
    /* best-effort instrumentation */
  }
}

export function recordDeviceLinkInvoke(channel: string, request: unknown, result: unknown): void {
  if (!enabled) return;
  const entry = channelEntry(channel);
  entry.invokes += 1;
  entry.requestBytes += jsonBytes(request);
  entry.resultBytes += jsonBytes(result);
}

export function recordDeviceLinkPush(channel: string, payload: unknown): void {
  if (!enabled) return;
  const entry = channelEntry(channel);
  entry.pushes += 1;
  entry.pushBytes += jsonBytes(payload);
}

/**
 * Wrap a client's `invoke` so every outbound request (business calls, subscribe and unsubscribe
 * control frames) is counted by channel. A failed request still counts the request it sent.
 */
export function meterDeviceLinkInvokes(client: object): void {
  if (!enabled) return;
  const target = client as { invoke: (...args: unknown[]) => Promise<unknown> };
  const original = target.invoke.bind(client);
  target.invoke = async (...args: unknown[]) => {
    const payload = args[1] as { channel?: unknown } | undefined;
    const channel = typeof payload?.channel === 'string' ? payload.channel : '(unknown)';
    try {
      const result = await original(...args);
      recordDeviceLinkInvoke(channel, payload, result);
      return result;
    } catch (error) {
      recordDeviceLinkInvoke(channel, payload, undefined);
      throw error;
    }
  };
}

export function snapshotDeviceLinkTraffic(): DeviceLinkTrafficSnapshot {
  return {
    since,
    wire: { ...wire },
    channels: Object.fromEntries([...channels].map(([channel, entry]) => [channel, { ...entry }])),
  };
}

export function resetDeviceLinkTraffic(): void {
  since = Date.now();
  wire = { inBytes: 0, inFrames: 0, outBytes: 0, outFrames: 0 };
  channels = new Map();
}

/** Plain-text table, largest channels first. */
export function formatDeviceLinkTrafficReport(snapshot = snapshotDeviceLinkTraffic()): string {
  const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)}KB`;
  const rows = Object.entries(snapshot.channels)
    .map(([channel, entry]) => ({ channel, entry, total: entry.requestBytes + entry.resultBytes + entry.pushBytes }))
    .sort((left, right) => right.total - left.total)
    .map(({ channel, entry, total }) => (
      `${channel}  invoke×${entry.invokes} req ${kb(entry.requestBytes)} res ${kb(entry.resultBytes)}`
      + `  push×${entry.pushes} ${kb(entry.pushBytes)}  total ${kb(total)}`
    ));
  const seconds = Math.round((Date.now() - snapshot.since) / 1000);
  return [
    `device-link traffic over ${seconds}s: wire in ${kb(snapshot.wire.inBytes)} (${snapshot.wire.inFrames} frames)`
      + ` out ${kb(snapshot.wire.outBytes)} (${snapshot.wire.outFrames} frames)`,
    ...rows,
  ].join('\n');
}

declare global {
  // Dev-only handle for reading the meter from a debugger / inspector session.
  // eslint-disable-next-line no-var
  var __cindyDeviceLinkTraffic: {
    snapshot: typeof snapshotDeviceLinkTraffic;
    reset: typeof resetDeviceLinkTraffic;
    report: typeof formatDeviceLinkTrafficReport;
  } | undefined;
}

if (enabled) {
  globalThis.__cindyDeviceLinkTraffic = {
    snapshot: snapshotDeviceLinkTraffic,
    reset: resetDeviceLinkTraffic,
    report: formatDeviceLinkTrafficReport,
  };
}
