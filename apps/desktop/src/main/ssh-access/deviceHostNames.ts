/**
 * Names the SSH access CONTROLLER gives a host for one of the person's own devices (decisions 6 and 8, 2026-11-26).
 * A leaf module: the controller, the SSH host list (remote-ssh/index.ts) and new-computer setup read the same rules.
 *
 * - Terminal alias and SSH host id: `cindy-<ascii slug of the device name>`. When the slug is empty (a name with no
 *   ASCII letters or digits) or already taken by another host, `cindy-<device id prefix>` (longer prefixes, then a
 *   number, while still taken). Follows the device's name (decision 2026-11-28): after a rename the controller moves
 *   the host to the alias these rules give the new name, and the old alias stops working.
 * - HostKeyAlias: `cindy-device-<device id>` (a hash of it when the id has other characters). The device's host keys
 *   are pinned under this name in ~/.ssh/cindy_known_hosts and in Cindy's host-key store, so an address change
 *   keeps the pin and no other host's address-based entry is ever touched.
 */
import { createHash } from 'node:crypto';
import { deviceAliasSlug } from '../../shared/sshAccess.js';

export { deviceAliasSlug };
export const DEVICE_HOST_ALIAS_PREFIX = 'cindy-';
export const DEVICE_HOST_KEY_ALIAS_PREFIX = 'cindy-device-';
/** Written as the OpenSSH `UserKnownHostsFile` of every device alias (knownHostsFile.ts maintains the file). */
export const DEVICE_KNOWN_HOSTS_SETTING = '~/.ssh/cindy_known_hosts';
const SAFE_DEVICE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const HOST_KEY_ALIAS = /^cindy-device-[A-Za-z0-9_-]{1,64}$/;

function deviceIdToken(deviceId: string): string {
  const token = deviceId.toLowerCase().replace(/[^a-z0-9]/g, '');
  return token.length >= 8 ? token : createHash('sha256').update(deviceId).digest('hex');
}

/** A free alias for a device: the name's slug when free, else a device-id prefix (`taken` holds every known host). */
export function chooseDeviceAlias(name: string | null | undefined, deviceId: string, taken: ReadonlySet<string>): string {
  const slug = deviceAliasSlug(name ?? '');
  if (slug && !taken.has(`${DEVICE_HOST_ALIAS_PREFIX}${slug}`)) return `${DEVICE_HOST_ALIAS_PREFIX}${slug}`;
  const token = deviceIdToken(deviceId);
  for (let length = 8; length < token.length + 4; length += 4) {
    const candidate = `${DEVICE_HOST_ALIAS_PREFIX}${token.slice(0, length)}`;
    if (!taken.has(candidate)) return candidate;
  }
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${DEVICE_HOST_ALIAS_PREFIX}${token.slice(0, 8)}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function deviceHostKeyAlias(deviceId: string): string {
  const id = SAFE_DEVICE_ID.test(deviceId) ? deviceId : createHash('sha256').update(deviceId).digest('hex').slice(0, 32);
  return `${DEVICE_HOST_KEY_ALIAS_PREFIX}${id}`;
}

/** The host key name of a host Cindy keeps for one of the person's own devices (any owner, any profile). */
export function isDeviceHostKeyAlias(value: unknown): value is string {
  return typeof value === 'string' && HOST_KEY_ALIAS.test(value);
}
