/**
 * Node Host assembly of the SSH access target (apps/desktop/src/main/ssh-access/sshAccessTargetCore.ts): the same body
 * as the desktop, bound to this Host's profile, owner and device-link settings. The Host device link
 * (device-link.ts) provides peers, pushes, revocation and the device list, and drives the lifecycle. There is no UI;
 * `cindy-host remote ssh-access …` and `cindy-host remote ssh-key …` reach it through `runSshAccessCommand`.
 */
import { createHash } from 'node:crypto';
import os from 'node:os';
import type { SshAccessAnnounce } from '@cindy/device-link';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../../desktop/src/main/appSessionState.js';
import { ownerScopedPath } from '../../desktop/src/main/dataOwnerPath.js';
import { createLogger } from '../../desktop/src/main/logger.js';
import { activeDataOwnerId } from '../../desktop/src/main/ownerContext.js';
import {
  createSshAccessTarget,
  type SshAccessSettings,
  type SshAccessTarget,
  type SshAccessTargetPorts,
} from '../../desktop/src/main/ssh-access/sshAccessTargetCore.js';
import { createNodeSshAccessSystem } from '../../desktop/src/main/ssh-access/sshAccessSystem.js';

/** This machine as SSH access sees it: the OS account's home and sshd, cloud facts, session termination. */
export type HostSshAccessMachine = Pick<SshAccessTargetPorts,
  'platform' | 'homeDir' | 'detectCloudGuest' | 'probeSshd' | 'readEndpointFacts' | 'readPublicIpv4' | 'terminator'>;

/** The real machine (main.ts); tests pass their own. */
export function nodeSshAccessMachine(): HostSshAccessMachine {
  return { platform: process.platform, homeDir: () => os.homedir(), ...createNodeSshAccessSystem(process.platform) };
}

export interface HostSshAccessPorts {
  profileDir: string;
  machine: HostSshAccessMachine;
  readSettings(): SshAccessSettings;
  writeEnabledOverride(value: boolean | undefined): Promise<void>;
  onlineDesktopPeers(): readonly string[];
  sendAnnounce(deviceId: string, payload: SshAccessAnnounce): void;
  revokeDevice(deviceId: string): Promise<void>;
  deviceName(deviceId: string): string | undefined;
  readDeviceDirectory(): Promise<readonly string[] | null>;
  /** False while a desktop uses this profile (coexistence plan A): the desktop's own target owns the files then. */
  canWrite(): boolean;
}

export function createHostSshAccessTarget(ports: HostSshAccessPorts): SshAccessTarget {
  const owner = () => (isAppSessionBoundaryPending() ? null : activeDataOwnerId());
  return createSshAccessTarget({
    ...ports.machine,
    // Same derivation as the desktop: a desktop and a Host on different profiles keep separate blocks.
    profileKey: createHash('sha256').update(ports.profileDir).digest('hex').slice(0, 12),
    ownerScope: () => (owner() ? activeOwnerScopeKey() : null),
    recordPath: () => {
      const ownerId = owner();
      return ownerId ? ownerScopedPath(ports.profileDir, ownerId, 'ssh-access.json') : null;
    },
    // The managed pod instance runs the desktop with --cloud-instance, never this launcher.
    managedCloudInstance: () => false,
    readSettings: () => ports.readSettings(),
    writeEnabledOverride: (value) => ports.writeEnabledOverride(value),
    onlineDesktopPeers: () => ports.onlineDesktopPeers(),
    sendAnnounce: (deviceId, payload) => ports.sendAnnounce(deviceId, payload),
    revokeDevice: (deviceId) => ports.revokeDevice(deviceId),
    deviceName: (deviceId) => ports.deviceName(deviceId),
    readDeviceDirectory: () => ports.readDeviceDirectory(),
    canWrite: () => ports.canWrite(),
    log: createLogger('ssh-access'),
  });
}

/**
 * `cindy-host remote ssh-access status|on|off|default` and `ssh-key add|remove`. The key text is read by the command
 * line from the file the person named; only the text reaches the running Host.
 */
export async function runSshAccessCommand(target: SshAccessTarget, action: string, body: { publicKey?: unknown; label?: unknown; fingerprint?: unknown }) {
  switch (action) {
    case 'ssh-access-status': return target.readLocal();
    case 'ssh-access-on': return target.setEnabled(true);
    case 'ssh-access-off': return target.setEnabled(false);
    case 'ssh-access-default': return target.setEnabled(null);
    case 'ssh-key-add':
      if (typeof body.publicKey !== 'string' || (body.label !== undefined && typeof body.label !== 'string')) throw new Error('A public key is required');
      return target.addManualKey(body.publicKey, body.label as string | undefined);
    case 'ssh-key-remove':
      if (typeof body.fingerprint !== 'string' || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(body.fingerprint)) throw new Error('A SHA256 fingerprint is required');
      return target.removeManualKey(body.fingerprint);
    default: throw new Error('Unknown SSH access command');
  }
}
