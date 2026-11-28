/**
 * Local (this computer) view of "allow my other devices to SSH into this computer" for the settings UI, and the
 * preload API that reads and changes it. Wire types between computers live in `@cindy/device-link` (sshAccess.ts).
 */
import type { SshAccessBlock, SshAccessEndpoint } from '@cindy/device-link';

export const SSH_ACCESS_IPC_CHANNEL = 'ssh-access:request';
/** Public keys the person can add by hand on one computer (device keys are counted apart). */
export const SSH_ACCESS_MAX_MANUAL_KEYS = 32;
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
  /**
   * False where this computer cannot end them: one device's sessions wherever `endsDeviceSessions` is false, every
   * session when Cindy runs as root or off macOS and Linux.
   */
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
  /**
   * Revoking a device here also ends its open SSH sessions (Linux, Cindy not running as root). Elsewhere they keep
   * running until 「断开全部 SSH 会话」; the same capability decides the result reported after a revocation.
   */
  endsDeviceSessions: boolean;
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

// ─── This computer as CONTROLLER: hosts for the person's other devices (ssh-access/sshAccessController.ts) ───

export const SSH_DEVICE_HOSTS_IPC_CHANNEL = 'ssh-device-hosts:request';
/** Main → renderer: the device hosts changed; read them again. */
export const SSH_DEVICE_HOSTS_CHANGED_CHANNEL = 'ssh-device-hosts:changed';

/**
 * - `ready`: listed in SSH 远程主机 and usable; `alias` works in a terminal.
 * - `pending`: being set up, or waiting for the device (offline, or still writing this computer's key).
 * - `unavailable`: the host stays listed but cannot be used now (see `reason`).
 * - `user-deleted`: the person deleted the host; 「添加到 SSH 远程主机」 brings it back.
 * - `needs-update`: that device's Cindy is too old for SSH access.
 * - `control-off`: this computer's own 「控制它」 for that device is off, so nothing is set up.
 * - `error`: the device refused this computer's key or answered something unusable.
 */
export type SshDeviceHostState = 'ready' | 'pending' | 'unavailable' | 'user-deleted' | 'needs-update' | 'control-off' | 'error';
/** Why a listed device host is unavailable: access off there, blocked there, this computer revoked, device removed. */
export type SshDeviceHostUnavailableReason = 'off' | 'blocked' | 'revoked' | 'removed';

export interface SshDeviceHostView {
  deviceId: string;
  /** `ssh <alias>` in a terminal (also the host id in SSH 远程主机); null before the host was first added. */
  alias: string | null;
  /** The host id in SSH 远程主机 while the host is listed there, else null. */
  hostId: string | null;
  state: SshDeviceHostState;
  reason: SshDeviceHostUnavailableReason | null;
  /** For `reason: 'blocked'`: what the device reported. */
  blocked: SshAccessBlock | 'UNKNOWN' | null;
}

export type SshDeviceHostsRequest = { operation: 'read' } | { operation: 'restore'; deviceId: string };

export interface SshDeviceHostsApi {
  read(): Promise<SshDeviceHostView[]>;
  /** 「添加到 SSH 远程主机」 for a device whose host the person deleted. */
  restore(deviceId: string): Promise<SshDeviceHostView[]>;
  onChanged(callback: () => void): () => void;
}

/**
 * The ASCII slug in a device's terminal alias `cindy-<slug>` (decision 6): lower-case letters and digits joined by
 * single hyphens; accents are dropped and other scripts removed, so it may be empty (the controller then uses a
 * device id prefix). Shared so this computer's settings can show the alias its other devices will usually use.
 */
export function deviceAliasSlug(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
}

/** Added to an SSH host snapshot when the host belongs to one of the person's own devices. */
export interface SshHostDeviceLabel {
  deviceId: string;
  /** False while the device has SSH access off, blocked, revoked this computer or left the account. */
  available: boolean;
}
