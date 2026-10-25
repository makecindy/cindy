import { createDeviceLinkManagement, type DeviceLinkIpcDeps } from '@cindy/app-runtime/deviceLinkManagement';
import { normalizeCachedDeviceName } from '@cindy/app-runtime/deviceLinkSettings';
import { applyControllerDisplayNameDirectorySnapshot, applyControllerDisplayNamePresence, beginControllerDisplayNameDirectoryRequest, createControllerDisplayNameFreshnessTracker, getControllerDisplayNameFreshnessSince, isLatestControllerDisplayNameDirectoryRequest, resetControllerDisplayNameFreshness, seedControllerDisplayNamesFromCache } from '@cindy/app-runtime/controllerDisplayNameFreshness';
import { applyControllerPresenceDirectorySnapshot, createControllerPresenceFreshnessTracker, markControllerPresenceFresh, resetControllerPresenceFreshness } from '@cindy/app-runtime/controllerPresenceDirectory';
import type { DeviceLinkDeviceView } from '@cindy/remote-agent/shared/deviceLinkIpc';
import type { SettingsStore } from '../settings.js';
import { readDeviceDirectory } from './directory.js';
import type { TerminalDeviceService } from './service.js';

/** Original device-management operations over the Node transport. Preferences,
 * name freshness and directory ordering are shared with the graphical host. */
export class TerminalDeviceManagement {
  private readonly names = new Map<string, string>();
  private readonly nameFreshness = createControllerDisplayNameFreshnessTracker();
  private readonly presenceFreshness = createControllerPresenceFreshnessTracker();
  private readonly pendingRevocations = new Set<string>();
  private readonly handlers;
  private readonly deps;
  private latestRead?: { sequence: number; promise: Promise<{ devices: DeviceLinkDeviceView[] }> };
  private readonly disposers: Array<() => void> = [];
  constructor(private readonly options: {
    settings: SettingsStore;
    remote: TerminalDeviceService;
    authenticated(): boolean;
    ownerScope(): string | null;
    emit(channel: string, payload: unknown): void;
    closePeerResources(peer: string): void;
  }) {
    const { remote, settings } = options;
    const store = settings.deviceLink;
    const setName = (id: string, name: string) => {
      this.names.set(id, name);
      const previous = remote.directoryPresence().get(id);
      if (previous) remote.directoryPresence().set(id, { ...previous, deviceName: name });
    };
    this.handlers = createDeviceLinkManagement({
      getAppCapabilities: () => ({ canUseDeviceLink: options.authenticated() }),
      rethrowServerError: error => { throw error; }, rethrowDeviceLinkError: error => { throw error; },
      // TerminalDeviceService.disconnect owns its outbound subscription ledger.
      resetSubscriptionRefcountForDevice: id => remote.disconnect(id),
    });
    this.deps = {
      getState: () => ({ ...store.readDeviceLinkSettings(), linkStatus: remote.getStatus(), connectionIssue: remote.getConnectionIssue(),
        standby: false, controlledBy: remote.activeControllers(), unresponsiveDeviceIds: remote.getUnresponsiveDeviceIds() }),
      clearDeviceResponsiveness: (id: string) => remote.clearDeviceResponsiveness(id),
      setEnabled: async (enabled: boolean) => { await settings.update({ remoteEnabled: enabled }); this.enforceSettings(); },
      setDeviceControlEnabled: store.setDeviceControlEnabled,
      openLink: (id: string) => remote.connect(id),
      closeLink: (id: string) => { options.closePeerResources(id); remote.disconnect(id); },
      disconnectAll: () => remote.disconnectControllers(),
      revoke: async (id: string) => {
        this.pendingRevocations.add(id);
        remote.revoke(id); options.closePeerResources(id);
        try { await store.updateDeviceLinkSetting('revokedControllers', latest => latest.includes(id) ? latest : [...latest, id]); }
        finally { this.pendingRevocations.delete(id); }
      },
      restore: async (id: string) => { await store.updateDeviceLinkSetting('revokedControllers', latest => latest.filter(value => value !== id)); if (options.authenticated()) remote.refreshPresence(); },
      broadcast: options.emit,
      apiFetch: async <T>(route: string, request?: { method?: string; body?: unknown }): Promise<T> => {
        const result = await remote.requestDevicesApi<unknown>(route, request);
        return (route === '/api/device-link/devices' ? { devices: readDeviceDirectory(result) } : result) as T;
      },
      readLastKnownDeviceNames: store.readLastKnownDeviceNames,
      rememberLastKnownDeviceName: store.rememberLastKnownDeviceName,
      forgetLastKnownDeviceName: store.forgetLastKnownDeviceName,
      beginControllerDisplayNameDirectoryRefresh: () => beginControllerDisplayNameDirectoryRequest(this.nameFreshness),
      isLatestControllerDisplayNameDirectoryRefresh: (sequence: number) => isLatestControllerDisplayNameDirectoryRequest(this.nameFreshness, sequence),
      waitForNewerControllerDisplayNameDirectoryRefresh: async (sequence: number) => {
        let pending = this.latestRead;
        while (pending && pending.sequence > sequence) {
          await pending.promise;
          const latest = this.latestRead;
          if (!latest || latest.sequence <= pending.sequence) return;
          pending = latest;
        }
      },
      captureControllerDisplayNameRequestEpoch: () => this.nameFreshness.epoch,
      captureControllerPresenceRequestEpoch: () => this.presenceFreshness.epoch,
      readControllerDisplayNameFreshnessSince: (id: string, epoch: number) => getControllerDisplayNameFreshnessSince(this.nameFreshness, id, epoch),
      applyControllerDisplayNameListSnapshot: ((devices, requestEpoch) => applyControllerDisplayNameDirectorySnapshot({
        devices, requestEpoch, freshness: this.nameFreshness, cachedNames: store.readLastKnownDeviceNames(),
        normalizeName: normalizeCachedDeviceName, setDisplayName: setName,
        // As in Desktop, the handler's reconciliation performs these writes.
        rememberName() {}, forgetName() {},
      })) satisfies DeviceLinkIpcDeps['applyControllerDisplayNameListSnapshot'],
      applyControllerPresenceListSnapshot: ((devices, requestEpoch) => {
        const presence = remote.directoryPresence();
        const previousOnline = new Map([...presence].map(([id, value]) => [id, value.online]));
        for (const device of devices) {
          if ((this.presenceFreshness.epochByDevice.get(device.deviceId) ?? 0) > requestEpoch) continue;
          const previous = presence.get(device.deviceId);
          presence.set(device.deviceId, { ...device, online: previous?.online ?? device.online,
            deviceName: this.names.get(device.deviceId) ?? device.name, platform: device.platform ?? '', appVersion: device.appVersion ?? '',
            lastSeenAt: device.lastSeenAt === null ? 0 : Date.parse(device.lastSeenAt) });
        }
        const change = (id: string, patch: { online?: boolean; platform?: string }) => {
          const previous = presence.get(id); if (previous) presence.set(id, { ...previous, ...patch });
        };
        applyControllerPresenceDirectorySnapshot({ devices, requestEpoch, selfDeviceId: remote.getSelfDeviceId(), freshness: this.presenceFreshness,
          getOnline: id => previousOnline.get(id), setOnline: (id, online) => change(id, { online }), forgetOnline: id => { presence.delete(id); },
          setPlatform: (id, platform) => change(id, { platform: platform ?? '' }), setName,
          shouldNotifyPeerOnline: ({ deviceId, online }) => online && !this.isTargetDisabled(deviceId),
          onPeerBecameOnline: id => remote.directoryPeerAvailable(id),
        });
      }) satisfies DeviceLinkIpcDeps['applyControllerPresenceListSnapshot'],
    };
    seedControllerDisplayNamesFromCache(store.readLastKnownDeviceNames(), this.nameFreshness, setName);
    this.disposers.push(remote.onPresenceChanged(snapshot => {
      markControllerPresenceFresh(this.presenceFreshness, snapshot.deviceId);
      applyControllerDisplayNamePresence({ deviceId: snapshot.deviceId, name: snapshot.deviceName,
        ...('selfName' in snapshot ? { selfName: snapshot.selfName } : {}), freshness: this.nameFreshness,
        normalizeName: normalizeCachedDeviceName, setDisplayName: setName, setFallbackDisplayName: setName,
        rememberName: (id, name) => { void store.rememberLastKnownDeviceName(id, name); },
        forgetName: id => { void store.forgetLastKnownDeviceName(id); },
      });
    }));
    this.disposers.push(remote.onStatusChange(status => {
      if (status !== 'online') {
        resetControllerDisplayNameFreshness(this.nameFreshness); resetControllerPresenceFreshness(this.presenceFreshness);
        this.names.clear(); seedControllerDisplayNamesFromCache(store.readLastKnownDeviceNames(), this.nameFreshness, setName);
      }
    }));
    remote.configureDirectoryReader(() => this.list());
  }
  isRevoked(id: string) { return this.pendingRevocations.has(id) || this.options.settings.deviceLink.readDeviceLinkSettings().revokedControllers.includes(id); }
  isTargetDisabled(id: string) { return this.options.settings.deviceLink.readDeviceLinkSettings().disabledControlDeviceIds.includes(id); }
  async list() {
    const owner = this.options.ownerScope();
    if (!owner) throw new Error('AUTH_REQUIRED');
    const promise = this.handlers.handleListDevices(this.deps);
    this.latestRead = { sequence: this.nameFreshness.directoryRequestSequence, promise };
    const result = await promise;
    if (owner !== this.options.ownerScope()) throw new Error('OWNER_CHANGED');
    return result.devices;
  }
  state() { return this.handlers.handleGetState(this.deps); }
  enforceSettings() {
    if (!this.options.settings.deviceLink.readDeviceLinkSettings().remoteControlEnabled) this.options.remote.disconnectControllers();
    if (this.options.authenticated()) this.options.remote.refreshPresence();
  }
  invoke(operation: string, args: unknown[]) {
    if (operation === 'state') return this.state();
    if (!this.options.authenticated()) throw new Error('AUTH_REQUIRED');
    switch (operation) {
      case 'enable': return this.handlers.handleSetDeviceControlEnabled(this.deps, args[0], true);
      case 'disable': return this.handlers.handleSetDeviceControlEnabled(this.deps, args[0], false);
      case 'revoke': return this.handlers.handleRevoke(this.deps, args[0]);
      case 'restore': return this.handlers.handleRestore(this.deps, args[0]);
      case 'rename': return this.handlers.handleRenameDevice(this.deps, args[0], args[1]);
      case 'remove': return this.handlers.handleDeleteDevice(this.deps, args[0]);
      case 'connect': return this.handlers.handleOpenLink(this.deps, args[0]);
      case 'disconnect': return this.handlers.handleCloseLink(this.deps, args[0]);
      case 'disconnect-all': return this.handlers.handleDisconnectAll(this.deps);
      default: throw new Error('INVALID_DEVICE_OPERATION');
    }
  }
  close() { for (const dispose of this.disposers.splice(0)) dispose(); }
}
