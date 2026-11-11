import { sharingOriginValid, sharingOriginsPayload, sharingOriginsPolicyValid, type SharingOrigin, type SharingOrigins, type DeviceCertificate } from '@cindy/agent-net-protocol';
import type { AgentNetSigner } from './portableClient.js';
interface OriginClient {
  certificate: DeviceCertificate; rootPublicKey: string;
  request<T>(method: string, resource: string, input?: unknown, options?: { signal?: AbortSignal }): Promise<T>;
}
export async function syncAgentNetSharingOrigins(options: {
  client: OriginClient; signer: AgentNetSigner; origins: SharingOrigin[]; assertCurrent(): void;
  verifyCertificate(root: string, value: unknown, now?: number): value is DeviceCertificate;
  verifySignature(publicKey: string, payload: string, signature: string): boolean;
}): Promise<SharingOrigin[]> {
  const { client, signer, assertCurrent } = options, certificate = client.certificate;
  assertCurrent();
  if (certificate.deviceId !== signer.identity.deviceId || certificate.signingKey !== signer.identity.signingKey) throw new Error('AGENT_NET_ORIGIN_IDENTITY_MISMATCH');
  const published = options.origins.filter(sharingOriginValid);
  if (published.length > 128) throw new Error('AGENT_NET_ORIGIN_LIMIT');
  const plain = { v: 2 as const, networkId: certificate.networkId, certificate, issuedAt: Date.now(), origins: published };
  const signature = await signer.sign(sharingOriginsPayload(plain)); assertCurrent();
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 5000);
  try {
    await client.request('POST', '/sharing-origins', { ...plain, signature }, { signal: controller.signal }); assertCurrent();
    const result = await client.request<{ origins: SharingOrigins[] }>('GET', '/sharing-origins', undefined, { signal: controller.signal }); assertCurrent();
    if (!Array.isArray(result.origins) || result.origins.length > 256) throw new Error('INVALID_AGENT_NET_ORIGINS');
    const origins = new Map<string, SharingOrigin>();
    for (const doc of result.origins) {
      if (!sharingOriginsPolicyValid(doc) || doc.networkId !== certificate.networkId || doc.certificate.subject !== certificate.subject
        || !options.verifyCertificate(client.rootPublicKey, doc.certificate, doc.issuedAt)
        || !options.verifySignature(doc.certificate.signingKey, sharingOriginsPayload(doc), doc.signature)) continue;
      for (const origin of doc.origins) origins.set(JSON.stringify(origin), origin);
    }
    return [...origins.values()];
  } finally { clearTimeout(timer); controller.abort(); }
}
