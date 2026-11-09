import { shareAvailabilityRequest as requestAvailability, disableShareAvailability } from './providerShareAvailabilityTransport.js';
export { disableShareAvailability } from './providerShareAvailabilityTransport.js';
import { isCrossRegionShare, crossRegionAvailabilityRequest } from './providerShareCrossRegion.js';
import { getDesktopProviderService } from '../maker-host/createDesktopProviderService.js';
import { getProviderGroupDirectory } from '../provider-group/runtime.js';
import { findReceivedShare } from './providerShareGuest.js';
import { knownStandbyGuests, reconcileStandbyGuest } from './providerShareAvailabilityGuests.js';
import { withAvailabilityPolicyLock, rememberAvailabilityShare } from './providerShareAvailabilityPolicy.js';
/** Offline-owner admission. This contains public identities and grants, never provider credentials. */
import { parseProviderSharePeer, ProviderShareScopeChangedError, type ProviderShareOwned } from '@cindy/device-link';
import type { AgentKind, CatalogModel, ProviderView } from '@cindy/model-providers';
import { getDeviceId } from '../authManager.js';
import { getClientEndpoint } from '../clientEndpointsService.js';
import { captureProviderManagementScope } from '../provider-group/managementScope.js';
import { readProviderGroup } from '../provider-group/store.js';
import { groupFastPolicyStore } from '../provider-group/fastPolicyStore.js';
import { isRemoteProviderInvocationAllowed } from '../maker-host/remote-provider-access-store.js';
import { getProviderShareUsageStore } from './providerShareUsageStore.js';
import { remoteModelAccess } from './remoteModelAccess.js';
import { readDeviceLinkSettings } from './settings-store.js';
import { providerShareOwnerKey } from './providerShareApi.js';
import { applyProviderShareDelegation, delegatedProviderShareLeases, invalidateProviderShareDelegation } from './providerShareDelegatedAccess.js';

export const PROVIDER_SHARE_AVAILABILITY_CAPABILITY = 'provider-share-availability-v1';
interface Model extends Pick<CatalogModel, 'id' | 'name' | 'contextWindow' | 'efforts' | 'defaultEffort'> { kind: AgentKind; metadata?: Partial<CatalogModel> }
interface Executor { deviceId: string; providerId: string; models: Model[]; limit: number }
interface Policy { revision: number; executors: Executor[]; members: Array<{ memberId: string; joinedAt: number; models: string[] }>;
  allowFast: boolean; fastRevision: number; blockedGuestDeviceIds?: string[] }
interface Assignment { shareId: string; memberId: string; guestDeviceId: string; sessionId: string;
  executorDeviceId: string; providerId: string; kind: AgentKind; model: string; generation: string; expiresAt: number }
interface Preparation { joinedAt: number; ownerDeviceId: string; groupProviderId: string; allowFast: boolean; revision: number; assignments: Assignment[] }

export function shareAvailabilityRequest<T>(shareId: string, action: string, body: unknown = {}, guest = false): Promise<T> {
  return requestAvailability<T>(shareId, action, body, guest && isCrossRegionShare(shareId)
    ? () => crossRegionAvailabilityRequest(shareId, action, body) : undefined);
}

/** Only the live owner publishes; failed reads publish no permission, not an unrestricted default. */
export function publishShareAvailability(shares: readonly ProviderShareOwned[]): Promise<void> {
  return withAvailabilityPolicyLock(() => publishUnlocked(shares));
}
async function publishUnlocked(shares: readonly ProviderShareOwned[]): Promise<void> {
  const assertCurrent = captureProviderManagementScope();
  for (const share of shares) {
    if (share.hostDeviceId !== getDeviceId()) continue;
    const current = await shareAvailabilityRequest<{ revision: number; executors: Executor[] }>(share.shareId, 'policy');
    assertCurrent();
    const group = readProviderGroup(share.providerId);
    const policy: Policy = { revision: 0, executors: [], members: [], allowFast: false, fastRevision: 0, blockedGuestDeviceIds: [...readDeviceLinkSettings().revokedControllers] };
    if (group && readDeviceLinkSettings().remoteControlEnabled && isRemoteProviderInvocationAllowed(share.providerId)) {
      const source = (await getDesktopProviderService().listProviders({ allowSideEffects: false })).find(view => view.id === share.providerId);
      assertCurrent();
      if (!source || source.suspended) {
        await disableShareAvailability(share.shareId);
        continue;
      }
      const offered = new Set(Object.values(source.models).flatMap(rows => (rows ?? []).filter(model => !model.disabled).map(model => model.id)));
      const resolved = await getProviderGroupDirectory().resolveMembers(share.providerId, group);
      assertCurrent();
      for (const row of resolved) {
        const member = row.member;
        // Never turn a third-party share or a local-only connection into a standby.
        if (member.kind !== 'device' || member.paused || !member.agentDeviceId
          || readDeviceLinkSettings().disabledControlDeviceIds.includes(member.agentDeviceId)) continue;
        if (row.state === 'offline') {
          const registered = current.executors.find(target => target.deviceId === member.agentDeviceId && target.providerId === member.providerId);
          if (registered) policy.executors.push({ ...registered, limit: member.limit });
          continue;
        }
        if (row.state !== 'ok' || !row.view?.connected || row.view.suspended || row.providerContinuity?.stale) continue;
        const models: Model[] = [];
        for (const kind of ['claude-code', 'codex', 'pi'] as const) for (const model of row.view.models[kind] ?? []) {
          if (!model.disabled && model.availability !== 'requires_payment'
            && (!row.view.remoteModelIds || row.view.remoteModelIds.includes(model.id))) {
            const metadata = Object.fromEntries(['supportsToolCalls', 'reasoningRequired', 'supportsImageInput', 'supportsFastMode', 'supportsUltrafastMode', 'thinkingToggle', 'effortsUnknown', 'defaultEnabled', 'group', 'mode', 'family', 'icon', 'status', 'modalities'].flatMap(key => {
              const value = model[key as keyof CatalogModel]; return value === undefined ? [] : [[key, value]];
            }));
            models.push({ kind, id: model.id, name: model.name, ...(Object.keys(metadata).length ? { metadata } : {}), contextWindow: model.contextWindow, efforts: [...model.efforts], defaultEffort: model.defaultEffort });
          }
        }
        if (models.length) policy.executors.push({ deviceId: member.agentDeviceId, providerId: member.providerId, models, limit: member.limit });
      }
      const ids = [...new Set(policy.executors.flatMap(row => row.models.map(model => model.id)))];
      policy.members = share.members.filter(member => member.status === 'active'
        && getProviderShareUsageStore()?.memberGenerationReady({ ownerScope: providerShareOwnerKey(),
          ownerDeviceId: share.hostDeviceId, shareId: share.shareId, memberId: member.memberId }, member.joinedAt)).map(member => ({
        memberId: member.memberId, joinedAt: Date.parse(member.joinedAt),
        models: ids.filter(id => offered.has(id) && remoteModelAccess.allowsDelegatedExecution(share.providerId, id, member.memberId)),
      }));
      const fast = groupFastPolicyStore.outgoing()[share.providerId];
      policy.fastRevision = fast?.revision ?? 0;
      policy.allowFast = fast?.allowFast === true && group.allowFast !== false;
    }
    // CAS prevents a slow catalog read from overwriting a later published revocation.
    policy.revision = current.revision;
    await rememberAvailabilityShare(share.shareId, share.providerId);
    assertCurrent();
    await shareAvailabilityRequest(share.shareId, 'publish', { policy });
    assertCurrent();
  }
}

export async function allocateShareAvailability(shareId: string, sessionId: string, kind: AgentKind, model: string) {
  const row = await shareAvailabilityRequest<Assignment>(shareId, 'allocate', { sessionId, kind, model }, true);
  if (row.shareId !== shareId || row.sessionId !== sessionId || row.kind !== kind || row.model !== model
    || typeof row.executorDeviceId !== 'string' || !/^[0-9a-f-]{36}$/.test(row.generation)
    || !Number.isSafeInteger(row.expiresAt) || row.expiresAt <= Date.now()) throw new Error('Invalid shared executor assignment');
  return { deviceId: row.executorDeviceId, generation: row.generation, leaseDurationMs: Math.min(30 * 60_000, row.expiresAt - Date.now()) };
}

export async function readShareAvailabilityCatalog(shareId: string): Promise<{ providers: ProviderView[]; providerOrder: string[]; modelVisibilityOverrides: Record<string, never> }> {
  const value = await shareAvailabilityRequest<{ providerId: string; providerLabel: string; models: Model[] }>(shareId, 'catalog', {}, true);
  const models: ProviderView['models'] = {};
  for (const row of value.models) {
    if (!['claude-code', 'codex', 'pi'].includes(row.kind) || typeof row.id !== 'string' || typeof row.name !== 'string') throw new Error('Invalid shared catalog');
    (models[row.kind] ??= []).push({ ...row.metadata, id: row.id, name: row.name, contextWindow: row.contextWindow, efforts: row.efforts, defaultEffort: row.defaultEffort });
  }
  return { providers: [{ id: value.providerId, name: value.providerLabel, source: 'user', auth: { method: 'none' }, routing: {},
    agents: Object.keys(models) as AgentKind[], models, connected: value.models.length > 0, remoteInvocationEnabled: true }],
    providerOrder: [value.providerId], modelVisibilityOverrides: {} };
}

const preparations = new Map<string, Promise<void>>();
/** Called by the executor before admitting the guest. Server response, not guest input, supplies every grant field. */
export async function prepareShareAvailability(controller: string): Promise<void> {
  const peer = parseProviderSharePeer(controller);
  if (peer?.role !== 'guest') return;
  const assertCurrent = captureProviderManagementScope();
  const owner = providerShareOwnerKey();
  const endpoint = getClientEndpoint('deviceLinkApiBaseUrl');
  const verify = () => {
    assertCurrent();
    if (providerShareOwnerKey() !== owner || getClientEndpoint('deviceLinkApiBaseUrl') !== endpoint) throw new ProviderShareScopeChangedError();
  };
  const key = JSON.stringify([owner, endpoint, controller]);
  const existing = preparations.get(key);
  if (existing) return existing;
  const pending = (async () => {
    let prepared: Preparation;
    try { prepared = await shareAvailabilityRequest<Preparation>(peer.shareId, 'prepare', { memberId: peer.memberId, guestDeviceId: peer.deviceId }); }
    catch (error) {
      verify();
      if ((error as { code?: unknown })?.code === 'NOT_FOUND') {
        for (const item of delegatedProviderShareLeases()) if (item.peer === controller && item.lease.availability) {
          invalidateProviderShareDelegation(item.peer, item.sessionId, item.lease.nonce);
        }
        await reconcileStandbyGuest(controller, null);
      }
      throw error;
    }
    verify();
    await reconcileStandbyGuest(controller, prepared.joinedAt);
    verify();
    const current = new Set(prepared.assignments.map(row => row.sessionId));
    for (const item of delegatedProviderShareLeases()) {
      if (item.peer === controller && item.lease.availability && !current.has(item.sessionId)) {
        invalidateProviderShareDelegation(item.peer, item.sessionId, item.lease.nonce);
      }
    }
    for (const row of prepared.assignments) {
      if (row.shareId !== peer.shareId || row.memberId !== peer.memberId || row.guestDeviceId !== peer.deviceId
        || row.executorDeviceId !== getDeviceId()) throw new Error('Shared executor identity mismatch');
      await applyProviderShareDelegation(prepared.ownerDeviceId, {
        op: 'delegate', action: 'grant', shareId: row.shareId, memberId: row.memberId,
        guestDeviceId: row.guestDeviceId, sessionId: row.sessionId, providerId: row.providerId,
        model: row.model, generation: row.generation,
        fastPolicy: { group: prepared.groupProviderId, revision: prepared.revision, allowFast: prepared.allowFast },
      }, async () => {
        verify();
        return { active: row.expiresAt > Date.now(), ownerDeviceId: prepared.ownerDeviceId,
          generation: row.generation, expiresAt: row.expiresAt };
      }, true);
      verify();
    }
  })();
  preparations.set(key, pending);
  try { await pending; } finally { if (preparations.get(key) === pending) preparations.delete(key); }
}

export async function reportShareAvailabilityStatus(shareId: string, sessionId: string, generation: string, running: boolean): Promise<void> {
  await shareAvailabilityRequest(shareId, 'status', { sessionId, generation, running }, true);
}

export async function lookupShareAvailability(shareId: string, sessionId: string): Promise<Assignment | null> {
  if (findReceivedShare(shareId)?.standbyOnline === undefined) return null;
  try { return (await shareAvailabilityRequest<{ assignment: Assignment | null }>(shareId, 'lookup', { sessionId }, true)).assignment; }
  catch (error) { if ((error as { code?: unknown })?.code === 'NOT_FOUND') return null; throw error; }
}
export async function acceptShareAvailability(controller: string, sessionId: string): Promise<void> {
  const item = delegatedProviderShareLeases().find(row => row.peer === controller && row.sessionId === sessionId);
  if (!item?.lease.availability) return;
  const peer = parseProviderSharePeer(controller);
  if (peer?.role !== 'guest') throw new Error('Invalid guest');
  await shareAvailabilityRequest(peer.shareId, 'accept', { memberId: peer.memberId, guestDeviceId: peer.deviceId, sessionId, generation: item.lease.generation });
}

/** Capture the receipt before execution: revoking the local grant must not strand its capacity. */
export async function beginShareAvailabilityTurn(controller: string, sessionId: string, executionId: string,
  captureCompletion: (complete: () => Promise<void>) => void): Promise<void> {
  const item = delegatedProviderShareLeases().find(row => row.peer === controller && row.sessionId === sessionId);
  if (!item?.lease.availability) return;
  const peer = parseProviderSharePeer(controller);
  if (peer?.role !== 'guest') throw new Error('Invalid guest');
  const assertCurrent = captureProviderManagementScope();
  const owner = providerShareOwnerKey();
  const endpoint = getClientEndpoint('deviceLinkApiBaseUrl');
  const generation = item.lease.generation;
  // Register before the request: an error can mean the server accepted but its reply was lost.
  captureCompletion(async () => {
    assertCurrent();
    if (providerShareOwnerKey() !== owner || getClientEndpoint('deviceLinkApiBaseUrl') !== endpoint) throw new ProviderShareScopeChangedError();
    await shareAvailabilityRequest(peer.shareId, 'complete', { sessionId, generation, executionId });
  });
  await shareAvailabilityRequest(peer.shareId, 'accept', { memberId: peer.memberId, guestDeviceId: peer.deviceId, sessionId, generation, executionId });
}

export async function refreshStandbyGuests(): Promise<void> {
  for (const controller of knownStandbyGuests()) {
    try { await prepareShareAvailability(controller); } catch { /* A failed read never renews a lease. */ }
  }
}
