import { parseKimiAccountUsageResult } from '../../shared/providerAccountUsage.js';
import { kimiSource } from './collect.js';
/**
 * Subscription accounts on the user's other computers, for the menu bar.
 *
 * The same reach as the model picker's remote providers: computers on this account that are
 * online, accept remote control and are not phones, and on them only the connections opened
 * with "allow remote invocation". Each account is read through the same device-link usage
 * channels the remote session chip uses, over a background link that does not put the other
 * computer under control. Responses are data from another machine: anything malformed drops
 * that one account. Deciding which of these duplicate an account already listed is left to
 * `distinctRemoteSubscriptions`.
 *
 * A computer that goes offline (or one account that fails to read) keeps its last reading for a
 * while, marked with when it was seen, instead of disappearing: `retainRemoteSubscriptions`.
 */

import type { ProviderView } from '@cindy/model-providers';
import type { ClaudeSubscriptionUsageSnapshot, XaiSubscriptionUsageSnapshot } from '@cindy/maker-shared/subscription-usage';

import type { DeviceLinkDeviceView } from '../../shared/deviceLinkIpc.js';
import { providerWeeklyQuotaSource } from '../../shared/providerQuotaSource.js';
import { readDeviceProviderViews } from '../remote-agent/controller/deviceCatalog.js';
import { mayServeBackgroundRead } from '../usage/peerUsageSync.js';
import type { CodexAccountUsagePayload } from '../usageBroadcaster.js';
import { claudeSource, codexSource, xaiSource } from './collect.js';
import type { MenubarRemoteDevice, MenubarSubscriptionInput } from './snapshot.js';

const MOBILE_PLATFORMS = new Set(['ios', 'android']);
const DEVICE_FANOUT = 3;
/** How long an unreachable computer's accounts stay listed with their last reading. */
export const REMOTE_RETAIN_MS = 3 * 24 * 60 * 60_000;

type InvokeResult = { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } };

export interface RemoteSubscriptionDeps {
  nowMs: number;
  listDevices(): Promise<{ devices: DeviceLinkDeviceView[] }>;
  invoke(deviceId: string, channel: string, args: unknown[]): Promise<InvokeResult>;
  onError?(scope: string, error: unknown): void;
}

/** A computer whose accounts the user lets this one read, whether or not it is online now. */
function isQuotaPeer(device: DeviceLinkDeviceView): boolean {
  return !device.isSelf && device.remoteControlEnabled && device.controlEnabled && !MOBILE_PLATFORMS.has(device.platform ?? '');
}

/** Same admission as the picker's other-computer providers and the cross-device usage sync. */
export function isRemoteQuotaDevice(device: DeviceLinkDeviceView): boolean {
  return isQuotaPeer(device) && device.online && mayServeBackgroundRead(device.appVersion);
}

export interface RemoteSubscriptionRead {
  sources: MenubarSubscriptionInput[];
  /** Computers that could not be read now (offline, or their account list failed). */
  unreachable: Set<string>;
  /** Accounts listed by a reachable computer whose own reading failed. */
  failed: Set<string>;
  /** An online computer or account failed to read; worth trying again soon. */
  incomplete: boolean;
}

/** A remote account as last read, kept for `retainRemoteSubscriptions`. */
export interface RemoteSeen {
  source: MenubarSubscriptionInput;
  seenAtMs: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Builtin accounts keep the legacy call shape; a named account passes its provider id and must
 * be echoed back, so an older computer that ignores the argument cannot lend the builtin
 * account's numbers to it.
 */
async function readUsage(
  deps: RemoteSubscriptionDeps,
  deviceId: string,
  channel: string,
  baseArgs: unknown[],
  providerId: string,
  defaultProviderId: string,
): Promise<Record<string, unknown> | null> {
  const scoped = providerId !== defaultProviderId;
  const response = await deps.invoke(deviceId, channel, scoped ? [...baseArgs, providerId] : baseArgs);
  if (!response.ok) throw Object.assign(new Error(response.error.message), { code: response.error.code });
  const value = response.result;
  if (!isRecord(value)) return null;
  if (scoped && value.providerId !== providerId) return null;
  return value;
}

async function readAccount(
  deps: RemoteSubscriptionDeps,
  device: MenubarRemoteDevice,
  provider: ProviderView,
): Promise<MenubarSubscriptionInput | null> {
  const kind = providerWeeklyQuotaSource(provider);
  let source: MenubarSubscriptionInput | null = null;
  if (kind === 'kimi') {
    const response = await deps.invoke(device.id, 'maker:usage:kimi-coding', [{ providerId: provider.id }]);
    if (response.ok && isRecord(response.result)) source = kimiSource(provider, parseKimiAccountUsageResult(response.result), deps.nowMs);
  } else if (kind === 'codex') {
    const payload = await readUsage(deps, device.id, 'maker:usage:account', ['codex'], provider.id, 'openai');
    source = payload ? codexSource(provider, payload as unknown as CodexAccountUsagePayload, deps.nowMs) : null;
  } else if (kind === 'claude') {
    const payload = await readUsage(deps, device.id, 'maker:usage:claude-subscription', [], provider.id, 'anthropic');
    source = payload ? claudeSource(provider, payload as unknown as ClaudeSubscriptionUsageSnapshot, deps.nowMs) : null;
  } else if (kind === 'xai') {
    const payload = await readUsage(deps, device.id, 'maker:usage:xai-subscription', [], provider.id, 'xai');
    source = payload ? xaiSource(provider, payload as unknown as XaiSubscriptionUsageSnapshot, deps.nowMs) : null;
  }
  if (!source) return null;
  return { ...source, id: `remote:${device.id}:${provider.id}`, device };
}

/** Null when the computer's account list could not be read. */
async function readDevice(
  deps: RemoteSubscriptionDeps,
  view: DeviceLinkDeviceView,
): Promise<{ sources: MenubarSubscriptionInput[]; failed: string[] } | null> {
  const device: MenubarRemoteDevice = { id: view.deviceId, name: view.name };
  let providers: ProviderView[];
  try {
    providers = await readDeviceProviderViews(deps.invoke, device.id);
  } catch (error) {
    deps.onError?.(`remote:${device.id}:providers`, error);
    return null;
  }
  const accounts = providers.filter((provider) => provider.connected && !provider.suspended && providerWeeklyQuotaSource(provider));
  const failed: string[] = [];
  const read = await Promise.all(
    accounts.map(async (provider) => {
      const key = `remote:${device.id}:${provider.id}`;
      try {
        const source = await readAccount(deps, device, provider);
        // Still listed but no usable reading (empty or failed response): keep its last reading too.
        if (!source) failed.push(key);
        return source;
      } catch (error) {
        deps.onError?.(key, error);
        failed.push(key);
        return null;
      }
    }),
  );
  return { sources: read.filter((source): source is MenubarSubscriptionInput => source !== null), failed };
}

export async function readRemoteSubscriptions(deps: RemoteSubscriptionDeps): Promise<RemoteSubscriptionRead> {
  const { devices } = await deps.listDevices();
  const result: RemoteSubscriptionRead = { sources: [], unreachable: new Set(), failed: new Set(), incomplete: false };
  for (const device of devices) {
    if (isQuotaPeer(device) && !device.online) result.unreachable.add(device.deviceId);
  }
  const targets = devices.filter(isRemoteQuotaDevice);
  for (let offset = 0; offset < targets.length; offset += DEVICE_FANOUT) {
    const slice = targets.slice(offset, offset + DEVICE_FANOUT);
    const batch = await Promise.all(slice.map((device) => readDevice(deps, device)));
    batch.forEach((read, index) => {
      if (!read) {
        result.unreachable.add(slice[index]!.deviceId);
        result.incomplete = true;
        return;
      }
      result.sources.push(...read.sources);
      for (const id of read.failed) result.failed.add(id);
      if (read.failed.length > 0) result.incomplete = true;
    });
  }
  return result;
}

/**
 * Fresh readings replace what was seen before; an unreachable computer's accounts (and a single
 * account that failed) keep their last reading for `REMOTE_RETAIN_MS`, marked with when it was
 * seen. A window whose reset has passed since then is shown as refilled. Accounts a reachable
 * computer no longer lists, and computers that left the list or stopped allowing access, drop.
 */
export function retainRemoteSubscriptions(
  previous: ReadonlyMap<string, RemoteSeen>,
  read: RemoteSubscriptionRead,
  nowMs: number,
): { sources: MenubarSubscriptionInput[]; seen: Map<string, RemoteSeen> } {
  const seen = new Map<string, RemoteSeen>();
  const sources: MenubarSubscriptionInput[] = [];
  for (const source of read.sources) {
    seen.set(source.id, { source, seenAtMs: nowMs });
    sources.push(source);
  }
  for (const [id, entry] of previous) {
    if (seen.has(id) || nowMs - entry.seenAtMs >= REMOTE_RETAIN_MS) continue;
    const deviceId = entry.source.device?.id;
    if (!(deviceId && read.unreachable.has(deviceId)) && !read.failed.has(id)) continue;
    seen.set(id, entry);
    sources.push({
      ...entry.source,
      windows: entry.source.windows.map((window) =>
        window.resetsAtMs !== null && window.resetsAtMs <= nowMs ? { ...window, usedPercent: 0, resetsAtMs: null } : window,
      ),
      lastSeenAtMs: entry.seenAtMs,
    });
  }
  return { sources, seen };
}
