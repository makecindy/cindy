/**
 * Cindy cloud computer facts the SSH access target needs (decision 4, 2026-11-26): whether this machine is a Lighthouse
 * cloud guest delivered by Cindy's cloud computer service (SSH access defaults on there), and its public IPv4 from the
 * Tencent instance metadata service. The managed pod/container instance (`--cloud-instance`, instance-runtime/config.ts)
 * is NOT a cloud guest; callers exclude it before asking. Shared by the desktop and the Node Host.
 */
import { readCloudGuest } from '@cindy/auth-client/linux-cloud';
import { isSshAccessHost } from '@cindy/device-link';

/** Verified on Lighthouse (2026-11-26). Instance-local, so it is fetched directly and never through a proxy. */
export const TENCENT_PUBLIC_IPV4_URL = 'http://metadata.tencentyun.com/latest/meta-data/public-ipv4';
const METADATA_TIMEOUT_MS = 2_000;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * Linux with Cindy's root-owned cloud enrollment file. A file with wrong ownership or mode is not trusted and reads as
 * "not a cloud guest" (linuxCloud.mjs refuses it the same way for sign-in).
 */
export async function detectCloudGuest(platform: NodeJS.Platform | string = process.platform): Promise<boolean> {
  if (platform !== 'linux') return false;
  try {
    return (await readCloudGuest()) !== null;
  } catch {
    return false;
  }
}

/** The instance's public IPv4, or null when the metadata service does not answer quickly with one. */
export async function readCloudPublicIpv4(
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  timeoutMs = METADATA_TIMEOUT_MS,
): Promise<string | null> {
  try {
    const response = await fetchImpl(TENCENT_PUBLIC_IPV4_URL, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    const value = (await response.text()).slice(0, 64).trim();
    return IPV4.test(value) && isSshAccessHost(value) ? value : null;
  } catch {
    return null;
  }
}
