import { BlockList, isIP } from 'node:net';

/** Only the last few X-Forwarded-For hops can have been appended by trusted proxies. */
const MAX_FORWARDED_HOPS = 8;

/** `::ffff:192.0.2.1` and `192.0.2.1` are the same client; key and log it one way. */
export function plainAddress(address: string): string {
  return /^::ffff:\d{1,3}(?:\.\d{1,3}){3}$/i.test(address) ? address.slice(7) : address;
}

/**
 * Proxies whose X-Forwarded-For append is believed: loopback always (a local Nginx or the
 * Desktop ingress), plus the configured addresses or CIDRs of a load balancer that connects
 * to the relay itself. A load balancer re-originates every connection, so without it every
 * client appears as the balancer and shares one rate-limit bucket.
 */
export function trustedProxies(entries: readonly string[] = []): (address: string) => boolean {
  const list = new BlockList();
  list.addSubnet('127.0.0.0', 8, 'ipv4');
  list.addAddress('::1', 'ipv6');
  for (const entry of entries) {
    const [address, prefix, extra] = entry.trim().split('/');
    const family = isIP(address ?? '');
    const bits = prefix === undefined ? undefined : /^\d{1,3}$/.test(prefix) ? Number(prefix) : NaN;
    if (!family || extra !== undefined || Number.isNaN(bits) || bits !== undefined && bits > (family === 4 ? 32 : 128))
      throw new Error('INVALID_TRUSTED_PROXY');
    const type = family === 4 ? 'ipv4' : 'ipv6';
    if (bits === undefined) list.addAddress(address, type); else list.addSubnet(address, bits, type);
  }
  return address => {
    const family = isIP(address);
    return family !== 0 && list.check(address, family === 4 ? 'ipv4' : 'ipv6');
  };
}

/**
 * The client a request is attributed to. Each trusted proxy appends the peer it saw, so walk
 * X-Forwarded-For from the right past trusted hops; entries left of the first untrusted hop
 * were written by the client and are never believed.
 */
export function clientAddressOf(peer: string | undefined, forwarded: string | string[] | undefined,
  trusted: (address: string) => boolean): string {
  const direct = plainAddress(peer ?? 'unknown');
  if (!trusted(direct)) return direct;
  const header = Array.isArray(forwarded) ? forwarded.join(',') : forwarded;
  if (typeof header !== 'string' || !header.trim()) return direct;
  let client = direct;
  for (const hop of header.split(',').slice(-MAX_FORWARDED_HOPS).reverse()) {
    const address = plainAddress(hop.trim());
    if (!isIP(address)) return client;
    client = address;
    if (!trusted(address)) return client;
  }
  return client;
}
