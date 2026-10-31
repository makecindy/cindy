import {
  parseSyncedProjectOrderOwnerStamp,
  type SyncedProjectOrderOwnerStamp,
} from './projectOrderSync.js';

/**
 * Host-owned project pins.
 *
 * A project's pinned state belongs to the desktop that owns its working directory,
 * like task pins and the host's manual project order. Controllers read the host's
 * pinned `local:` projects, write pin changes back to the host and follow its change
 * push; they never copy another computer's pin state into their own durable list.
 */
export const PROJECT_PINS_GET_CHANNEL = 'sidebar-settings:get-project-pins';
export const PROJECT_PINS_APPLY_CHANNEL = 'sidebar-settings:apply-project-pins';
export const PROJECT_PINS_CHANGED_CHANNEL = 'sidebar-settings:project-pins-changed';

/** Bounds one controller handoff of its legacy pins for a single host. */
export const PROJECT_PINS_APPLY_MAX_KEYS = 64;
const MAX_PROJECT_PIN_KEYS = 10_000;
const MAX_PROJECT_KEY_LENGTH = 4_096;
const LOCAL_PREFIX = 'local:';

export interface HostProjectPinsSnapshot {
  /** false = the host has no project pin channel (older desktop). */
  available: boolean;
  /** Host-local project keys (`local:<path>`) in the host's pinned order. */
  projectKeys: readonly string[];
  /** The host's active data owner. APPLY must echo it; absent means writes are not ready. */
  ownerStamp?: SyncedProjectOrderOwnerStamp;
}

export interface ProjectPinsApplyRequest extends SyncedProjectOrderOwnerStamp {
  projectKeys: readonly string[];
  pinned: boolean;
}

export const UNAVAILABLE_PROJECT_PINS: HostProjectPinsSnapshot = {
  available: false,
  projectKeys: [],
};

export function isHostLocalProjectPinKey(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.startsWith(LOCAL_PREFIX) &&
    value.trim().length > LOCAL_PREFIX.length &&
    value.length <= MAX_PROJECT_KEY_LENGTH
  );
}

/** Accepts only host `local:` identities; SSH and other-device keys stay on their own computer. */
export function parseHostProjectPinsSnapshot(raw: unknown): HostProjectPinsSnapshot | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (!Array.isArray(value.projectKeys)) return null;
  const ownerStamp = parseSyncedProjectOrderOwnerStamp(value.ownerStamp);
  if (value.ownerStamp !== undefined && !ownerStamp) return null;
  const projectKeys: string[] = [];
  const seen = new Set<string>();
  for (const key of value.projectKeys) {
    if (!isHostLocalProjectPinKey(key) || seen.has(key)) continue;
    seen.add(key);
    projectKeys.push(key);
    if (projectKeys.length >= MAX_PROJECT_PIN_KEYS) break;
  }
  return {
    available: value.available !== false,
    projectKeys,
    ...(ownerStamp ? { ownerStamp } : {}),
  };
}

export function sameHostProjectPinsSnapshot(
  a: HostProjectPinsSnapshot | undefined,
  b: HostProjectPinsSnapshot,
): boolean {
  return (
    !!a &&
    a.available === b.available &&
    a.ownerStamp?.dataOwnerId === b.ownerStamp?.dataOwnerId &&
    a.ownerStamp?.ownerGeneration === b.ownerStamp?.ownerGeneration &&
    a.projectKeys.length === b.projectKeys.length &&
    a.projectKeys.every((key, index) => key === b.projectKeys[index])
  );
}

/** Only an explicit missing channel means an older host; timeouts and offline peers are transient. */
export function isProjectPinsChannelMissing(error: unknown): boolean {
  const record = error && typeof error === 'object' ? (error as Record<string, unknown>) : null;
  const code = typeof record?.code === 'string' ? record.code : undefined;
  const message = typeof error === 'string' ? error : record?.message;
  const resolved =
    code ?? (typeof message === 'string' ? message.match(/\[([A-Z0-9_]+)\]/)?.[1] : undefined);
  return resolved === 'CHANNEL_NOT_ALLOWED' || resolved === 'DEVICE_LINK_CHANNEL_NOT_ALLOWED';
}
