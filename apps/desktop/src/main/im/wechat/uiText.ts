/**
 * Personal WeChat channel copy. Keep this pack independent from other IM
 * channels so channel-specific wording cannot leak into WeChat replies.
 *
 * Every leaf is resolved at send time through `imText` (desktop locale
 * catalogue `imBot.text.wechat.*`), so the copy follows the owner's current
 * Cindy interface language. String leaves are getters for that reason — do not
 * spread or snapshot this pack.
 */
import type { IMUnsupportedEntry } from '@cindy/im';

import { imText } from '../shared/imText';
import type { ImUiTextPack } from '../shared/types';

const K = 'imBot.text.wechat';

function unsupportedList(entries: IMUnsupportedEntry[]): string {
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
  },
  agent: {
    get completedNoText() { return imText(`${K}.agent.completedNoText`); },
    runtimeError: (errMsg: string) => imText(`${K}.agent.runtimeError`, { error: errMsg.slice(0, 200) }),
    sendInternalError: (errMsg: string) => imText(`${K}.agent.sendInternalError`, { error: errMsg }),
    get apiKeyMissing() { return imText(`${K}.agent.apiKeyMissing`); },
    authMissing: ({ providerLabel, providerId, missing, agentKind, model, attached }) => {
      const provider = providerLabel ?? providerId ?? imText(`${K}.agent.authMissing.currentProvider`);
      const reason =
        missing === 'gateway-key'
          ? imText(`${K}.agent.authMissing.reasonGatewayKey`)
          : missing === 'provider-key'
            ? imText(`${K}.agent.authMissing.reasonProviderKey`)
            : missing === 'provider-disconnected'
              ? imText(`${K}.agent.authMissing.reasonProviderDisconnected`)
              : imText(`${K}.agent.authMissing.reasonAgentLogin`, { agentKind });
      const message = imText(`${K}.agent.authMissing.message`, { provider, model, reason });
      return attached
        ? `${message}\n${imText(`${K}.agent.authMissing.attachedHint`)}`
        : `${message}\n${imText(`${K}.agent.authMissing.detachedHint`)}`;
    },
    get controlInProgress() { return imText(`${K}.agent.controlInProgress`); },
    get credentialBusy() { return imText(`${K}.agent.credentialBusy`); },
    queuedNotice: (position: number) =>
      position <= 1
        ? imText(`${K}.agent.queuedNext`)
        : imText(`${K}.agent.queuedPosition`, { position }),
    stopDone: (droppedQueued: number) =>
      droppedQueued > 0
        ? imText(`${K}.agent.stopDoneWithQueued`, { count: droppedQueued })
        : imText(`${K}.agent.stopDone`),
    get stopIdle() { return imText(`${K}.agent.stopIdle`); },
    scheduledTaskHeader: (name: string | null) =>
      name ? imText(`${K}.agent.scheduledTaskHeaderNamed`, { name }) : imText(`${K}.agent.scheduledTaskHeader`),
    unsupportedOnly: (entries: IMUnsupportedEntry[]) =>
      imText(`${K}.agent.unsupportedOnly`, { items: unsupportedList(entries) }),
    unsupportedNotice: (entries: IMUnsupportedEntry[]) =>
      imText(`${K}.agent.unsupportedNotice`, { items: unsupportedList(entries) }),
  },
  error: {
    // turnPermissionPolicy 分类:agent(如 Pi)未声明该 capability,任何权限模式
    // 都无法提供微信所需的逐条确认 → 换 Agent;已声明的 agent 仅个别模式不可用
    // (如 bypassPermissions / acceptEdits) → 换权限模式。
    // 注意:跟随渠道默认的会话在下一条消息就会换到新 Agent, 但单独选过 Agent / 模型
    // 的会话不跟随设置, 所以「换 Agent」指引仍带 /new, 否则这类会话重发仍路由到旧 Agent。
    get agentUnsupported() { return imText(`${K}.error.agentUnsupported`); },
    // 换 Agent 后仍可能不兼容的权限模式(Claude Code / Codex 的
    // unsupportedPermissionModes 并集:bypassPermissions / acceptEdits):
    // 仅换 Agent 会在新 Agent 上再次命中权限模式错误,补一条 /permission 提示。
    get agentSwitchAlsoCheckPermissionMode() { return imText(`${K}.error.agentSwitchAlsoCheckPermissionMode`); },
    get permissionModeUnsupported() { return imText(`${K}.error.permissionModeUnsupported`); },
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
      // 发给 Agent 的一次性开场 prompt(模型输入,不是控制文案),保持原文不本地化。
      sessionAttachedOneshotPrompts: [
        '我刚通过微信远程上号了——简单同步下战况：上回合咋样、当前在哪一步，然后问我下一步咋走。',
        '我接力了——一句话过下进度，告诉我现在到哪、刚做了啥，再问我要不要继续推进或者换方向。',
        'Hi 我从微信接手了——快速 brief 一下当前形势、最新结果是啥，最后问我下一步指令。',
        '切到我了——简单复盘下，告诉我现在是什么阶段，然后问我要不要继续干。',
      ],
      newSessionWelcomePrompts: [1, 2, 3, 4].map(
        (n) => (workspaceName: string) =>
          imText(`${K}.cards.control.newSessionWelcomePrompt${n}`, { workspaceName }),
      ),
    },
  },
} satisfies ImUiTextPack;
