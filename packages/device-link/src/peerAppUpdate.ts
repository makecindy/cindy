/**
 * Remote peer app-update check & trigger (owner-approved 2026-11-26):
 * a computer on the same account asks another Cindy Desktop whether a newer
 * release is available on that device's own channel/platform, and—after the
 * user confirms in a secondary confirmation dialog—asks it to run its built-in
 * updater (`updateService.ts` check -> download -> relaunch).
 *
 * - `status` is read-only. Older Desktops do not list the channel ->
 *   CHANNEL_NOT_ALLOWED, so the requester simply hides the update icon instead
 *   of guessing from version numbers across potentially different channels.
 * - `install` validates `expectedVersion`, replies immediately before
 *   relaunching (so macOS exit does not swallow the RPC reply), and runs the
 *   target's existing built-in updater state machine.
 * - Raw `update-*` IPC channels remain permanently forbidden in allowlist.ts.
 * - Same-account Desktop only: shared-task guests and provider-share guests are
 *   refused by the target's dispatch. No new relay frame or capability bit is
 *   needed; official and self-hosted relays forward it as a normal invoke.
 */
export const PEER_APP_UPDATE_CHANNEL = 'device-link:peer-app-update:v1';
export const PEER_APP_UPDATE_VERSION = 1;
/** Reading manifest or validating/acknowledging an install request. */
export const PEER_APP_UPDATE_TIMEOUT_MS = 20_000;

export type PeerAppUpdateRequest =
  | { action: 'status' }
  | { action: 'install'; expectedVersion: string };

export type PeerAppUpdateState =
  | 'available'
  | 'downloading'
  | 'ready'
  | 'relaunching'
  | 'up-to-date'
  | 'unsupported'
  | 'failed';

export interface PeerAppUpdateStatus {
  version: number;
  state: PeerAppUpdateState;
  currentVersion: string;
  targetVersion?: string;
  /** True when restarting would interrupt running tasks or background work. */
  busy?: boolean;
  /** Target OS platform (`darwin` / `win32` / `linux`) for confirmation hints. */
  platform?: string;
  /** Present when state === 'failed' or a recent remote install failed. */
  errorCode?: string;
  /** Failure code from a recent background remote install attempt on this version. */
  lastErrorCode?: string;
}

export interface PeerAppUpdateInstallAccepted {
  version: number;
  accepted: true;
  state: 'downloading' | 'relaunching';
  targetVersion: string;
}

/** Error codes carried in `[CODE]` of an IPC_ERROR message. */
export type PeerAppUpdateErrorCode =
  | 'PEER_APP_UPDATE_INVALID'
  | 'PEER_APP_UPDATE_UNSUPPORTED'
  | 'PEER_APP_UPDATE_NO_UPDATE'
  | 'PEER_APP_UPDATE_VERSION_CHANGED'
  | 'PEER_APP_UPDATE_BUSY'
  | 'PEER_APP_UPDATE_UNAVAILABLE';

const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const STATES: ReadonlySet<string> = new Set<PeerAppUpdateState>([
  'available',
  'downloading',
  'ready',
  'relaunching',
  'up-to-date',
  'unsupported',
  'failed',
]);

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const cleanVersion = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 64 || !VERSION_PATTERN.test(trimmed)) return null;
  return trimmed;
};

export function parsePeerAppUpdateRequest(value: unknown): PeerAppUpdateRequest | null {
  const root = record(value);
  if (!root) return null;
  if (root.action === 'status') return { action: 'status' };
  if (root.action === 'install') {
    const expectedVersion = cleanVersion(root.expectedVersion);
    if (!expectedVersion) return null;
    return { action: 'install', expectedVersion };
  }
  return null;
}

export function parsePeerAppUpdateStatus(value: unknown): PeerAppUpdateStatus | null {
  const root = record(value);
  if (!root || typeof root.state !== 'string' || !STATES.has(root.state)) return null;
  if (typeof root.currentVersion !== 'string' || !root.currentVersion.trim()) return null;
  const targetVersion = cleanVersion(root.targetVersion) ?? undefined;
  return {
    version: typeof root.version === 'number' ? root.version : PEER_APP_UPDATE_VERSION,
    state: root.state as PeerAppUpdateState,
    currentVersion: root.currentVersion.trim(),
    ...(targetVersion ? { targetVersion } : {}),
    ...(typeof root.busy === 'boolean' ? { busy: root.busy } : {}),
    ...(typeof root.platform === 'string' && root.platform.trim() ? { platform: root.platform.trim() } : {}),
    ...(typeof root.errorCode === 'string' && root.errorCode.trim() ? { errorCode: root.errorCode.trim() } : {}),
    ...(typeof root.lastErrorCode === 'string' && root.lastErrorCode.trim() ? { lastErrorCode: root.lastErrorCode.trim() } : {}),
  };
}

export function parsePeerAppUpdateInstallAccepted(value: unknown): PeerAppUpdateInstallAccepted | null {
  const root = record(value);
  if (!root || root.accepted !== true) return null;
  if (root.state !== 'downloading' && root.state !== 'relaunching') return null;
  const targetVersion = cleanVersion(root.targetVersion);
  if (!targetVersion) return null;
  return {
    version: typeof root.version === 'number' ? root.version : PEER_APP_UPDATE_VERSION,
    accepted: true,
    state: root.state,
    targetVersion,
  };
}

/** Reads `[PEER_APP_UPDATE_*]` out of an IPC error message; null for anything else. */
export function peerAppUpdateErrorCode(message: unknown): PeerAppUpdateErrorCode | null {
  const match = typeof message === 'string' ? /\[(PEER_APP_UPDATE_[A-Z_]+)\]/.exec(message) : null;
  return (match?.[1] as PeerAppUpdateErrorCode | undefined) ?? null;
}
