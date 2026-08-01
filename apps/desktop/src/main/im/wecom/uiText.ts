import type { IMUnsupportedEntry } from '@cindy/im';

import type { ImUiTextPack } from '../shared/types';

export const ui = {
  slash: {
    new: '🌱 新任务已开始，之前的上下文已清空。',
    help: `🤖 可用命令：

/new         开始新任务
/stop        中止当前任务
/exctr       结束已有接管
/help        查看帮助

任务运行中可发送 \`!stop\` 中止当前任务并清空排队消息。`,
    unknownCommand: (cmd: string) =>
      `未识别命令 \`${cmd}\`。可用命令：/new、/stop、/exctr、/help`,
    detachedBySlash: '🚪 已结束接管，后续消息回到企业微信对话。',
    detachedByRevoke: '⚠️ desktop 端已收回接管，后续消息回到企业微信对话。',
    notAttached: '当前没有正在接管的任务。',
  },
  agent: {
    completedNoText: '✅ 任务已完成（本轮没有文本输出）',
    runtimeError: (errMsg: string) => `⚠️ Agent 执行失败：${errMsg.slice(0, 200)}`,
    sendInternalError: (errMsg: string) => `❌ 消息发送失败：${errMsg}`,
    apiKeyMissing: '⚠️ 当前模型尚未完成认证。请在 desktop 的设置中连接模型供应商后重试。',
    authMissing: ({ providerLabel, providerId, missing, agentKind, model, attached }) => {
      const provider = providerLabel ?? providerId ?? '当前供应商';
      const reason =
        missing === 'gateway-key'
          ? '需要先配置 Cindy AI Key'
          : missing === 'provider-key'
            ? '尚未配置该供应商的 API Key'
            : missing === 'provider-disconnected'
              ? '连接已断开或失效'
              : `需要先登录 ${agentKind}`;
      const message = `⚠️ 当前企业微信对话使用「${provider}」（${model}），${reason}。`;
      return attached
        ? `${message}\n请在 desktop 修复认证后继续发送消息。`
        : `${message}\n修改后请发送 \`/new\` 开始新任务。`;
    },
    controlInProgress: '🎮 接管选择尚未完成，请先处理上一条交互消息。',
    credentialBusy: '⏳ 本地 Agent 正在运行，暂时不能切换凭证模式，请稍后重试。',
    queuedNotice: (position: number) =>
      position <= 1
        ? '⏳ 上一轮仍在运行，这条消息已排队。需要中止可发送 `!stop`。'
        : `⏳ 上一轮仍在运行，这条消息排在第 ${position} 位。需要中止可发送 \`!stop\`。`,
    stopDone: (droppedQueued: number) =>
      droppedQueued > 0
        ? `⏹ 已中止当前任务，并移除 ${droppedQueued} 条排队消息。`
        : '⏹ 已中止当前任务。',
    stopIdle: '当前没有正在运行或排队的任务。',
    scheduledTaskHeader: (name: string | null) => (name ? `🤖 自动任务「${name}」` : '🤖 自动任务'),
    unsupportedOnly: (entries: IMUnsupportedEntry[]) =>
      `🙏 暂时无法处理这条消息：\n${entries.map((entry) => `• ${entry.label}`).join('\n')}`,
    unsupportedNotice: (entries: IMUnsupportedEntry[]) =>
      `ℹ️ 以下内容未能处理：\n${entries.map((entry) => `• ${entry.label}`).join('\n')}\n\n其它内容将继续处理。`,
  },
  cards: {
    permission: {
      title: (toolName: string) => `🔧 工具调用：${toolName}`,
      paramsLabel: '**参数预览**',
      btnAllowOnce: '✅ 仅本次允许',
      btnAllowAlways: '✅ 总是允许',
      btnDeny: '❌ 拒绝',
      resolvedAllowOnce: '✅ 已允许（仅本次）',
      resolvedAllowAlways: '✅ 已允许（以后均允许）',
      resolvedDeny: '❌ 已拒绝',
    },
    ask: {
      title: (header: string) => `❓ ${header}`,
      noOptionsHint: '_请直接回复文字。_',
      resolved: (optionLabel: string) => `✅ 已选择：${optionLabel}`,
    },
    plan: {
      title: '📋 执行计划',
      btnApprove: '✅ 批准',
      btnReject: '❌ 拒绝',
      resolvedApproved: '✅ 已批准',
      resolvedRejected: '❌ 已拒绝',
    },
    model: {
      title: '🤖 切换模型',
      currentLine: (label: string, effort: string | null, description: string) =>
        effort
          ? `**当前**：${label} · effort \`${effort}\`\n_${description}_`
          : `**当前**：${label}\n_${description}_`,
      hint: '请选择要使用的模型。',
      optionLabel: (providerName: string, label: string, effort: string | null) =>
        effort ? `${providerName} / ${label} · ${effort}` : `${providerName} / ${label}`,
      resolved: (label: string, effort: string | null) =>
        effort ? `✅ 已切换到 ${label}（effort：${effort}）` : `✅ 已切换到 ${label}`,
      failed: (reason: string) => `❌ 模型切换失败：${reason}`,
    },
    permissionMode: {
      title: '🛡️ 调整权限模式',
      currentLine: (label: string, description: string) => `**当前**：${label}\n_${description}_`,
      hint: '请选择权限模式。',
      optionLabel: (label: string) => label,
      resolved: (label: string) => `✅ 权限模式已切换到 ${label}`,
      failed: (reason: string) => `❌ 权限模式切换失败：${reason}`,
      fullAccessConfirmTitle: '⚠️ 确认开启 Full access？',
      fullAccessConfirmBody:
        'Full access 会关闭工作区沙箱并跳过常规审批。Cindy 可以修改工作区外文件并执行联网命令；内置高风险操作仍会要求确认。',
      btnConfirmFullAccess: '开启 Full access',
      btnCancelFullAccess: '保留当前权限',
      fullAccessCancelled: '已取消，保留当前权限',
    },
    control: {
      title: '🎮 选择工作区',
      emptyBody: '_暂时没有可接管的工作区，请先在 desktop 创建任务。_',
      hint: '选择工作区继续，或退出本次操作。',
      attachedSwitchHint: (sessionTitle: string) => `当前正在接管：**${sessionTitle}**`,
      btnExit: '🚪 退出',
      resolvedExit: '🚪 已退出接管',
      sessionPickerTitle: (displayName: string) => `🎮 ${displayName} 中的任务`,
      sessionPickerHint: '选择任务、创建新任务或返回上一步。',
      sessionPickerEmptyBody: (displayName: string) => `_${displayName} 中暂时没有可用任务。_`,
      btnNew: '➕ 新建',
      btnBack: '↩️ 返回',
      resolvedSessionPick: (sessionTitle: string, workspaceName: string) =>
        `🎯 已接管 **${sessionTitle}**（${workspaceName}）`,
      resolvedNewSession: (workspaceName: string) => `✨ 已在 **${workspaceName}** 新建并接管任务`,
      attachFailed: (reason: string) => `❌ 接管失败：${reason}`,
      sessionBusyOldCardPlaceholder: '⏳ 该任务仍在运行，请稍后重试。',
      sessionBusyPrompts: [
        (sessionTitle: string) => `⏳ **${sessionTitle}** 正在运行，请等待当前回合结束。`,
      ],
      takeoverLoadingPrompts: [(sessionTitle: string) => `⏳ 正在接管 **${sessionTitle}**…`],
      sessionAttachedOneshotPrompts: [
        '我已从企业微信接管此任务。请简要同步当前进度，并询问下一步指令。',
      ],
      newSessionWelcomePrompts: [
        (workspaceName: string) => `✨ 已在 **${workspaceName}** 创建新任务，可以发送第一条指令。`,
      ],
    },
  },
} satisfies ImUiTextPack;
