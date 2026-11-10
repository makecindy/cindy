import AsyncStorage from '@react-native-async-storage/async-storage';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { CERT_LIFETIME_MS, type DeviceView } from '@cindy/agent-net-protocol';
import { fromBase64Url, toBase64Url, utf8 } from '@cindy/agent-net/portable';
import { getMobileAuthOwner } from '@/auth/authOwnerGeneration';
import type { PreparedMobileAgentNetIdentity } from './agentNetIdentity';
import { verifyMobileAgentNetCertificate } from './agentNetProtocol';

interface DirectoryRecord { version: 2; receivedAt: number; devices: DeviceView[]; mac: string; }
const writes = new Map<string, Promise<void>>();
function key(identity: PreparedMobileAgentNetIdentity): string {
  return 'cindy.agent-net.directory.v2.' + bytesToHex(sha256(utf8(JSON.stringify([
    getMobileAuthOwner().accountKey, identity.api.base, identity.api.rootPublicKey,
    identity.api.certificate.networkId, identity.api.identity.deviceId,
  ]))));
}
function mac(identity: PreparedMobileAgentNetIdentity, value: Omit<DirectoryRecord, 'mac'>): Uint8Array {
  return hmac(sha256, fromBase64Url(identity.seed), utf8(JSON.stringify([
    'cindy-agent-net/mobile-directory-cache/2', identity.api.rootPublicKey,
    identity.api.certificate.networkId, identity.api.certificate.subject, identity.api.identity.deviceId,
    value.version, value.receivedAt, value.devices,
  ])));
}
function trusted(identity: PreparedMobileAgentNetIdentity, devices: unknown): devices is DeviceView[] {
  return Array.isArray(devices) && devices.length <= 512 && devices.every(view => {
    const c = view?.certificate;
    return c && verifyMobileAgentNetCertificate(identity.api.rootPublicKey, c, c.issuedAt)
      && c.issuedAt <= Date.now() + 30_000 && c.networkId === identity.api.certificate.networkId
      && c.subject === identity.api.certificate.subject;
  });
}
export async function readMobileAgentNetDirectory(identity: PreparedMobileAgentNetIdentity): Promise<{
  devices: DeviceView[]; expiresAt: number;
} | null> {
  identity.signer.assertCurrent();
  const raw = await AsyncStorage.getItem(key(identity));
  identity.signer.assertCurrent();
  if (!raw || utf8(raw).length > 512 * 1024) return null;
  try {
    const value = JSON.parse(raw) as DirectoryRecord;
    if (value.version !== 2 || !Number.isSafeInteger(value.receivedAt) || value.receivedAt < 0
      || value.receivedAt > Date.now() + 30_000 || value.receivedAt + CERT_LIFETIME_MS <= Date.now()
      || !trusted(identity, value.devices)) return null;
    const expected = mac(identity, value), supplied = fromBase64Url(value.mac);
    if (expected.length !== supplied.length) return null;
    let difference = 0;
    for (let index = 0; index < expected.length; index++) difference |= expected[index] ^ supplied[index];
    return difference === 0 ? { devices: value.devices, expiresAt: value.receivedAt + CERT_LIFETIME_MS } : null;
  } catch { return null; }
}
export function writeMobileAgentNetDirectory(identity: PreparedMobileAgentNetIdentity, devices: DeviceView[]): Promise<void> {
  identity.signer.assertCurrent();
  if (!trusted(identity, devices)) return Promise.reject(new Error('UNTRUSTED_DIRECTORY'));
  const plain = { version: 2 as const, receivedAt: Date.now(), devices };
  const raw = JSON.stringify({ ...plain, mac: toBase64Url(mac(identity, plain)) });
  if (utf8(raw).length > 512 * 1024) return Promise.reject(new Error('DIRECTORY_CACHE_TOO_LARGE'));
  const slot = key(identity);
  const work = (writes.get(slot) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    identity.signer.assertCurrent();
    await AsyncStorage.setItem(slot, raw);
    identity.signer.assertCurrent();
  });
  writes.set(slot, work);
  return work.finally(() => { if (writes.get(slot) === work) writes.delete(slot); });
}
