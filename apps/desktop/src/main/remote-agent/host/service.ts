/**
 * 远程 Agent 运行服务的被控端接线：把 `maker:remote-agent:v1` 接到本机 Maker 的 Agent。
 * 准入：本机打开了「允许远程控制」且没有撤销该控制端；账号切换后进行中的任务全部结束。
 */
import path from 'node:path';

import type { Maker, StartSessionOptions } from '@cindy/maker-core';

import { createLogger } from '../../logger.js';
import {
  captureDataOwnerBroadcastScope,
  isDataOwnerBroadcastScopeCurrent,
  type DataOwnerBroadcastScope,
} from '../../device-link/broadcast-tap.js';
import { setRemoteAgentHandler } from '../../device-link/dispatch.js';
import { readDeviceLinkSettings } from '../../device-link/settings-store.js';
import { getDesktopProviderService } from '../../maker-host/createDesktopProviderService.js';
import { isRemoteProviderInvocationAllowed } from '../../maker-host/remote-provider-access-store.js';
import { resolveSharedProviderId } from './providerAccess';
import { createRemoteAgentHost, type HostedStartInput, type RemoteAgentHost } from './runHost';

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
      mcpServers: [...input.mcpServers],
      mirrorRoot: input.mirrorRoot,
      ...(input.personalInstructions ? { personalInstructions: input.personalInstructions } : {}),
    },
    ...(input.onInvalidResumeSession ? { onInvalidResumeSession: input.onInvalidResumeSession } : {}),
  };
}

let host: RemoteAgentHost | null = null;

export function installRemoteAgentHost(options: { getMaker: () => Maker; userDataDir: string }): void {
  if (host) return;
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
      const settings = readDeviceLinkSettings();
      return settings.remoteControlEnabled && !settings.revokedControllers.includes(controller);
    },
    providerAccess: {
      resolve: async (kind, model, providerId) =>
        resolveSharedProviderId(
          await getDesktopProviderService().listProviders({ allowSideEffects: false }),
          isRemoteProviderInvocationAllowed,
          kind,
          model,
          providerId,
        ),
      isAllowed: isRemoteProviderInvocationAllowed,
    },
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
  });
}

/** 退出时结束全部远程 Agent 任务。 */
export function disposeRemoteAgentHost(): void {
  setRemoteAgentHandler(null);
  host?.dispose();
  host = null;
}
