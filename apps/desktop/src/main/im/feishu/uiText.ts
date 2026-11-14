/**
 * main/im/feishu/uiText.ts
 * ---------------------------------------------------------------------------
 * User-facing strings sent BACK to the feishu user. Centralised so wording
 * tweaks don't require touching logic files. Mirrors the legacy
 * apps/desktop/src/main/feishuBot/messages.ts groupings (slash / agent /
 * cards / streaming).
 *
 * 文案跟随主人在 Cindy 里选的界面语言: 词条在 desktop locale 的
 * `imBot.text.feishu.*` 下, 经 `imText` 在**发送时**现取 —— 字符串字段是 getter、
 * 模板字段是函数, 消费方写法不变, 主人切换语言后下一条消息即生效。
 * 不要在模块加载时把这里的值拷贝/缓存到常量里, 那样会冻结语言。
 *
 * Tone: 我们是游戏公司, 文案保持有温度、有人味 — 别那么"系统提示"的刻板。
 * 该清楚的地方仍然清楚 (按钮 / 错误信息), 但语气放松, 偶尔带点游戏味的隐喻
 * (上号、存档、副本、AFK 之类), 让用户感觉跟队友对话, 而不是跟 dialog box。
 */

import type { IMUnsupportedEntry } from '@cindy/im';

import { t } from '../../i18n.desktop';
import { imText, type ImTextVars } from '../shared/imText';
import type { ImUiTextPack } from '../shared/types';

/** `imBot.text.feishu.<key>` 的当前语言文案。 */
export function feishuText(key: string, vars?: ImTextVars): string {
  return imText(`imBot.text.feishu.${key}`, vars);
}

const f = feishuText;

const bulletList = (entries: IMUnsupportedEntry[]) => entries.map((e) => `• ${e.label}`).join('\n');

export const ui = {
  // ── slash command replies ──────────────────────────────────────────────────
  slash: {
    get new() { return f('slash.new'); },
    get help() { return f('slash.help'); },
    unknownCommand: (cmd: string) => f('slash.unknownCommand', { cmd }),
    get detachedBySlash() { return f('slash.detachedBySlash'); },
    get detachedByRevoke() { return f('slash.detachedByRevoke'); },
    get notAttached() { return f('slash.notAttached'); },
    // 连接已交给伙伴(伙伴即 IM 本体)时的命令提示。
    get companionDmNew() { return f('slash.companionDmNew'); },
    get companionLaneNew() { return f('slash.companionLaneNew'); },
    get companionManagedCommand() { return f('slash.companionManagedCommand'); },
  },

  // ── agent runtime feedback ─────────────────────────────────────────────────
  agent: {
    get completedNoText() { return f('agent.completedNoText'); },
    runtimeError: (errMsg: string) => f('agent.runtimeError', { error: errMsg.slice(0, 200) }),
    sendInternalError: (errMsg: string) => f('agent.sendInternalError', { error: errMsg }),
    get apiKeyMissing() { return f('agent.apiKeyMissing'); },
    authMissing: ({ providerLabel, providerId, missing, agentKind, model, attached }) => {
      const provider = providerLabel ?? providerId ?? f('agent.authMissing.defaultProvider');
      const reason =
        missing === 'gateway-key'
          ? f('agent.authMissing.reasonGatewayKey')
          : missing === 'provider-key'
            ? f('agent.authMissing.reasonProviderKey')
            : missing === 'provider-disconnected'
              ? f('agent.authMissing.reasonProviderDisconnected')
              : f('agent.authMissing.reasonAgentLogin', { agentKind });
      const message = f('agent.authMissing.message', { provider, model, reason });
      return `${message}\n${f(attached ? 'agent.authMissing.attachedHint' : 'agent.authMissing.detachedHint')}`;
    },
    get controlInProgress() { return f('agent.controlInProgress'); },
    get credentialBusy() { return f('agent.credentialBusy'); },
    /** turn 进行中收到新消息 — 入队提示（跑完自动按序派发, 不报错）。 */
    queuedNotice: (position: number) =>
      position <= 1 ? f('agent.queuedNoticeFirst') : f('agent.queuedNotice', { position }),
    /** `!stop` 生效 — 当前执行已中止, 任务保留可继续。 */
    stopDone: (droppedQueued: number) =>
      droppedQueued > 0
        ? f('agent.stopDoneWithQueued', { count: droppedQueued })
        : f('agent.stopDone'),
    /** `!stop` 时没有任务在跑。 */
    get stopIdle() { return f('agent.stopIdle'); },
    /** 远程控制时转播自动化 turn 的卡片头(系统自动发起,非用户)。 */
    scheduledTaskHeader: (name: string | null) =>
      name ? f('agent.scheduledTaskHeaderNamed', { name }) : f('agent.scheduledTaskHeader'),
    /** 用户发的内容**全部**模型都处理不了——单独发，不进 Agent。 */
    unsupportedOnly: (entries: IMUnsupportedEntry[]) =>
      f('agent.unsupportedOnly', { items: bulletList(entries) }),
    /** 用户发的内容**部分**能处理——先 ack 提示，再继续把能处理的部分送给 Agent。 */
    unsupportedNotice: (entries: IMUnsupportedEntry[]) =>
      f('agent.unsupportedNotice', { items: bulletList(entries) }),
    companionUnavailable: (reason: string) =>
      f('agent.companionUnavailable', { reason: reason.slice(0, 200) }),
  },

  // ── pre-dispatch 失败细分文案 ──────────────────────────────────────────────
  error: {
    get agentUnsupported() { return f('error.agentUnsupported'); },
    permissionModeUnsupported: () =>
      t('settings.imBot.defaults.permissionModeUnsupportedOnChannelHint'),
  },

  // ── card text (sent via @cindy/im InteractiveCardSpec) ──────────────────────
  cards: {
    permission: {
      title: (toolName: string) => f('cards.permission.title', { tool: toolName }),
      get paramsLabel() { return f('cards.permission.paramsLabel'); },
      get btnAllowOnce() { return f('cards.permission.btnAllowOnce'); },
      get btnAllowAlways() { return f('cards.permission.btnAllowAlways'); },
      get btnDeny() { return f('cards.permission.btnDeny'); },
      /** 授权卡转投 owner 私聊后, 在原群/话题里留的指路提示 — 带工具名, 点出具体是什么操作。 */
      dmRoutedNotice: (toolName: string) => f('cards.permission.dmRoutedNotice', { tool: toolName }),
      get resolvedAllowOnce() { return f('cards.permission.resolvedAllowOnce'); },
      get resolvedAllowAlways() { return f('cards.permission.resolvedAllowAlways'); },
      get resolvedDeny() { return f('cards.permission.resolvedDeny'); },
    },
    ask: {
      title: (header: string) => `❓ ${header}`,
      get noOptionsHint() { return f('cards.ask.noOptionsHint'); },
      resolved: (optionLabel: string) => f('cards.ask.resolved', { option: optionLabel }),
      // 多题/多选打勾卡: 依赖飞书卡片原地更新(im.v1.message.patch), 提供
      // 这份文案即启用 buildAskUserCard 的多题分发(见 cardBuilders)。
      multi: {
        get title() { return f('cards.ask.multi.title'); },
        get multiSelectHint() { return f('cards.ask.multi.multiSelectHint'); },
        get submitLabel() { return f('cards.ask.multi.submitLabel'); },
        selectedMark: '✓ ',
      },
    },
    plan: {
      get title() { return f('cards.plan.title'); },
      get btnApprove() { return f('cards.plan.btnApprove'); },
      get btnReject() { return f('cards.plan.btnReject'); },
      get resolvedApproved() { return f('cards.plan.resolvedApproved'); },
      get resolvedRejected() { return f('cards.plan.resolvedRejected'); },
    },
    model: {
      get title() { return f('cards.model.title'); },
      currentLine: (label: string, effort: string | null, description: string) =>
        effort
          ? f('cards.model.currentLineWithEffort', { label, effort, description })
          : f('cards.model.currentLine', { label, description }),
      get hint() { return f('cards.model.hint'); },
      optionLabel: (providerName: string, label: string, effort: string | null) =>
        effort ? `${providerName} / ${label} · ${effort}` : `${providerName} / ${label}`,
      resolved: (label: string, effort: string | null) =>
        effort ? f('cards.model.resolvedWithEffort', { label, effort }) : f('cards.model.resolved', { label }),
      failed: (reason: string) => f('cards.model.failed', { reason }),
    },
    permissionMode: {
      get title() { return f('cards.permissionMode.title'); },
      currentLine: (label: string, description: string) =>
        f('cards.permissionMode.currentLine', { label, description }),
      get hint() { return f('cards.permissionMode.hint'); },
      optionLabel: (label: string) => label,
      resolved: (label: string) => f('cards.permissionMode.resolved', { label }),
      failed: (reason: string) => f('cards.permissionMode.failed', { reason }),
      get fullAccessConfirmTitle() { return f('cards.permissionMode.fullAccessConfirmTitle'); },
      get fullAccessConfirmBody() { return f('cards.permissionMode.fullAccessConfirmBody'); },
      get btnConfirmFullAccess() { return f('cards.permissionMode.btnConfirmFullAccess'); },
      get btnCancelFullAccess() { return f('cards.permissionMode.btnCancelFullAccess'); },
      get fullAccessCancelled() { return f('cards.permissionMode.fullAccessCancelled'); },
    },
    /**
     * 群会话「完全访问」档被强确认策略拒绝时, 发到 owner 私聊的一键修复卡 —
     * 点按钮把该会话切回 auto(自动审批), 群里就能继续发消息了。
     */
    permissionModeFix: {
      get title() { return f('cards.permissionModeFix.title'); },
      body: (sessionTitle: string) => f('cards.permissionModeFix.body', { title: sessionTitle }),
      get btnFix() { return f('cards.permissionModeFix.btnFix'); },
      get resolved() { return f('cards.permissionModeFix.resolved'); },
      failed: (reason: string) => f('cards.permissionModeFix.failed', { reason }),
    },
    project: {
      get title() { return f('cards.project.title'); },
      hint: (currentName: string) => f('cards.project.hint', { name: currentName }),
      get emptyBody() { return f('cards.project.emptyBody'); },
      get btnDialogue() { return f('cards.project.btnDialogue'); },
      get btnCancel() { return f('cards.project.btnCancel'); },
      resolvedPick: (displayName: string) => f('cards.project.resolvedPick', { name: displayName }),
      get resolvedDialogue() { return f('cards.project.resolvedDialogue'); },
      get resolvedCancel() { return f('cards.project.resolvedCancel'); },
      switchFailed: (reason: string) => f('cards.project.switchFailed', { reason }),
      get attachedUnsupported() { return f('cards.project.attachedUnsupported'); },
      get dialogueName() { return f('cards.project.dialogueName'); },
    },
    control: {
      get title() { return f('cards.control.title'); },
      get emptyBody() { return f('cards.control.emptyBody'); },
      get hint() { return f('cards.control.hint'); },
      /** 接管态下重发 /ctr — picker 顶部提示当前接管中的任务, 选新的直接换乘。 */
      attachedSwitchHint: (sessionTitle: string) =>
        f('cards.control.attachedSwitchHint', { title: sessionTitle }),
      get btnExit() { return f('cards.control.btnExit'); },
      get resolvedExit() { return f('cards.control.resolvedExit'); },
      sessionPickerTitle: (displayName: string) =>
        f('cards.control.sessionPickerTitle', { workspace: displayName }),
      get sessionPickerHint() { return f('cards.control.sessionPickerHint'); },
      sessionPickerEmptyBody: (displayName: string) =>
        f('cards.control.sessionPickerEmptyBody', { workspace: displayName }),
      get btnNew() { return f('cards.control.btnNew'); },
      get btnBack() { return f('cards.control.btnBack'); },
      resolvedSessionPick: (sessionTitle: string, workspaceName: string) =>
        f('cards.control.resolvedSessionPick', { title: sessionTitle, workspace: workspaceName }),
      resolvedNewSession: (workspaceName: string) =>
        f('cards.control.resolvedNewSession', { workspace: workspaceName }),
      attachFailed: (reason: string) => f('cards.control.attachFailed', { reason }),
      // 群卡认不出自己在哪条话题(应用重启过, 卡片和话题的对应关系只存在内存里)。
      // 这时候按回调身份接管会把绑定挂到私聊上, 所以宁可不接, 让用户重发一次。
      get staleGroupCard() { return f('cards.control.staleGroupCard'); },
      /** 旧卡片(被点了 busy session 那张)被 freeze 时的占位文字, 让用户知道这张
       *  卡片不再活跃, 下面会新发一张可重选的卡片。 */
      get sessionBusyOldCardPlaceholder() { return f('cards.control.sessionBusyOldCardPlaceholder'); },
      // ── /ctr session-pick: 目标 session 正在跑 turn — 4 套有温度的提示 ──
      // 共同核心: agent 在干活, 强行接管会乱; 等会儿再来。话术尽量像队友说话。
      sessionBusyPrompts: [1, 2, 3, 4].map(
        (n) => (sessionTitle: string) => f(`cards.control.sessionBusyPrompts.prompt${n}`, { title: sessionTitle }),
      ),
      // ── /ctr session-pick idle 路径, attach + 生成回顾这段 3-5s 的 loading 卡 ──
      // 用途: 用户点了 session 之后立刻把卡片换成无按钮的 loading 占位, 杜绝
      // 重复点击; 同时给个有温度的等待文案让用户安心。文案带轻微游戏味,
      // 跟 sessionBusyPrompts / newSessionWelcomePrompts 同语气。
      takeoverLoadingPrompts: [1, 2, 3, 4].map(
        (n) => (sessionTitle: string) =>
          f(`cards.control.takeoverLoadingPrompts.prompt${n}`, { title: sessionTitle }),
      ),
      // ── /ctr session-pick 接管成功后, 自动给 agent 发的 oneshot prompt ──
      // 这个是给 agent 的指令(不是给用户看的), 让 agent 用一段简短话回顾现状 +
      // 问用户下一步意图。fanout listener 会把 agent 输出推到飞书卡片。
      // 面向模型的文本, 不走界面语言。
      sessionAttachedOneshotPrompts: [
        '我刚通过 IM 远程上号了——简单同步下战况：上回合咋样、当前在哪一步，然后问我下一步咋走。',
        '我接力了——一句话过下进度，告诉我现在到哪、刚做了啥，再问我要不要继续推进或者换方向。',
        'Hi 我从 IM 接手了——快速 brief 一下当前形势、最新结果是啥，最后问我下一步指令。',
        '切到我了——简单复盘下，告诉我现在是什么阶段，然后问我要不要继续干。',
      ],
      // ── /ctr new: 新建空白 session 接管成功后 ──
      newSessionWelcomePrompts: [1, 2, 3, 4].map(
        (n) => (workspaceName: string) =>
          f(`cards.control.newSessionWelcomePrompts.prompt${n}`, { workspace: workspaceName }),
      ),
    },
  },

  // NOTE: streaming card placeholder texts (thinking / preparingImage /
  // preparingFile / fileSentDone / emptyReply) live in @cindy/im's feishu
  // transport layer — see packages/lizi-im/src/feishu/messages.ts. They're
  // owned by the streaming-card subsystem there, not duplicated in host.
} satisfies ImUiTextPack;

/** Feishu native processing marker; the transport selects a work/thinking variant. */
export const REACTION_PROCESSING = 'Typing';
