import { REMOTE_INVOKE_ALLOWLIST } from './allowlist.js';
import type { InvokePayload } from './protocol.js';
import type { RemoteActionInvokeRequest } from './remoteResources.js';
import { parseSharedTaskPeer } from './sharedTaskPeer.js';
import { parseProviderSharePeer } from './providerSharePeer.js';

// Scoped sharing has a separate authorization list; this label is for logs only.
export const PROVIDER_SHARE_INSIGHTS_DIAGNOSTIC_CHANNEL = 'provider-share:insights:v1';

/** Fixed vocabulary only. Never retain request arguments, responses or error text. */
export function diagnosticChannel(channel: string): string {
  return channel === PROVIDER_SHARE_INSIGHTS_DIAGNOSTIC_CHANNEL || REMOTE_INVOKE_ALLOWLIST.has(channel)
    ? channel : 'unknown';
}

/**
 * Log-only short form of a device identifier. It keeps the historical budget of eight
 * identifying characters, but skips a readable prefix such as `dev-dev-` or `cloud-device-`:
 * development and cloud ids share those prefixes, so the first eight characters alone made
 * different computers look identical in logs. Plain production ids are unchanged.
 * Never use the result as a key or as a name shown to people.
 */
export function shortDeviceRef(id: string | null | undefined): string {
  if (!id) return 'unknown';
  const split = id.lastIndexOf('-');
  if (split > 0 && split <= 48) {
    const tail = id.slice(split + 1);
    if (/^[a-f\d]{16,}$/i.test(tail)) return id.slice(0, split + 1) + tail.slice(0, 8);
  }
  return id.slice(0, 8);
}

export function diagnosticRef(id: string | undefined): string {
  id = id && (parseSharedTaskPeer(id)?.deviceId ?? parseProviderSharePeer(id)?.deviceId ?? id);
  return id && /^[a-z\d-]{8,128}$/i.test(id) ? shortDeviceRef(id) : 'unknown';
}

export function diagnosticOperation(payload: InvokePayload): string {
  if (payload.channel !== 'maker:remote-resources:invoke') return diagnosticChannel(payload.channel);
  const input = payload.args?.[0];
  if (!input || typeof input !== 'object') return 'unknown';
  const action = (input as Partial<RemoteActionInvokeRequest>).actionId;
  return action === 'management:snapshot' || action === 'management:ui-consent'
    ? action : 'other-resource-action';
}

type RelayTrafficCounts = { firstFrames: number; replayFrames: number; beforeWriteTimeouts: number };

/** Bounded INFO evidence. First samples are immediate; omitted counts are flushed,
 * so a burst cannot silently look like one incident. No scheduling decisions here. */
export class StallDiagnostics {
  private readonly samples = new Map<string, number>();
  private sequence = 0;
  private readonly instance = Math.random().toString(16).slice(2, 10);
  private readonly omitted = new Map<string, number>();
  private readonly relayTraffic = new Map<string, RelayTrafficCounts>();
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly emit: (message: string) => void) {}

  private armFlush(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), 30_000);
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  /** Channel must be a fixed label from backlogLabel. Aggregate without per-frame logging. */
  countRelayTraffic(channel: string, event: keyof RelayTrafficCounts, count = 1): void {
    let counts = this.relayTraffic.get(channel);
    if (!counts) {
      counts = { firstFrames: 0, replayFrames: 0, beforeWriteTimeouts: 0 };
      this.relayTraffic.set(channel, counts);
    }
    counts[event] += count;
    this.armFlush();
  }

  record(stage: 'admission' | 'request' | 'decode' | 'receive' | 'path' | 'ack' | 'execution' | 'send' | 'encode', fields: Record<string, unknown>): void {
    try {
      this.armFlush();
      const key = stage === 'admission' ? `${stage}:${fields.reason}`
        : stage === 'request' ? `${stage}:${fields.outcome}`
          : stage === 'execution' || stage === 'send' ? `${stage}:${fields.outcome}` : stage;
      const count = this.samples.get(key) ?? 0;
      this.samples.set(key, count + 1);
      if (count >= 4) { this.omitted.set(key, (this.omitted.get(key) ?? 0) + 1); return; }
      // Upload truncates each message at 2000 chars. Keep independently parseable
      // pieces below that bound and correlate them, rather than losing the tail.
      const event = ++this.sequence;
      const entries = Object.entries(fields).flatMap(([key, value]) =>
        JSON.stringify(value ?? null).length > 1200 && value && typeof value === 'object' && !Array.isArray(value)
          ? Object.entries(value).map(([child, v]) => [`${key}.${child}`, v] as const) : [[key, value] as const]);
      let data: Record<string, unknown> = {};
      const pieces: Record<string, unknown>[] = [];
      const write = () => { pieces.push(data); data = {}; };
      for (const [key, value] of entries) {
        if (Object.keys(data).length && JSON.stringify({ ...data, [key]: value }).length > 1600) write();
        data[key] = value;
      }
      write();
      pieces.forEach((piece, index) => this.emit(`device-link diagnostic ${JSON.stringify({
        stage, instance: this.instance, event, part: index + 1, parts: pieces.length, ...piece,
      })}`));
    } catch { /* Logging must never affect delivery. */ }
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const traffic = [...this.relayTraffic];
    this.relayTraffic.clear();
    if (traffic.some(([, counts]) => counts.replayFrames || counts.beforeWriteTimeouts)) {
      const totalCount = (counts: RelayTrafficCounts) => counts.firstFrames + counts.replayFrames + counts.beforeWriteTimeouts;
      traffic.sort(([, a], [, b]) => totalCount(b) - totalCount(a));
      const omitted = traffic.slice(10).reduce((total, [, counts]) => ({
        firstFrames: total.firstFrames + counts.firstFrames,
        replayFrames: total.replayFrames + counts.replayFrames,
        beforeWriteTimeouts: total.beforeWriteTimeouts + counts.beforeWriteTimeouts,
      }), { firstFrames: 0, replayFrames: 0, beforeWriteTimeouts: 0 });
      try { this.emit(`device-link diagnostic ${JSON.stringify({
        stage: 'relay-traffic', instance: this.instance, channels: Object.fromEntries(traffic.slice(0, 10)), omitted,
      })}`); }
      catch { /* Logging must never affect delivery. */ }
    }
    if (this.omitted.size) {
      try { this.emit(`device-link diagnostic ${JSON.stringify({ stage: 'suppressed', instance: this.instance, counts: Object.fromEntries(this.omitted) })}`); }
      catch { /* Logging must never affect delivery. */ }
    }
    this.samples.clear();
    this.omitted.clear();
  }
}
