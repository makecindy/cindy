import { randomUUID } from 'node:crypto';
import { delegationPayload, MAX_GRANT_LIFETIME_MS, type Delegation, type DeviceCertificate } from '@cindy/agent-net-protocol';
import { signature, verifyCertificate, verifyDelegation } from '@cindy/agent-net-relay';
import type { AgentNetClient } from '@cindy/agent-net-relay/client';
import { AgentNetSharingClient } from './sharingClient.js';
export interface SharingExecutorInput { shareId: string; memberId: string; guestDeviceId: string; executorDeviceId: string; }
interface Options { client: AgentNetClient; sharing: AgentNetSharingClient; assertCurrent(): void; }
const writes = new Map<string, Promise<unknown>>();
function ordered<T>(options: Options, input: SharingExecutorInput, work: () => Promise<T>): Promise<T> {
  const key = JSON.stringify([options.client.base, options.client.certificate.networkId, options.client.identity.deviceId, input.shareId, input.memberId, input.guestDeviceId]);
  const result = (writes.get(key) ?? Promise.resolve()).catch(() => undefined).then(() => { options.assertCurrent(); return work(); });
  writes.set(key, result); void result.finally(() => { if (writes.get(key) === result) writes.delete(key); }).catch(() => undefined); return result;
}
async function prepare(options: Options, input: SharingExecutorInput) {
  const { shareId, memberId, guestDeviceId, executorDeviceId } = input;
  const result = await options.sharing.request<{ delegation: Delegation; executorCertificate: DeviceCertificate }>(
    '/api/device-link/provider-shares/delegations/prepare', { method: 'POST', body: { shareId, memberId, guestDeviceId, executorDeviceId } }); options.assertCurrent();
  const { delegation: d, executorCertificate: c } = result, api = options.client;
  if (!verifyDelegation(api.rootPublicKey, d) || !verifyCertificate(api.rootPublicKey, c) || d.kind !== 'provider-share'
    || d.hostDeviceId !== api.identity.deviceId || d.issuerCertificate.signingKey !== api.identity.signingKey
    || d.networkId !== api.certificate.networkId || d.resourceId !== input.shareId || d.guestDeviceId !== input.guestDeviceId
    || d.scope?.memberId !== input.memberId || c.deviceId !== input.executorDeviceId || c.networkId !== d.networkId
    || c.subject !== api.certificate.subject) throw new Error('UNTRUSTED_AGENT_NET_EXECUTOR');
  return result;
}
async function update(options: Options, previous: Delegation, executors: NonNullable<Delegation['executors']>): Promise<void> {
  options.assertCurrent(); const api = options.client;
  const plain = { ...previous, issuedAt: Math.max(Date.now(), previous.issuedAt), executors };
  const delegation = { ...plain, signature: signature(api.identity.signingPrivateKey, delegationPayload(plain)) };
  if (!verifyDelegation(api.rootPublicKey, delegation)) throw new Error('INVALID_AGENT_NET_EXECUTOR_GRANT');
  const result = await api.request<{ delegation: Delegation }>('POST', '/grants', { delegation, previousSignature: previous.signature }); options.assertCurrent();
  if (result.delegation.signature !== delegation.signature) throw new Error('UNCONFIRMED_AGENT_NET_EXECUTOR_GRANT');
}
/** The resource owner signs exact executor keys; the relay cannot add another
 * computer, renew its generation or turn this visitor into a network member. */
export function grantAgentNetSharingExecutor(options: Options, input: SharingExecutorInput): Promise<{ generation: string; expiresAt: number }> {
  return ordered(options, input, async () => {
    for (let attempt = 0; ; attempt++) {
      const { delegation, executorCertificate } = await prepare(options, input), at = Date.now();
      const expiresAt = Math.min(at + MAX_GRANT_LIFETIME_MS, delegation.expiresAt, executorCertificate.expiresAt);
      if (expiresAt - at < 5000) throw new Error('AGENT_NET_EXECUTOR_LEASE_EXPIRING');
      const generation = randomUUID(), executors = (delegation.executors ?? []).filter(e => e.expiresAt > at && e.certificate.deviceId !== input.executorDeviceId);
      if (executors.length >= 32) throw new Error('AGENT_NET_EXECUTOR_LIMIT');
      executors.push({ certificate: executorCertificate, generation, expiresAt });
      try { await update(options, delegation, executors); return { generation, expiresAt }; }
      catch (error) { if ((error as { code?: string }).code !== 'GRANT_CHANGED' || attempt >= 2) throw error; }
    }
  });
}
export function revokeAgentNetSharingExecutor(options: Options, input: SharingExecutorInput & { generation: string }): Promise<void> {
  return ordered(options, input, async () => {
    for (let attempt = 0; ; attempt++) {
      let prepared; try { prepared = await prepare(options, input); }
      catch (error) { if ((error as { status?: number }).status === 404) return; throw error; }
      const { delegation } = prepared;
      if (!delegation.executors?.some(e => e.certificate.deviceId === input.executorDeviceId && e.generation === input.generation)) return;
      const executors = delegation.executors.filter(e => e.expiresAt > Date.now() && !(e.certificate.deviceId === input.executorDeviceId && e.generation === input.generation));
      try { await update(options, delegation, executors); return; }
      catch (error) { if ((error as { code?: string }).code !== 'GRANT_CHANGED' || attempt >= 2) throw error; }
    }
  });
}
export async function checkAgentNetSharingExecutor(options: Options, input: SharingExecutorInput, signal?: AbortSignal) {
  const result = await options.sharing.request<{ active: boolean; delegation?: Delegation; ownerDeviceId?: string;
    executorCertificate?: DeviceCertificate; generation?: string; expiresAt?: number }>(
    '/api/device-link/provider-shares/delegations/check', { method: 'POST', body: input, signal }); options.assertCurrent();
  if (result.active !== true) return { active: false as const };
  const d = result.delegation, api = options.client;
  if (!verifyDelegation(api.rootPublicKey, d) || d.networkId !== api.certificate.networkId || d.kind !== 'provider-share'
    || d.resourceId !== input.shareId || d.scope?.memberId !== input.memberId || d.guestDeviceId !== input.guestDeviceId
    || result.ownerDeviceId !== d.hostDeviceId) throw new Error('UNTRUSTED_AGENT_NET_EXECUTOR');
  const executor = d.executors?.find(e => e.certificate.deviceId === input.executorDeviceId && e.generation === result.generation);
  if (!executor || executor.expiresAt <= Date.now() || executor.expiresAt !== result.expiresAt || executor.certificate.subject !== api.certificate.subject
    || result.executorCertificate?.signature !== executor.certificate.signature
    || api.identity.deviceId !== d.hostDeviceId && (api.identity.deviceId !== input.executorDeviceId
      || api.identity.signingKey !== executor.certificate.signingKey || api.identity.transportKey !== executor.certificate.transportKey))
    throw new Error('UNTRUSTED_AGENT_NET_EXECUTOR');
  return { active: true as const, ownerDeviceId: d.hostDeviceId, generation: executor.generation, expiresAt: executor.expiresAt };
}
