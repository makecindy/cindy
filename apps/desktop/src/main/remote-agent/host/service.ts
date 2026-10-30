import { assertMemberBudget, memberBudgetDenial, memberBudgetAllows } from '../../device-link/providerShareBudgetRuntime.js';
import { readRemoteAgentLimitsState } from './limitsStore.js';
/**
 * 远程 Agent 运行服务的被控端接线：把 `maker:remote-agent:v1` 接到本机 Maker 的 Agent。
 * 准入：本机打开了「允许远程控制」且没有撤销该控制端；账号切换后进行中的任务全部结束。
 * 供应商分享的受邀者(其他账号)另按分享快照准入，只能用分享给它的那个供应商。
 */
import path from 'node:path';
import { createNativeHistoryTransfer } from '../nativeHistoryTransfer';
import { nativeHistoryStorage } from '../nativeHistoryStorage';
import fsp from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';

import { isProviderSharePeer, parseProviderSharePeer, providerShareGuestPeer, type RemoteAgentRequest } from '@cindy/device-link';
import type { Maker, StartSessionOptions } from '@cindy/maker-core';
import { LOCAL_AGENT_CLIENT } from '@cindy/maker-core';

import { createLogger } from '../../logger.js';
import {
  captureDataOwnerBroadcastScope,
  isDataOwnerBroadcastScopeCurrent,
  type DataOwnerBroadcastScope,
} from '../../device-link/broadcast-tap.js';
import { setRemoteAgentHandler } from '../../device-link/dispatch.js';
import { getSelfDeviceId, remoteBackgroundInvoke } from '../../device-link/index.js';
import { getProviderShareHostLoadedSnapshot, onProviderShareHostChanged, ownedProviderShareGuestAccess, providerShareGuestAccess, verifyProviderShareMemberGeneration } from '../../device-link/providerShareHost.js';
import { applyProviderShareDelegation, clearProviderShareDelegations, delegatedProviderShareGuestAccess, delegatedProviderShareLeases, delegatedProviderShareModelAllowed, delegatedProviderShareReceiptAuthority, delegatedProviderShareSessionAllowed, delegatedProviderShareTaskAccess, invalidateProviderShareDelegation, revokeDelegatedProviderShareGuest } from '../../device-link/providerShareDelegatedAccess.js';
import { checkProviderShareDelegation, grantProviderShareDelegation, providerShareOwnerKey, revokeProviderShareDelegation } from '../../device-link/providerShareApi.js';
import { remoteModelAccess } from '../../device-link/remoteModelAccess.js';
import { handleProviderShareReshare, providerShareReshareAllows } from '../../device-link/providerShareReshare.js';
import { createProviderGroupGuestRelay } from '../../provider-group/guestRelay.js';
import { providerGroupReshare } from '../../provider-group/reshareRuntime.js';
import { getProviderGroupOwnerScope } from '../../provider-group/runtime.js';
import { onProviderGroupChanged, readProviderGroup } from '../../provider-group/store.js';
import { bindGroupFastPolicy, bindLocalHostedGroupFastPolicy, receiveGroupFastPolicy, startGroupFastPolicySync } from '../../provider-group/fastPolicyRuntime.js';
import { groupFastPolicyStore } from '../../provider-group/fastPolicyStore.js';
import { captureProviderManagementScope } from '../../provider-group/managementScope.js';
import { createSubscriptionFastPolicy } from '../../maker-host/subscription-fast-policy.js';
import { getSessionProvider } from '../../maker-host/session-provider-store.js';
import { remoteAgentPollerFor } from '../controller/service';
import { RemoteAgentRunClient, type RemoteAgentInvoke } from '../controller/runClient.js';
import { getProviderShareUsageStore, installProviderShareUsageStore, type ProviderShareDirectReceiptRoute } from '../../device-link/providerShareUsageStore.js';
import { currentProviderPartyUsageStore, flushProviderPartyUsage } from '../../usage/providerPartyUsageStore.js';
import { onDeviceLinkSettingChanged, readDeviceLinkSettings } from '../../device-link/settings-store.js';
import { readTurnUsageResetAt } from '../../goal-host/usageLimit.js';
import { getDesktopProviderService } from '../../maker-host/createDesktopProviderService.js';
import { bindHostedSessionProvider, hasHostedSessionModelAccess } from '../../maker-host/session-provider-store.js';
import { hostedProviderOffersModel } from '../../maker-host/guest-provider-route-store.js';
import { isRemoteProviderInvocationAllowed } from '../../maker-host/remote-provider-access-store.js';
import { createGuestProviderRouteBinder, guestProviderModelIds, resolveGuestProviderId, resolveSharedProviderId } from './providerAccess';
import { createRemoteAgentHost, type GroupRelayLoad, type HostedStartInput, type RemoteAgentHost, type RunUsageRecord } from './runHost';
import { purgeClaudeHostedSessionArtifacts, purgeClaudeHostedTranscripts, purgePiHostedSubagentRuns } from './transcripts';
import { captureGeneratedImageStorage, generatedImageErrorCode, handleGeneratedImageArtifacts, prepareGeneratedImageTransport } from '../../cindy-media/generatedImageStorage';

const log = createLogger('remote-agent:host');

/** 对方任务的启动选项 → 本机 Agent 的启动选项(工作目录是影子目录，工具经隧道回到对方)。 */
export function hostedStartOptions(input: HostedStartInput): StartSessionOptions {
  const { options, workspace } = input;
  const client = options.localApplication;
  if (client && (!input.localApplicationStorage || !input.mcpServers.includes(client.mcpName))) {
    throw new Error('[REMOTE_AGENT_INVALID] Missing isolated application tools or storage.');
  }
  return {
    ...(client ? { [LOCAL_AGENT_CLIENT]: {
      url: `${input.tunnel.url.replace(/\/+$/, '')}/mcp/${encodeURIComponent(client.mcpName)}`,
      token: input.tunnel.token,
      mcpName: client.mcpName, hostToolsOnly: client.hostToolsOnly,
      storageDirectory: input.localApplicationStorage,
    } } : {}),
    sessionId: input.hostSessionId,
    workingDir: input.shadowDir,
    model: options.model,
    ...(options.providerId !== undefined ? { providerId: options.providerId } : {}),
    ...(options.effort ? { effort: options.effort as StartSessionOptions['effort'] } : {}),
    ...(options.fastMode !== undefined ? { fastMode: options.fastMode } : {}),
    ...(options.thinkingEnabled !== undefined ? { thinkingEnabled: options.thinkingEnabled } : {}),
    ...(options.userPrompt ? { userPrompt: options.userPrompt } : {}),
    ...(options.botProfilePrompt ? { botProfilePrompt: options.botProfilePrompt } : {}),
    ...(options.botProfileContextPrompt ? { botProfileContextPrompt: options.botProfileContextPrompt } : {}),
    ...(options.botUserProfilePrompt ? { botUserProfilePrompt: options.botUserProfilePrompt } : {}),
    ...(options.makerMemoryEnabled !== undefined ? { makerMemoryEnabled: options.makerMemoryEnabled } : {}),
    ...(options.makerMemoryScopeKey ? { makerMemoryScopeKey: options.makerMemoryScopeKey } : {}),
    // 记忆在对方电脑上：没有快照时也给空快照，本机不读自己的记忆库。
    ...(options.makerMemoryEnabled ? { makerMemoryIndexSnapshot: options.makerMemoryIndexSnapshot ?? '' } : {}),
    ...(options.permissionMode ? { permissionMode: options.permissionMode as StartSessionOptions['permissionMode'] } : {}),
    ...(options.planMode !== undefined ? { planMode: options.planMode } : {}),
    ...(options.displayReasoning ? { displayReasoning: options.displayReasoning as StartSessionOptions['displayReasoning'] } : {}),
    ...(options.resumeSessionId ? { resumeSessionId: options.resumeSessionId } : {}),
    ...(options.codexHistoryHasProductPrompt !== undefined ? { codexHistoryHasProductPrompt: options.codexHistoryHasProductPrompt } : {}),
    ...(options.vendorOptions ? { vendorOptions: { ...options.vendorOptions } } : {}),
    extraDirs: [...(input.extraDirs ?? workspace.extraDirs)],
    writableDirs: [...(input.writableDirs ?? workspace.writableDirs)],
    deviceHosted: {
      ...workspace,
      workingDir: input.virtualWorkspace ? input.shadowDir : workspace.workingDir,
      // 旧协议把控制端真实路径直接交给 Agent；只有虚拟工作区才采用 Agent 主机的路径风格。
      pathPlatform: input.virtualWorkspace ? process.platform : workspace.platform,
      extraDirs: [...(input.extraDirs ?? workspace.extraDirs)],
      writableDirs: [...(input.writableDirs ?? workspace.writableDirs)],
      // HOME 属于 Agent 主机；不能把控制端的个人目录带入 Agent 上下文。
      homeDir: undefined,
      tunnelUrl: input.tunnel.url,
      tunnelToken: input.tunnel.token,
      ...(input.tunnel.linkActivity ? { linkActivity: input.tunnel.linkActivity } : {}),
      mcpServers: [...input.mcpServers],
      mirrorRoot: input.mirrorRoot,
      ...(input.personalInstructions ? { personalInstructions: input.personalInstructions } : {}),
      ...(input.guest ? { guest: true } : {}),
      ...(input.guest && input.guestHome ? { guestHome: input.guestHome } : {}),
      ...(input.guest && input.guestProvider
        ? { guestProvider: { ...input.guestProvider, modelIds: [...input.guestProvider.modelIds] } }
        : {}),
    },
    ...(input.onInvalidResumeSession ? { onInvalidResumeSession: input.onInvalidResumeSession } : {}),
  };
}

let host: RemoteAgentHost | null = null;
// resetMaker can install a replacement while the previous host is still deleting
// its shadow workspaces. Preserve that boundary across repeated resets.
let hostDisposal: Promise<void> = Promise.resolve();
let stopFastPolicySync: (() => void) | undefined;
let stopDirectRouteWatch: (() => void) | undefined;
let stopDirectModelWatch: (() => void) | undefined;
let stopDirectGroupWatch: (() => void) | undefined;
let stopDirectSettingsWatch: (() => void) | undefined;
let directRouteSweep: ReturnType<typeof setInterval> | undefined;
let delegationCheckTimer: ReturnType<typeof setInterval> | undefined;

/** M's per-task delegated lease takes precedence over any other task's lease. */
function guestAccessForTask(controller: string, sessionId?: string) {
  return delegatedProviderShareGuestAccess(controller)
    ? sessionId ? delegatedProviderShareTaskAccess(controller, sessionId) : null
    : providerShareGuestAccess(controller);
}

/** 受邀者能用的供应商：分享的那一个，且本机仍开放「允许被远程调用」。 */
function guestAllows(controller: string, providerId: string, sessionId?: string): boolean {
  const access = guestAccessForTask(controller, sessionId);
  return !!access && access.providerId === providerId && isRemoteProviderInvocationAllowed(providerId);
}

/** An undelegated guest is allowed only on the computer that owns its share. */
function shareTaskModelAllowed(controller: string, model: string, sessionId?: string): boolean {
  if (!isProviderSharePeer(controller)) return true;
  if (delegatedProviderShareGuestAccess(controller)) {
    return delegatedProviderShareModelAllowed(controller, model, sessionId);
  }
  return ownedProviderShareGuestAccess(controller) !== null;
}

/** Durable admission fence around legacy best-effort guest cleanup. */
export function createProviderShareMemberPurger(options: {
  userDataDir: string;
  usage: ReturnType<typeof installProviderShareUsageStore>;
  current: Pick<RemoteAgentHost, 'purgeControllers' | 'activeControllers'>;
  ownerScope: () => string;
  ownerDeviceId: () => string | null | undefined;
  isCurrent: () => boolean;
  hasAccess: (controller: string) => boolean;
}): (match: (controller: string) => boolean) => Promise<void> {
  const { usage, current } = options;
  let memberPurgeWork: Promise<void> = Promise.resolve();
  const purgeMemberControllers = (match: (controller: string) => boolean): Promise<void> => {
    const work = memberPurgeWork.then(async () => {
      const ownerScope = options.ownerScope();
      const ownerDeviceId = options.ownerDeviceId();
      if (!ownerDeviceId) throw new Error('Provider share owner device is unavailable');
      const assertCurrent = () => {
        if (!options.isCurrent() || options.ownerScope() !== ownerScope || options.ownerDeviceId() !== ownerDeviceId) {
          throw new Error('Provider share cleanup owner changed');
        }
      };
      const pending = usage.listPendingMemberCleanup(ownerScope, ownerDeviceId).filter((member) =>
        match(providerShareGuestPeer(member.shareId, member.memberId, 'membership-cleanup')));
      const belongs = (controller: string, member: typeof pending[number]) => {
        const peer = parseProviderSharePeer(controller);
        return peer?.role === 'guest' && peer.shareId === member.shareId && peer.memberId === member.memberId;
      };
      // A delayed duplicate purge must not delete a newly admitted incarnation.
      const guarded = (controller: string) => match(controller)
        && (pending.some((member) => belongs(controller, member)) || !options.hasAccess(controller));
      const indexFile = path.join(options.userDataDir, 'remote-agent', 'guest-sessions.json');
      const readIndex = async (): Promise<Array<Record<string, unknown>>> => {
        let raw: string;
        try { raw = await fsp.readFile(indexFile, 'utf8'); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
          throw error;
        }
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid guest cleanup index');
        const records = Object.values(parsed);
        if (records.some((record) => !record || typeof record !== 'object' || Array.isArray(record)
          || typeof (record as Record<string, unknown>).controller !== 'string')) {
          throw new Error('Invalid guest cleanup index record');
        }
        return records as Array<Record<string, unknown>>;
      };
      const before = pending.length ? await readIndex() : [];
      for (const member of pending) {
        const scopes = before.filter((record) => belongs(record.controller as string, member)).map((record) => ({
          controller: record.controller as string,
          ...(typeof record.relay === 'string' && record.relay ? { relay: record.relay } : {}),
        }));
        for (const controller of current.activeControllers()) {
          if (belongs(controller, member)) scopes.push({ controller });
        }
        assertCurrent();
        await usage.rememberMemberCleanupScopes(member, scopes);
      }
      await current.purgeControllers(guarded);
      assertCurrent();
      // runHost's legacy cleanup is best effort. Retain the membership fence
      // until its durable index and pending relay forgets are actually empty.
      // Scope receipts survive index deletion, so failed directory removal can
      // be retried after an O restart without reviving the old relay tombstone.
      const directoryKey = (scope: string) => createHash('sha256').update(scope).digest('hex').slice(0, 16);
      const scopes = usage.listPendingMemberCleanup(ownerScope, ownerDeviceId)
        .filter((member) => pending.some((item) => item.shareId === member.shareId && item.memberId === member.memberId
          && item.joinedAt === member.joinedAt && item.present === member.present))
        .flatMap((member) => member.cleanupScopes ?? []);
      for (const scope of scopes) {
        assertCurrent();
        const controllerKey = directoryKey(scope.controller);
        const guestKey = directoryKey(scope.relay ? `${scope.controller}\0relay:${scope.relay}` : scope.controller);
        const cleanupRoot = path.resolve(options.userDataDir, 'remote-agent');
        for (const [directory, key] of [['workspaces', controllerKey], ['attachments', controllerKey], ['guest-homes', guestKey]] as const) {
          const target = path.resolve(cleanupRoot, directory, key);
          const relative = path.relative(cleanupRoot, target);
          if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Invalid guest cleanup directory');
          await fsp.rm(target, { recursive: true, force: true });
        }
      }
      const after = pending.length ? await readIndex() : [];
      for (const member of pending) {
        const unfinished = after.some((record) => belongs(record.controller as string, member)
          && ['hostSessionIds', 'nativeIds', 'members', 'relayDevices', 'forgetPending', 'forkWorkspaces', 'attachmentRunIds']
            .some((field) => record[field] !== undefined && (record[field] === null
              || typeof record[field] !== 'object' || Object.keys(record[field] as object).length > 0)));
        if (unfinished) throw new Error('Provider share legacy history cleanup is still pending');
        assertCurrent();
        await usage.acknowledgeMemberCleanup(member);
      }
    });
    memberPurgeWork = work.catch(() => undefined);
    return work;
  };
  return purgeMemberControllers;
}

export function installRemoteAgentHost(options: { getMaker: () => Maker; userDataDir: string }): void {
  if (host) return;
  const previousHostDisposal = hostDisposal;
  const usage = installProviderShareUsageStore(options.userDataDir);
  const isControllerAuthorized = (controller: string): boolean => {
    if (isProviderSharePeer(controller)) return providerShareGuestAccess(controller) !== null;
    const settings = readDeviceLinkSettings();
    return settings.remoteControlEnabled && !settings.revokedControllers.includes(controller);
  };
  // 同一份受邀者分配器同时提供匿名状态，沿用实际分配时记录的版本兼容情况。
  const groupRelay = createProviderGroupGuestRelay({
    bindFastPolicy: bindGroupFastPolicy,
    scope: getProviderGroupOwnerScope,
    readGroup: readProviderGroup,
    connect: (agentDeviceId) => {
      const poller = remoteAgentPollerFor(agentDeviceId, remoteBackgroundInvoke, log);
      return { invoke: poller.invoke, poller };
    },
    // 组内电脑的报错用那台机器的本地时间：不带时区的钟点不按本机时区理解。
    readResetAt: (failure) => readTurnUsageResetAt(failure, Date.now(), { localTimeZoneTrusted: false }),
    // 转分享(provider-sharing.md §4.3)：分享来的电脑只给它的主人同意过的人。
    reshareAllows: providerGroupReshare.allows,
    noteReshareDenied: providerGroupReshare.noteDenied,
    reshareNeedsUpdate: providerGroupReshare.needsUpdate,
    now: () => Date.now(),
    log,
  });
  let checkingDelegations = false;
  delegationCheckTimer = setInterval(() => {
    if (checkingDelegations) return;
    checkingDelegations = true;
    const byPeer = new Map<string, ReturnType<typeof delegatedProviderShareLeases>>();
    for (const item of delegatedProviderShareLeases()) {
      const list = byPeer.get(item.peer) ?? [];
      list.push(item);
      byPeer.set(item.peer, list);
    }
    const groups = [...byPeer.values()];
    let next = 0;
    void Promise.all(Array.from({ length: Math.min(8, groups.length) }, async () => {
      while (next < groups.length) {
        const items = groups[next++];
        const first = items[0];
        const peer = parseProviderSharePeer(first.peer);
        const deviceId = getSelfDeviceId();
        if (peer?.role !== 'guest' || !deviceId) continue;
        try {
          const confirmed = await checkProviderShareDelegation({
            shareId: peer.shareId, memberId: peer.memberId, guestDeviceId: peer.deviceId,
            executorDeviceId: deviceId,
          });
          for (const item of items) if (!confirmed.active || confirmed.ownerDeviceId !== item.lease.ownerDeviceId) {
            invalidateProviderShareDelegation(item.peer, item.sessionId, item.lease.nonce);
          }
        } catch {
          // An unavailable server cannot extend a lease; its original deadline still applies.
        }
      }
    })).finally(() => { checkingDelegations = false; });
  }, 60_000);
  (delegationCheckTimer as { unref?: () => void }).unref?.();
  const directRoutes = new Map<string, {
    shareId: string; memberId: string; guestDeviceId: string; executorDeviceId: string;
    providerId: string; groupProviderId: string; memberKey: string; agentKind: string;
    model: string; sessionId: string; expiresAt: number;
    generation: string;
    load?: GroupRelayLoad; lastStatusAt: number;
  }>();
  // The executor can finish a turn while O's socket is reconnecting. Retry the same
  // receipt ID; O persists recent IDs so an ambiguous acknowledgement is harmless.
  const pendingUsage = new Map<string, { owner: string; request: Extract<RemoteAgentRequest, { op: 'direct-usage' }>;
    at: number; sending: boolean }>();
  const sendPendingUsage = (id: string) => {
    const receipt = pendingUsage.get(id);
    if (!receipt || receipt.sending) return;
    receipt.sending = true;
    void groupRelay.connect(receipt.owner).invoke([receipt.request]).then(() => {
      pendingUsage.delete(id);
    }).catch(() => {
      receipt.sending = false;
    });
  };
  const allocations = new Map<string, Promise<void>>();
  const directTaskContext = (controller: string, sessionId: string) => {
    const peer = parseProviderSharePeer(controller);
    const access = ownedProviderShareGuestAccess(controller);
    const settings = readDeviceLinkSettings();
    const ownerDeviceId = getSelfDeviceId();
    if (peer?.role !== 'guest' || !access || !ownerDeviceId || !getProviderShareHostLoadedSnapshot()
      || access.shareId !== peer.shareId || access.memberId !== peer.memberId
      || !settings.remoteControlEnabled || settings.revokedControllers.includes(peer.deviceId)
      || !isRemoteProviderInvocationAllowed(access.providerId)) {
      throw new Error('[REMOTE_AGENT_UNAVAILABLE] Provider share access is unavailable');
    }
    const identity = { ownerScope: providerShareOwnerKey(), ownerDeviceId,
      shareId: peer.shareId, memberId: peer.memberId, guestDeviceId: peer.deviceId, sessionId };
    const joinedAt = getProviderShareHostLoadedSnapshot()?.find((share) => share.shareId === peer.shareId)
      ?.members.find((member) => member.memberId === peer.memberId)?.joinedAt;
    if (!joinedAt || !usage.memberGenerationReady(identity, joinedAt)) {
      throw new Error('[REMOTE_AGENT_UNAVAILABLE] Provider share membership cleanup is pending');
    }
    const location = usage.findDirectTaskLocation(identity);
    if (location && (location.providerId !== access.providerId
      || usage.pendingDirectCleanupFor(identity.ownerScope, location))) {
      throw new Error('[REMOTE_AGENT_UNAVAILABLE] Provider share task is unavailable');
    }
    return { identity, location, access, joinedAt };
  };
  // Removing M from the new-task pool does not move its native history. The
  // durable location can retain only this exact guest/task/provider on M;
  // current share, model, device and server/M authorization remain separate.
  const directTargetAllowed = (route: Pick<ProviderShareDirectReceiptRoute,
    'ownerScope' | 'ownerDeviceId' | 'shareId' | 'memberId' | 'guestDeviceId' | 'sessionId'
    | 'providerId' | 'executorDeviceId' | 'executorProviderId' | 'memberKey'>): boolean => {
    if (readProviderGroup(route.providerId)?.members.some((member) => member.kind === 'device'
      && member.key === route.memberKey && member.agentDeviceId === route.executorDeviceId
      && member.providerId === route.executorProviderId)) return true;
    const saved = usage.findDirectTaskLocation(route);
    return !!saved && saved.providerId === route.providerId && saved.memberKey === route.memberKey
      && saved.executorDeviceId === route.executorDeviceId && saved.executorProviderId === route.executorProviderId;
  };
  const liveDirectTargetAllowed = (route: NonNullable<ReturnType<typeof directRoutes.get>>) =>
    directTargetAllowed({ ...route, ownerScope: providerShareOwnerKey(), ownerDeviceId: getSelfDeviceId() ?? '',
      providerId: route.groupProviderId, executorProviderId: route.providerId });
  // The server has one generation per G→M link. Two different task IDs may
  // renew together, so grant and M's confirmation must be serialized per link.
  const delegationGrants = new Map<string, Promise<void>>();
  const withDelegationGrant = async <T>(linkKey: string, work: () => Promise<T>): Promise<T> => {
    while (delegationGrants.has(linkKey)) await delegationGrants.get(linkKey);
    let release!: () => void;
    const turn = new Promise<void>((resolve) => { release = resolve; });
    delegationGrants.set(linkKey, turn);
    try { return await work(); }
    finally {
      if (delegationGrants.get(linkKey) === turn) delegationGrants.delete(linkKey);
      release();
    }
  };
  const directSwitchIssued = new Map<string, { generation: string; executorDeviceId: string;
    at: number; token: string }>();
  const directSwitchPending = new Map<string, Promise<{ token?: string }>>();
  const directSwitchAttempts = new Map<string, number>();
  const revokeDirectRoute = (key: string, route: NonNullable<ReturnType<typeof directRoutes.get>>): Promise<void> => {
    directRoutes.delete(key);
    route.load?.release();
    const { shareId, memberId, guestDeviceId, executorDeviceId, providerId, model, sessionId } = route;
    void revokeUnusedDirectPair(route).catch(() => undefined);
    return groupRelay.connect(executorDeviceId).invoke([{
      op: 'delegate', action: 'revoke', shareId, memberId, guestDeviceId, providerId, model, sessionId,
      generation: route.generation,
    }]).then(() => undefined).catch(() => undefined);
  };
  const previousDirectRouteAllowed = (route: ProviderShareDirectReceiptRoute): boolean => {
    const settings = readDeviceLinkSettings();
    const peer = providerShareGuestPeer(route.shareId, route.memberId, route.guestDeviceId);
    const access = ownedProviderShareGuestAccess(peer);
    return route.ownerScope === providerShareOwnerKey() && route.ownerDeviceId === getSelfDeviceId()
      && route.expiresAt > Date.now() && settings.remoteControlEnabled
      && usage.memberGenerationReady(route, route.memberJoinedAt)
      && usage.listActiveDirectReceiptRoutes(route.ownerScope).some((saved) => saved.ownerDeviceId === route.ownerDeviceId
        && saved.shareId === route.shareId && saved.memberId === route.memberId && saved.guestDeviceId === route.guestDeviceId
        && saved.sessionId === route.sessionId && saved.executorDeviceId === route.executorDeviceId && saved.generation === route.generation)
      && !usage.pendingDirectCleanupFor(route.ownerScope, route)
      && !settings.revokedControllers.includes(route.executorDeviceId)
      && access?.providerId === route.providerId
      && isRemoteProviderInvocationAllowed(route.providerId)
      && remoteModelAccess.allowsDelegatedExecution(route.providerId, route.model, route.memberId)
      && directTargetAllowed(route);
  };
  const assertCommittedDirectRoute = (route: ProviderShareDirectReceiptRoute): void => {
    const current = directTaskContext(providerShareGuestPeer(route.shareId, route.memberId,
      route.guestDeviceId), route.sessionId);
    if (current.identity.ownerScope !== route.ownerScope || current.identity.ownerDeviceId !== route.ownerDeviceId
      || current.joinedAt !== route.memberJoinedAt || current.location?.generation !== route.generation
      || current.location.executorDeviceId !== route.executorDeviceId
      || current.location.executorProviderId !== route.executorProviderId
      || current.location.providerId !== route.providerId || current.location.model !== route.model
      || current.location.memberKey !== route.memberKey || current.location.agentKind !== route.agentKind
      || !previousDirectRouteAllowed(route)) throw new Error('Provider share access changed during commit');
  };
  type DirectPairTask = Pick<ProviderShareDirectReceiptRoute,
    'shareId' | 'memberId' | 'guestDeviceId' | 'executorDeviceId' | 'sessionId' | 'generation'>;
  const hasValidDirectSibling = (route: DirectPairTask): boolean => {
    const sameGuest = (other: DirectPairTask) => other.shareId === route.shareId
      && other.memberId === route.memberId && other.guestDeviceId === route.guestDeviceId;
    for (const live of directRoutes.values()) {
      if (!sameGuest(live) || live.sessionId === route.sessionId
        || live.executorDeviceId !== route.executorDeviceId) continue;
      if (previousDirectRouteAllowed({ ...live, ownerScope: providerShareOwnerKey(),
        ownerDeviceId: getSelfDeviceId() ?? '', providerId: live.groupProviderId,
        executorProviderId: live.providerId })) return true;
    }
    // O may have restarted without restoring A into memory. Only the latest
    // task assignment counts: an old executor or a provisional row is not A.
    const latest = new Map<string, ProviderShareDirectReceiptRoute>();
    for (const saved of usage.listActiveDirectReceiptRoutes(providerShareOwnerKey())) {
      if (sameGuest(saved) && saved.sessionId !== route.sessionId
        && saved.ownerDeviceId === getSelfDeviceId()) latest.set(saved.sessionId, saved);
    }
    return [...latest.values()].some((saved) => saved.committedAt !== undefined
      && saved.executorDeviceId === route.executorDeviceId && previousDirectRouteAllowed(saved));
  };
  const revokeUnusedDirectPair = (route: DirectPairTask): Promise<void> => {
    // A server generation belongs to G/M, even when B's allocation created it.
    // Removing B's local lease must not disconnect a still-authorized sibling A.
    return hasValidDirectSibling(route) ? Promise.resolve() : revokeProviderShareDelegation({
      shareId: route.shareId, memberId: route.memberId, guestDeviceId: route.guestDeviceId,
      executorDeviceId: route.executorDeviceId, generation: route.generation,
    });
  };
  /** A new M grant replaces the session lease without closing its run. Restore
   * the last committed model with another grant before retiring a failed one. */
  const restorePreviousDirectGrant = async (previous: ProviderShareDirectReceiptRoute) => {
    if (!previousDirectRouteAllowed(previous)) throw new Error('Previous provider share route is no longer allowed');
    const delegation = { shareId: previous.shareId, memberId: previous.memberId,
      guestDeviceId: previous.guestDeviceId, executorDeviceId: previous.executorDeviceId };
    // A delete/rejoin boundary cannot resurrect the task that preceded it.
    if (usage.pendingDirectCleanupFor(previous.ownerScope, delegation)) {
      throw new Error('Previous provider share task is pending deletion');
    }
    const memberJoinedAt = previous.memberJoinedAt ?? getProviderShareHostLoadedSnapshot()
      ?.find((share) => share.shareId === previous.shareId)?.members.find((member) => member.memberId === previous.memberId)?.joinedAt;
    if (!memberJoinedAt) throw new Error('Previous provider share membership is unavailable');
    const granted = await grantProviderShareDelegation(delegation);
    const restored: ProviderShareDirectReceiptRoute = {
      ownerScope: previous.ownerScope, ownerDeviceId: previous.ownerDeviceId, ...delegation, memberJoinedAt,
      sessionId: previous.sessionId, agentKind: previous.agentKind,
      executorProviderId: previous.executorProviderId, providerId: previous.providerId,
      memberKey: previous.memberKey, model: previous.model,
      generation: granted.generation, expiresAt: granted.expiresAt,
    };
    const { invoke } = groupRelay.connect(previous.executorDeviceId);
    let grantAttempted = false;
    try {
      await verifyProviderShareMemberGeneration({ ...delegation, joinedAt: memberJoinedAt });
      const cleanupEpoch = await usage.registerDirectReceiptRoute(restored);
      if (!previousDirectRouteAllowed(previous)) throw new Error('Previous provider share route is no longer allowed');
      await bindGroupFastPolicy({ group: previous.providerId, deviceId: previous.executorDeviceId,
        sessionId: previous.sessionId, providerShareGuest: {
          shareId: previous.shareId, memberId: previous.memberId, guestDeviceId: previous.guestDeviceId,
        } });
      if (!previousDirectRouteAllowed(previous)) throw new Error('Previous provider share route is no longer allowed');
      grantAttempted = true;
      await invoke([{ op: 'delegate', action: 'grant', ...delegation,
        providerId: previous.executorProviderId, model: previous.model,
        sessionId: previous.sessionId, generation: granted.generation, cleanupEpoch }]);
      if (!previousDirectRouteAllowed(previous)) throw new Error('Previous provider share route is no longer allowed');
      await usage.commitDirectReceiptRoute(restored);
      assertCommittedDirectRoute(restored);
      return restored;
    } catch (error) {
      const revokes = [revokeUnusedDirectPair(restored)];
      if (grantAttempted) revokes.push(invoke([{ op: 'delegate', action: 'revoke', ...delegation,
        providerId: previous.executorProviderId, model: previous.model,
        sessionId: previous.sessionId, generation: granted.generation }]).then(() => undefined));
      await Promise.allSettled(revokes);
      try { await usage.markDirectReceiptRouteRevoked(restored); }
      catch (revokeError) { log.warn('provider group failed restoration journal revocation will retry', {
        error: String(revokeError),
      }); }
      throw error;
    }
  };
  const dropLiveDirectReceiptRoute = (route: ProviderShareDirectReceiptRoute) => {
    const key = JSON.stringify([providerShareGuestPeer(route.shareId, route.memberId,
      route.guestDeviceId), route.sessionId]);
    const live = directRoutes.get(key);
    if (live?.generation !== route.generation || live.executorDeviceId !== route.executorDeviceId) return;
    directRoutes.delete(key);
    live.load?.release();
    directSwitchIssued.delete(key);
  };
  const revokeRetiredDirectReceiptRoutes = (key: string, routes: ProviderShareDirectReceiptRoute[]): Promise<void> => {
    const live = directRoutes.get(key);
    if (live) {
      directRoutes.delete(key);
      live.load?.release();
    }
    const targets = [...routes];
    if (live && !targets.some((route) => route.generation === live.generation
      && route.executorDeviceId === live.executorDeviceId)) {
      targets.push({ ownerScope: providerShareOwnerKey(), ownerDeviceId: getSelfDeviceId() ?? '',
        shareId: live.shareId, memberId: live.memberId, guestDeviceId: live.guestDeviceId,
        executorDeviceId: live.executorDeviceId, executorProviderId: live.providerId,
        providerId: live.groupProviderId, memberKey: live.memberKey, agentKind: live.agentKind,
        model: live.model, sessionId: live.sessionId, generation: live.generation,
        expiresAt: live.expiresAt });
    }
    const revocations: Promise<void>[] = [];
    for (const route of targets) {
      try {
        revocations.push(revokeDirectRoute(key, {
          shareId: route.shareId, memberId: route.memberId, guestDeviceId: route.guestDeviceId,
          executorDeviceId: route.executorDeviceId, providerId: route.executorProviderId,
          groupProviderId: route.providerId, memberKey: route.memberKey, agentKind: route.agentKind,
          model: route.model, sessionId: route.sessionId, generation: route.generation,
          expiresAt: route.expiresAt, lastStatusAt: Date.now(),
        }));
      } catch (error) {
        log.warn('provider group retired direct route remote revocation failed', {
          executorDeviceId: route.executorDeviceId, error: String(error),
        });
      }
    }
    directSwitchIssued.delete(key);
    return Promise.all(revocations).then(() => undefined);
  };
  const retireDirectReceiptRoutes = async (routes: ProviderShareDirectReceiptRoute[]) => {
    for (const route of routes) {
      try {
        await usage.markDirectReceiptRouteRevoked(route);
        dropLiveDirectReceiptRoute(route);
      }
      catch (error) { log.warn('provider group superseded route journal revocation will retry', {
        error: String(error),
      }); }
    }
  };
  const settlePendingDirectCleanup = async (delegation: {
    shareId: string; memberId: string; guestDeviceId: string; executorDeviceId: string;
  }, invoke: RemoteAgentInvoke): Promise<boolean> => {
    const ownerScope = providerShareOwnerKey();
    const pending = usage.pendingDirectCleanupFor(ownerScope, delegation);
    if (!pending) return false;
    await invoke([{ op: 'forget', directGuest: {
      shareId: pending.shareId, memberId: pending.memberId,
      guestDeviceId: pending.guestDeviceId, forgetId: pending.pendingId,
      cleanupEpoch: pending.cleanupEpoch,
    } }]);
    // Keep the cleanup pending until all pre-delete routes have been retired
    // durably. A crash can then retry the idempotent forget before any grant.
    for (const saved of usage.listActiveDirectReceiptRoutes(ownerScope)) {
      if (saved.shareId === delegation.shareId && saved.memberId === delegation.memberId
        && saved.guestDeviceId === delegation.guestDeviceId
        && saved.executorDeviceId === delegation.executorDeviceId) {
        await revokeProviderShareDelegation({ ...delegation, generation: saved.generation });
        await usage.markDirectReceiptRouteRevoked(saved);
      }
    }
    for (const [key, route] of directRoutes) {
      if (route.shareId === delegation.shareId && route.memberId === delegation.memberId
        && route.guestDeviceId === delegation.guestDeviceId
        && route.executorDeviceId === delegation.executorDeviceId) {
        directRoutes.delete(key);
        route.load?.release();
        directSwitchIssued.delete(key);
      }
    }
    await usage.acknowledgeDirectCleanup(pending);
    return true;
  };
  const restoreDirectRoute = (controller: string, sessionId: string) => {
    const key = JSON.stringify([controller, sessionId]);
    const live = directRoutes.get(key);
    if (live) {
      if (!usage.pendingDirectCleanupFor(providerShareOwnerKey(), live)) return live;
      directRoutes.delete(key);
      live.load?.release();
      return null;
    }
    const peer = parseProviderSharePeer(controller);
    const self = getSelfDeviceId();
    const settings = readDeviceLinkSettings();
    if (peer?.role !== 'guest' || !self || !settings.remoteControlEnabled
      || settings.revokedControllers.includes(peer.deviceId) || !getProviderShareHostLoadedSnapshot()) return null;
    const saved = usage.listActiveDirectReceiptRoutes(providerShareOwnerKey())
      .filter((route) => route.ownerDeviceId === self
        && route.shareId === peer.shareId && route.memberId === peer.memberId
        && route.guestDeviceId === peer.deviceId && route.sessionId === sessionId)
      .reduce<(ReturnType<typeof usage.listActiveDirectReceiptRoutes>[number]) | null>((last, route) =>
        !last || (last.createdAt ?? 0) <= (route.createdAt ?? 0) ? route : last, null);
    const access = ownedProviderShareGuestAccess(controller);
    if (!saved || saved.committedAt === undefined
      || usage.pendingDirectCleanupFor(saved.ownerScope, saved)
      || access?.providerId !== saved.providerId
      || !isRemoteProviderInvocationAllowed(saved.providerId)
      || !remoteModelAccess.allowsDelegatedExecution(saved.providerId, saved.model, saved.memberId)
      || !directTargetAllowed(saved)) return null;
    const load = groupRelay.trackRun(saved.providerId, saved.memberKey);
    const route = { shareId: saved.shareId, memberId: saved.memberId, guestDeviceId: saved.guestDeviceId,
      executorDeviceId: saved.executorDeviceId, providerId: saved.executorProviderId,
      groupProviderId: saved.providerId, memberKey: saved.memberKey, agentKind: saved.agentKind,
      model: saved.model, sessionId: saved.sessionId, expiresAt: saved.expiresAt,
      generation: saved.generation, load, lastStatusAt: Date.now() };
    directRoutes.set(key, route);
    return route;
  };
  let reconcileAfterAllocation = false;
  let reconcilingJournal = false;
  let reconcileJournalAgain = false;
  const reconcileDirectJournal = async () => {
    if (reconcilingJournal) { reconcileJournalAgain = true; return; }
    const self = getSelfDeviceId();
    if (!self) return;
    const settings = readDeviceLinkSettings();
    if (!getProviderShareHostLoadedSnapshot() && settings.remoteControlEnabled) return;
    reconcilingJournal = true;
    try {
      type JournalRoute = ReturnType<typeof usage.listActiveDirectReceiptRoutes>[number];
      const rows = usage.listActiveDirectReceiptRoutes(providerShareOwnerKey())
        .filter((route) => route.ownerDeviceId === self);
      const routeOrder = new Map(rows.map((route, index) => [route, index]));
      const sessionKey = (route: JournalRoute) => JSON.stringify([
        route.shareId, route.memberId, route.guestDeviceId, route.sessionId]);
      const pairKey = (route: JournalRoute) => JSON.stringify([
        route.shareId, route.memberId, route.guestDeviceId, route.executorDeviceId]);
      const sessionExecutorKey = (route: JournalRoute) => JSON.stringify([
        sessionKey(route), route.executorDeviceId]);
      const latestSession = new Map<string, JournalRoute>();
      const latestExecutor = new Map<string, JournalRoute>();
      const latestPair = new Map<string, JournalRoute>();
      for (const route of rows) {
        const addLatest = (map: Map<string, JournalRoute>, id: string) => { map.set(id, route); };
        addLatest(latestSession, sessionKey(route));
        if (route.committedAt !== undefined) {
          addLatest(latestExecutor, sessionExecutorKey(route));
        }
        addLatest(latestPair, pairKey(route));
      }
      const valid = (route: JournalRoute): boolean => {
        if (route.committedAt === undefined || latestSession.get(sessionKey(route)) !== route
          || usage.pendingDirectCleanupFor(route.ownerScope, route)
          || !settings.remoteControlEnabled
          || settings.revokedControllers.includes(route.executorDeviceId)) return false;
        const peer = providerShareGuestPeer(route.shareId, route.memberId, route.guestDeviceId);
        const live = directRoutes.get(JSON.stringify([peer, route.sessionId]));
        if (live && (live.executorDeviceId !== route.executorDeviceId || live.expiresAt > route.expiresAt)) return false;
        const access = ownedProviderShareGuestAccess(peer);
        return access?.providerId === route.providerId
          && isRemoteProviderInvocationAllowed(route.providerId)
          && remoteModelAccess.allowsDelegatedExecution(route.providerId, route.model, route.memberId)
          && directTargetAllowed(route);
      };
      const jobs = new Map<string, JournalRoute[]>();
      for (const route of [...latestExecutor.values(), ...rows.filter((row) => row.committedAt === undefined)]) {
        const key = pairKey(route);
        const group = jobs.get(key) ?? [];
        group.push(route);
        jobs.set(key, group);
      }
      const reconcileRoute = async (route: JournalRoute) => {
        if (allocations.has(JSON.stringify([
          providerShareGuestPeer(route.shareId, route.memberId, route.guestDeviceId), route.sessionId,
        ]))) { reconcileAfterAllocation = true; return; }
        // Only the newest provisional route can describe M's current lease.
        // Retiring an older one first can expose an obsolete committed route.
        if (route.committedAt === undefined && latestSession.get(sessionKey(route)) !== route) return;
        // A provisional grant may already have replaced M's old lease. Resolve
        // that generation first; old committed rows cannot clear its journal.
        if (route.committedAt !== undefined && rows.some((candidate) =>
          candidate.committedAt === undefined && sessionKey(candidate) === sessionKey(route)
            && (candidate.createdAt ?? 0) >= (route.createdAt ?? 0))) return;
        if (route.committedAt === undefined) {
          const previous = [...rows].reverse().find((candidate) => candidate.committedAt !== undefined
            && routeOrder.get(candidate)! < routeOrder.get(route)!
            && sessionExecutorKey(candidate) === sessionExecutorKey(route));
          if (previous && previousDirectRouteAllowed(previous)) {
            let recovered = false;
            let deferred = false;
            try {
              await withDelegationGrant(pairKey(route), async () => {
                const key = JSON.stringify([providerShareGuestPeer(route.shareId, route.memberId,
                  route.guestDeviceId), route.sessionId]);
                if (allocations.has(key)) { reconcileAfterAllocation = true; deferred = true; return; }
                const current = usage.listActiveDirectReceiptRoutes(providerShareOwnerKey());
                const pending = current.filter((candidate) => sessionKey(candidate) === sessionKey(route));
                if (pending.at(-1)?.generation !== route.generation
                  || !pending.some((candidate) => candidate.generation === previous.generation)
                  || !previousDirectRouteAllowed(previous)) { deferred = true; return; }
                const restored = await restorePreviousDirectGrant(previous);
                const live = directRoutes.get(key);
                if (live?.generation === previous.generation) directRoutes.set(key, {
                  ...live, generation: restored.generation, expiresAt: restored.expiresAt,
                });
                await retireDirectReceiptRoutes(pending.filter((candidate) =>
                  candidate.executorDeviceId === route.executorDeviceId));
                recovered = true;
              });
            } catch (error) {
              log.warn('provider group previous direct route restoration failed', {
                executorDeviceId: route.executorDeviceId, error: String(error),
              });
            }
            if (recovered || deferred) return;
            if (usage.listActiveDirectReceiptRoutes(providerShareOwnerKey())
              .some((candidate) => candidate.generation !== route.generation
                && sessionKey(candidate) === sessionKey(route)
                && (candidate.createdAt ?? 0) > (route.createdAt ?? 0))) {
              dropLiveDirectReceiptRoute(previous);
              return;
            }
            if (previousDirectRouteAllowed(previous)) {
              // g2 may have crashed before M saw it. Revoke only g2, keep g1's
              // committed evidence for a later restoration attempt, and stop O
              // from advertising g1 until M has confirmed a fresh grant.
              dropLiveDirectReceiptRoute(previous);
              const revokes = await Promise.allSettled([
                groupRelay.connect(route.executorDeviceId).invoke([{ op: 'delegate', action: 'revoke',
                  shareId: route.shareId, memberId: route.memberId, guestDeviceId: route.guestDeviceId,
                  providerId: route.executorProviderId, model: route.model, sessionId: route.sessionId,
                  generation: route.generation }]),
                revokeUnusedDirectPair(route),
              ]);
              if (revokes.some((result) => result.status === 'rejected')) {
                log.warn('provider group provisional direct revocation will retry', {
                  executorDeviceId: route.executorDeviceId,
                });
              }
              return;
            }
          }
        }
        if (valid(route)) {
          for (const old of rows) if (old !== route
            && routeOrder.get(old)! < routeOrder.get(route)!
            && sessionExecutorKey(old) === sessionExecutorKey(route)) {
            await usage.markDirectReceiptRouteRevoked(old);
            dropLiveDirectReceiptRoute(old);
          }
          return;
        }
        const serverRevoke = latestPair.get(pairKey(route)) === route;
        const revoke = { op: 'delegate' as const, action: 'revoke' as const,
          shareId: route.shareId, memberId: route.memberId, guestDeviceId: route.guestDeviceId,
          providerId: route.executorProviderId, model: route.model, sessionId: route.sessionId,
          generation: route.generation };
        const work = [groupRelay.connect(route.executorDeviceId).invoke([revoke])];
        if (serverRevoke) work.push(revokeUnusedDirectPair(route));
        const outcomes = await Promise.allSettled(work);
        if (outcomes.some((outcome) => outcome.status === 'rejected')) {
          log.warn('provider group direct revocation will retry', { executorDeviceId: route.executorDeviceId });
          return;
        }
        for (const old of rows) if (routeOrder.get(old)! <= routeOrder.get(route)!
          && sessionExecutorKey(old) === sessionExecutorKey(route)) {
          await usage.markDirectReceiptRouteRevoked(old);
          dropLiveDirectReceiptRoute(old);
        }
      };
      const groups = [...jobs.values()];
      let nextGroup = 0;
      await Promise.all(Array.from({ length: Math.min(16, groups.length) }, async () => {
        while (nextGroup < groups.length) {
          const group = groups[nextGroup++]!;
          for (const route of group) {
            try { await reconcileRoute(route); }
            catch (error) {
              log.warn('provider group direct journal route reconciliation failed', {
                executorDeviceId: route.executorDeviceId, error: String(error),
              });
            }
          }
        }
      }));
    } catch (error) {
      log.warn('provider group direct journal reconciliation failed', { error: String(error) });
    } finally {
      reconcilingJournal = false;
      if (reconcileJournalAgain) {
        reconcileJournalAgain = false;
        queueMicrotask(() => { void reconcileDirectJournal(); });
      }
    }
  };
  stopDirectRouteWatch = onProviderShareHostChanged(() => {
    if (!getProviderShareHostLoadedSnapshot()) return;
    for (const [key, route] of directRoutes) {
      const access = ownedProviderShareGuestAccess(providerShareGuestPeer(route.shareId, route.memberId, route.guestDeviceId));
      if (!access || access.providerId !== route.groupProviderId || route.expiresAt <= Date.now()
        || !remoteModelAccess.allowsDelegatedExecution(route.groupProviderId, route.model, route.memberId)) revokeDirectRoute(key, route);
    }
    void reconcileDirectJournal();
  });
  stopDirectModelWatch = remoteModelAccess.subscribe(() => {
    for (const [key, route] of directRoutes) {
      if (!remoteModelAccess.allowsDelegatedExecution(route.groupProviderId, route.model, route.memberId)) revokeDirectRoute(key, route);
    }
    void reconcileDirectJournal();
  });
  stopDirectGroupWatch = onProviderGroupChanged((providerId) => {
    for (const [key, route] of directRoutes) {
      if (route.groupProviderId !== providerId) continue;
      if (!liveDirectTargetAllowed(route)) {
        revokeDirectRoute(key, route);
      }
    }
    void reconcileDirectJournal();
  });
  stopDirectSettingsWatch = onDeviceLinkSettingChanged((changed) => {
    if (changed !== 'remoteControlEnabled' && changed !== 'revokedControllers') return;
    const settings = readDeviceLinkSettings();
    for (const [key, route] of directRoutes) {
      if (!settings.remoteControlEnabled || settings.revokedControllers.includes(route.executorDeviceId)) {
        revokeDirectRoute(key, route);
      }
    }
    void reconcileDirectJournal();
  });
  directRouteSweep = setInterval(() => {
    void reconcileDirectJournal();
    for (const [id, receipt] of pendingUsage) {
      if (receipt.at + 30 * 60_000 <= Date.now()) pendingUsage.delete(id);
      else sendPendingUsage(id);
    }
    for (const [key, route] of directRoutes) {
      const access = getProviderShareHostLoadedSnapshot()
        ? providerShareGuestAccess(providerShareGuestPeer(route.shareId, route.memberId, route.guestDeviceId)) : null;
      if (route.expiresAt <= Date.now() || !liveDirectTargetAllowed(route)
        || (getProviderShareHostLoadedSnapshot() && (!access || access.providerId !== route.groupProviderId
          || !remoteModelAccess.allowsDelegatedExecution(route.groupProviderId, route.model, route.memberId)))) {
        revokeDirectRoute(key, route);
      } else if (Date.now() - route.lastStatusAt > 150_000) route.load?.setRunning(false);
    }
  }, 60_000);
  (directRouteSweep as { unref?: () => void }).unref?.();
  host = createRemoteAgentHost({
    nativeHistory: createNativeHistoryTransfer(path.join(options.userDataDir, 'native-history-transfers'), nativeHistoryStorage(options.userDataDir)),
    fastPolicy: receiveGroupFastPolicy,
    prepareImageEvent: (sessionId, event, upstream, retainForRecovery) => prepareGeneratedImageTransport(`remote:${sessionId}`, event, { upstream, retainForRecovery, invoke: remoteBackgroundInvoke }),
    imageArtifacts: async (sessionId, request) => {
      try { return await handleGeneratedImageArtifacts(sessionId, request, remoteBackgroundInvoke); }
      catch (error) { throw new Error(generatedImageErrorCode(error)); }
    },
    readLimits: () => readRemoteAgentLimitsState().value,
    isAgentAvailable: (kind) => {
      try {
        return options.getMaker().listAvailableAgents().includes(kind);
      } catch {
        return false;
      }
    },
    startHosted: async (input) => {
      if (input.groupProviderId) await bindLocalHostedGroupFastPolicy(input.groupProviderId, input.hostSessionId);
      return options.getMaker().startHostedAgentSession(input.kind, {
        ...hostedStartOptions(input),
        fastModePolicy: createSubscriptionFastPolicy(input.hostSessionId, () => getSessionProvider(input.hostSessionId) ?? input.options.providerId),
      });
    },
    forkHosted: (kind, opts) => options.getMaker().forkSdkSession(kind, opts),
    bindOwnerProviderRoute: bindHostedSessionProvider,
    ownerModelAllowed: (hostSessionId, providerId, kind, model) => hasHostedSessionModelAccess(hostSessionId)
      && hostedProviderOffersModel(hostSessionId, providerId, kind, model),
    isControllerAuthorized,
    controllerTrust: (controller) => (isProviderSharePeer(controller) ? 'guest' : 'owner'),
    providerAccess: {
      models: async (kind, providerId, controller, sessionId) => {
        const views = await getDesktopProviderService().listProviders({ allowSideEffects: false });
        const access = isProviderSharePeer(controller) ? guestAccessForTask(controller, sessionId) : null;
        if (isProviderSharePeer(controller) && access?.providerId !== providerId) return [];
        return guestProviderModelIds(views, providerId, kind)
          .filter(model => isControllerAuthorized(controller) && isRemoteProviderInvocationAllowed(providerId)
            && shareTaskModelAllowed(controller, model, sessionId)
            && remoteModelAccess.allows(providerId, model, access?.memberId));
      },
      restricted: (providerId, controller, sessionId) => {
        try {
          if (delegatedProviderShareGuestAccess(controller)) return true;
          const access = isProviderSharePeer(controller) ? guestAccessForTask(controller, sessionId) : null;
          const rule = remoteModelAccess.read(providerId, access?.memberId);
          return rule.models !== null || rule.providerModels !== null || !!(rule.memberBudget?.enabled && rule.memberBudget.rules.length);
        } catch { return true; }
      },
      resolve: async (kind, model, providerId, controller, sessionId) => {
        const views = await getDesktopProviderService().listProviders({ allowSideEffects: false });
        const access = isProviderSharePeer(controller) ? guestAccessForTask(controller, sessionId) : null;
        const memberId = access?.memberId;
        const allowed = (id: string) => {
          if (!isRemoteProviderInvocationAllowed(id) || !shareTaskModelAllowed(controller, model, sessionId) || !remoteModelAccess.allows(id, model, memberId)) return false;
          assertMemberBudget(id, model, memberId);
          return true;
        };
        // 受邀者：来源钉在分享的供应商上，且要它提供所选模型(启动与每次换模型都核对)。
        if (isProviderSharePeer(controller)) {
          // G still names O's shared provider; M resolves that alias to its own group member provider.
          const delegated = sessionId ? delegatedProviderShareTaskAccess(controller, sessionId) : null;
          return resolveGuestProviderId(
            views,
            access?.providerId,
            (id) => guestAllows(controller, id, sessionId) && allowed(id),
            kind,
            model,
            delegated ? undefined : providerId,
          );
        }
        return resolveSharedProviderId(views, allowed, kind, model, providerId);
      },
      isAllowed: (providerId, controller, model, sessionId) => {
        const access = isProviderSharePeer(controller) ? guestAccessForTask(controller, sessionId) : null;
        return (isProviderSharePeer(controller) ? guestAllows(controller, providerId, sessionId) : isRemoteProviderInvocationAllowed(providerId))
          && shareTaskModelAllowed(controller, model ?? '', sessionId)
          && remoteModelAccess.allows(providerId, model ?? '', access?.memberId)
          && (assertMemberBudget(providerId, model ?? '', access?.memberId), true);
      },
    },
    // 受邀者任务的出站登记：本机 proxy 只让它经分享的供应商、用它提供的模型。
    bindGuestProviderRoute: createGuestProviderRouteBinder({
      readProviders: () => getDesktopProviderService().listProviders({ allowSideEffects: false }),
      guestAccess: guestAccessForTask,
      modelAllowed: shareTaskModelAllowed,
      modelRestricted: (controller, sessionId) => delegatedProviderShareTaskAccess(controller, sessionId) !== null,
      ownerAllowed: isControllerAuthorized,
      providerAllowed: isRemoteProviderInvocationAllowed,
      modelAccess: remoteModelAccess,
      memberBudgetAllows,
      memberBudgetDenial,
      receiptMeteringAllowed: (controller, sessionId) => delegatedProviderShareTaskAccess(controller, sessionId) === null,
      recordRequestUsage: (controller, providerId, kind, sample) => {
        const peer = parseProviderSharePeer(controller);
        if (peer?.role === 'guest' && peer.memberId) usage.record(peer.shareId, peer.memberId,
          { providerId, kind, memberKey: 'local', samples: [{ ...sample, turns: 0, sdkCostUsd: 0 }] });
      },
    }),
    // Codex 与 Pi 的会话历史在受邀者目录里，随它整体删除；这里清 Claude Code 的项目记录与 Pi 子代理运行目录。
    purgeHostedTranscripts: async (hostSessionIds, nativeIds) => {
      const assertCurrent = captureProviderManagementScope();
      const images = captureGeneratedImageStorage();
      for (const id of hostSessionIds) {
        for (const record of await images.journal.list(`remote:${id}`)) await images.release(record.scope, record.id);
      }
      await purgeClaudeHostedTranscripts(hostSessionIds);
      await purgeClaudeHostedSessionArtifacts(nativeIds);
      await purgePiHostedSubagentRuns(hostSessionIds, path.join(options.userDataDir, 'pi-agent-home'));
      // These histories have been permanently revoked and purged. Ordinary
      // task close/idle retains bindings so resuming cannot restore Fast.
      await groupFastPolicyStore.forgetSessions(hostSessionIds, assertCurrent);
    },
    recordGuestUsage: (controller, sample, sessionId) => {
      const peer = parseProviderSharePeer(controller);
      if (peer?.role === 'guest' && peer.memberId) {
        // O receives only model/counter data for the matching delegated task.
        const authority = sessionId && delegatedProviderShareReceiptAuthority(controller, sessionId);
        if (authority) {
          for (let i = 0; i < sample.samples.length; i += 64) {
            const usageId = randomUUID();
            const request: Extract<RemoteAgentRequest, { op: 'direct-usage' }> = {
              op: 'direct-usage', shareId: peer.shareId, memberId: peer.memberId,
              guestDeviceId: peer.deviceId, sessionId, generation: authority.generation, usageId,
              agentKind: sample.kind, samples: sample.samples.slice(i, i + 64),
            };
            if (pendingUsage.size >= 20_000) pendingUsage.delete(pendingUsage.keys().next().value!);
            pendingUsage.set(usageId, { owner: authority.ownerDeviceId, request, at: Date.now(), sending: false });
            sendPendingUsage(usageId);
          }
        } else if (ownedProviderShareGuestAccess(controller)) {
          usage.record(peer.shareId, peer.memberId, sample);
        } else {
          log.warn('provider share delegated usage could not be attributed to owner', {
            shareId: peer.shareId, memberId: peer.memberId,
          });
        }
      }
      // 同账号的组所在电脑替它的受邀者转过来的任务：记在那台电脑名下(经那台使用)。
      else if (!peer) recordDeviceUsage(controller, sample, 'relay');
    },
    recordOwnerUsage: (controller, sample) => recordDeviceUsage(controller, sample, 'device'),
    // 供应商组(本机是组所在电脑)：受邀者的任务按组分给组内电脑，本机中转(provider-groups.md §4)。
    groupRelay,
    directGuestExecution: {
      ownerScope: providerShareOwnerKey,
      async locate(controller, request) {
        const key = JSON.stringify([controller, request.sessionId]);
        while (allocations.has(key)) await allocations.get(key);
        const { location } = directTaskContext(controller, request.sessionId);
        return location ? { deviceId: location.executorDeviceId } : null;
      },
      async acceptRelay(controller, sessionId, hasNativeHistory) {
        const key = JSON.stringify([controller, sessionId]);
        while (allocations.has(key)) await allocations.get(key);
        let finish!: () => void;
        const turn = new Promise<void>((resolve) => { finish = resolve; });
        allocations.set(key, turn);
        try {
          const { identity, location } = directTaskContext(controller, sessionId);
          if (!location) return;
          if (hasNativeHistory) throw new Error('[REMOTE_AGENT_UNAVAILABLE] Native history belongs to its original executor');
          await withDelegationGrant(JSON.stringify([identity.shareId, identity.memberId,
            identity.guestDeviceId, location.executorDeviceId]), async () => {
            const current = directTaskContext(controller, sessionId);
            if (current.identity.ownerScope !== identity.ownerScope
              || current.identity.ownerDeviceId !== identity.ownerDeviceId
              || current.location?.generation !== location.generation) {
              throw new Error('[REMOTE_AGENT_UNAVAILABLE] Provider share assignment changed');
            }
            const routes = usage.listActiveDirectReceiptRoutes(identity.ownerScope).filter((route) =>
              route.ownerDeviceId === identity.ownerDeviceId && route.shareId === identity.shareId
              && route.memberId === identity.memberId && route.guestDeviceId === identity.guestDeviceId
              && route.sessionId === sessionId);
            for (const route of routes) await usage.markDirectReceiptRouteRevoked(route);
            if (!await usage.markDirectTaskRelayed(identity, location.generation)) {
              throw new Error('[REMOTE_AGENT_UNAVAILABLE] Provider share assignment changed');
            }
            // Remote revocation is best effort; the durable handoff must finish
            // before O accepts history, even if the failed executor is offline.
            void revokeRetiredDirectReceiptRoutes(key, routes);
          });
        } finally {
          if (allocations.get(key) === turn) allocations.delete(key);
          finish();
        }
      },
      async allocate(controller, request) {
        const routeKey = JSON.stringify([controller, request.sessionId]);
        while (allocations.has(routeKey)) await allocations.get(routeKey);
        let finish!: () => void;
        const turn = new Promise<void>((resolve) => { finish = resolve; });
        allocations.set(routeKey, turn);
        try {
        const peer = parseProviderSharePeer(controller);
        const access = ownedProviderShareGuestAccess(controller);
        if (peer?.role !== 'guest' || !access || !isRemoteProviderInvocationAllowed(access.providerId)
          || !remoteModelAccess.allowsDelegatedExecution(access.providerId, request.model, access.memberId)) return null;
        if (!directRoutes.has(routeKey) && directRoutes.size >= 512) return null;
        const { identity, location, joinedAt } = directTaskContext(controller, request.sessionId);
        const old = restoreDirectRoute(controller, request.sessionId) ?? undefined;
        const group = readProviderGroup(access.providerId);
        if (location && (location.agentKind !== request.agentKind
          || (request.preferredExecutorDeviceId && request.preferredExecutorDeviceId !== location.executorDeviceId))) return null;
        const preferred = location?.executorDeviceId ?? request.preferredExecutorDeviceId;
        // A live G→M task cannot be renewed on a newly selected M: its run and
        // reliable link remain on the original executor, including after O restarts.
        if (preferred && !location && !group?.members.some((member) => member.kind === 'device'
          && member.agentDeviceId === preferred)) return null;
        if (preferred && readDeviceLinkSettings().revokedControllers.includes(preferred)) return null;
        const retained = old && old.expiresAt > Date.now() && old.groupProviderId === access.providerId
          && old.agentKind === request.agentKind && old.model === request.model
          && (!preferred || old.executorDeviceId === preferred)
          && liveDirectTargetAllowed(old);
        const selected = location ? { agentDeviceId: location.executorDeviceId, providerId: location.executorProviderId,
          memberKey: location.memberKey, sameAccount: true }
          : retained ? { agentDeviceId: old.executorDeviceId, providerId: old.providerId,
          memberKey: old.memberKey, sameAccount: true }
          : await groupRelay.plan({ kind: request.agentKind, model: request.model,
            providerId: access.providerId,
            exclude: preferred ? new Set(group!.members.filter((member) => member.kind !== 'device'
              || member.agentDeviceId !== preferred).map((member) => member.key)) : new Set(), reserve: true });
        if (!selected || !('sameAccount' in selected) || !selected.sameAccount
          || (preferred && selected.agentDeviceId !== preferred)) {
          if (selected && 'load' in selected) selected.load?.release();
          return null;
        }
        try {
          const assertCurrent = (generation = location?.generation) => {
            const current = directTaskContext(controller, request.sessionId);
            const live = current.access;
            const currentGroup = readProviderGroup(access.providerId);
            if (current.identity.ownerScope !== identity.ownerScope || current.identity.ownerDeviceId !== identity.ownerDeviceId
              || current.joinedAt !== joinedAt
              || current.location?.generation !== generation
              || readDeviceLinkSettings().revokedControllers.includes(selected.agentDeviceId)
              || live.providerId !== access.providerId || !remoteModelAccess.allowsDelegatedExecution(live.providerId, request.model, live.memberId)
              || (!location && !currentGroup?.members.some((member) => member.kind === 'device'
                && member.key === selected.memberKey && member.agentDeviceId === selected.agentDeviceId
                && member.providerId === selected.providerId))) {
              throw new Error('Provider share access changed');
            }
          };
          const { invoke } = groupRelay.connect(selected.agentDeviceId);
          const caps = await RemoteAgentRunClient.caps(invoke);
          assertCurrent();
          if (!caps.directGuestExecution || !caps.guestRelay) {
            if ('load' in selected) selected.load?.release();
            return null;
          }
          const delegation = { shareId: peer.shareId, memberId: peer.memberId,
            guestDeviceId: peer.deviceId, executorDeviceId: selected.agentDeviceId };
          return await withDelegationGrant(JSON.stringify([delegation.shareId, delegation.memberId,
            delegation.guestDeviceId, delegation.executorDeviceId]), async () => {
          const ownerDeviceId = getSelfDeviceId();
          if (!ownerDeviceId) {
            if ('load' in selected) selected.load?.release();
            return null;
          }
          const ownerScope = providerShareOwnerKey();
          const cleaned = await settlePendingDirectCleanup(delegation, invoke);
          assertCurrent();
          if (getSelfDeviceId() !== ownerDeviceId || providerShareOwnerKey() !== ownerScope) {
            throw new Error('Provider share owner changed');
          }
          const effectiveOld = directRoutes.get(routeKey) === old ? old : undefined;
          const effectiveRetained = !!(retained && effectiveOld && !cleaned);
          const previousReceipt = effectiveOld?.executorDeviceId === selected.agentDeviceId
            ? usage.listActiveDirectReceiptRoutes(providerShareOwnerKey()).find((saved) =>
              saved.ownerDeviceId === ownerDeviceId && saved.shareId === peer.shareId
              && saved.memberId === peer.memberId && saved.guestDeviceId === peer.deviceId
              && saved.sessionId === request.sessionId && saved.executorDeviceId === selected.agentDeviceId
              && saved.generation === effectiveOld.generation && saved.committedAt !== undefined)
            : undefined;
          // The executor checks this server grant before installing a local
          // guest lease. Never lengthen its lease ahead of server confirmation.
          const granted = await grantProviderShareDelegation(delegation);
          const receiptRoute = {
            ownerScope, ownerDeviceId,
            memberJoinedAt: joinedAt,
            ...delegation, sessionId: request.sessionId, agentKind: request.agentKind,
            executorProviderId: selected.providerId,
            providerId: access.providerId, memberKey: selected.memberKey,
            model: request.model, generation: granted.generation, expiresAt: granted.expiresAt,
          };
          let memberGrantAttempted = false;
          try {
            await verifyProviderShareMemberGeneration({ ...delegation, joinedAt });
            assertCurrent();
            // Persist a provisional route before M can execute. A crash before
            // commit leaves recovery enough information to revoke M's lease.
            const cleanupEpoch = await usage.registerDirectReceiptRoute(receiptRoute);
            // M authenticates O against the server pair grant and persists the
            // policy before its task lease can admit a guessed/reused task ID.
            await bindGroupFastPolicy({ group: access.providerId, deviceId: selected.agentDeviceId,
              sessionId: request.sessionId,
              providerShareGuest: { shareId: peer.shareId, memberId: peer.memberId, guestDeviceId: peer.deviceId } });
            assertCurrent();
            memberGrantAttempted = true;
            await invoke([{ op: 'delegate', action: 'grant', shareId: peer.shareId,
              memberId: peer.memberId, guestDeviceId: peer.deviceId, providerId: selected.providerId,
              model: request.model, sessionId: request.sessionId, generation: granted.generation, cleanupEpoch }]);
            assertCurrent();
            await usage.commitDirectReceiptRoute(receiptRoute);
            assertCurrent(receiptRoute.generation);
            assertCommittedDirectRoute(receiptRoute);
            if (effectiveOld && !effectiveRetained) {
              if (effectiveOld.executorDeviceId !== selected.agentDeviceId) revokeDirectRoute(routeKey, effectiveOld);
              else effectiveOld.load?.release();
            }
            const load = ('load' in selected ? selected.load : effectiveRetained ? effectiveOld?.load : undefined)
              ?? groupRelay.trackRun(access.providerId, selected.memberKey);
            if (!effectiveRetained) load.setRunning(false);
            directRoutes.set(routeKey, { ...delegation, providerId: selected.providerId,
              groupProviderId: access.providerId, memberKey: selected.memberKey,
              agentKind: request.agentKind, model: request.model, sessionId: request.sessionId,
              expiresAt: granted.expiresAt, generation: granted.generation,
              load, lastStatusAt: effectiveRetained ? effectiveOld!.lastStatusAt : Date.now() });
            if (previousReceipt) await retireDirectReceiptRoutes([previousReceipt]);
            assertCurrent(receiptRoute.generation);
            assertCommittedDirectRoute(receiptRoute);
            return { deviceId: selected.agentDeviceId, generation: granted.generation,
              leaseDurationMs: Math.min(30 * 60_000, Math.max(0, Math.floor(granted.expiresAt - Date.now()))) };
          } catch (error) {
            dropLiveDirectReceiptRoute(receiptRoute);
            // M's new grant may have replaced an active A lease. Re-grant A with
            // a fresh server generation, keeping its run alive and its journal
            // current. This also rolls back a failed B model authorization.
            let previousRestored = false;
            if (previousReceipt && previousDirectRouteAllowed(previousReceipt)) {
              try {
                const restored = await restorePreviousDirectGrant(previousReceipt);
                if (effectiveOld && directRoutes.get(routeKey) === effectiveOld) directRoutes.set(routeKey, {
                  ...effectiveOld, generation: restored.generation, expiresAt: restored.expiresAt,
                });
                await retireDirectReceiptRoutes([previousReceipt, receiptRoute]);
                previousRestored = true;
              } catch (restoreError) {
                log.warn('provider group previous direct route restoration failed', {
                  executorDeviceId: selected.agentDeviceId, error: String(restoreError),
                });
              }
            }
            if (previousRestored) throw error;
            // M may never have accepted the new grant. Quarantine O's old route
            // until a fresh grant confirms its state, without revoking g1's
            // committed evidence merely because g2 was sent.
            if (previousReceipt) dropLiveDirectReceiptRoute(previousReceipt);
            else if (effectiveOld && effectiveOld.executorDeviceId === selected.agentDeviceId
              && directRoutes.get(routeKey) === effectiveOld) {
              directRoutes.delete(routeKey);
              effectiveOld.load?.release();
              directSwitchIssued.delete(routeKey);
            }
            const revoked = await Promise.allSettled([
              invoke([{ op: 'delegate', action: 'revoke', shareId: peer.shareId,
                memberId: peer.memberId, guestDeviceId: peer.deviceId, providerId: selected.providerId,
                model: request.model, sessionId: request.sessionId, generation: granted.generation }]),
              revokeUnusedDirectPair(receiptRoute),
            ]);
            if (revoked.every((result) => result.status === 'fulfilled')) {
              if (memberGrantAttempted && previousReceipt && previousDirectRouteAllowed(previousReceipt)) {
                // g2 could have missed M entirely. Keep the provisional marker
                // so restart/reconciliation retries g1 without advertising it.
                log.warn('provider group previous direct route restoration will retry', {
                  executorDeviceId: selected.agentDeviceId,
                });
              } else {
                try {
                  if (memberGrantAttempted && previousReceipt) {
                    await usage.markDirectReceiptRouteRevoked(previousReceipt);
                  }
                  await usage.markDirectReceiptRouteRevoked(receiptRoute);
                } catch (revokeError) {
                  log.warn('provider group direct route journal revocation will retry', {
                    error: String(revokeError),
                  });
                }
              }
            } else {
              log.warn('provider group failed allocation revocation will retry', {
                executorDeviceId: selected.agentDeviceId,
              });
            }
            throw error;
          }
          });
        } catch (error) {
          if ('load' in selected) selected.load?.release();
          log.warn('provider group direct allocation failed', { error: String(error) });
          return null;
        }
        } finally {
          if (allocations.get(routeKey) === turn) allocations.delete(routeKey);
          finish();
          if (reconcileAfterAllocation) {
            reconcileAfterAllocation = false;
            void reconcileDirectJournal();
          }
        }
      },
      status(controller, request) {
        const route = restoreDirectRoute(controller, request.sessionId);
        if (!route || route.expiresAt <= Date.now() || !ownedProviderShareGuestAccess(controller)) return;
        route.load?.setRunning(request.running);
        route.lastStatusAt = Date.now();
      },
      async release(controller, request) {
        const peer = parseProviderSharePeer(controller);
        const ownerDeviceId = getSelfDeviceId();
        if (peer?.role !== 'guest' || !ownerDeviceId) return;
        const key = JSON.stringify([controller, request.sessionId]);
        // A failed g1 open can report after g2 has already been allocated.
        // Serialize with allocation before comparing the durable generation.
        while (allocations.has(key)) await allocations.get(key);
        let finish!: () => void;
        const turn = new Promise<void>((resolve) => { finish = resolve; });
        allocations.set(key, turn);
        try {
          const ownerScope = providerShareOwnerKey();
          const current = () => usage.listActiveDirectReceiptRoutes(ownerScope)
            .filter((route) => route.ownerDeviceId === ownerDeviceId
              && route.shareId === peer.shareId && route.memberId === peer.memberId
              && route.guestDeviceId === peer.deviceId && route.sessionId === request.sessionId);
          const candidate = current().at(-1);
          if (!candidate || candidate.committedAt === undefined
            || candidate.generation !== request.generation) return;
          const linkKey = JSON.stringify([peer.shareId, peer.memberId, peer.deviceId,
            candidate.executorDeviceId]);
          await withDelegationGrant(linkKey, async () => {
            const routes = current();
            const saved = routes.at(-1);
            if (!saved || saved.committedAt === undefined || saved.generation !== request.generation
              || ownerScope !== providerShareOwnerKey() || ownerDeviceId !== getSelfDeviceId()) return;
            // The journal is the restart boundary. A failed write leaves the
            // assignment intact so reconciliation can still find it.
            for (const route of routes) await usage.markDirectReceiptRouteRevoked(route);
            await revokeRetiredDirectReceiptRoutes(key, routes);
          });
        } finally {
          if (allocations.get(key) === turn) allocations.delete(key);
          finish();
        }
      },
      switch(controller, request) {
        const key = JSON.stringify([controller, request.sessionId]);
        const pending = directSwitchPending.get(key);
        if (pending) return pending;
        if (allocations.has(key)) return Promise.resolve({});
        const current = restoreDirectRoute(controller, request.sessionId);
        const previous = directSwitchIssued.get(key);
        if (current && previous?.generation === current.generation && Date.now() - previous.at < 2 * 60_000
          && ownedProviderShareGuestAccess(controller) && current.expiresAt > Date.now()
          && remoteModelAccess.allowsDelegatedExecution(current.groupProviderId, current.model, current.memberId)
          && readProviderGroup(current.groupProviderId)?.autoSwitch === true
          && liveDirectTargetAllowed(current)) {
          return Promise.resolve({ token: previous.token });
        }
        const lastAttempt = directSwitchAttempts.get(key) ?? 0;
        if (Date.now() - lastAttempt < 10_000 || directSwitchPending.size >= 32) return Promise.resolve({});
        directSwitchAttempts.set(key, Date.now());
        for (const [id, at] of directSwitchAttempts) {
          if (Date.now() - at >= 2 * 60_000) directSwitchAttempts.delete(id);
        }
        if (directSwitchAttempts.size > 512) directSwitchAttempts.delete(directSwitchAttempts.keys().next().value!);
        const work = (async (): Promise<{ token?: string }> => {
          const peer = parseProviderSharePeer(controller);
          const route = directRoutes.get(key);
          if (peer?.role !== 'guest' || !route || route.expiresAt <= Date.now()
            || route.shareId !== peer.shareId || route.memberId !== peer.memberId
            || route.guestDeviceId !== peer.deviceId) return {};
          const valid = () => {
            const live = directRoutes.get(key);
            const access = ownedProviderShareGuestAccess(controller);
            const group = readProviderGroup(route.groupProviderId);
            return live === route && route.expiresAt > Date.now()
              && access?.providerId === route.groupProviderId
              && isRemoteProviderInvocationAllowed(route.groupProviderId)
              && remoteModelAccess.allowsDelegatedExecution(route.groupProviderId, route.model, route.memberId)
              && group?.autoSwitch === true
              && liveDirectTargetAllowed(route);
          };
          if (!valid()) return {};
          const issued = directSwitchIssued.get(key);
          if (issued?.generation === route.generation && Date.now() - issued.at < 2 * 60_000) {
            return { token: issued.token };
          }
          for (const [id, item] of directSwitchIssued) {
            if (Date.now() - item.at >= 2 * 60_000) directSwitchIssued.delete(id);
          }
          if (directSwitchIssued.size >= 512) return {};
          // The guest's error is only a request to move its own task. It never
          // cools an executor or changes group health without an owner-side signal.
          const group = readProviderGroup(route.groupProviderId);
          const exclude = new Set(group?.members.filter((member) => member.kind === 'device'
            && member.agentDeviceId === route.executorDeviceId).map((member) => member.key) ?? [route.memberKey]);
          const next = await groupRelay.plan({ kind: route.agentKind as 'claude-code' | 'codex' | 'pi',
            model: route.model, providerId: route.groupProviderId,
            exclude }).catch(() => null);
          const canMove = next?.kind === 'member' || (next?.kind === 'local'
            && options.getMaker().listAvailableAgents().includes(route.agentKind as 'claude-code' | 'codex' | 'pi'));
          if (!valid() || !next || !canMove || (next.kind === 'member' && exclude.has(next.memberKey))) return {};
          const token = host?.issueDirectGroupSwitchToken(controller, request.sessionId,
            exclude);
          if (!token) return {};
          directSwitchIssued.set(key, { generation: route.generation,
            executorDeviceId: route.executorDeviceId, at: Date.now(), token });
          return { token };
        })().finally(() => { directSwitchPending.delete(key); });
        directSwitchPending.set(key, work);
        return work;
      },
      async switched(controller, sessionId, token) {
        const key = JSON.stringify([controller, sessionId]);
        while (allocations.has(key)) await allocations.get(key);
        let finish!: () => void;
        const turn = new Promise<void>((resolve) => { finish = resolve; });
        allocations.set(key, turn);
        try {
        const peer = parseProviderSharePeer(controller);
        const issued = directSwitchIssued.get(key);
        if (peer?.role !== 'guest' || !issued || issued.token !== token) return;
        const delegation = { shareId: peer.shareId, memberId: peer.memberId,
          guestDeviceId: peer.deviceId, executorDeviceId: issued.executorDeviceId };
        const ownerScope = providerShareOwnerKey();
        const ownerDeviceId = getSelfDeviceId();
        if (!ownerDeviceId) throw new Error('Provider share owner is unavailable');
        await withDelegationGrant(JSON.stringify([delegation.shareId, delegation.memberId,
          delegation.guestDeviceId, delegation.executorDeviceId]), async () => {
          if (directSwitchIssued.get(key) !== issued) return;
          const sameTaskRoutes = usage.listActiveDirectReceiptRoutes(ownerScope)
            .filter((route) => route.ownerDeviceId === ownerDeviceId
              && route.shareId === delegation.shareId && route.memberId === delegation.memberId
              && route.guestDeviceId === delegation.guestDeviceId && route.sessionId === sessionId);
          const routes = sameTaskRoutes
            .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
          const live = directRoutes.get(key);
          const location = directTaskContext(controller, sessionId).location;
          if ((live && (live.generation !== issued.generation
              || live.executorDeviceId !== issued.executorDeviceId))
            || (sameTaskRoutes.length && sameTaskRoutes.at(-1)?.generation !== issued.generation)
            || (location && location.generation !== issued.generation)
            || providerShareOwnerKey() !== ownerScope || getSelfDeviceId() !== ownerDeviceId) {
            throw new Error('Provider share direct assignment changed during switch');
          }
          // Disk is the restart boundary. A failed write leaves the token and
          // live route intact, so this open fails and can retry with the token.
          for (const route of routes) await usage.markDirectReceiptRouteRevoked(route);
          if (location && !await usage.markDirectTaskRelayed(location, issued.generation)) {
            throw new Error('Provider share direct assignment changed during switch');
          }
          void revokeRetiredDirectReceiptRoutes(key, routes);
          directSwitchAttempts.delete(key);
        });
        } finally {
          if (allocations.get(key) === turn) allocations.delete(key);
          finish();
        }
      },
      sessionAllowed: (controller, sessionId) => ownedProviderShareGuestAccess(controller) !== null
        || delegatedProviderShareSessionAllowed(controller, sessionId),
      sessionDelegated: (controller, sessionId) => delegatedProviderShareTaskAccess(controller, sessionId) !== null,
      async usage(controller, request) {
        const ownerDeviceId = getSelfDeviceId();
        if (!ownerDeviceId) throw new Error('REMOTE_AGENT_INVALID');
        await usage.recordDirectReceipt(providerShareOwnerKey(), ownerDeviceId, controller, request);
      },
      delegate(controller, request) { return applyProviderShareDelegation(controller, request); },
      forget: revokeDelegatedProviderShareGuest,
    },
    // 转分享(本机是分享者)：受邀者的组替它分享的人转来的任务，只在本机主人同意过那个人时运行。
    reshare: { canUse: (controller) => ownedProviderShareGuestAccess(controller) !== null,
      sync: handleProviderShareReshare, allows: providerShareReshareAllows },
    captureOwner: captureDataOwnerBroadcastScope,
    isOwnerCurrent: (owner) => isDataOwnerBroadcastScopeCurrent(owner as DataOwnerBroadcastScope),
    runsRoot: path.join(options.userDataDir, 'remote-agent'),
    log,
  });
  const current = host;
  const purgeMemberControllers = createProviderShareMemberPurger({
    userDataDir: options.userDataDir, usage, current,
    ownerScope: providerShareOwnerKey, ownerDeviceId: getSelfDeviceId,
    isCurrent: () => host === current, hasAccess: (controller) => ownedProviderShareGuestAccess(controller) !== null,
  });
  stopFastPolicySync = startGroupFastPolicySync();
  setRemoteAgentHandler({
    handle: async (controller, raw) => {
      await previousHostDisposal;
      if (host !== current) throw new Error('[REMOTE_AGENT_UNAVAILABLE] remote agent host has been replaced');
      return current.handle(controller, raw);
    },
    abortAll: (reason) => {
      void current.abortAll(reason);
    },
    abortControllers: (match) => current.abortControllers(match),
    revalidateModelAccess: () => current.revalidateModelAccess(),
    abortReshare: (match, reshareKey) => current.abortReshare(match, reshareKey),
    purgeControllers: purgeMemberControllers,
    activeControllers: () => current.activeControllers(),
    limitUsage: () => current.limitUsage(),
    turnRunningControllers: () => current.turnRunningControllers(),
    sharedGroupStatus: (providerId, guestController) => groupRelay.sharedStatus(providerId, guestController),
  });
}

/** 本机替其他电脑运行、正在运行一轮的远程 Agent 任务用的本机供应商(每个任务一项)；服务没起来时为空。 */
export function remoteAgentHostRunningProviders(): string[] {
  return host?.turnRunningProviders() ?? [];
}

export function resolveRemoteAgentHostClaudeSessionId(sdkSessionId: string): string | null {
  return host?.resolveClaudeSessionId(sdkSessionId) ?? null;
}

/** 退出时结束全部远程 Agent 任务。 */
export function disposeRemoteAgentHost(): void {
  if (delegationCheckTimer) clearInterval(delegationCheckTimer);
  delegationCheckTimer = undefined;
  if (directRouteSweep) clearInterval(directRouteSweep);
  directRouteSweep = undefined;
  stopDirectRouteWatch?.();
  stopDirectRouteWatch = undefined;
  stopDirectModelWatch?.();
  stopDirectModelWatch = undefined;
  stopDirectGroupWatch?.();
  stopDirectGroupWatch = undefined;
  stopDirectSettingsWatch?.();
  stopDirectSettingsWatch = undefined;
  stopFastPolicySync?.();
  stopFastPolicySync = undefined;
  setRemoteAgentHandler(null);
  if (host) hostDisposal = Promise.all([hostDisposal, host.dispose()]).then(() => undefined);
  host = null;
  clearProviderShareDelegations();
  void flushProviderShareUsage();
}

function flushProviderShareUsage(): Promise<void> {
  return Promise.all([getProviderShareUsageStore()?.flush(), flushProviderPartyUsage()]).then(() => undefined);
}

/**
 * 同账号另一台电脑在本机运行的这一轮(远程与分享页按使用方的用量)：那台自己的任务记在「我的其他电脑」下，
 * 那台作为组所在电脑替受邀者转来的记在「经其他电脑转来」下。
 */
function recordDeviceUsage(controller: string, sample: RunUsageRecord, via: 'device' | 'relay'): void {
  if (!sample.providerId) return;
  currentProviderPartyUsageStore().record(
    { kind: via, deviceId: controller },
    { kind: sample.kind, providerId: sample.providerId, memberKey: sample.memberKey, samples: sample.samples },
  );
}
