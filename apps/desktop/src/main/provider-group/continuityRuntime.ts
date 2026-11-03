import { randomUUID } from 'node:crypto';
import { isScopedPeer, PROVIDER_GROUP_REMOTE_CHANNEL, REMOTE_AGENT_CHANNEL, parseRemoteAgentCaps } from '@cindy/device-link';
import { findCatalogModel, isModelSelectableForNewRoute, supportsSubscriptionFastPolicy } from '@cindy/model-providers';
import { activeOwnerScopeKey } from '../appSessionState.js';
import { getClientEndpoint } from '../clientEndpointsService.js';
import { getRemoteLinkCloseEpoch, getSelfDeviceId, remoteBackgroundInvoke } from '../device-link/index.js';
import { captureProviderMetadataContinuityScope } from '../device-link/providerMetadataContinuity.js';
import { getDesktopProviderService } from '../maker-host/createDesktopProviderService.js';
import { getActiveCatalog } from '../maker-host/active-catalog.js';
import { isRemoteProviderInvocationAllowed, remoteProviderAccessEpoch, onRemoteProviderAccessChanged } from '../maker-host/remote-provider-access-store.js';
import { GROUP_CONTINUITY_MS, parseGroupContinuityAck, type GroupContinuityGrant } from '../../shared/providerGroupContinuity.js';
import type { ProviderGroupMember } from '../../shared/providerGroup.js';
import type { ProviderGroupRemoteHandlerDeps } from './remoteHandler.js';
import { createGroupContinuityExecutor } from './continuityExecutor.js';
import { groupFastPolicyStore } from './fastPolicyStore.js';
import { captureProviderManagementScope } from './managementScope.js';
import { onProviderGroupChanged, readProviderGroup } from './store.js';


/** Wiring lives here; the routing client never imports the server-side handler/runtime. */
export function createGroupContinuityRuntime(readRunning: () => Promise<ReadonlyMap<string, number> | null>) {
  const capture = (origin: string, controller: string, providerId?: string) => {
    const assertOwner = captureProviderManagementScope();
    const endpoint = getClientEndpoint('deviceLinkApiBaseUrl');
    const originEpoch = getRemoteLinkCloseEpoch(origin), controllerEpoch = getRemoteLinkCloseEpoch(controller);
    const permission = providerId ? remoteProviderAccessEpoch(providerId) : undefined;
    return () => {
      try { assertOwner(); } catch { return false; }
      return endpoint === getClientEndpoint('deviceLinkApiBaseUrl') && originEpoch === getRemoteLinkCloseEpoch(origin)
        && controllerEpoch === getRemoteLinkCloseEpoch(controller)
        && (!providerId || permission === remoteProviderAccessEpoch(providerId));
    };
  };
  const executor = createGroupContinuityExecutor({
    capture, wall: Date.now, mono: () => performance.now(),
    async inspect(grant) {
      const assertOwner = captureProviderManagementScope();
      const providers = await getDesktopProviderService().listProviders({ allowSideEffects: false });
      assertOwner();
      const provider = providers.find(candidate => candidate.id === grant.providerId);
      const found = provider ? findCatalogModel(provider, grant.model, grant.agentKind) : null;
      if (!provider?.connected || provider.suspended || !isRemoteProviderInvocationAllowed(grant.providerId)
        || !found || !isModelSelectableForNewRoute(found, { userProvider: provider.source === 'user' })) {
        throw new Error('[ACCESS_REVOKED] The executor no longer offers this provider/model');
      }
      const running = await readRunning();
      assertOwner();
      if (!running) throw new Error('[REMOTE_AGENT_UNAVAILABLE] Executor load is not ready');
      return { running: running.get(grant.providerId) ?? 0,
        fastPolicyRequired: supportsSubscriptionFastPolicy(getActiveCatalog().providers.find(row => row.id === grant.providerId)) };
    },
    async bindFast(origin, grant, sessionId, current) {
      const policy = groupFastPolicyStore.received(origin, grant.group);
      const assertCurrent = () => { if (!current()) throw new Error('[ACCESS_REVOKED] Group routing context changed'); };
      if (!policy) throw new Error('[ACCESS_REVOKED] Group Fast policy has not been confirmed');
      assertCurrent();
      await groupFastPolicyStore.receive(origin, { group: grant.group, ...policy,
        binding: { sessionId, controllerDeviceId: grant.controller } }, getSelfDeviceId(), assertCurrent);
      assertCurrent();
    },
  });
  type Prepared = { owner: string; target: string; grant: GroupContinuityGrant; fingerprint: string;
    wall: number; mono: number; current(): boolean };
  const prepared = new Map<string, Prepared>();
  const preparing = new Map<string, Promise<Prepared | undefined>>();
  const unsupported = new Map<string, { wall: number; mono: number; current(): boolean }>();
  const revoke = (row: Prepared) => {
    if (row.owner !== activeOwnerScopeKey()) return;
    void remoteBackgroundInvoke(row.target, PROVIDER_GROUP_REMOTE_CHANNEL, [{ action: 'continuity-revoke', id: row.grant.id }], {
      preSend: () => { if (row.owner !== activeOwnerScopeKey()) throw new Error('Group owner changed'); },
    }).catch(() => undefined);
  };
  const invalidateGroup = (group: string) => {
    for (const [key, row] of prepared) if (row.grant.group === group) { prepared.delete(key); revoke(row); }
  };
  onProviderGroupChanged(invalidateGroup);
  onRemoteProviderAccessChanged(invalidateGroup);

  const prepare: NonNullable<ProviderGroupRemoteHandlerDeps['prepareContinuity']> = async (controller, request, member: ProviderGroupMember) => {
    // Never turn a third-party share/reshare or a cross-account guest into a same-account context.
    if (isScopedPeer(controller) || member.kind !== 'device' || !member.agentDeviceId || isScopedPeer(member.agentDeviceId)) return undefined;
    const config = readProviderGroup(request.providerId);
    if (!config || !isRemoteProviderInvocationAllowed(request.providerId)) return undefined;
    const fingerprint = JSON.stringify(config);
    const owner = activeOwnerScopeKey();
    const supportKey = JSON.stringify([owner, member.agentDeviceId]);
    const oldPeer = unsupported.get(supportKey);
    if (oldPeer && oldPeer.current() && Date.now() < oldPeer.wall && performance.now() < oldPeer.mono) return undefined;
    const currentScope = capture(controller, member.agentDeviceId, request.providerId);
    const current = () => currentScope() && fingerprint === JSON.stringify(readProviderGroup(request.providerId))
      && isRemoteProviderInvocationAllowed(request.providerId);
    const key = JSON.stringify([owner, controller, request.providerId, member.agentDeviceId, member.providerId, request.agentKind, request.model]);
    for (const [key, row] of prepared) if (!row.current() || Date.now() >= row.wall || performance.now() >= row.mono) prepared.delete(key);
    let row = prepared.get(key);
    if (!row || Math.min(row.wall - Date.now(), row.mono - performance.now()) < 10 * 60_000) {
      let flight = preparing.get(key);
      if (!flight) {
        flight = (async () => {
          if (!current() || prepared.size >= 512) return undefined;
          const requestedWall = Date.now(), requestedMono = performance.now();
          const caps = await remoteBackgroundInvoke(member.agentDeviceId!, REMOTE_AGENT_CHANNEL, [{ op: 'caps' }], {
            preSend: () => { if (!current()) throw new Error('Group routing context changed'); },
          });
          if (!current() || !caps.ok) return undefined;
          const parsedCaps = parseRemoteAgentCaps(caps.result);
          if (!parsedCaps.groupContinuity) {
            if (unsupported.size >= 512) unsupported.delete(unsupported.keys().next().value!);
            unsupported.set(supportKey, { wall: requestedWall + GROUP_CONTINUITY_MS, mono: requestedMono + GROUP_CONTINUITY_MS,
              current: captureProviderMetadataContinuityScope(member.agentDeviceId!) });
            return undefined;
          }
          if (!parsedCaps.agents.some(agent => agent.kind === request.agentKind && agent.available)) return undefined;
          const grant: GroupContinuityGrant = { id: randomUUID(), group: request.providerId, controller,
            providerId: member.providerId, agentKind: request.agentKind, model: request.model,
            fastPolicyRequired: supportsSubscriptionFastPolicy(getActiveCatalog().providers.find(row => row.id === request.providerId)),
            remainingMs: GROUP_CONTINUITY_MS };
          const result = await remoteBackgroundInvoke(member.agentDeviceId!, PROVIDER_GROUP_REMOTE_CHANNEL,
            [{ action: 'continuity-prepare', grant }], { preSend: () => { if (!current()) throw new Error('Group routing context changed'); } });
          const ack = result.ok ? parseGroupContinuityAck(result.result, grant.id) : null;
          const created: Prepared = { owner, target: member.agentDeviceId!, grant, fingerprint,
            wall: requestedWall + (ack?.remainingMs ?? 0), mono: requestedMono + (ack?.remainingMs ?? 0), current };
          if (!ack || !current() || created.wall <= Date.now() || created.mono <= performance.now()) { revoke(created); return undefined; }
          prepared.set(key, created);
          return created;
        })().finally(() => { preparing.delete(key); });
        preparing.set(key, flight);
      }
      // Optional preparation must not add a full RPC timeout to normal task startup.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { row = await Promise.race([flight, new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 2_000); })]); }
      finally { if (timer) clearTimeout(timer); }
    }
    if (!row || !current()) return undefined;
    const remainingMs = Math.min(row.wall - Date.now(), row.mono - performance.now());
    return remainingMs > 0 ? { id: row.grant.id, remainingMs, config: JSON.parse(fingerprint) } : undefined;
  };
  return { handle: executor.handle, prepare };
}
