/**
 * main/im/telegram/uiText.ts
 * ---------------------------------------------------------------------------
 * 个人 Telegram bot 渠道的用户文案包。DM + 群 lane 双形态, 不启用 threadScoped,
 * 只提供共享编排层的非 thread 文案字段。
 *
 * 控制文案跟随主人在 Cindy 里选的界面语言: 文案放在 desktop locale 的
 * `imBot.text.telegram.*` 下, 经 `imText` 在**发送时**现取 —— 字符串字段是 getter、
 * 带参字段是函数, 不在模块加载时求值, 主人切换语言后下一条消息即生效。
 * 消费方只按属性/函数读取; 不要把这个包展开或缓存成常量, 否则语言会被冻结在那一刻。
 */

import type { IMUnsupportedEntry } from '@cindy/im';

import { imText, type ImTextVars } from '../shared/imText';
import type { ImUiTextPack } from '../shared/types';

/** `imBot.text.telegram.<key>` 的当前语言文案。 */
function tg(key: string, vars?: ImTextVars): string {
  return imText(`imBot.text.telegram.${key}`, vars);
}

function bulletList(entries: IMUnsupportedEntry[]): string {
  return entries.map((e) => `• ${e.label}`).join('\n');
}

export const telegramUiText = {
  get expiredCardNotice() { return tg('expiredCardNotice'); },
};

export const ui = {
  slash: {
    get start() { return tg('slash.start'); },
    get new() { return tg('slash.new'); },
    get help() { return tg('slash.help'); },
    unknownCommand: (cmd: string) => tg('slash.unknownCommand', { cmd }),
    settings: ({ workspace, agent, model, effort, permission }) =>
      tg('slash.settings', { workspace, agent, model, effort, permission }),
    // 连接已交给伙伴: 五项读的是伙伴这条任务实际在用的, 要改去伙伴设置。
    settingsCompanion: ({ workspace, agent, model, effort, permission }) =>
      tg('slash.settingsCompanion', { workspace, agent, model, effort, permission }),
    get detachedBySlash() { return tg('slash.detachedBySlash'); },
    get detachedByRevoke() { return tg('slash.detachedByRevoke'); },
    get notAttached() { return tg('slash.notAttached'); },
    // 连接已交给伙伴(伙伴即 IM 本体)时的命令提示。
    get companionDmNew() { return tg('slash.companionDmNew'); },
    get companionLaneNew() { return tg('slash.companionLaneNew'); },
    get companionManagedCommand() { return tg('slash.companionManagedCommand'); },
  },

  agent: {
    get completedNoText() { return tg('agent.completedNoText'); },
    runtimeError: (errMsg: string) => tg('agent.runtimeError', { error: errMsg.slice(0, 200) }),
    sendInternalError: (errMsg: string) => tg('agent.sendInternalError', { error: errMsg }),
    get apiKeyMissing() { return tg('agent.apiKeyMissing'); },
    authMissing: ({ providerLabel, providerId, missing, agentKind, model, attached }) => {
      const provider = providerLabel ?? providerId ?? tg('agent.authMissing.currentProvider');
      const reason =
        missing === 'gateway-key'
          ? tg('agent.authMissing.reasonGatewayKey')
          : missing === 'provider-key'
            ? tg('agent.authMissing.reasonProviderKey')
            : missing === 'provider-disconnected'
              ? tg('agent.authMissing.reasonProviderDisconnected')
              : tg('agent.authMissing.reasonAgentLogin', { agentKind });
      const message = tg('agent.authMissing.message', { provider, model, reason });
      return attached
        ? `${message}\n${tg('agent.authMissing.attachedHint')}`
        : `${message}\n${tg('agent.authMissing.detachedHint')}`;
    },
    get controlInProgress() { return tg('agent.controlInProgress'); },
    get credentialBusy() { return tg('agent.credentialBusy'); },
    queuedNotice: (position: number) =>
      position <= 1 ? tg('agent.queuedNoticeFirst') : tg('agent.queuedNotice', { position }),
    /** `!stop` 生效 — 当前执行已中止, 任务保留可继续。 */
    stopDone: (droppedQueued: number) =>
      droppedQueued > 0
        ? tg('agent.stopDoneDropped', { count: droppedQueued })
        : tg('agent.stopDone'),
    /** `!stop` 时没有任务在跑。 */
    get stopIdle() { return tg('agent.stopIdle'); },
    scheduledTaskHeader: (name: string | null) =>
      name ? tg('agent.scheduledTaskHeaderNamed', { name }) : tg('agent.scheduledTaskHeader'),
    unsupportedOnly: (entries: IMUnsupportedEntry[]) =>
      tg('agent.unsupportedOnly', { list: bulletList(entries) }),
    unsupportedNotice: (entries: IMUnsupportedEntry[]) =>
      tg('agent.unsupportedNotice', { list: bulletList(entries) }),
    companionUnavailable: (reason: string) =>
      tg('agent.companionUnavailable', { reason: reason.slice(0, 200) }),
  },

  error: {
    get agentUnsupported() { return tg('error.agentUnsupported'); },
    permissionModeUnsupported: (mode: string) =>
      mode === 'bypassPermissions'
        ? tg('error.permissionModeUnsupportedFullAccess')
        : tg('error.permissionModeUnsupported'),
  },

  cards: {
    permission: {
      title: (toolName: string) => tg('cards.permission.title', { tool: toolName }),
      get paramsLabel() { return tg('cards.permission.paramsLabel'); },
      get btnAllowOnce() { return tg('cards.permission.btnAllowOnce'); },
      get btnAllowAlways() { return tg('cards.permission.btnAllowAlways'); },
      get btnDeny() { return tg('cards.permission.btnDeny'); },
      get resolvedAllowOnce() { return tg('cards.permission.resolvedAllowOnce'); },
      get resolvedAllowAlways() { return tg('cards.permission.resolvedAllowAlways'); },
      get resolvedDeny() { return tg('cards.permission.resolvedDeny'); },
    },
    ask: {
      title: (header: string) => `❓ ${header}`,
      get noOptionsHint() { return tg('cards.ask.noOptionsHint'); },
      resolved: (optionLabel: string) => tg('cards.ask.resolved', { option: optionLabel }),
    },
    plan: {
      get title() { return tg('cards.plan.title'); },
      get btnApprove() { return tg('cards.plan.btnApprove'); },
      get btnReject() { return tg('cards.plan.btnReject'); },
      get resolvedApproved() { return tg('cards.plan.resolvedApproved'); },
      get resolvedRejected() { return tg('cards.plan.resolvedRejected'); },
    },
    model: {
      get title() { return tg('cards.model.title'); },
      currentLine: (label: string, effort: string | null, description: string) =>
        effort
          ? tg('cards.model.currentLineWithEffort', { label, effort, description })
          : tg('cards.model.currentLine', { label, description }),
      get hint() { return tg('cards.model.hint'); },
      optionLabel: (providerName: string, label: string, effort: string | null) =>
        effort ? `${providerName} / ${label} · ${effort}` : `${providerName} / ${label}`,
      resolved: (label: string, effort: string | null) =>
        effort
          ? tg('cards.model.resolvedWithEffort', { label, effort })
          : tg('cards.model.resolved', { label }),
      failed: (reason: string) => tg('cards.model.failed', { reason }),
    },
    permissionMode: {
      get title() { return tg('cards.permissionMode.title'); },
      currentLine: (label: string, description: string) =>
        tg('cards.permissionMode.currentLine', { label, description }),
      get hint() { return tg('cards.permissionMode.hint'); },
      optionLabel: (label: string) => label,
      resolved: (label: string) => tg('cards.permissionMode.resolved', { label }),
      failed: (reason: string) => tg('cards.permissionMode.failed', { reason }),
      get fullAccessConfirmTitle() { return tg('cards.permissionMode.fullAccessConfirmTitle'); },
      get fullAccessConfirmBody() { return tg('cards.permissionMode.fullAccessConfirmBody'); },
      get btnConfirmFullAccess() { return tg('cards.permissionMode.btnConfirmFullAccess'); },
      get btnCancelFullAccess() { return tg('cards.permissionMode.btnCancelFullAccess'); },
      get fullAccessCancelled() { return tg('cards.permissionMode.fullAccessCancelled'); },
    },
    project: {
      get title() { return tg('cards.project.title'); },
      hint: (currentName: string) => tg('cards.project.hint', { name: currentName }),
      get emptyBody() { return tg('cards.project.emptyBody'); },
      get btnDialogue() { return tg('cards.project.btnDialogue'); },
      get btnCancel() { return tg('cards.project.btnCancel'); },
      resolvedPick: (displayName: string) => tg('cards.project.resolvedPick', { name: displayName }),
      get resolvedDialogue() { return tg('cards.project.resolvedDialogue'); },
      get resolvedCancel() { return tg('cards.project.resolvedCancel'); },
      switchFailed: (reason: string) => tg('cards.project.switchFailed', { reason }),
      get attachedUnsupported() { return tg('cards.project.attachedUnsupported'); },
      get dialogueName() { return tg('cards.project.dialogueName'); },
    },
    control: {
      get title() { return tg('cards.control.title'); },
      get emptyBody() { return tg('cards.control.emptyBody'); },
      recentSessions: {
        get title() { return tg('cards.control.recentSessions.title'); },
        get hint() { return tg('cards.control.recentSessions.hint'); },
        get emptyBody() { return tg('cards.control.recentSessions.emptyBody'); },
        optionLabel: (title: string, workspaceName: string | null) =>
          workspaceName ? `${title} · ${workspaceName}` : title,
      },
      get hint() { return tg('cards.control.hint'); },
      attachedSwitchHint: (sessionTitle: string) =>
        tg('cards.control.attachedSwitchHint', { title: sessionTitle }),
      get btnExit() { return tg('cards.control.btnExit'); },
      get resolvedExit() { return tg('cards.control.resolvedExit'); },
      sessionPickerTitle: (displayName: string) =>
        tg('cards.control.sessionPickerTitle', { name: displayName }),
      get sessionPickerHint() { return tg('cards.control.sessionPickerHint'); },
      sessionPickerEmptyBody: (displayName: string) =>
        tg('cards.control.sessionPickerEmptyBody', { name: displayName }),
      get btnNew() { return tg('cards.control.btnNew'); },
      get btnBack() { return tg('cards.control.btnBack'); },
      resolvedSessionPick: (sessionTitle: string, workspaceName: string) =>
        tg('cards.control.resolvedSessionPick', { title: sessionTitle, workspace: workspaceName }),
      resolvedNewSession: (workspaceName: string) =>
        tg('cards.control.resolvedNewSession', { workspace: workspaceName }),
      attachFailed: (reason: string) => tg('cards.control.attachFailed', { reason }),
      get sessionBusyOldCardPlaceholder() { return tg('cards.control.sessionBusyOldCardPlaceholder'); },
      sessionBusyPrompts: [
        (sessionTitle: string) => tg('cards.control.sessionBusyPrompts.variant1', { title: sessionTitle }),
        (sessionTitle: string) => tg('cards.control.sessionBusyPrompts.variant2', { title: sessionTitle }),
        (sessionTitle: string) => tg('cards.control.sessionBusyPrompts.variant3', { title: sessionTitle }),
        (sessionTitle: string) => tg('cards.control.sessionBusyPrompts.variant4', { title: sessionTitle }),
      ],
      takeoverLoadingPrompts: [
        (sessionTitle: string) => tg('cards.control.takeoverLoadingPrompts.variant1', { title: sessionTitle }),
        (sessionTitle: string) => tg('cards.control.takeoverLoadingPrompts.variant2', { title: sessionTitle }),
        (sessionTitle: string) => tg('cards.control.takeoverLoadingPrompts.variant3', { title: sessionTitle }),
        (sessionTitle: string) => tg('cards.control.takeoverLoadingPrompts.variant4', { title: sessionTitle }),
      ],
      // 接管后发给 Agent 的同步请求(模型输入, 不是给 IM 用户看的控制文案), 不随界面语言切换。
      sessionAttachedOneshotPrompts: [
        '我刚通过 Telegram 远程接入了——简单同步下现状：上一轮做了啥、当前在哪一步，然后问我下一步咋走。',
        '我接力了——一句话过下进度，告诉我现在到哪、刚做了啥，再问我要不要继续推进或者换方向。',
        'Hi 我从 Telegram 接手了——快速 brief 一下当前形势、最新结果是啥，最后问我下一步指令。',
        '切到我了——简单复盘下，告诉我现在是什么阶段，然后问我要不要继续干。',
      ],
      newSessionWelcomePrompts: [
        (workspaceName: string) => tg('cards.control.newSessionWelcomePrompts.variant1', { workspace: workspaceName }),
        (workspaceName: string) => tg('cards.control.newSessionWelcomePrompts.variant2', { workspace: workspaceName }),
        (workspaceName: string) => tg('cards.control.newSessionWelcomePrompts.variant3', { workspace: workspaceName }),
        (workspaceName: string) => tg('cards.control.newSessionWelcomePrompts.variant4', { workspace: workspaceName }),
      ],
    },
  },
} satisfies ImUiTextPack;

export const PROCESSING_EMOJI = '🤔';
