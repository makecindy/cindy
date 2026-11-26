/**
 * Local (this computer) view of "allow my other devices to SSH into this computer" for the settings UI, and the
 * preload API that reads and changes it. Wire types between computers live in `@cindy/device-link` (sshAccess.ts).
 */
import type { SshAccessBlock, SshAccessEndpoint } from '@cindy/device-link';

export const SSH_ACCESS_IPC_CHANNEL = 'ssh-access:request';
/** Main → renderer: something in the state below changed; read it again. */
export const SSH_ACCESS_CHANGED_CHANNEL = 'ssh-access:changed';

export interface SshAccessDeviceRow {
  deviceId: string;
  /** Last known display name; absent when this computer never saw one. */
  deviceName?: string;
  fingerprint: string;
  enrolledAt: number;
  /** The key is in the authorized-keys file right now. */
  active: boolean;
}

export interface SshAccessManualKeyRow {
  fingerprint: string;
  label: string;
  addedAt: number;
  active: boolean;
}

export interface SshAccessSessionCleanup {
  at: number;
  /** False where ending sessions is not supported yet (macOS key mapping). */
  supported: boolean;
  terminated: number;
  /** Sessions whose key could not be determined; they were left running. */
  unmapped: number;
}

export interface SshAccessLocalState {
  /** This computer can accept SSH from the owner's devices (macOS or Linux, not a managed cloud instance). */
  supported: boolean;
  /** 「允许同账号设备控制本机」; SSH access is off while it is off. */
  remoteControlEnabled: boolean;
  /** The SSH access switch as shown: the person's choice, else the default. */
  setting: boolean;
  /** On for Cindy cloud guests, off elsewhere. */
  defaultSetting: boolean;
  /** The person changed the switch; "restore default" clears it. */
  customized: boolean;
  cloudGuest: boolean;
  /** Setting on, remote control on, supported and signed in. */
  enabled: boolean;
  blocked: SshAccessBlock | null;
  endpoint: SshAccessEndpoint | null;
  devices: SshAccessDeviceRow[];
  manualKeys: SshAccessManualKeyRow[];
  /** The per-owner record could not be read; nothing is changed until it is fixed. */
  recordUnreadable: boolean;
  /** The last time keys left the file and their sessions were ended. */
  lastSessionCleanup: SshAccessSessionCleanup | null;
}

/** One settings IPC request (not the device-link wire request, which is `SshAccessRequest` in `@cindy/device-link`). */
export type SshAccessLocalRequest =
  | { operation: 'read' }
  /** `enabled: null` restores the default (deletes the stored choice). */
  | { operation: 'set-enabled'; enabled: boolean | null }
  | { operation: 'add-key'; publicKey: string; label?: string }
  | { operation: 'remove-key'; fingerprint: string }
  /** Revokes that device's remote access (the existing revoke path), which also drops its SSH key. */
  | { operation: 'remove-device'; deviceId: string }
  | { operation: 'end-sessions' };

export interface SshAccessRemoveDeviceResult {
  state: SshAccessLocalState;
  /** The device's remote access was revoked (false when it already was). */
  revoked: boolean;
  /** Its SSH sessions that were ended, or null when it had no key in the file. */
  sessions: SshAccessSessionCleanup | null;
}

export interface SshAccessEndSessionsResult {
  state: SshAccessLocalState;
  sessions: SshAccessSessionCleanup;
}

export interface SshAccessApi {
  read(): Promise<SshAccessLocalState>;
  setEnabled(enabled: boolean): Promise<SshAccessLocalState>;
  restoreDefault(): Promise<SshAccessLocalState>;
  addKey(publicKey: string, label?: string): Promise<{ state: SshAccessLocalState; fingerprint: string }>;
  removeKey(fingerprint: string): Promise<SshAccessLocalState>;
  removeDevice(deviceId: string): Promise<SshAccessRemoveDeviceResult>;
  endAllSessions(): Promise<SshAccessEndSessionsResult>;
  onChanged(callback: () => void): () => void;
}
