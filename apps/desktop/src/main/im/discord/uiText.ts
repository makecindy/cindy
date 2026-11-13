/**
 * main/im/discord/uiText.ts
 * ---------------------------------------------------------------------------
 * Discord 私聊与服务器频道 / thread 的用户文案。thread 已编码进 lane id，
 * 不启用共享编排层的 threadScoped 文案。
 *
 * 控制文案跟随主人在 Cindy 里选的界面语言（`imBot.text.discord.*`），每个叶子在
 * 读取 / 调用时现取，切换语言后下一条消息即生效；不要在模块加载时把文案取成常量。
 */

import type { IMUnsupportedEntry } from '@cindy/im';

import { imText } from '../shared/imText';
import type { ImUiTextPack } from '../shared/types';

const K = 'imBot.text.discord';

function bulletList(entries: IMUnsupportedEntry[]): string {
  return entries.map((e) => `• ${e.label}`).join('\n');
}

export const discordUiText = {
  get expiredCardNotice() { return imText(`${K}.expiredCardNotice`); },
};

export const ui = {
  slash: {
    get new() { return imText(`${K}.slash.new`); },
    get help() { return imText(`${K}.slash.help`); },
    unknownCommand: (cmd: string) => imText(`${K}.slash.unknownCommand`, { cmd }),
    localTaskAccessUnavailable: (cmd: string) => imText(`${K}.slash.localTaskAccessUnavailable`, { cmd }),
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
      const provider = providerLabel ?? providerId ?? imText(`${K}.agent.authMissing.defaultProvider`);
      const vars = { provider, model, agentKind };
      const message =
        missing === 'gateway-key'
          ? imText(`${K}.agent.authMissing.gatewayKey`, vars)
          : missing === 'provider-key'
            ? imText(`${K}.agent.authMissing.providerKey`, vars)
            : missing === 'provider-disconnected'
              ? imText(`${K}.agent.authMissing.providerDisconnected`, vars)
              : imText(`${K}.agent.authMissing.agentLogin`, vars);
      return attached
        ? `${message}\n${imText(`${K}.agent.authMissing.fixAttached`)}`
        : `${message}\n${imText(`${K}.agent.authMissing.fixDetached`)}`;
    },
    get controlInProgress() { return imText(`${K}.agent.controlInProgress`); },
    get credentialBusy() { return imText(`${K}.agent.credentialBusy`); },
    queuedNotice: (position: number) =>
      position <= 1
        ? imText(`${K}.agent.queuedNoticeNext`)
        : imText(`${K}.agent.queuedNoticePosition`, { position }),
    /** `!stop` 生效 — 当前执行已中止, 任务保留可继续。 */
    stopDone: (droppedQueued: number) =>
      droppedQueued > 0
        ? imText(`${K}.agent.stopDoneDropped`, { count: droppedQueued })
        : imText(`${K}.agent.stopDone`),
    /** `!stop` 时没有任务在跑。 */
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
        imText(`${K}.cards.control.sessionPickerTitle`, { displayName }),
      get sessionPickerHint() { return imText(`${K}.cards.control.sessionPickerHint`); },
      sessionPickerEmptyBody: (displayName: string) =>
        imText(`${K}.cards.control.sessionPickerEmptyBody`, { displayName }),
      get btnNew() { return imText(`${K}.cards.control.btnNew`); },
      get btnBack() { return imText(`${K}.cards.control.btnBack`); },
      resolvedSessionPick: (sessionTitle: string, workspaceName: string) =>
        imText(`${K}.cards.control.resolvedSessionPick`, { sessionTitle, workspaceName }),
      resolvedNewSession: (workspaceName: string) =>
        imText(`${K}.cards.control.resolvedNewSession`, { workspaceName }),
      attachFailed: (reason: string) => imText(`${K}.cards.control.attachFailed`, { reason }),
      get sessionBusyOldCardPlaceholder() { return imText(`${K}.cards.control.sessionBusyOldCardPlaceholder`); },
      sessionBusyPrompts: [1, 2, 3, 4].map(
        (n) => (sessionTitle: string) => imText(`${K}.cards.control.sessionBusyPrompt${n}`, { sessionTitle }),
      ),
      takeoverLoadingPrompts: [1, 2, 3, 4].map(
        (n) => (sessionTitle: string) => imText(`${K}.cards.control.takeoverLoadingPrompt${n}`, { sessionTitle }),
      ),
      // 发给模型的接管引导语（不是给 IM 用户看的控制文案），保持原样。
      sessionAttachedOneshotPrompts: [
        '我刚通过 Discord 远程上号了——简单同步下战况：上回合咋样、当前在哪一步，然后问我下一步咋走。',
        '我接力了——一句话过下进度，告诉我现在到哪、刚做了啥，再问我要不要继续推进或者换方向。',
        'Hi 我从 Discord 接手了——快速 brief 一下当前形势、最新结果是啥，最后问我下一步指令。',
        '切到我了——简单复盘下，告诉我现在是什么阶段，然后问我要不要继续干。',
      ],
      newSessionWelcomePrompts: [1, 2, 3, 4].map(
        (n) => (workspaceName: string) =>
          imText(`${K}.cards.control.newSessionWelcomePrompt${n}`, { workspaceName }),
      ),
    },
  },
} satisfies ImUiTextPack;

export const PROCESSING_EMOJI = '👩🏻‍💻';
