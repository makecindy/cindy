import { TASK_ACTIVITY_SNAPSHOT, type DeviceView, type ForegroundHostTaskActivity } from '@cindy/device-link';
import type { AgentActivityState } from './agentActivity';

type Status = AgentActivityState['status'];
const rank: Record<Status, number> = { attention: 0, completed: 1, error: 1, running: 2 };
const listeners = new Set<(device: string, value: unknown) => void>();

/** No process-wide snapshot cache: a suspended or signed-out consumer owns no reports. */
export function receiveHostTaskActivity(device: string, value: unknown) {
  for (const listener of listeners) listener(device, value);
}

function parseReport(value: unknown): ForegroundHostTaskActivity | null {
  if (!value || typeof value !== 'object') return null;
  const report = value as ForegroundHostTaskActivity;
  const { waitingCount, unreadCount, runningCount, selected } = report;
  const counts = [waitingCount, unreadCount, runningCount];
  if (report.schemaVersion !== 1 || !Number.isSafeInteger(report.revision) || report.revision < 1
    || !counts.every(n => Number.isSafeInteger(n) && n >= 0 && n <= 1_000_000)) return null;
  if (!waitingCount && !unreadCount && !runningCount) return selected === null ? report : null;
  if (!selected || typeof selected.sessionId !== 'string' || !selected.sessionId || selected.sessionId.length > 256
    || typeof selected.title !== 'string' || [...selected.title].length > 100
    || !Object.hasOwn(rank, selected.status)
    || rank[selected.status] !== (waitingCount ? 0 : unreadCount ? 1 : 2)) return null;
  return report;
}

export interface ForegroundActivitySource {
  readDeviceList(): Promise<{ devices: DeviceView[]; stale?: boolean }>;
  subscribe(owner: string, device: string, topics: string[]): Promise<void>;
  unsubscribe(owner: string, device: string, topics: string[]): Promise<void>;
  invoke(device: string, channel: string, args: unknown[], options: { noResultCache: boolean; preSend(): void }): Promise<unknown>;
  getPresenceAvailability(device: string): boolean | null;
  getSubscriptionIdentity?(device: string, topics: readonly ['sessions']): number | null;
}

let nextOwner = 0;

/** One foreground/connection lifetime. Each host supplies the exact projection it uploads
 * for APNs. A list page, a failed read or a missing subscription is never a zero. */
export function startForegroundTaskActivity(source: ForegroundActivitySource, options: {
  active(): boolean;
  labels: Record<Status, string>;
  staleDetail: string;
  url(device: string, session: string): string;
  write(state: AgentActivityState | null, observedAt: number): void;
}) {
  const owner = 'live-activity-' + ++nextOwner;
  let disposed = false;
  let devices: DeviceView[] = [];
  const peers = new Map<string, {
    report: ForegroundHostTaskActivity | null;
    subscription: number | null;
    observedAt: number;
    verified: boolean;
  }>();
  const active = () => !disposed && options.active();
  let previous: string | undefined;

  function publish() {
    if (!active() || !peers.size) return;
    let observedAt = 0;
    let count = 0;
    let runningCount = 0;
    let attentionCount = 0;
    let selected: (NonNullable<ForegroundHostTaskActivity['selected']> & { device: string }) | undefined;
    for (const [device, peer] of peers) {
      if (source.getPresenceAvailability(device) === false || !peer.verified || !peer.report || peer.subscription == null
        || peer.subscription !== source.getSubscriptionIdentity?.(device, ['sessions'])) return;
      const { waitingCount, unreadCount, runningCount: running, selected: top } = peer.report;
      observedAt = Math.max(observedAt, peer.observedAt);
      count += waitingCount + unreadCount + running;
      runningCount += running;
      attentionCount += waitingCount;
      if (top && (!selected || rank[top.status] < rank[selected.status])) selected = { ...top, device };
    }
    // An offline computer could still own the last task. Let the server decide when to end.
    if (!selected && devices.some(device => !peers.has(device.deviceId))) return;
    const state: AgentActivityState | null = selected ? {
      status: selected.status, title: selected.title, detail: options.labels[selected.status],
      count, runningCount, attentionCount, staleDetail: options.staleDetail,
      url: options.url(selected.device, selected.sessionId),
    } : null;
    const key = JSON.stringify(state);
    if (key === previous) return;
    previous = key;
    options.write(state, observedAt);
  }

  function receive(device: string, value: unknown, observedAt = Date.now()) {
    const peer = peers.get(device);
    const identity = source.getSubscriptionIdentity?.(device, ['sessions']);
    if (!active() || !peer || identity == null) return;
    const report = parseReport(value);
    if (report && peer.subscription === identity && peer.report && (report.revision < peer.report.revision
      || (report.revision === peer.report.revision && observedAt < peer.observedAt))) return;
    peer.verified = !!report;
    peer.subscription = identity;
    peer.report = report;
    peer.observedAt = observedAt;
    publish();
  }
  let readGeneration = 0;
  async function readPeer(device: string, generation: number) {
    const subscription = source.getSubscriptionIdentity?.(device, ['sessions']);
    if (!active() || subscription == null) return;
    const current = () => active() && generation === readGeneration
      && subscription === source.getSubscriptionIdentity?.(device, ['sessions']);
    const started = Date.now();
    try {
      const report = await source.invoke(device, TASK_ACTIVITY_SNAPSHOT, [], {
        noResultCache: true,
        preSend() {
          if (!current()) throw new Error('Foreground activity read superseded');
        },
      });
      if (current()) receive(device, report, started);
    } catch { /* An unsupported or unreachable peer leaves APNs in charge. */ }
  }

  listeners.add(receive);
  void (async () => {
    const roster = await source.readDeviceList();
    if (!active() || roster.stale) return;
    devices = roster.devices.filter(device => !device.isSelf && ['darwin', 'win32', 'linux'].includes(device.platform ?? ''));
    const online = devices.filter(device => device.online).sort((a, b) => a.deviceId < b.deviceId ? -1 : 1);
    if (online.some(device => !device.remoteControlEnabled)) return;
    for (const { deviceId } of online) peers.set(deviceId, { report: null, subscription: null, observedAt: 0, verified: false });
    for (const { deviceId } of online) {
      void (async () => {
        await source.subscribe(owner, deviceId, ['sessions']);
        await readPeer(deviceId, readGeneration);
      })().catch(() => { /* An unsupported or unavailable computer leaves APNs in charge. */ });
    }
  })().catch(() => { /* Unknown roster: preserve the account's existing activity. */ });

  let rechecking = false;
  return {
    async recheck() {
      if (!active() || rechecking || !peers.size) return;
      // APNs can legitimately advance first. Re-read the existing links before writing;
      // a conflict neither changes the account roster nor requires new subscriptions.
      rechecking = true;
      const generation = ++readGeneration;
      previous = undefined;
      for (const peer of peers.values()) peer.verified = false;
      try {
        await Promise.all([...peers.keys()].map(device => readPeer(device, generation)));
      } finally {
        rechecking = false;
      }
    },
    rosterChanged(device: { deviceId: string; online: boolean; remoteControlEnabled: boolean; platform: string }) {
      if (!['darwin', 'win32', 'linux'].includes(device.platform)) return false;
      const known = devices.find(row => row.deviceId === device.deviceId);
      return known ? known.online !== device.online || (device.online && known.remoteControlEnabled !== device.remoteControlEnabled)
        : device.online;
    },
    dispose() {
      disposed = true;
      listeners.delete(receive);
      for (const device of peers.keys()) void source.unsubscribe(owner, device, ['sessions']).catch(() => {});
    },
  };
}
