/**
 * Desktop assembly of the SSH access controller (sshAccessController.ts): binds the owner's files, the key generator
 * and the SSH host list (remote-ssh/index.ts). The device-link service (device-link/index.ts) creates it once with
 * its peer and background-invoke ports and drives it next to the remote-control consent push; the settings IPC
 * (ipc.desktop.ts) and the SSH host list receive it here. Desktop only: the Node Host is never a controller.
 */
import os from 'node:os';
import { SSH_ACCESS_CHANNEL, type SshAccessRequest } from '@cindy/device-link';
import { generateOpenSshEd25519KeyPair } from '@cindy/maker-remote-ssh';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState.js';
import { ownerScopedPath } from '../dataOwnerPath.js';
import { readDeviceLinkSettings } from '../device-link/settings-store.desktop.js';
import { createLogger } from '../logger.js';
import { activeDataOwnerId } from '../ownerContext.js';
import {
  broadcastRemoteSshHostsChanged,
  listRemoteSshHostAliases,
  onRemoteSshHostRemoved,
  renamePinnedDeviceHost,
  setRemoteSshDeviceHostResolver,
  upsertPinnedDeviceHost,
} from '../remote-ssh/index.js';
import { getUserDataDir } from '../userDataPath.js';
import { bindSshDeviceHostsController } from './ipc.desktop.js';
import { probeSshBanner } from './sshdProbe.js';
import { createSshAccessController, type SshAccessController, type SshAccessControllerPeer } from './sshAccessController.js';

/** Bursts of record changes (one device's operation writes two or three times) reach the windows as one notice. */
const NOTIFY_DEBOUNCE_MS = 200;

/** What the device-link service provides. */
export interface DesktopSshAccessControllerLinkPorts {
  selfDeviceId(): string | null;
  peer(deviceId: string): SshAccessControllerPeer | null;
  /** `remoteBackgroundInvoke`: background priority, account-checked, refuses devices whose 「控制它」 is off. */
  backgroundInvoke(deviceId: string, channel: string, args: unknown[]): Promise<
    { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } }
  >;
  /** Tell this computer's windows to read the device hosts again. */
  notifyChanged(): void;
}

export function createDesktopSshAccessController(link: DesktopSshAccessControllerLinkPorts): SshAccessController {
  const log = createLogger('ssh-access');
  const owner = () => (isAppSessionBoundaryPending() ? null : activeDataOwnerId());
  let notifyTimer: ReturnType<typeof setTimeout> | null = null;
  const notify = () => {
    if (notifyTimer) return;
    notifyTimer = setTimeout(() => {
      notifyTimer = null;
      link.notifyChanged();
      broadcastRemoteSshHostsChanged();
    }, NOTIFY_DEBOUNCE_MS);
    notifyTimer.unref?.();
  };
  const controller = createSshAccessController({
    ownerScope: () => (owner() ? activeOwnerScopeKey() : null),
    recordPath: () => {
      const ownerId = owner();
      return ownerId ? ownerScopedPath(getUserDataDir(), ownerId, 'ssh-device-access.json') : null;
    },
    keyDir: () => {
      const ownerId = owner();
      return ownerId ? ownerScopedPath(getUserDataDir(), ownerId, 'ssh-access') : null;
    },
    selfDeviceId: () => link.selfDeviceId(),
    homeDir: () => os.homedir(),
    peer: (deviceId) => link.peer(deviceId),
    controlDisabled: (deviceId) => readDeviceLinkSettings().disabledControlDeviceIds.includes(deviceId),
    invoke: (deviceId, request: SshAccessRequest) => link.backgroundInvoke(deviceId, SSH_ACCESS_CHANNEL, [request]),
    probeAddress: (host, port) => probeSshBanner(port, { host }),
    hostAliases: () => listRemoteSshHostAliases(),
    upsertHost: (spec, options) => upsertPinnedDeviceHost(spec, options),
    renameHost: (fromAlias, spec) => renamePinnedDeviceHost(fromAlias, spec),
    generateKeyPair: (comment) => generateOpenSshEd25519KeyPair(comment),
    onChanged: notify,
    log,
  });
  bindSshDeviceHostsController(controller);
  setRemoteSshDeviceHostResolver((hostId) => controller.deviceHostFor(hostId));
  onRemoteSshHostRemoved((hostId) => controller.hostRemovedByUser(hostId));
  return controller;
}
