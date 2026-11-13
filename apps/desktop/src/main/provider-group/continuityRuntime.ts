import { hostSessionIdFor } from '../remote-agent/host/sessionIdentity.js';
import { randomUUID } from 'node:crypto';
import { isProviderAccessDeniedError, isScopedPeer, PROVIDER_GROUP_REMOTE_CHANNEL, REMOTE_AGENT_CHANNEL, parseRemoteAgentCaps } from '@cindy/device-link';
import { findCatalogModel, isModelSelectableForNewRoute, supportsSubscriptionFastPolicy } from '@cindy/model-providers';
import { activeOwnerScopeKey } from '../appSessionState.js';
import { getClientEndpoint } from '../clientEndpointsService.js';
import { getRemoteLinkCloseEpoch, getSelfDeviceId, remoteBackgroundInvoke } from '../device-link/index.js';
import { deviceAccessGeneration, isControllerAccessAllowed, onRemoteControlAccessChanged,
  remoteControlAccessGeneration } from '../device-link/remoteControlAccess.js';
import { captureProviderMetadataContinuityScope, isTemporaryProviderMetadataFailure } from '../device-link/providerMetadataContinuity.js';
import { getDesktopProviderService } from '../maker-host/createDesktopProviderService.js';
import { getActiveCatalog } from '../maker-host/active-catalog.js';
import { isRemoteProviderInvocationAllowed, remoteProviderAccessEpoch, onRemoteProviderAccessChanged } from '../maker-host/remote-provider-access-store.js';
import { ownComputersMayUseProvider } from '../maker-host/own-computer-provider-access.js';
import { GROUP_CONTINUITY_MS, parseGroupContinuityAck, type GroupContinuityGrant } from '../../shared/providerGroupContinuity.js';
import type { ProviderGroupMember } from '../../shared/providerGroup.js';
import type { ProviderGroupRemoteHandlerDeps } from './remoteHandler.js';
import { createGroupContinuityExecutor } from './continuityExecutor.js';
import { groupFastPolicyStore } from './fastPolicyStore.js';
import { captureProviderManagementScope } from './managementScope.js';
import { onProviderGroupChanged, readProviderGroup } from './store.js';

/**
 * Reserve a conservative delivery allowance using the current client's 10s
 * first-write and 30s response budgets. Publishing also checks the actual
 * wall/monotonic elapsed time from the first encoding anchor; delayed timeout
 * callbacks cannot extend that allowance. Encoding may precede the socket write.
 * Late unpublished prepares are revoked best-effort and keep M's own expiry.
 */
export const GROUP_CONTINUITY_DELIVERY_BUDGET_MS = 40_000;


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
  /**
   * Executor captures also bind the local control switch generation. This is
   * intentionally separate from the O-side capture: C's own control switch
   * governs who may control C, not C's outbound group routing.
   */
  const captureExecutor = (origin: string, controller: string, providerId: string) => {
    const base = capture(origin, controller, providerId);
    const controlGeneration = remoteControlAccessGeneration();
    const originAccess = deviceAccessGeneration(origin);
    const controllerAccess = deviceAccessGeneration(controller);
    return () => base() && controlGeneration === remoteControlAccessGeneration()
      && originAccess === deviceAccessGeneration(origin)
      && controllerAccess === deviceAccessGeneration(controller)
      && isControllerAccessAllowed(origin) && isControllerAccessAllowed(controller);
  };
  const executor = createGroupContinuityExecutor({
    capture: captureExecutor, wall: Date.now, mono: () => performance.now(),
    async inspect(grant) {
      const assertOwner = captureProviderManagementScope();
      const providers = await getDesktopProviderService().listProviders({ allowSideEffects: false });
      assertOwner();
      const provider = providers.find(candidate => candidate.id === grant.providerId);
      const found = provider ? findCatalogModel(provider, grant.model, grant.agentKind) : null;
      // 续用只发给同账号控制端(grant 不收受邀者)，与直接启动任务用同一条判断。
      if (!provider?.connected || provider.suspended || !ownComputersMayUseProvider(grant.providerId)
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
      assertCurrent();
      try { await groupFastPolicyStore.receive(origin, { group: grant.group,
        ...(policy ?? { revision: 0, allowFast: false }),
        binding: { sessionId, controllerDeviceId: grant.controller } }, getSelfDeviceId(), assertCurrent, undefined, true); }
      catch {
        assertCurrent();
        groupFastPolicyStore.suppress(hostSessionIdFor(grant.controller, sessionId), origin, grant.group);
      }
      assertCurrent();
    },
  });
  type Prepared = { owner: string; target: string; grant: GroupContinuityGrant; fingerprint: string;
    wall: number; mono: number; missing?: true; current(): boolean };
  type PrepareAttempt = { row?: Prepared; transient?: true; refused?: true };
  const prepared = new Map<string, Prepared>();
  const preparing = new Map<string, { group: string; promise: Promise<PrepareAttempt> }>();
  const groupGenerations = new Map<string, number>();
  const unsupported = new Map<string, { wall: number; mono: number; current(): boolean }>();
  const generation = (group: string) => groupGenerations.get(group) ?? 0;
  const revoke = (row: Prepared) => {
    if (row.owner !== activeOwnerScopeKey()) return;
    void remoteBackgroundInvoke(row.target, PROVIDER_GROUP_REMOTE_CHANNEL, [{ action: 'continuity-revoke', id: row.grant.id }], {
      preSend: () => { if (row.owner !== activeOwnerScopeKey()) throw new Error('Group owner changed'); },
    }).catch(() => undefined);
  };
  const invalidatePrepared = (key: string, previous: Prepared | undefined) => {
    if (!previous || prepared.get(key) !== previous) return;
    prepared.delete(key);
    revoke(previous);
  };
  const replyError = (reply: { ok: boolean; error?: { code?: string; message?: string } }): Error | null =>
    reply.ok ? null : Object.assign(new Error(reply.error?.message ?? 'continuity request failed'), {
      code: reply.error?.code,
    });
  const errorCode = (error: unknown): string | undefined => {
    const row = error && typeof error === 'object' ? error as { code?: unknown; message?: unknown } : {};
    const message = typeof error === 'string' ? error : typeof row.message === 'string' ? row.message : '';
    return typeof row.code === 'string' && row.code !== 'IPC_ERROR'
      ? row.code : /^\[([A-Z0-9_]+)\]/.exec(message)?.[1];
  };
  const transientFailure = (error: unknown): boolean => {
    const code = errorCode(error);
    // Dispatch reports an executor whose provider-group handler has not
    // registered yet as [UNAVAILABLE]; this is the same temporary not-ready
    // condition the pick path treats as retryable.
    return isTemporaryProviderMetadataFailure(error) || code === 'REMOTE_AGENT_UNAVAILABLE'
      || code === 'UNAVAILABLE'
      || (typeof (error as { message?: unknown })?.message === 'string'
        && /^\[REMOTE_AGENT_UNAVAILABLE\]/.test((error as { message: string }).message));
  };
  const unsupportedFailure = (error: unknown): boolean => {
    const code = errorCode(error);
    return code === 'CHANNEL_NOT_ALLOWED' || code === 'REMOTE_AGENT_UNSUPPORTED'
      || code === 'REMOTE_AGENT_PEER_TOO_OLD' || code === 'UNSUPPORTED_CAPABILITY';
  };
  const invalidateGroup = (group: string) => {
    groupGenerations.set(group, generation(group) + 1);
    for (const [key, row] of prepared) if (row.grant.group === group) { prepared.delete(key); revoke(row); }
    for (const [key, flight] of preparing) if (flight.group === group) preparing.delete(key);
  };
  onProviderGroupChanged(invalidateGroup);
  onRemoteProviderAccessChanged(invalidateGroup);
  onRemoteControlAccessChanged(scope => {
    if (scope === 'all') {
      // The switch is a permission boundary for every context retained by this
      // executor. Retire them before the next request, even if the controller
      // never receives the link-close.
      executor.invalidate(() => true);
      const self = getSelfDeviceId();
      if (!self) return;
      // A local member's O-side prepared row is the same authorization this
      // executor just retired. Remote members are not this machine's switch
      // scope and will be resolved by their own link-close/permission change.
      for (const [key, row] of prepared) {
        if (row.target === self) prepared.delete(key);
      }
      return;
    }
    const deviceId = scope.deviceId;
    executor.invalidate(entry => entry.origin === deviceId || entry.grant.controller === deviceId);
    for (const [key, row] of prepared) {
      // Only the revoked device's controller role ends its route. Revoking a
      // device as a controller must not retire another controller's task on
      // that same device as executor.
      if (row.grant.controller !== deviceId) continue;
      prepared.delete(key);
      revoke(row);
    }
  });

  const prepare: NonNullable<ProviderGroupRemoteHandlerDeps['prepareContinuity']> = async (controller, request, member: ProviderGroupMember) => {
    // Never turn a third-party share/reshare or a cross-account guest into a same-account context.
    if (isScopedPeer(controller) || member.kind !== 'device' || !member.agentDeviceId || isScopedPeer(member.agentDeviceId)) return undefined;
    const group = request.providerId;
    const config = readProviderGroup(group);
    if (!config || !isRemoteProviderInvocationAllowed(group)) return undefined;
    const fingerprint = JSON.stringify(config);
    const owner = activeOwnerScopeKey();
    const supportKey = JSON.stringify([owner, member.agentDeviceId]);
    const oldPeer = unsupported.get(supportKey);
    if (oldPeer && oldPeer.current() && Date.now() < oldPeer.wall && performance.now() < oldPeer.mono) return undefined;
    const currentScope = capture(controller, member.agentDeviceId, group);
    const controlGeneration = member.agentDeviceId === getSelfDeviceId()
      ? remoteControlAccessGeneration() : undefined;
    // A controller revocation observed by dispatch or the settings poll must
    // fence an in-flight caps/prepare even when the explicit link-close epoch
    // has not advanced yet; otherwise a late grant could outlive the revocation
    // on M, which only knows its own permission list.
    const controllerAccess = deviceAccessGeneration(controller);
    const controllerAllowed = () => isControllerAccessAllowed(controller);
    const attemptGeneration = generation(group);
    const current = () => controllerAllowed() && controllerAccess === deviceAccessGeneration(controller)
      && currentScope() && attemptGeneration === generation(group)
      && (controlGeneration === undefined || controlGeneration === remoteControlAccessGeneration())
      && fingerprint === JSON.stringify(readProviderGroup(group))
      && isRemoteProviderInvocationAllowed(group);
    const key = JSON.stringify([owner, controller, group, member.agentDeviceId, member.providerId, request.agentKind, request.model]);
    for (const [key, row] of prepared) {
      if (Date.now() >= row.wall || performance.now() >= row.mono) { prepared.delete(key); continue; }
      // Another instance can change the shared group file without notifying this
      // process. Dropping a still-open row here would lose the only id we could
      // revoke; M would keep admitting it until its own deadline.
      if (!row.current()) { prepared.delete(key); revoke(row); }
    }
    let row = prepared.get(key);
    const previous = row;
    const markUnsupported = (requestedWall: number, requestedMono: number) => {
      if (!current()) return;
      if (unsupported.size >= 512) unsupported.delete(unsupported.keys().next().value!);
      unsupported.set(supportKey, { wall: requestedWall + GROUP_CONTINUITY_MS, mono: requestedMono + GROUP_CONTINUITY_MS,
        current: captureProviderMetadataContinuityScope(member.agentDeviceId!) });
    };
    let verified = false;
    // Age alone does not end a healthy ACK; verify every still-valid row.
    if (row && !row.missing) {
      const self = getSelfDeviceId();
      if (!self) {
        // No local device identity: preserve the acknowledged row; a restart
        // cannot be distinguished without contacting M.
        verified = true;
      } else {
        let reply: Awaited<ReturnType<typeof remoteBackgroundInvoke>> | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const checked = row;
        const verifyWall = Date.now(), verifyMono = performance.now();
        const missingContext = (value: unknown) => {
          const absent = value as { id?: unknown; remainingMs?: unknown } | null;
          return absent?.id === checked.grant.id && absent.remainingMs === 0;
        };
        const retireChecked = () => {
          if (current() && prepared.get(key) === checked) invalidatePrepared(key, checked);
        };
        try {
          const request = remoteBackgroundInvoke(member.agentDeviceId!, PROVIDER_GROUP_REMOTE_CHANNEL, [{
            action: 'continuity-inspect', id: row.grant.id, ownerDeviceId: self,
            sessionId: 'continuity-verify',
          }], { preSend: () => { if (!current()) throw new Error('Group routing context changed'); } }).then(result => {
            // Missing is authoritative even after the soft timeout returned an
            // older ACK. Keep its deadlines for retry, but never deliver it again.
            if (result.ok && missingContext(result.result) && current() && prepared.get(key) === checked) {
              checked.missing = true;
            }
            if (!result.ok && isProviderAccessDeniedError(replyError(result)!)) retireChecked();
            return result;
          }, error => {
            if (isProviderAccessDeniedError(error)) retireChecked();
            throw error;
          });
          // A failed verification must not delay the normal offline fallback by
          // the full remote RPC timeout. Keep the acknowledged row on timeout.
          void request.catch(() => undefined);
          reply = await Promise.race([request, new Promise<undefined>(resolve => {
            timer = setTimeout(() => resolve(undefined), 2_000);
          })]);
          if (!reply) verified = true;
        } catch (error) {
          if (!current()) return undefined;
          if (transientFailure(error)) verified = true;
          else { retireChecked(); return undefined; }
        } finally {
          if (timer) clearTimeout(timer);
        }
        if (!verified && reply) {
          if (!current()) return undefined;
          if (prepared.get(key) !== checked) return undefined;
          if (!reply.ok) {
            if (transientFailure(replyError(reply)!)) verified = true;
            else { retireChecked(); return undefined; }
          } else {
            const ack = parseGroupContinuityAck(reply.result, checked.grant.id);
            if (ack) {
              checked.wall = Math.min(checked.wall, verifyWall + ack.remainingMs);
              checked.mono = Math.min(checked.mono, verifyMono + ack.remainingMs);
              verified = true;
            } else {
              // Only the issuer's missing-context response permits re-authorization.
              if (!missingContext(reply.result)) {
                retireChecked(); return undefined;
              }
            }
          }
        }
      }
    }
    // M keeps continuity grants in memory. A still-fresh O row can therefore
    // outlive a restarted M, so a reused row must be re-ACKed by M before it is
    // handed to C. A missing row only caps the replacement's wall/mono budget;
    // it cannot be an offline fallback while replacement has no M ACK.
    if (!verified) {
      let pending = preparing.get(key);
      if (!pending) {
        const flight: { group: string; promise: Promise<PrepareAttempt> } = {
          group,
          promise: Promise.resolve<PrepareAttempt>({ transient: true }),
        };
        const createdFlight = (async (): Promise<PrepareAttempt> => {
          if (!current() || (!previous && prepared.size >= 512)) return { transient: true };
          const requestedWall = Date.now(), requestedMono = performance.now();
          const owns = () => preparing.get(key) === flight;
          const fail = (error: unknown): PrepareAttempt => {
            if (isProviderAccessDeniedError(error)) {
              invalidatePrepared(key, previous);
              return { refused: true };
            }
            if (unsupportedFailure(error)) {
              invalidatePrepared(key, previous);
              return { refused: true };
            }
            return transientFailure(error) ? { transient: true } : { refused: true };
          };
          let caps: Awaited<ReturnType<typeof remoteBackgroundInvoke>>;
          try {
            caps = await remoteBackgroundInvoke(member.agentDeviceId!, REMOTE_AGENT_CHANNEL, [{ op: 'caps' }], {
              preSend: () => { if (!current()) throw new Error('Group routing context changed'); },
            });
          } catch (error) {
            return fail(error);
          }
          if (!current()) return { transient: true };
          if (!caps.ok) return fail(replyError(caps)!);
          let parsedCaps: ReturnType<typeof parseRemoteAgentCaps>;
          try {
            parsedCaps = parseRemoteAgentCaps(caps.result);
          } catch (error) {
            return fail(error);
          }
          if (!current()) return { transient: true };
          if (!parsedCaps.groupContinuity) {
            if (owns()) markUnsupported(requestedWall, requestedMono);
            invalidatePrepared(key, previous);
            return { refused: true };
          }
          if (!parsedCaps.agents.some(agent => agent.kind === request.agentKind && agent.available)) return { transient: true };
          // Do not send an authorization from a flight that was superseded while
          // its capability probe was in flight.
          if (!owns()) return { transient: true };
          const remainingWindowMs = () => Math.min(
            requestedWall + GROUP_CONTINUITY_MS - Date.now(),
            requestedMono + GROUP_CONTINUITY_MS - performance.now(),
            previous ? previous.wall - Date.now() : Infinity,
            previous ? previous.mono - performance.now() : Infinity,
          );
          const initialRemainingMs = remainingWindowMs();
          if (initialRemainingMs <= GROUP_CONTINUITY_DELIVERY_BUDGET_MS) return { transient: true };
          let sentAt: { wall: number; mono: number } | undefined;
          let frozenGrant: GroupContinuityGrant | undefined;
          const grantFields = { id: randomUUID(), group, controller,
            providerId: member.providerId, agentKind: request.agentKind, model: request.model,
            fastPolicyRequired: supportsSubscriptionFastPolicy(getActiveCatalog().providers.find(row => row.id === group)) };
          const grant = { ...grantFields,
            remainingMs: initialRemainingMs - GROUP_CONTINUITY_DELIVERY_BUDGET_MS,
            // Freeze the first conservative encoding anchor. A caller's preSend
            // can also run after the response and must not move that anchor.
            toJSON(): GroupContinuityGrant {
              // The SDK encodes the same logical request more than once (cache key,
              // reservation measurement and reliable replays). Freeze the first
              // conservative payload so those re-encodes cannot move the anchor or
              // change the remaining value sent to M.
              if (frozenGrant) return frozenGrant;
              const remaining = remainingWindowMs() - GROUP_CONTINUITY_DELIVERY_BUDGET_MS;
              if (remaining <= 0) throw new Error('[REMOTE_AGENT_UNAVAILABLE] Group continuity window expired before send');
              grant.remainingMs = remaining;
              frozenGrant = { ...grantFields, remainingMs: remaining };
              sentAt = { wall: Date.now(), mono: performance.now() };
              return frozenGrant;
            },
          } as GroupContinuityGrant & { toJSON(): GroupContinuityGrant };
          const revokeSent = () => {
            if (!sentAt) return;
            revoke({ owner, target: member.agentDeviceId!, grant, fingerprint, wall: 0, mono: 0, current });
          };
          let result: Awaited<ReturnType<typeof remoteBackgroundInvoke>>;
          try {
            result = await remoteBackgroundInvoke(member.agentDeviceId!, PROVIDER_GROUP_REMOTE_CHANNEL,
              [{ action: 'continuity-prepare', grant }], { preSend: () => {
                if (!current()) throw new Error('Group routing context changed');
                // Check after admission/open/retry waits; serialization records the final anchor.
                if (remainingWindowMs() - GROUP_CONTINUITY_DELIVERY_BUDGET_MS <= 0) {
                  throw new Error('[REMOTE_AGENT_UNAVAILABLE] Group continuity window expired before send');
                }
              } });
          } catch (error) {
            revokeSent();
            return fail(error);
          }
          if (!result.ok) {
            revokeSent();
            return fail(replyError(result)!);
          }
          const sent = sentAt;
          if (!sent || Date.now() - sent.wall > GROUP_CONTINUITY_DELIVERY_BUDGET_MS
            || performance.now() - sent.mono > GROUP_CONTINUITY_DELIVERY_BUDGET_MS) {
            revokeSent();
            return { transient: true };
          }
          const ack = parseGroupContinuityAck(result.result, grant.id);
          const ackRemainingMs = ack?.remainingMs ?? 0;
          // Anchor the ack remaining at the final send, not at ack receipt: the return
          // trip must not lengthen O's prepared deadline beyond M's installed deadline.
          const created: Prepared = { owner, target: member.agentDeviceId!, grant, fingerprint,
            wall: Math.min(previous?.wall ?? requestedWall + GROUP_CONTINUITY_MS, sent.wall + ackRemainingMs),
            mono: Math.min(previous?.mono ?? requestedMono + GROUP_CONTINUITY_MS, sent.mono + ackRemainingMs), current };
          if (!ack || !current() || created.wall <= Date.now() || created.mono <= performance.now()) {
            revoke(created);
            return { transient: true };
          }
          // A superseded attempt must not overwrite a context prepared by a newer
          // flight, even if the old command eventually returns success.
          if (!owns()) { revoke(created); return { transient: true }; }
          const latest = prepared.get(key);
          if (latest && latest !== previous) { revoke(created); return { transient: true }; }
          prepared.set(key, created);
          // The replacement is the only route C may keep. Retiring the old id
          // also covers a previous pick already held by C; failure is bounded by
          // that old row's original deadline.
          if (previous && previous.grant.id !== created.grant.id) revoke(previous);
          return { row: created };
        })();
        flight.promise = createdFlight;
        pending = flight;
        preparing.set(key, flight);
        const cleanup = () => { if (preparing.get(key) === flight) preparing.delete(key); };
        void createdFlight.then(cleanup, cleanup);
      }
      // Optional preparation must not add a full RPC timeout to normal task startup.
      let timer: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      let outcome: PrepareAttempt | undefined;
      try {
        outcome = await Promise.race([pending.promise, new Promise<undefined>(resolve => {
          timer = setTimeout(() => { timedOut = true; resolve(undefined); }, 2_000);
        })]);
      } finally { if (timer) clearTimeout(timer); }
      // A timed-out probe must not be joined forever. A later pick starts a
      // fresh attempt; a late success from the superseded flight is discarded
      // and revoked, while its current/config checks still fence that work.
      if (timedOut && preparing.get(key) === pending) preparing.delete(key);
      if (outcome?.row) row = outcome.row;
      else if (!outcome || outcome.transient) row = prepared.get(key);
      else row = undefined;
    }
    if (!row || row.missing || !current()) return undefined;
    const remainingMs = Math.min(row.wall - Date.now(), row.mono - performance.now());
    return remainingMs > 0 ? { id: row.grant.id, remainingMs, config: JSON.parse(fingerprint) } : undefined;
  };
  return { handle: executor.handle, prepare };
}
