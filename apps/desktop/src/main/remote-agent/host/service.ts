import { readRemoteAgentLimitsState } from './limitsStore.js';
/**
 * 远程 Agent 运行服务的被控端接线：把 `maker:remote-agent:v1` 接到本机 Maker 的 Agent。
 * 准入：本机打开了「允许远程控制」且没有撤销该控制端；账号切换后进行中的任务全部结束。
 * 供应商分享的受邀者(其他账号)另按分享快照准入，只能用分享给它的那个供应商。
 */
import path from 'node:path';

import { isProviderSharePeer, parseProviderSharePeer } from '@cindy/device-link';
import type { Maker, StartSessionOptions } from '@cindy/maker-core';

import { createLogger } from '../../logger.js';
import {
  captureDataOwnerBroadcastScope,
  isDataOwnerBroadcastScopeCurrent,
  type DataOwnerBroadcastScope,
} from '../../device-link/broadcast-tap.js';
import { setRemoteAgentHandler } from '../../device-link/dispatch.js';
import { remoteBackgroundInvoke } from '../../device-link/index.js';
import { providerShareGuestAccess } from '../../device-link/providerShareHost.js';
import { remoteModelAccess } from '../../device-link/remoteModelAccess.js';
import { handleProviderShareReshare, providerShareReshareAllows } from '../../device-link/providerShareReshare.js';
import { createProviderGroupGuestRelay } from '../../provider-group/guestRelay.js';
import { providerGroupReshare } from '../../provider-group/reshareRuntime.js';
import { getProviderGroupOwnerScope } from '../../provider-group/runtime.js';
import { readProviderGroup } from '../../provider-group/store.js';
import { bindGroupFastPolicy, bindLocalHostedGroupFastPolicy, receiveGroupFastPolicy, startGroupFastPolicySync } from '../../provider-group/fastPolicyRuntime.js';
import { groupFastPolicyStore } from '../../provider-group/fastPolicyStore.js';
import { captureProviderManagementScope } from '../../provider-group/managementScope.js';
import { createSubscriptionFastPolicy } from '../../maker-host/subscription-fast-policy.js';
import { getSessionProvider } from '../../maker-host/session-provider-store.js';
import { remoteAgentPollerFor } from '../controller/service';
import { getProviderShareUsageStore, installProviderShareUsageStore } from '../../device-link/providerShareUsageStore.js';
import { currentProviderPartyUsageStore, flushProviderPartyUsage } from '../../usage/providerPartyUsageStore.js';
import { readDeviceLinkSettings } from '../../device-link/settings-store.js';
import { readTurnUsageResetAt } from '../../goal-host/usageLimit.js';
import { getDesktopProviderService } from '../../maker-host/createDesktopProviderService.js';
import { bindHostedSessionProvider, hasHostedSessionModelAccess } from '../../maker-host/session-provider-store.js';
import { hostedProviderOffersModel } from '../../maker-host/guest-provider-route-store.js';
import { isRemoteProviderInvocationAllowed } from '../../maker-host/remote-provider-access-store.js';
import { createGuestProviderRouteBinder, guestProviderModelIds, resolveGuestProviderId, resolveSharedProviderId } from './providerAccess';
import { createRemoteAgentHost, type HostedStartInput, type RemoteAgentHost, type RunUsageRecord } from './runHost';
import { purgeClaudeHostedSessionArtifacts, purgeClaudeHostedTranscripts, purgePiHostedSubagentRuns } from './transcripts';
import { captureGeneratedImageStorage, generatedImageErrorCode, handleGeneratedImageArtifacts, prepareGeneratedImageTransport } from '../../cindy-media/generatedImageStorage';

const log = createLogger('remote-agent:host');

/** 对方任务的启动选项 → 本机 Agent 的启动选项(工作目录是影子目录，工具经隧道回到对方)。 */
export function hostedStartOptions(input: HostedStartInput): StartSessionOptions {
  const { options, workspace } = input;
  return {
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
let stopFastPolicySync: (() => void) | undefined;

/** 受邀者能用的供应商：分享的那一个，且本机仍开放「允许被远程调用」。 */
function guestAllows(controller: string, providerId: string): boolean {
  const access = providerShareGuestAccess(controller);
  return !!access && access.providerId === providerId && isRemoteProviderInvocationAllowed(providerId);
}

export function installRemoteAgentHost(options: { getMaker: () => Maker; userDataDir: string }): void {
  if (host) return;
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
  host = createRemoteAgentHost({
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
      models: async (kind, providerId, controller) => {
        const views = await getDesktopProviderService().listProviders({ allowSideEffects: false });
        const access = isProviderSharePeer(controller) ? providerShareGuestAccess(controller) : null;
        if (isProviderSharePeer(controller) && access?.providerId !== providerId) return [];
        return guestProviderModelIds(views, providerId, kind)
          .filter(model => isControllerAuthorized(controller) && isRemoteProviderInvocationAllowed(providerId)
            && remoteModelAccess.allows(providerId, model, access?.memberId));
      },
      restricted: (providerId, controller) => {
        try {
          const access = isProviderSharePeer(controller) ? providerShareGuestAccess(controller) : null;
          const rule = remoteModelAccess.read(providerId, access?.memberId);
          return rule.models !== null || rule.providerModels !== null;
        } catch { return true; }
      },
      resolve: async (kind, model, providerId, controller) => {
        const views = await getDesktopProviderService().listProviders({ allowSideEffects: false });
        const memberId = isProviderSharePeer(controller) ? providerShareGuestAccess(controller)?.memberId : undefined;
        const allowed = (id: string) => isRemoteProviderInvocationAllowed(id) && remoteModelAccess.allows(id, model, memberId);
        // 受邀者：来源钉在分享的供应商上，且要它提供所选模型(启动与每次换模型都核对)。
        if (isProviderSharePeer(controller)) {
          return resolveGuestProviderId(
            views,
            providerShareGuestAccess(controller)?.providerId,
            (id) => guestAllows(controller, id) && allowed(id),
            kind,
            model,
            providerId,
          );
        }
        return resolveSharedProviderId(views, allowed, kind, model, providerId);
      },
      isAllowed: (providerId, controller, model) => {
        const access = isProviderSharePeer(controller) ? providerShareGuestAccess(controller) : null;
        return (isProviderSharePeer(controller) ? guestAllows(controller, providerId) : isRemoteProviderInvocationAllowed(providerId))
          && remoteModelAccess.allows(providerId, model ?? '', access?.memberId);
      },
    },
    // 受邀者任务的出站登记：本机 proxy 只让它经分享的供应商、用它提供的模型。
    bindGuestProviderRoute: createGuestProviderRouteBinder({
      readProviders: () => getDesktopProviderService().listProviders({ allowSideEffects: false }),
      guestAccess: providerShareGuestAccess,
      ownerAllowed: isControllerAuthorized,
      providerAllowed: isRemoteProviderInvocationAllowed,
      modelAccess: remoteModelAccess,
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
    recordGuestUsage: (controller, sample) => {
      const peer = parseProviderSharePeer(controller);
      if (peer?.role === 'guest' && peer.memberId) usage.record(peer.shareId, peer.memberId, sample);
      // 同账号的组所在电脑替它的受邀者转过来的任务：记在那台电脑名下(经那台使用)。
      else if (!peer) recordDeviceUsage(controller, sample, 'relay');
    },
    recordOwnerUsage: (controller, sample) => recordDeviceUsage(controller, sample, 'device'),
    // 供应商组(本机是组所在电脑)：受邀者的任务按组分给组内电脑，本机中转(provider-groups.md §4)。
    groupRelay,
    // 转分享(本机是分享者)：受邀者的组替它分享的人转来的任务，只在本机主人同意过那个人时运行。
    reshare: { sync: handleProviderShareReshare, allows: providerShareReshareAllows },
    captureOwner: captureDataOwnerBroadcastScope,
    isOwnerCurrent: (owner) => isDataOwnerBroadcastScopeCurrent(owner as DataOwnerBroadcastScope),
    runsRoot: path.join(options.userDataDir, 'remote-agent'),
    log,
  });
  const current = host;
  stopFastPolicySync = startGroupFastPolicySync();
  setRemoteAgentHandler({
    handle: (controller, raw) => current.handle(controller, raw),
    abortAll: () => {
      void current.abortAll();
    },
    abortControllers: (match) => current.abortControllers(match),
    revalidateModelAccess: () => current.revalidateModelAccess(),
    abortReshare: (match, reshareKey) => current.abortReshare(match, reshareKey),
    purgeControllers: (match) => current.purgeControllers(match),
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
  stopFastPolicySync?.();
  stopFastPolicySync = undefined;
  setRemoteAgentHandler(null);
  host?.dispose();
  host = null;
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
