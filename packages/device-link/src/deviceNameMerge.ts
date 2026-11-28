import type { DeviceView } from './protocol.js';

/** Agent-Net relay enforces a 64-character cap on custom device names. */
export const AGENT_NET_DEVICE_NAME_MAX_LENGTH = 64;

function trimmedName(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isPlaceholderName(value: string): boolean {
  const lower = value.toLowerCase();
  return lower === 'unknown' || lower === 'no';
}

/**
 * Normalizes a legacy display name for backfilling into Agent-Net (`PATCH /devices/:id`).
 * Returns null if the name is empty or a placeholder.
 */
export function normalizeAgentNetBackfillName(name: string): string | null {
  const value = trimmedName(name);
  if (!value || isPlaceholderName(value)) return null;
  const clamped = value.slice(0, AGENT_NET_DEVICE_NAME_MAX_LENGTH).trim();
  return clamped && !isPlaceholderName(clamped) ? clamped : null;
}

/**
 * When V2 (Agent-Net) has no explicit custom alias (its display name is empty
 * or still matches its self-reported hostname), preserve an explicit custom
 * name already saved on the legacy (V1) Device Link row.
 *
 * Returns the custom display name to keep, or null when V2's name should stand.
 */
export function preservedLegacyCustomName(
  legacy: Pick<DeviceView, 'name' | 'selfName'> | undefined,
  encrypted: Pick<DeviceView, 'name' | 'selfName'>,
): string | null {
  if (!legacy) return null;
  const legacyName = trimmedName(legacy.name);
  if (!legacyName || isPlaceholderName(legacyName)) return null;

  const encryptedName = trimmedName(encrypted.name);
  const encryptedSelf = trimmedName(encrypted.selfName);

  // V2 already carries an explicit custom alias (distinct from its self-reported
  // hostname): V2 is authoritative, so never overwrite a V2 rename with V1.
  if (encryptedName && encryptedSelf && encryptedName !== encryptedSelf) {
    return null;
  }

  const legacySelf = trimmedName(legacy.selfName);
  if (legacySelf) {
    if (legacyName === legacySelf) return null;
    // Older V2 relays may omit selfName: only treat V2's name as uncustomized
    // when it is empty, matches V2's own selfName (handled above), or matches
    // the legacy reported hostname.
    if (!encryptedName || encryptedSelf || encryptedName === legacySelf) {
      return legacyName;
    }
    return null;
  }

  // Legacy row explicitly carried `selfName: null` (device was renamed in V1
  // before ever reporting a hostname there): preserve it when V2 is still at
  // its default hostname and differs from that custom name.
  if (
    Object.prototype.hasOwnProperty.call(legacy, 'selfName') &&
    legacy.selfName === null &&
    encryptedSelf &&
    (!encryptedName || encryptedName === encryptedSelf) &&
    legacyName !== encryptedSelf
  ) {
    return legacyName;
  }

  return null;
}

export interface MergedAgentNetDeviceRow {
  device: DeviceView;
  /** Non-null when V1 had an explicit custom name that V2 has not yet recorded. */
  backfilledCustomName: string | null;
}

/**
 * Merges an Agent-Net (V2) directory row onto an optional legacy (V1) Device
 * Link row, preserving V1 liveness when V2 is offline and V1 custom aliases
 * when V2 has not been customized yet.
 */
export function mergeAgentNetDeviceRow(
  legacy: DeviceView | undefined,
  encrypted: DeviceView,
): MergedAgentNetDeviceRow {
  const preserved = preservedLegacyCustomName(legacy, encrypted);
  if (!encrypted.online && legacy?.online) {
    // A paired device can turn V2 off and remain online through V1. Keep V1
    // liveness while retaining durable V2 App identity.
    const device = encrypted.app !== undefined ? { ...legacy, app: encrypted.app } : legacy;
    return { device, backfilledCustomName: preserved };
  }
  const mergedSelfName = encrypted.selfName ?? legacy?.selfName ?? null;
  const device: DeviceView = {
    ...legacy,
    ...encrypted,
    ...(preserved ? { name: preserved } : {}),
    ...(mergedSelfName !== null || encrypted.selfName !== undefined || legacy?.selfName !== undefined
      ? { selfName: mergedSelfName }
      : {}),
    deviceInfo: legacy?.deviceInfo ?? encrypted.deviceInfo,
  };
  return { device, backfilledCustomName: preserved };
}
