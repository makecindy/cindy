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

type InvokeResult = { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } };

export interface RemoteSubscriptionDeps {
  nowMs: number;
  listDevices(): Promise<{ devices: DeviceLinkDeviceView[] }>;
  invoke(deviceId: string, channel: string, args: unknown[]): Promise<InvokeResult>;
  onError?(scope: string, error: unknown): void;
}

/** Same admission as the picker's other-computer providers and the cross-device usage sync. */
export function isRemoteQuotaDevice(device: DeviceLinkDeviceView): boolean {
  return (
    !device.isSelf &&
    device.online &&
    device.remoteControlEnabled &&
    device.controlEnabled &&
    !MOBILE_PLATFORMS.has(device.platform ?? '') &&
    mayServeBackgroundRead(device.appVersion)
  );
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

async function readDevice(deps: RemoteSubscriptionDeps, view: DeviceLinkDeviceView): Promise<MenubarSubscriptionInput[]> {
  const device: MenubarRemoteDevice = { id: view.deviceId, name: view.name };
  let providers: ProviderView[];
  try {
    providers = await readDeviceProviderViews(deps.invoke, device.id);
  } catch (error) {
    deps.onError?.(`remote:${device.id}:providers`, error);
    return [];
  }
  const accounts = providers.filter((provider) => provider.connected && !provider.suspended && providerWeeklyQuotaSource(provider));
  const read = await Promise.all(
    accounts.map(async (provider) => {
      try {
        return await readAccount(deps, device, provider);
      } catch (error) {
        deps.onError?.(`remote:${device.id}:${provider.id}`, error);
        return null;
      }
    }),
  );
  return read.filter((source): source is MenubarSubscriptionInput => source !== null);
}

export async function readRemoteSubscriptions(deps: RemoteSubscriptionDeps): Promise<MenubarSubscriptionInput[]> {
  const { devices } = await deps.listDevices();
  const targets = devices.filter(isRemoteQuotaDevice);
  const sources: MenubarSubscriptionInput[] = [];
  for (let offset = 0; offset < targets.length; offset += DEVICE_FANOUT) {
    const batch = await Promise.all(targets.slice(offset, offset + DEVICE_FANOUT).map((device) => readDevice(deps, device)));
    for (const read of batch) sources.push(...read);
  }
  return sources;
}
