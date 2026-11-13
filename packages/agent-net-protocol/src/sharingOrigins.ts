import type { DeviceCertificate } from './index.js';
/** Linear-time URL suffix normalization, including long caller-supplied paths. */
export function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end--;
  return value.slice(0, end);
}
export interface SharingOrigin { server: string; networkId: string; rootPublicKey: string; region: 'cn' | 'global'; }
export function agentNetSharingSubject(accountId: string, accountRegion: 'cn' | 'global', networkRegion: 'cn' | 'global'): string {
  return accountRegion === networkRegion ? accountId : 'x:' + accountRegion + ':' + accountId;
}
/** Public origins only. Resource IDs, invitations and device seeds stay local. */
export interface SharingOrigins { v: 2; networkId: string; certificate: DeviceCertificate; issuedAt: number; origins: SharingOrigin[]; signature: string; }
export function sharingOriginValid(value: unknown): value is SharingOrigin {
  if (!value || typeof value !== 'object') return false;
  const r = value as SharingOrigin;
  try {
    const url = new URL(r.server);
    return Object.keys(r).every(k => ['server', 'networkId', 'rootPublicKey', 'region'].includes(k))
      && r.server.length <= 2048 && r.server === stripTrailingSlashes(r.server) && !url.username && !url.password && !url.hash && !url.search
      && (url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      && typeof r.networkId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(r.networkId)
      && typeof r.rootPublicKey === 'string' && /^[A-Za-z0-9_-]{43}$/.test(r.rootPublicKey)
      && /[AEIMQUYcgkosw048]$/.test(r.rootPublicKey)
      && (r.region === 'cn' || r.region === 'global');
  } catch { return false; }
}
export function sharingOriginsPayload(value: Omit<SharingOrigins, 'signature'>): string {
  return JSON.stringify(['cindy-agent-net/sharing-origins/2', value.networkId, value.certificate.signature, value.issuedAt,
    value.origins.map(o => [o.server, o.networkId, o.rootPublicKey, o.region])]);
}
export function sharingOriginsPolicyValid(value: unknown, now = Date.now()): value is SharingOrigins {
  if (!value || typeof value !== 'object') return false;
  const doc = value as SharingOrigins;
  return doc.v === 2 && typeof doc.networkId === 'string' && !!doc.certificate && doc.certificate.networkId === doc.networkId
    && Number.isSafeInteger(doc.issuedAt) && doc.issuedAt <= now + 30_000 && now - doc.issuedAt <= 30 * 24 * 60 * 60_000
    && Array.isArray(doc.origins) && doc.origins.length <= 128 && doc.origins.every(sharingOriginValid)
    && new Set(doc.origins.map(o => JSON.stringify(o))).size === doc.origins.length
    && typeof doc.signature === 'string' && /^[A-Za-z0-9_-]{86}$/.test(doc.signature);
}
