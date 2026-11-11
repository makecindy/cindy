import type { IncomingMessage } from 'node:http';
import { AppError, invalidParams, notFound, permissionDenied } from '@cindy/device-link-sharing/errors';
import { createSharingRepositories, type SharingStorage } from '@cindy/device-link-sharing/repositories';
import { createSharedTaskService } from '@cindy/device-link-sharing/shared-tasks';
import { createProviderShareService, type ProviderShareServiceOptions } from '@cindy/device-link-sharing/provider-shares';
import { createHash, randomUUID } from 'node:crypto';
import { ID_PATTERN, KEY_PATTERN, MAX_GRANT_LIFETIME_MS, type Delegation, type DelegationRequest, type DeviceCertificate } from '@cindy/agent-net-protocol';
import { verifyRequestProof } from './identity.js';

export interface SharingActor { accountId: string; deviceId: string; networkId: string; }
export interface SharingAuthenticationContext {
  rootPublicKey(networkId: string): string;
  remember(account: string, device: string, nonce: string): void;
}
export interface AgentNetSharingOptions {
  /** A separate, audience-bound account identity surface. Full account access
   * tokens never authenticate business, member, media or datagram routes. */
  authenticate(req: IncomingMessage, body: Buffer, context: SharingAuthenticationContext): Promise<SharingActor>;
  providers: Omit<ProviderShareServiceOptions, 'hostStatus' | 'now'>;
}
/**
 * A network another account owns on this relay (self-hosted-relay-plan.md §5.5) may belong to the peer region:
 * its certificate carries the account's own ID, the relay names that account `x:<region>:<ID>`.
 * The member certificate (signed by that network's root, held only by its owner) still has to match.
 */
export function sameAccount(member: { subject: string; tenant?: boolean }, accountId: string): boolean {
  if (member.subject === accountId) return true;
  const peer = /^x:(?:cn|global):(.+)$/.exec(accountId);
  return member.tenant === true && peer?.[1] === member.subject;
}
export interface SharingHost {
  storage: SharingStorage;
  /** `tenant`: the network another account owns on this relay. */
  member(req: IncomingMessage, bytes: Buffer): Promise<{ networkId: string; deviceId: string; subject: string; tenant?: boolean }>;
  hostStatus(deviceId: string, networkId: string): { online: boolean; capabilities: readonly string[] };
  changed(networkIds: readonly string[]): void;
  requests(): DelegationRequest[];
  saveRequest(request: DelegationRequest): Promise<void>;
  grant(request: DelegationRequest): { rootPublicKey: string; certificate: DeviceCertificate; delegation?: Delegation; revoked?: boolean };
  remember(account: string, device: string, nonce: string): void;
  rootPublicKey(networkId: string): string;
  now(): number;
  grants?(networkId: string): Delegation[];
  memberCertificate?(networkId: string, deviceId: string): DeviceCertificate | undefined;
}
const text = (value: unknown): string => {
  if (typeof value !== 'string') throw invalidParams('Expected a string'); return value;
};
/** Authenticated CRUD reuses the V1 domain. A visitor gets membership in one
 * resource; only a certified physical host may create an authority namespace. */
export function createAgentNetSharing(options: AgentNetSharingOptions, host: SharingHost) {
  let cachedRevision: unknown;
  let authority: ReturnType<SharingStorage['read']> | undefined;
  const admissions = new Map<string, boolean>();
  const services = (networkId?: string) => {
    const repo = createSharingRepositories(host.storage, networkId);
    return { tasks: createSharedTaskService(repo.tasks, host.now),
      providers: createProviderShareService(repo.providers, { ...options.providers, now: host.now,
        async hostStatus(_account, deviceId) {
          const bindings = host.storage.read().bindings.filter(b => b.kind === 'provider-share');
          const share = host.storage.read().shares.find(s => s.hostDeviceId === deviceId && s.ownerAccountId === _account);
          const binding = share && bindings.find(b => b.resourceId === share.shareId);
          return binding ? host.hostStatus(deviceId, binding.networkId) : { online: false, capabilities: [] };
        } }) };
  };
  function authorized(d: Delegation): boolean {
    if (!d.scope) return true; // Original datagram-only owner delegation.
    const revision = host.storage.revision?.();
    if (!authority || !host.storage.revision || cachedRevision !== revision) {
      authority = host.storage.read(); cachedRevision = revision; admissions.clear();
    }
    const cached = admissions.get(d.signature);
    if (cached !== undefined) return cached;
    const request = host.requests().find(r => r.id === d.id && r.guestSigningKey === d.guestSigningKey
      && r.guestTransportKey === d.guestTransportKey && r.expiresAt > host.now() && r.kind === d.kind
      && r.resourceId === d.resourceId && r.networkId === d.networkId && r.hostDeviceId === d.hostDeviceId
      && r.guestDeviceId === d.guestDeviceId && r.scope.memberId === d.scope!.memberId
      && r.scope.memberVersion === d.scope!.memberVersion && r.scope.guestSubject === d.scope!.guestSubject);
    const allowed = !!request && d.expiresAt <= request.expiresAt && check(d, authority);
    if (admissions.size >= 4096) admissions.clear();
    admissions.set(d.signature, allowed); return allowed;
  }
  function check(d: Pick<Delegation, 'kind' | 'resourceId' | 'networkId' | 'hostDeviceId' | 'guestDeviceId' | 'scope'>, state: ReturnType<SharingStorage['read']>): boolean {
    const binding = state.bindings.find(b => b.kind === d.kind && b.resourceId === d.resourceId && b.networkId === d.networkId);
    if (!binding) return false;
    if (d.kind === 'shared-task') {
      const task = state.tasks.find(t => t.sharedTaskId === d.resourceId && t.hostDeviceId === d.hostDeviceId && t.status === 'active');
      return !!task?.guests.some(g => g.status === 'joined' && g.memberId === d.scope!.memberId
        && g.accountId === d.scope!.guestSubject && g.version === d.scope!.memberVersion && g.deviceIds.includes(d.guestDeviceId));
    }
    const share = state.shares.find(s => s.shareId === d.resourceId && s.hostDeviceId === d.hostDeviceId && s.status === 'active');
    return !!share?.members.some(m => m.status === 'active' && m.memberId === d.scope!.memberId
      && m.guestKey === d.scope!.guestSubject && m.version === d.scope!.memberVersion && m.deviceIds.includes(d.guestDeviceId));
  }
  async function handle(req: IncomingMessage, bytes: Buffer): Promise<unknown> {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname.slice('/api/agent-net/sharing'.length);
    const method = req.method ?? 'GET';
    const actor = await options.authenticate(req, bytes, { rootPublicKey: host.rootPublicKey, remember: host.remember });
    if (!actor || typeof actor.accountId !== 'string' || typeof actor.deviceId !== 'string'
      || !actor.accountId || !actor.deviceId || typeof actor.networkId !== 'string' || !ID_PATTERN.test(actor.networkId))
      throw new AppError('UNAUTHORIZED', 401, 'Verified network/device identity required');
    let input: Record<string, unknown> = {};
    if (bytes.length) {
      try { input = JSON.parse(bytes.toString('utf8')); } catch { throw invalidParams('Invalid JSON'); }
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalidParams('Expected an object');
    }
    const body = (keys: readonly string[]) => {
      if (Object.keys(input).some(key => !keys.includes(key))) throw invalidParams('Unexpected fields'); return input;
    };
    const inNetwork = (kind: Delegation['kind'], id: string) => host.storage.read().bindings.some(binding =>
      binding.kind === kind && binding.resourceId === id && binding.networkId === actor.networkId);
    const scoped = (kind: Delegation['kind'], id: string | undefined) => { if (!id || !inNetwork(kind, id)) throw notFound(); };
    const repositories = createSharingRepositories(host.storage);
    const digest = (value: unknown) => createHash('sha256').update(text(value)).digest('hex');
    let networkId: string | undefined;
    const certified = async () => {
      const member = await host.member(req, bytes);
      if (member.deviceId !== actor.deviceId || member.networkId !== actor.networkId || !sameAccount(member, actor.accountId)) throw permissionDenied('Network/account/device identity mismatch');
      networkId = member.networkId; return services(networkId);
    };
    const ordinary = services();
    let result: unknown;
    if ((path === '/provider-shares/delegations/prepare' || path === '/provider-shares/delegations/check') && method === 'POST') {
      body(['shareId', 'memberId', 'guestDeviceId', 'executorDeviceId']);
      const shareId = text(input.shareId), memberId = text(input.memberId), guestDeviceId = text(input.guestDeviceId), executorDeviceId = text(input.executorDeviceId);
      if (![shareId, memberId, guestDeviceId, executorDeviceId].every(value => ID_PATTERN.test(value))) throw invalidParams('Invalid executor request');
      scoped('provider-share', shareId); await certified();
      const share = await repositories.providers.findShare(shareId);
      if (!share || share.ownerAccountId !== actor.accountId || ![share.hostDeviceId, executorDeviceId].includes(actor.deviceId)) throw permissionDenied();
      const prepare = path.endsWith('/prepare');
      if (prepare && actor.deviceId !== share.hostDeviceId) throw permissionDenied();
      const certificate = host.memberCertificate?.(actor.networkId, executorDeviceId);
      const grants = (host.grants?.(actor.networkId) ?? []).filter(d => d.kind === 'provider-share' && d.scope?.memberId === memberId
        && d.resourceId === shareId && d.guestDeviceId === guestDeviceId && d.hostDeviceId === share.hostDeviceId
        && authorized(d) && d.expiresAt > host.now()).sort((a, b) => b.expiresAt - a.expiresAt);
      const delegation = grants[0];
      if (prepare) {
        if (!delegation || !certificate || certificate.deviceId === share.hostDeviceId
          || certificate.subject !== delegation.issuerCertificate.subject) throw notFound();
        result = { delegation, executorCertificate: certificate };
      } else {
        const executor = delegation?.executors?.find(e => e.certificate.deviceId === executorDeviceId && e.expiresAt > host.now()
          && e.certificate.signingKey === certificate?.signingKey && e.certificate.transportKey === certificate.transportKey);
        result = delegation && executor ? { active: true, ownerDeviceId: share.hostDeviceId, generation: executor.generation,
          expiresAt: executor.expiresAt, delegation, executorCertificate: executor.certificate } : { active: false };
      }
    } else if ((path === '/transport' || path === '/transport/status') && method === 'POST') {
      const status = path.endsWith('/status');
      body(status ? ['id', 'signingKey', 'transportKey'] : ['kind', 'resourceId', 'memberId', 'signingKey', 'transportKey']);
      const signingKey = text(input.signingKey), transportKey = text(input.transportKey);
      const validKey = (key: string) => KEY_PATTERN.test(key) && Buffer.from(key, 'base64url').toString('base64url') === key;
      if (!validKey(signingKey) || !validKey(transportKey)) throw invalidParams('Invalid public key');
      const header = req.headers['x-agent-net-applicant'];
      let proof: unknown;
      try { if (typeof header !== 'string' || header.length > 1024) throw new Error();
        proof = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')); } catch { throw permissionDenied('Applicant proof required'); }
      if (!verifyRequestProof(signingKey, proof, method, req.url ?? '/', bytes, host.now())) throw permissionDenied('Invalid applicant proof');
      host.remember(actor.accountId, actor.deviceId, proof.nonce);
      let request: DelegationRequest | undefined;
      if (status) {
        request = host.requests().find(r => r.id === text(input.id) && r.guestDeviceId === actor.deviceId
          && r.scope.guestSubject === actor.accountId && r.guestSigningKey === signingKey && r.guestTransportKey === transportKey);
        if (!request || request.expiresAt <= host.now() || !check(request, host.storage.read())) throw notFound();
        if (request.networkId !== actor.networkId) throw notFound();
      } else {
        const kind = input.kind, resourceId = text(input.resourceId), memberId = text(input.memberId);
        if ((kind !== 'shared-task' && kind !== 'provider-share') || !ID_PATTERN.test(resourceId) || !ID_PATTERN.test(memberId))
          throw invalidParams('Invalid resource');
        scoped(kind, resourceId);
        const repo = createSharingRepositories(host.storage);
        const row = kind === 'shared-task' ? await repo.tasks.find(resourceId) : await repo.providers.findShare(resourceId);
        if (!row) throw notFound();
        const attached = kind === 'shared-task' ? await ordinary.tasks.connectDevice(actor, resourceId, memberId, row.hostDeviceId)
          : await ordinary.providers.connectDevice(actor, resourceId, memberId, row.hostDeviceId);
        if (!attached) throw notFound();
        const state = host.storage.read();
        const binding = state.bindings.find(b => b.kind === kind && b.resourceId === resourceId);
        const member = kind === 'shared-task' ? state.tasks.find(t => t.sharedTaskId === resourceId)?.guests.find(g => g.memberId === memberId)
          : state.shares.find(s => s.shareId === resourceId)?.members.find(m => m.memberId === memberId);
        if (!binding || !member) throw notFound();
        const scope = { memberId, guestSubject: actor.accountId, memberVersion: member.version };
        const existing = host.requests().find(r => r.networkId === actor.networkId && r.kind === kind && r.resourceId === resourceId && r.guestDeviceId === actor.deviceId
          && r.scope.memberId === memberId && r.scope.memberVersion === member.version && r.guestSigningKey === signingKey && r.guestTransportKey === transportKey);
        request = { id: existing && !host.grant(existing).revoked ? existing.id : randomUUID(), kind, resourceId, hostDeviceId: row.hostDeviceId,
          networkId: binding.networkId, scope, guestDeviceId: actor.deviceId, guestSigningKey: signingKey, guestTransportKey: transportKey,
          requestedAt: host.now(), expiresAt: host.now() + MAX_GRANT_LIFETIME_MS };
        if (!check(request, state)) throw notFound();
        await host.saveRequest(request); host.changed([binding.networkId]);
      }
      const grant = host.grant(request);
      result = { id: request.id, status: grant.delegation ? 'ready' : 'pending', networkId: request.networkId,
        rootPublicKey: grant.rootPublicKey, certificate: grant.certificate, ...(grant.delegation ? { delegation: grant.delegation } : {}) };
    } else if (path === '/shared-tasks' && method === 'GET') result = { sharedTasks: (await ordinary.tasks.list(actor)).filter(row => inNetwork('shared-task', row.sharedTaskId)) };
    else if (path === '/shared-tasks' && method === 'POST') {
      body(['sessionId', 'title']); const { tasks } = await certified();
      const row = await tasks.create(actor, text(input.sessionId), text(input.title));
      result = { sharedTaskId: row.sharedTaskId, revision: row.revision };
    } else if (path === '/shared-tasks/join' && method === 'POST') {
      body(['invitation', 'displayName']);
      scoped('shared-task', (await repositories.tasks.findInvitation(digest(input.invitation)))?.sharedTaskId);
      result = await ordinary.tasks.join(actor, text(input.invitation), text(input.displayName));
    } else if (/^\/shared-tasks\/[^/]+(?:\/.*)?$/.test(path)) {
      const parts = path.split('/').slice(2).map(decodeURIComponent), [id, action] = parts;
      scoped('shared-task', id);
      if (parts.length === 1 && method === 'GET') result = await ordinary.tasks.get(actor, id);
      else if (action === 'leave' && parts.length === 2 && method === 'POST') {
        body([]); result = await ordinary.tasks.depart(actor, id);
      } else if (method === 'POST') {
        body([]); const { tasks } = await certified();
        if (action === 'invites' && parts.length === 2) result = await tasks.invite(actor, id);
        else if (action === 'close' && parts.length === 2) result = await tasks.close(actor, id);
        else if (action === 'members' && parts.length === 4 && parts[3] === 'remove') result = await tasks.depart(actor, id, parts[2]);
        else throw notFound();
      } else throw notFound();
    } else if (path === '/provider-shares' && method === 'GET') result = { shares: (await (await certified()).providers.listOwner(actor)).filter(row => inNetwork('provider-share', row.shareId)) };
    else if (path === '/provider-shares/links' && method === 'POST') {
      body(['providerId', 'providerLabel', 'deviceName', 'identityCard']);
      result = await (await certified()).providers.createLink(actor, input as Parameters<typeof ordinary.providers.createLink>[1]);
    } else if (path === '/provider-shares/preview' && method === 'POST') {
      body(['invitation']); scoped('provider-share', (await repositories.providers.findLink(digest(input.invitation)))?.shareId);
      result = await ordinary.providers.preview(actor, input.invitation);
    } else if (path === '/provider-shares/requests' && method === 'POST') {
      body(['invitation', 'identityCard']); scoped('provider-share', (await repositories.providers.findLink(digest(input.invitation)))?.shareId);
      result = await ordinary.providers.createRequest(actor, input.invitation, input.identityCard);
    } else if (path === '/provider-shares/received' && method === 'GET') result = { shares: (await ordinary.providers.listReceived(actor)).filter(row => inNetwork('provider-share', row.shareId)) };
    else {
      const parts = path.split('/').slice(1).map(decodeURIComponent);
      if (parts[0] !== 'provider-shares') throw notFound();
      const [, group, id, action] = parts;
      if (group === 'requests' && id) scoped('provider-share', (await repositories.providers.findRequest(id))?.shareId);
      if ((group === 'members' || group === 'received') && id) scoped('provider-share', (await repositories.providers.findMember(id))?.shareId);
      if (group === 'requests' && parts.length === 3 && method === 'GET') result = await ordinary.providers.getRequest(actor, id);
      else if (method === 'POST' && parts.length === 4) {
        body([]);
        if (group === 'requests' && action === 'withdraw') result = await ordinary.providers.withdraw(actor, id);
        else if (group === 'received' && action === 'leave') result = await ordinary.providers.leave(actor, id);
        else {
          const { providers } = await certified();
          if (group === 'requests' && action === 'approve') result = await providers.approve(actor, id);
          else if (group === 'requests' && action === 'reject') result = await providers.reject(actor, id);
          else if (group === 'members' && (action === 'pause' || action === 'resume' || action === 'remove'))
            result = await providers.setMemberStatus(actor, id, action);
          else throw notFound();
        }
      } else throw notFound();
    }
    if (method !== 'GET' && !path.startsWith('/transport') && path !== '/provider-shares/preview') host.changed([actor.networkId]);
    return result;
  }
  function requestsFor(networkId: string, deviceId: string): DelegationRequest[] {
    const state = host.storage.read();
    return host.requests().filter(r => r.networkId === networkId && r.hostDeviceId === deviceId
      && r.expiresAt > host.now() && check(r, state)
      && (host.grant(r).delegation?.expiresAt ?? 0) < r.expiresAt - 30_000).slice(0, 128);
  }
  return { handle, authorized, requestsFor };
}
