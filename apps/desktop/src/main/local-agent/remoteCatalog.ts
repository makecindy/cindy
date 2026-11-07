/** The same authorized device/share directory used by Cindy's model picker. */
import type { AgentKind } from '@cindy/maker-core';
import { readDeviceProviderViews } from '../remote-agent/controller/deviceCatalog.js';
import { remoteBackgroundInvoke } from '../device-link/index.js';
import { deviceLinkApiFetch } from '../device-link/deviceLinkApi.js';
import { getReceivedShares } from '../device-link/providerShareGuest.js';
import { readDeviceLinkSettings } from '../device-link/settings-store.js';
import type { DeviceLinkDeviceView } from '../../shared/deviceLinkIpc.js';
import { t } from '../i18n.js';
import { LOCAL_AGENT_ROUTE, localAgentModels, type LocalAgentModel } from './catalog.js';
import type { ProviderGroupConfig } from '../../shared/providerGroup.js';
import { collectRemoteProviderGroups, remoteProviderEntryKey } from '../../shared/remoteProviderGroups.js';

export interface RemoteCatalogSource { deviceId: string; label: string; providerId?: string }

// A sleeping/offline peer must not prevent using a local supplier. No cache: open
// re-reads the same directory, and the remote host enforces live authorization.
async function bounded<T>(read: Promise<T>, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([read, new Promise<T>(resolve => { timer = setTimeout(() => resolve(fallback), 3000); })]);
  } catch { return fallback; }
  finally { clearTimeout(timer); }
}

export async function readRemoteCatalog(
  sources: readonly RemoteCatalogSource[],
  invoke: typeof remoteBackgroundInvoke = remoteBackgroundInvoke,
  localGroups: Readonly<Record<string, ProviderGroupConfig>> = {},
  localModels: readonly LocalAgentModel[] = [],
): Promise<LocalAgentModel[]> {
  const lists = await Promise.all(sources.map(async source => {
    try {
      const [catalog, available] = await Promise.all([
        bounded(readDeviceProviderViews(invoke, source.deviceId, { visibleOnly: true }), []),
        bounded(invoke(source.deviceId, 'maker:list-available-agents', []), { ok: false, error: { code: 'IPC_ERROR', message: 'Catalog unavailable' } }),
      ]);
      if (!available.ok || !Array.isArray(available.result)) return null;
      const engines = available.result.filter((kind): kind is AgentKind => kind === 'pi' || kind === 'codex' || kind === 'claude-code');
      const providers = catalog.filter(provider => !source.providerId || provider.id === source.providerId);
      // Only a group with a usable application model may hide other sources.
      const models = localAgentModels(providers, engines, source);
      return { source, engines, providers: providers.filter(provider =>
        models.some(model => model[LOCAL_AGENT_ROUTE]?.providerId === provider.id)), models };
    } catch { return null; }
  }));
  const catalogs = lists.filter(entry => entry !== null);
  const groupCatalogs = catalogs.map(({ source, providers }) => ({ deviceId: source.deviceId, providers }));
  const { hidden } = collectRemoteProviderGroups(groupCatalogs);
  // A configured local group can only replace choices actually advertised by
  // /models. A disconnected provider or missing engine/model must not erase
  // otherwise usable device/share choices.
  const choiceKey = (model: LocalAgentModel) => JSON.stringify([model.engine, model.model]);
  const represented = new Map<string, Record<string, ProviderGroupConfig>>();
  for (const model of localModels) {
    const group = localGroups[model.provider];
    if (!group) continue;
    const key = choiceKey(model);
    const groups = represented.get(key) ?? {};
    groups[model.provider] = group;
    represented.set(key, groups);
  }
  const hiddenByChoice = new Map([...represented].map(([key, groups]) =>
    [key, collectRemoteProviderGroups(groupCatalogs, groups).hidden]));
  return catalogs.flatMap(({ source, models }) => models.filter(model =>
    !(hiddenByChoice.get(choiceKey(model)) ?? hidden).has(
      remoteProviderEntryKey(source.deviceId, model[LOCAL_AGENT_ROUTE]!.providerId))));
}

export async function remoteLocalAgentModels(isCurrent: () => boolean, localGroups: Readonly<Record<string, ProviderGroupConfig>> = {}, localModels: readonly LocalAgentModel[] = []): Promise<LocalAgentModel[]> {
  const settings = readDeviceLinkSettings();
  const shares = getReceivedShares().filter(share => share.status === 'active');
  const directory = await bounded(deviceLinkApiFetch<{ devices: DeviceLinkDeviceView[] }>('/api/device-link/devices'), { devices: [] });
  if (!isCurrent()) return [];
  const sources: RemoteCatalogSource[] = directory.devices
    .filter(device => !device.isSelf && device.online && device.remoteControlEnabled && !settings.disabledControlDeviceIds.includes(device.deviceId))
    .map(device => ({ deviceId: device.deviceId, label: device.name || device.selfName || settings.lastKnownDeviceNames[device.deviceId] || device.deviceId }));
  const duplicates = new Map<string, number>();
  for (const share of shares) {
    const key = JSON.stringify([share.owner.displayName, share.providerId]);
    const count = (duplicates.get(key) ?? 0) + 1;
    duplicates.set(key, count);
    sources.push({ deviceId: `share:${share.shareId}`, providerId: share.providerId,
      label: t('providerShare.received.fromOwner').replaceAll('{{name}}', () => share.owner.displayName) + (count > 1 ? ` (${count})` : '') });
  }
  const models = await readRemoteCatalog(sources, remoteBackgroundInvoke, localGroups, localModels);
  return isCurrent() ? models : [];
}
