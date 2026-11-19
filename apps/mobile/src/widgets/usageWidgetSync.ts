import { requireOptionalNativeModule } from 'expo-modules-core';
import type { DeviceView } from '@cindy/device-link';
import {
  DEVICE_LINK_USAGE_WIDGET_SNAPSHOT_CHANNEL,
  type MobileUsageWidgetSnapshot,
} from '@cindy/maker-shared/device-link-contract';

/** One computer's answer. `update-desktop`: its Cindy is too old to answer. */
export type UsageWidgetState =
  | { kind: 'snapshot'; receivedAtMs: number; deviceName: string; snapshot: MobileUsageWidgetSnapshot }
  | { kind: 'update-desktop'; receivedAtMs: number };

/**
 * What the home-screen widgets read (iOS App Group, Android app files). Each widget shows either "automatic" (the
 * computer that answered last) or the computer it was set to in its edit sheet. A request
 * that gets no answer keeps that computer's previous state, so the widgets show its age.
 */
export interface UsageWidgetStore {
  version: 2;
  /** Account the store was read for; another account's store is never shown or reused. */
  accountId?: string;
  autoDeviceId: string | null;
  /** Computers a widget can be set to, as listed in its edit sheet. */
  computers: { id: string; name: string }[];
  states: Record<string, UsageWidgetState>;
}

// Absent on binaries built before the widgets (OTA updates reach them too).
const native = requireOptionalNativeModule<{
  writeSnapshot(json: string): boolean;
  readSnapshot(): string | null;
  clearSnapshot(): void;
  readPinnedDeviceIds(): string[];
  /** iOS binaries with background refresh (`UsageWidgetBackgroundRefresh.swift`). */
  finishBackgroundRefresh?(success: boolean): Promise<void>;
  addListener?(event: 'onBackgroundRefresh', listener: () => void): { remove(): void };
}>('CindyUsageWidgets');

export const usageWidgetsSupported = native !== null;

/**
 * Runs `refresh` each time iOS grants the app background time for the widgets (it asks for it
 * while a widget is placed), and tells iOS when it is done. Android and binaries without the
 * native support never call it.
 */
export function onUsageWidgetBackgroundRefresh(refresh: () => Promise<boolean>): () => void {
  if (!native?.addListener || !native.finishBackgroundRefresh) return () => {};
  let running = false;
  const subscription = native.addListener('onBackgroundRefresh', () => {
    if (running) return;
    running = true;
    void refresh().catch(() => false).then((success) => {
      running = false;
      void native.finishBackgroundRefresh?.(success)?.catch(() => undefined);
    });
  });
  return () => subscription.remove();
}

// Stable snapshot for React subscribers. Older app binaries can still show the same
// foreground data even when their native home-screen widget module is unavailable.
let currentStore: UsageWidgetStore | null | undefined;
const listeners = new Set<() => void>();

function publishStore(store: UsageWidgetStore | null) {
  currentStore = store;
  for (const listener of listeners) listener();
}

export function subscribeUsageWidgetStore(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function writeUsageWidgetStore(store: UsageWidgetStore): boolean {
  const persisted = native?.writeSnapshot(JSON.stringify(store)) ?? false;
  publishStore(store);
  return persisted;
}

export function readUsageWidgetStore(): UsageWidgetStore | null {
  if (currentStore !== undefined) return currentStore;
  try {
    const store = JSON.parse(native?.readSnapshot() ?? 'null') as Partial<UsageWidgetStore> | null;
    currentStore = store?.version === 2 && store.states && Array.isArray(store.computers) ? store as UsageWidgetStore : null;
  } catch {
    currentStore = null;
  }
  return currentStore;
}

export function clearUsageWidgetState(): void {
  native?.clearSnapshot();
  publishStore(null);
}

export function automaticUsageState(store: UsageWidgetStore | null, userId?: string) {
  if (!userId || store?.accountId !== userId || !store.autoDeviceId) return null;
  return store.states[store.autoDeviceId] ?? null;
}

/** Computers that home-screen widgets are set to; the widgets record them when they draw. */
export function readPinnedUsageWidgetDevices(): string[] {
  return native?.readPinnedDeviceIds() ?? [];
}

const MOBILE_PLATFORMS = new Set(['ios', 'android', 'web']);

/** The user's other computers that allow remote control, online or not. */
function isWidgetComputer(device: DeviceView): boolean {
  return !device.isSelf && device.remoteControlEnabled && !MOBILE_PLATFORMS.has(device.platform ?? '');
}

/** Online computers in the order "automatic" tries them: the last one that answered, then Macs. */
export function usageWidgetCandidates(devices: readonly DeviceView[], preferred: string | null = null): DeviceView[] {
  const rank = (device: DeviceView) => (device.deviceId === preferred ? 0 : device.platform === 'darwin' ? 1 : 2);
  return devices.filter(device => isWidgetComputer(device) && device.online).sort((a, b) => rank(a) - rank(b));
}

type Invoke = <T>(deviceId: string, channel: string, args?: unknown[]) => Promise<T>;

function isChannelNotAllowed(error: unknown): boolean {
  // Covers both CHANNEL_NOT_ALLOWED and DEVICE_LINK_CHANNEL_NOT_ALLOWED, as code or message.
  const code = String((error as { code?: unknown } | null)?.code ?? '');
  const message = error instanceof Error ? error.message : String(error);
  return `${code} ${message}`.includes('CHANNEL_NOT_ALLOWED');
}

function isSnapshot(value: unknown): value is MobileUsageWidgetSnapshot {
  const snapshot = value as Partial<MobileUsageWidgetSnapshot> | null;
  return !!snapshot && snapshot.version === 1 && Array.isArray(snapshot.sources)
    && !!snapshot.usage && Array.isArray(snapshot.usage.daily) && Array.isArray(snapshot.usage.days);
}

/**
 * Asks the computers the widgets need: for "automatic", the one that answered last and then
 * the others until one answers; plus every computer a widget is set to. A computer that does
 * not answer keeps its previous state.
 */
export async function refreshUsageWidgetStore(
  previous: UsageWidgetStore | null,
  devices: readonly DeviceView[],
  invoke: Invoke,
  pinned: readonly string[] = [],
  nowMs: () => number = Date.now,
  isCurrent: () => boolean = () => true,
): Promise<UsageWidgetStore> {
  const computers = devices.filter(isWidgetComputer);
  const listed = new Set(computers.map(device => device.deviceId));
  const states: Record<string, UsageWidgetState> = {};
  for (const [id, state] of Object.entries(previous?.states ?? {})) {
    if (listed.has(id)) states[id] = state;
  }
  let autoDeviceId = previous?.autoDeviceId && listed.has(previous.autoDeviceId) ? previous.autoDeviceId : null;
  const outcomes = new Map<string, 'answered' | 'too-old' | 'failed'>();
  const ask = async (device: DeviceView) => {
    if (!isCurrent()) throw new Error('Widget refresh expired');
    let outcome: 'answered' | 'too-old' | 'failed' = 'failed';
    try {
      const result = await invoke<{ ok?: boolean; snapshot?: unknown }>(
        device.deviceId, DEVICE_LINK_USAGE_WIDGET_SNAPSHOT_CHANNEL, [],
      );
      if (result?.ok === true && isSnapshot(result.snapshot)) {
        states[device.deviceId] = {
          kind: 'snapshot', receivedAtMs: nowMs(), deviceName: device.selfName || device.name, snapshot: result.snapshot,
        };
        outcome = 'answered';
      }
    } catch (error) {
      if (isChannelNotAllowed(error)) outcome = 'too-old';
    }
    outcomes.set(device.deviceId, outcome);
    return outcome;
  };

  const candidates = usageWidgetCandidates(devices, autoDeviceId);
  let answered = false;
  for (const device of candidates) {
    if (await ask(device) === 'answered') {
      autoDeviceId = device.deviceId;
      answered = true;
      break;
    }
  }
  for (const id of pinned) {
    const device = candidates.find(candidate => candidate.deviceId === id);
    if (device && !outcomes.has(id)) await ask(device);
  }
  // A computer that is too old replaces its kept snapshot with the update prompt only when a widget
  // is set to it, or when every reachable computer is too old (so "automatic" has nothing to show).
  const allTooOld = !answered && candidates.length > 0
    && candidates.every(device => outcomes.get(device.deviceId) === 'too-old');
  if (allTooOld) autoDeviceId = candidates[0]!.deviceId;
  for (const [id, outcome] of outcomes) {
    if (outcome === 'too-old' && (allTooOld || pinned.includes(id))) {
      states[id] = { kind: 'update-desktop', receivedAtMs: nowMs() };
    }
  }
  return {
    version: 2,
    autoDeviceId,
    computers: computers.map(device => ({ id: device.deviceId, name: device.selfName || device.name })),
    states,
  };
}

/** Refresh one account, fencing every request and the final write after waits. */
export async function refreshUsageWidgets(
  latest: { readonly current: {
    readDeviceList: () => Promise<{ devices: DeviceView[] }>;
    invoke: Invoke;
    accountGeneration: number;
    userId: string | null;
  } },
  generation: number,
  active: () => boolean,
): Promise<boolean> {
  const isCurrent = () => active() && latest.current.accountGeneration === generation;
  if (!isCurrent()) return false;
  const { devices } = await latest.current.readDeviceList();
  if (!isCurrent()) return false;
  const accountId = latest.current.userId;
  if (!accountId) return false;
  const stored = readUsageWidgetStore();
  const store = await refreshUsageWidgetStore(
    stored?.accountId === accountId ? stored : null, devices, latest.current.invoke,
    readPinnedUsageWidgetDevices(), Date.now, isCurrent,
  );
  if (!isCurrent()) return false;
  return writeUsageWidgetStore({ ...store, accountId });
}
