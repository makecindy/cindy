/**
 * Desktop assembly of the SSH access target (sshAccessTargetCore.ts): binds the profile, owner, device-link settings and
 * real-machine ports. The device-link service (device-link/index.ts) creates it once with its peer and revoke ports and
 * drives its lifecycle; the dispatcher (dispatch.desktop.ts) and the settings IPC (ipc.desktop.ts) read it through
 * `currentSshAccessTarget()`.
 */
import { createHash } from 'node:crypto';
import os from 'node:os';
import type { SshAccessAnnounce } from '@cindy/device-link';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState.js';
import { ownerScopedPath } from '../dataOwnerPath.js';
import { readDeviceLinkSettings, updateDeviceLinkSetting } from '../device-link/settings-store.desktop.js';
import { getInstanceConfig } from '../instance-runtime/config.js';
import { createLogger } from '../logger.js';
import { activeDataOwnerId } from '../ownerContext.js';
import { getUserDataDir } from '../userDataPath.js';
import { createSshAccessTarget, type SshAccessTarget } from './sshAccessTargetCore.js';
import { createNodeSshAccessSystem } from './sshAccessSystem.js';

/** What the device-link service provides: peers, pushes, revocation and the device list. */
export interface DesktopSshAccessLinkPorts {
  onlineDesktopPeers(): readonly string[];
  sendAnnounce(deviceId: string, payload: SshAccessAnnounce): void;
  revokeDevice(deviceId: string): Promise<void>;
  deviceName(deviceId: string): string | undefined;
  readDeviceDirectory(): Promise<readonly string[] | null>;
  /** Tell this computer's windows to read the state again. */
  notifyChanged(): void;
}

let target: SshAccessTarget | null = null;

/** The running target, or null before the device-link service created it. */
export function currentSshAccessTarget(): SshAccessTarget | null {
  return target;
}

export function createDesktopSshAccessTarget(link: DesktopSshAccessLinkPorts): SshAccessTarget {
  const log = createLogger('ssh-access');
  const owner = () => (isAppSessionBoundaryPending() ? null : activeDataOwnerId());
  target = createSshAccessTarget({
    platform: process.platform,
    homeDir: () => os.homedir(),
    // One block per profile: a release and a development profile on the same account never overwrite each other.
    profileKey: createHash('sha256').update(getUserDataDir()).digest('hex').slice(0, 12),
    ownerScope: () => (owner() ? activeOwnerScopeKey() : null),
    recordPath: () => {
      const ownerId = owner();
      return ownerId ? ownerScopedPath(getUserDataDir(), ownerId, 'ssh-access.json') : null;
    },
    managedCloudInstance: () => getInstanceConfig() !== null,
    readSettings: () => {
      const { remoteControlEnabled, revokedControllers, sshAccessEnabled } = readDeviceLinkSettings();
      return { remoteControlEnabled, revokedControllers, ...(sshAccessEnabled === undefined ? {} : { sshAccessEnabled }) };
    },
    writeEnabledOverride: async (value) => { await updateDeviceLinkSetting('sshAccessEnabled', () => value); },
    onlineDesktopPeers: () => link.onlineDesktopPeers(),
    sendAnnounce: (deviceId, payload) => link.sendAnnounce(deviceId, payload),
    revokeDevice: (deviceId) => link.revokeDevice(deviceId),
    deviceName: (deviceId) => link.deviceName(deviceId),
    readDeviceDirectory: () => link.readDeviceDirectory(),
    onChanged: () => link.notifyChanged(),
    log,
    ...createNodeSshAccessSystem(process.platform),
  });
  return target;
}
