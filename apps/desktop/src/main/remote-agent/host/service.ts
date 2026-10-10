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
import { createProviderGroupGuestRelay } from '../../provider-group/guestRelay.js';
import { getProviderGroupOwnerScope } from '../../provider-group/runtime.js';
import { readProviderGroup } from '../../provider-group/store.js';
import { remoteAgentPollerFor } from '../controller/service';
import { getProviderShareUsageStore, installProviderShareUsageStore } from '../../device-link/providerShareUsageStore.js';
import { readDeviceLinkSettings } from '../../device-link/settings-store.js';
import { readTurnUsageResetAt } from '../../goal-host/usageLimit.js';
import { getDesktopProviderService } from '../../maker-host/createDesktopProviderService.js';
import { registerGuestProviderRoute } from '../../maker-host/guest-provider-route-store.js';
import { isRemoteProviderInvocationAllowed } from '../../maker-host/remote-provider-access-store.js';
import { guestProviderModelIds, resolveGuestProviderId, resolveSharedProviderId } from './providerAccess';
import { createRemoteAgentHost, type HostedStartInput, type RemoteAgentHost } from './runHost';
import { purgeClaudeHostedSessionArtifacts, purgeClaudeHostedTranscripts, purgePiHostedSubagentRuns } from './transcripts';

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

/** 受邀者能用的供应商：分享的那一个，且本机仍开放「允许被远程调用」。 */
function guestAllows(controller: string, providerId: string): boolean {
  const access = providerShareGuestAccess(controller);
  return !!access && access.providerId === providerId && isRemoteProviderInvocationAllowed(providerId);
}

export function installRemoteAgentHost(options: { getMaker: () => Maker; userDataDir: string }): void {
  if (host) return;
  const usage = installProviderShareUsageStore(options.userDataDir);
  host = createRemoteAgentHost({
    isAgentAvailable: (kind) => {
      try {
        return options.getMaker().listAvailableAgents().includes(kind);
      } catch {
        return false;
      }
    },
    startHosted: (input) => options.getMaker().startHostedAgentSession(input.kind, hostedStartOptions(input)),
    isControllerAuthorized: (controller) => {
      if (isProviderSharePeer(controller)) return providerShareGuestAccess(controller) !== null;
      const settings = readDeviceLinkSettings();
      return settings.remoteControlEnabled && !settings.revokedControllers.includes(controller);
    },
    controllerTrust: (controller) => (isProviderSharePeer(controller) ? 'guest' : 'owner'),
    providerAccess: {
      resolve: async (kind, model, providerId, controller) => {
        const views = await getDesktopProviderService().listProviders({ allowSideEffects: false });
        // 受邀者：来源钉在分享的供应商上，且要它提供所选模型(启动与每次换模型都核对)。
        if (isProviderSharePeer(controller)) {
          return resolveGuestProviderId(
            views,
            providerShareGuestAccess(controller)?.providerId,
            (id) => guestAllows(controller, id),
            kind,
            model,
            providerId,
          );
        }
        return resolveSharedProviderId(views, isRemoteProviderInvocationAllowed, kind, model, providerId);
      },
      isAllowed: (providerId, controller) =>
        isProviderSharePeer(controller) ? guestAllows(controller, providerId) : isRemoteProviderInvocationAllowed(providerId),
    },
    // 受邀者任务的出站登记：本机 proxy 只让它经分享的供应商、用它提供的模型。
    bindGuestProviderRoute: async ({ kind, hostSessionId, providerId, isCurrent }) => {
      const views = await getDesktopProviderService().listProviders({ allowSideEffects: false });
      // 读目录期间这次启动可能已被取代：此时不再登记(登记与检查之间没有 await)。
      if (!isCurrent()) return null;
      const binding = registerGuestProviderRoute(hostSessionId, providerId);
      return {
        routeToken: binding.token,
        modelIds: guestProviderModelIds(views, providerId, kind),
        release: binding.release,
      };
    },
    // Codex 与 Pi 的会话历史在受邀者目录里，随它整体删除；这里清 Claude Code 的项目记录与 Pi 子代理运行目录。
    purgeHostedTranscripts: async (hostSessionIds, nativeIds) => {
      await purgeClaudeHostedTranscripts(hostSessionIds);
      await purgeClaudeHostedSessionArtifacts(nativeIds);
      await purgePiHostedSubagentRuns(hostSessionIds, path.join(options.userDataDir, 'pi-agent-home'));
    },
    recordGuestUsage: (controller, sample) => {
      const peer = parseProviderSharePeer(controller);
      if (peer?.role === 'guest' && peer.memberId) usage.record(peer.shareId, peer.memberId, sample);
    },
    // 供应商组(本机是组所在电脑)：受邀者的任务按组分给组内电脑，本机中转(provider-groups.md §4)。
    groupRelay: createProviderGroupGuestRelay({
      scope: getProviderGroupOwnerScope,
      readGroup: readProviderGroup,
      connect: (agentDeviceId) => {
        const poller = remoteAgentPollerFor(agentDeviceId, remoteBackgroundInvoke, log);
        return { invoke: poller.invoke, poller };
      },
      // 组内电脑的报错用那台机器的本地时间：不带时区的钟点不按本机时区理解。
      readResetAt: (failure) => readTurnUsageResetAt(failure, Date.now(), { localTimeZoneTrusted: false }),
      now: () => Date.now(),
      log,
    }),
    captureOwner: captureDataOwnerBroadcastScope,
    isOwnerCurrent: (owner) => isDataOwnerBroadcastScopeCurrent(owner as DataOwnerBroadcastScope),
    runsRoot: path.join(options.userDataDir, 'remote-agent'),
    log,
  });
  const current = host;
  setRemoteAgentHandler({
    handle: (controller, raw) => current.handle(controller, raw),
    abortAll: () => {
      void current.abortAll();
    },
    abortControllers: (match) => current.abortControllers(match),
    purgeControllers: (match) => current.purgeControllers(match),
    activeControllers: () => current.activeControllers(),
    turnRunningControllers: () => current.turnRunningControllers(),
  });
}

/** 本机替其他电脑运行、正在运行一轮的远程 Agent 任务用的本机供应商(每个任务一项)；服务没起来时为空。 */
export function remoteAgentHostRunningProviders(): string[] {
  return host?.turnRunningProviders() ?? [];
}

/** 退出时结束全部远程 Agent 任务。 */
export function disposeRemoteAgentHost(): void {
  setRemoteAgentHandler(null);
  host?.dispose();
  host = null;
  void flushProviderShareUsage();
}

function flushProviderShareUsage(): Promise<void> {
  return getProviderShareUsageStore()?.flush() ?? Promise.resolve();
}
