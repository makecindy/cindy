/**
 * 企业微信个人 bot 的控制文案包。文案跟随主人在 Cindy 里选的界面语言
 * (`imBot.text.wecom.*`), 每个叶子在读取 / 调用时现取, 切换语言后下一条消息即生效。
 */
import type { IMUnsupportedEntry } from '@cindy/im';

import { imText } from '../shared/imText';
import type { ImUiTextPack } from '../shared/types';

const K = 'imBot.text.wecom';

function bulletList(entries: IMUnsupportedEntry[]): string {
  return entries.map((entry) => `• ${entry.label}`).join('\n');
}

export const ui = {
  slash: {
    get new() { return imText(`${K}.slash.new`); },
    get help() { return imText(`${K}.slash.help`); },
    unknownCommand: (cmd: string) => imText(`${K}.slash.unknownCommand`, { cmd }),
    get detachedBySlash() { return imText(`${K}.slash.detachedBySlash`); },
    get detachedByRevoke() { return imText(`${K}.slash.detachedByRevoke`); },
    get notAttached() { return imText(`${K}.slash.notAttached`); },
    get companionManagedCommand() { return imText(`${K}.slash.companionManagedCommand`); },
  },
  agent: {
    get completedNoText() { return imText(`${K}.agent.completedNoText`); },
    runtimeError: (errMsg: string) => imText(`${K}.agent.runtimeError`, { error: errMsg.slice(0, 200) }),
    sendInternalError: (errMsg: string) => imText(`${K}.agent.sendInternalError`, { error: errMsg }),
    get apiKeyMissing() { return imText(`${K}.agent.apiKeyMissing`); },
    authMissing: ({ providerLabel, providerId, missing, agentKind, model, attached }) => {
      const provider = providerLabel ?? providerId ?? imText(`${K}.agent.authMissing.providerFallback`);
      const reason =
        missing === 'gateway-key'
          ? imText(`${K}.agent.authMissing.reasonGatewayKey`)
          : missing === 'provider-key'
            ? imText(`${K}.agent.authMissing.reasonProviderKey`)
            : missing === 'provider-disconnected'
              ? imText(`${K}.agent.authMissing.reasonProviderDisconnected`)
              : imText(`${K}.agent.authMissing.reasonLogin`, { agentKind });
      const message = imText(`${K}.agent.authMissing.message`, { provider, model, reason });
      return attached
        ? `${message}\n${imText(`${K}.agent.authMissing.attachedHint`)}`
        : `${message}\n${imText(`${K}.agent.authMissing.newChatHint`)}`;
    },
    get controlInProgress() { return imText(`${K}.agent.controlInProgress`); },
    get credentialBusy() { return imText(`${K}.agent.credentialBusy`); },
    queuedNotice: (position: number) =>
      position <= 1
        ? imText(`${K}.agent.queuedNoticeNext`)
        : imText(`${K}.agent.queuedNoticePosition`, { position }),
    stopDone: (droppedQueued: number) =>
      droppedQueued > 0
        ? imText(`${K}.agent.stopDoneDropped`, { count: droppedQueued })
        : imText(`${K}.agent.stopDone`),
    get stopIdle() { return imText(`${K}.agent.stopIdle`); },
    scheduledTaskHeader: (name: string | null) =>
      name
        ? imText(`${K}.agent.scheduledTaskHeaderNamed`, { name })
        : imText(`${K}.agent.scheduledTaskHeader`),
    unsupportedOnly: (entries: IMUnsupportedEntry[]) =>
      imText(`${K}.agent.unsupportedOnly`, { items: bulletList(entries) }),
    unsupportedNotice: (entries: IMUnsupportedEntry[]) =>
      imText(`${K}.agent.unsupportedNotice`, { items: bulletList(entries) }),
  },
  cards: {
    permission: {
      title: (toolName: string) => imText(`${K}.cards.permission.title`, { toolName }),
      get paramsLabel() { return imText(`${K}.cards.permission.paramsLabel`); },
      get btnAllowOnce() { return imText(`${K}.cards.permission.btnAllowOnce`); },
      get btnAllowAlways() { return imText(`${K}.cards.permission.btnAllowAlways`); },
      get btnDeny() { return imText(`${K}.cards.permission.btnDeny`); },
      get resolvedAllowOnce() { return imText(`${K}.cards.permission.resolvedAllowOnce`); },
      get resolvedAllowAlways() { return imText(`${K}.cards.permission.resolvedAllowAlways`); },
      get resolvedDeny() { return imText(`${K}.cards.permission.resolvedDeny`); },
    },
    ask: {
      title: (header: string) => `❓ ${header}`,
      get noOptionsHint() { return imText(`${K}.cards.ask.noOptionsHint`); },
      resolved: (optionLabel: string) => imText(`${K}.cards.ask.resolved`, { option: optionLabel }),
    },
    plan: {
      get title() { return imText(`${K}.cards.plan.title`); },
      get btnApprove() { return imText(`${K}.cards.plan.btnApprove`); },
      get btnReject() { return imText(`${K}.cards.plan.btnReject`); },
      get resolvedApproved() { return imText(`${K}.cards.plan.resolvedApproved`); },
      get resolvedRejected() { return imText(`${K}.cards.plan.resolvedRejected`); },
    },
    model: {
      get title() { return imText(`${K}.cards.model.title`); },
      currentLine: (label: string, effort: string | null, description: string) =>
        effort
          ? imText(`${K}.cards.model.currentLineWithEffort`, { label, effort, description })
          : imText(`${K}.cards.model.currentLine`, { label, description }),
      get hint() { return imText(`${K}.cards.model.hint`); },
      optionLabel: (providerName: string, label: string, effort: string | null) =>
        effort ? `${providerName} / ${label} · ${effort}` : `${providerName} / ${label}`,
      resolved: (label: string, effort: string | null) =>
        effort
          ? imText(`${K}.cards.model.resolvedWithEffort`, { label, effort })
          : imText(`${K}.cards.model.resolved`, { label }),
      failed: (reason: string) => imText(`${K}.cards.model.failed`, { reason }),
    },
    permissionMode: {
      get title() { return imText(`${K}.cards.permissionMode.title`); },
      currentLine: (label: string, description: string) =>
        imText(`${K}.cards.permissionMode.currentLine`, { label, description }),
      get hint() { return imText(`${K}.cards.permissionMode.hint`); },
      optionLabel: (label: string) => label,
      resolved: (label: string) => imText(`${K}.cards.permissionMode.resolved`, { label }),
      failed: (reason: string) => imText(`${K}.cards.permissionMode.failed`, { reason }),
      get fullAccessConfirmTitle() { return imText(`${K}.cards.permissionMode.fullAccessConfirmTitle`); },
      get fullAccessConfirmBody() { return imText(`${K}.cards.permissionMode.fullAccessConfirmBody`); },
      get btnConfirmFullAccess() { return imText(`${K}.cards.permissionMode.btnConfirmFullAccess`); },
      get btnCancelFullAccess() { return imText(`${K}.cards.permissionMode.btnCancelFullAccess`); },
      get fullAccessCancelled() { return imText(`${K}.cards.permissionMode.fullAccessCancelled`); },
    },
    control: {
      get title() { return imText(`${K}.cards.control.title`); },
      get emptyBody() { return imText(`${K}.cards.control.emptyBody`); },
      get hint() { return imText(`${K}.cards.control.hint`); },
      attachedSwitchHint: (sessionTitle: string) =>
        imText(`${K}.cards.control.attachedSwitchHint`, { sessionTitle }),
      get btnExit() { return imText(`${K}.cards.control.btnExit`); },
      get resolvedExit() { return imText(`${K}.cards.control.resolvedExit`); },
      sessionPickerTitle: (displayName: string) =>
        imText(`${K}.cards.control.sessionPickerTitle`, { workspaceName: displayName }),
      get sessionPickerHint() { return imText(`${K}.cards.control.sessionPickerHint`); },
      sessionPickerEmptyBody: (displayName: string) =>
        imText(`${K}.cards.control.sessionPickerEmptyBody`, { workspaceName: displayName }),
      get btnNew() { return imText(`${K}.cards.control.btnNew`); },
      get btnBack() { return imText(`${K}.cards.control.btnBack`); },
      resolvedSessionPick: (sessionTitle: string, workspaceName: string) =>
        imText(`${K}.cards.control.resolvedSessionPick`, { sessionTitle, workspaceName }),
      resolvedNewSession: (workspaceName: string) =>
        imText(`${K}.cards.control.resolvedNewSession`, { workspaceName }),
      attachFailed: (reason: string) => imText(`${K}.cards.control.attachFailed`, { reason }),
      get sessionBusyOldCardPlaceholder() {
        return imText(`${K}.cards.control.sessionBusyOldCardPlaceholder`);
      },
      sessionBusyPrompts: [
        (sessionTitle: string) => imText(`${K}.cards.control.sessionBusyPrompt`, { sessionTitle }),
      ],
      takeoverLoadingPrompts: [
        (sessionTitle: string) => imText(`${K}.cards.control.takeoverLoadingPrompt`, { sessionTitle }),
      ],
      // 发给 Agent 的同步指令(当前无消费方), 不属于控制文案, 保持原样。
      sessionAttachedOneshotPrompts: [
        '我已从企业微信接管此任务。请简要同步当前进度，并询问下一步指令。',
      ],
      newSessionWelcomePrompts: [
        (workspaceName: string) =>
          imText(`${K}.cards.control.newSessionWelcomePrompt`, { workspaceName }),
      ],
    },
  },
} satisfies ImUiTextPack;
