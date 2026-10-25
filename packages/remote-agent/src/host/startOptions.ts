import type { StartSessionOptions } from '@cindy/maker-core';
import type { HostedStartInput } from './runHost.js';

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
