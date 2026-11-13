/** A standalone Host is a separate device, even beside a desktop on this machine.
 * Bind that identity to the encrypted session record so refresh never silently
 * changes the device used by an existing login. Legacy desktop records remain
 * readable locally, but cannot register a second relay connection as that desktop.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseAuthSessionRecord, serializeAuthSessionRecord } from '@cindy/auth-client';

const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
export function readSessionDeviceId(raw) {
  if (!parseAuthSessionRecord(raw)) return null;
  const value = JSON.parse(raw).hostDeviceId;
  if (value === undefined) return null;
  if (!validId(value)) throw new Error('Invalid Host session device identity; sign in again.');
  return value;
}
export function serializeHostSession(realm, refreshToken, deviceId) {
  if (!validId(deviceId)) throw new Error('Invalid Host device identity');
  return JSON.stringify({ ...JSON.parse(serializeAuthSessionRecord(realm, refreshToken)), hostDeviceId: deviceId });
}
export function resolveSessionDevice(raw, physicalDeviceId, override = process.env.XDT_DEVICE_ID_OVERRIDE) {
  const bound = readSessionDeviceId(raw);
  const explicit = override?.trim();
  if (explicit && !validId(explicit)) throw new Error('Invalid XDT_DEVICE_ID_OVERRIDE');
  if (bound && explicit && bound !== explicit) throw new Error('Host device identity changed; use the original profile or sign in again.');
  return bound ?? (explicit || physicalDeviceId());
}
export function canRegisterHostDevice(raw, physicalDeviceId, override = process.env.XDT_DEVICE_ID_OVERRIDE) {
  const id = resolveSessionDevice(raw, physicalDeviceId, override);
  // An explicit isolated preview is also safe; an adopted physical-desktop
  // identity is never registered by a second process.
  return Boolean(readSessionDeviceId(raw) || override?.trim()) && id !== physicalDeviceId();
}
export function getOrCreateHostDeviceId(profile, override = process.env.XDT_DEVICE_ID_OVERRIDE) {
  const explicit = override?.trim();
  if (explicit) {
    if (!validId(explicit)) throw new Error('Invalid XDT_DEVICE_ID_OVERRIDE');
    return explicit;
  }
  const file = path.join(profile, 'host-device.json');
  const read = () => {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value.version !== 1 || !validId(value.deviceId)) throw new Error('Invalid Host device identity file');
    return value.deviceId;
  };
  try { return read(); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
  const deviceId = randomUUID();
  try { fs.writeFileSync(file, JSON.stringify({ version: 1, deviceId }), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code === 'EEXIST') return read(); throw error; }
  return deviceId;
}
