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
}>('CindyUsageWidgets');

export const usageWidgetsSupported = native !== null;

export function writeUsageWidgetStore(store: UsageWidgetStore): boolean {
  return native?.writeSnapshot(JSON.stringify(store)) ?? false;
}

export function readUsageWidgetStore(): UsageWidgetStore | null {
  try {
    const store = JSON.parse(native?.readSnapshot() ?? 'null') as Partial<UsageWidgetStore> | null;
    return store?.version === 2 && store.states && Array.isArray(store.computers) ? store as UsageWidgetStore : null;
  } catch {
    return null;
  }
}

export function clearUsageWidgetState(): void {
  native?.clearSnapshot();
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
