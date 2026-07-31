/**
 * main/im/shared/types.ts
 * ---------------------------------------------------------------------------
 * IM 业务编排层的渠道适配契约。
 *
 * 背景: 飞书 bot 的业务编排(消息路由 / slash 命令 / agent turn / 卡片交互 /
 * /ctr 接管)逻辑本身是渠道无关的, 历史上却直接 import feishuIm 单例与 feishu
 * 专属的 sessionRepo / uiText。Slack 渠道接入时把这层抽到 im/shared/, 以
 * ImChannelAdapter 参数化 —— 同一套编排逻辑挂 feishu / slack 两个 adapter。
 *
 * 设计要点:
 *   - adapter.im 只要求 @cindy/im 的 ChannelIM 能力接口, 不要求具体类;
 *     可选能力(emoji 回应)用 `im.reactToMessage?.()` 探测, 不另设 caps 开关
 *   - sessions 命名空间封装"这个渠道的 session 行长什么样"(id 格式 / source
 *     列值 / 默认 title / workingDir 策略 / 渠道专属列), DB 读写逻辑共用
 *   - ui 是完整的文案包契约 —— 新渠道必须逐字段提供, 缺字段编译期报错,
 *     不存在静默回退
 */

import type {
  AgentKind,
  Effort,
  InteractionDecision,
  InteractionRequest,
  PermissionMode,
  TurnPermissionPolicy,
} from '@cindy/maker-core';
import type { ChannelIM, ImOutputDriver, IMMessageEvent, IMUnsupportedEntry } from '@cindy/im';

/** 渠道名 — 同时是 sessions.source 列值与 IdentityKey.channel 的值域。 */
export type ImChannelName = 'feishu' | 'slack' | 'discord' | 'wechat' | 'telegram' | 'dingtalk';

/**
 * IM 编排层的产品默认配置(由 main/im/index.ts 产品接线层注入)。
 * 形状与历史 FeishuOrchestratorConfig 完全一致。
 */
export interface ImOrchestratorConfig {
  /** 该渠道 session 绑定的 maker agent kind。 */
  agentKind: AgentKind;
  /** 新建该渠道 session 的默认 model id。 */
  defaultModel: string;
  /** 新建该渠道 session 的默认权限模式。 */
  defaultPermissionMode: PermissionMode;
  /**
   * IM 语境下按 model 的 effort 覆盖(选默认 effort 时优先于
   * ModelDescriptor.defaultEffort;不在表里的 model 走 defaultEffort)。
   */
  effortOverrides?: Readonly<Partial<Record<string, Effort>>>;
}

/**
 * 渠道的 session 行策略 — sessionRepo 共用 DB 逻辑, 渠道差异收敛到这里。
 */
export interface ImSessionNamespace {
  /** sessions.source 列值。 */
  source: ImChannelName;
  /**
   * 确定性 session id(跨重启稳定)。threadScoped 渠道(slack)把 scopeKey
   * (thread root ts)编进 id — 每个 thread 一个独立 session;无 thread 渠道
   * (feishu)忽略 scopeKey, 同一 (botContextId, userId) 恒同一 id。
   */
  sessionIdFor(botContextId: string, userId: string, scopeKey?: string): string;
  /** 新建 session 行的初始 title。 */
  defaultTitle(userId: string): string;
  /**
   * 该渠道会话在侧边栏的归属语义(sessions.workspaceKind 列)。缺省 'project'
   * (按 workingDir 聚成项目组);'dialogue' 落「对话」分组 —— IM 私聊会话的
   * workingDir 是 app 托管目录(im-working-dir),不该以它聚成假项目组。
   */
  workspaceKind?: 'project' | 'dialogue';
  /** 该渠道 session 的工作目录(必须已创建好)。 */
  ensureWorkingDir(botContextId: string): string;
  /** 渠道专属列(feishu: feishuBotAppId/feishuOpenId;slack: imBotContextId/imUserId)。 */
  extraInsertColumns(botContextId: string, userId: string): Record<string, unknown>;
  /**
   * 按 userId 收紧新会话的权限档(telegram guest lane → 'plan' 只读探索)。
   * 返回 null/缺省 = 用渠道默认。只影响**新建**行; 已存在行的权限归 owner 管。
   */
  permissionModeFor?(userId: string): PermissionMode | null;
  /**
   * 非接管会话 oneshot 生成正式标题时的前缀(如 'Slack · ' / '[飞书·DM] ')。
   *   - threadScoped 渠道(slack): 新 thread 会话的首条消息触发;
   *   - 非 threadScoped 渠道(feishu/discord): 新上下文(建行 / /new 后)的
   *     首条消息触发, 标题跟随当前话题。
   * 缺省时 threadScoped 渠道回落 FBot 前缀, 非 threadScoped 渠道不起名
   * (保持 defaultTitle)。接管 session 一律沿用 FBot 前缀, 不走这里。
   */
  generatedTitlePrefix?: string | (() => string);
}

/**
 * 渠道适配器 — 编排层所有渠道差异的唯一注入点。
 */
export interface ImChannelAdapter {
  channel: ImChannelName;
  /** 收发能力(@cindy/im ChannelIM 契约)。 */
  im: ChannelIM;
  /** Terminal output strategy; existing channels use rich-card. */
  output: ImOutputDriver;
  config: ImOrchestratorConfig;
  ui: ImUiTextPack;
  sessions: ImSessionNamespace;
  /** "已收到" ack 的 emoji(feishu: emoji_type 枚举名;slack: emoji 名)。 */
  processingEmoji: string;
  /**
   * turn 终态时把 ack 表情替换成结果表情(官方 Telegram bot 习惯:
   * 成功 👍 / 失败 👎)。返回 null = 该终态不放表情(按默认撤掉 ack);
   * 缺省 = 全部按默认撤掉。仅真正跑过的 turn 生效, pre-dispatch 失败不放。
   */
  terminalReactionEmoji?(kind: 'done' | 'aborted' | 'error'): string | null;
  /**
   * `/project` 项目切换开关(个人 Telegram: true)。开启后 slash 层放行
   * /project 命令: 列出 desktop 端项目工作区, 选中后把当前 (bot, user/lane)
   * 会话行切到该项目目录并重开上下文(bot 原生会话, 非接管)。开启时
   * ui.cards.project 必须提供(orchestrator 接线期断言)。
   */
  projectSwitching?: boolean;
  /**
   * thread = session 模型开关(slack: true)。开启后:
   *   - 入站事件的 scopeKey(thread root ts)参与会话路由与接管 binding
   *   - 出站回复全部带 threadTs = scopeKey(发进对应 thread)
   *   - /new 废弃、/exctr 全退、接管走顶层卡片 + thread
   * 开启时 ui.thread 必须提供(orchestrator 接线期断言)。
   */
  threadScoped?: boolean;
  /**
   * 非接管 session 的 vendorOptions(注入渠道专属 MCP, 如 send_file_to_user)。
   * 接管(attached)session 恒为 undefined — 该语义在编排层硬编码, 不走这里。
   * threadScoped 渠道会收到 scopeKey(thread root ts), 供 MCP 出站定位 thread。
   */
  buildVendorOptions(userId: string, scopeKey?: string): Record<string, unknown>;
  /**
   * Text-only channels can still resolve agent interactions without rich cards.
   * The callback owns channel-specific correlation and parsing.
   */
  handleTextInteraction?(userId: string, request: InteractionRequest): Promise<InteractionDecision>;
  /** Durable channels may promote task-scoped attachments after message persistence succeeds. */
  onUserMessagePersisted?(args: {
    sessionId: string;
    userMessageId: string | null;
    persisted: boolean;
  }): Promise<void>;
  /**
   * 流式进度"只发正文"判定(按出站目标粒度)。Telegram 私聊的可编辑消息被
   * 客户端渲染成带动画的 Rich draft, 过程时间线反复重排会清空重播 —— 返回
   * true 时中间态只显示正文;零产出的过载重试窗口仍显示 notice 单行(否则
   * 退避期间毫无反馈)。缺省 = 完整过程时间线(卡片渠道的既有行为)。
   */
  answerOnlyProgress?(userId: string): boolean;
  /**
   * 送模型正文的改写钩子(群上下文拼装等): 返回 agentText 替换发给 agent 的
   * 文本 —— 落库与标题生成仍用渠道原文, 桌面 transcript 不被上下文前缀污染。
   * commit 在路由解析成功(消息确定会被派发/排队)时调用, 是群窗口游标推进的
   * 时机锚点; 路由失败(如鉴权缺失)不调用, 这批上下文下次仍会进入 prompt。
   * 返回 null = 不改写。钩子抛错按"不改写"降级, 不阻断消息。
   */
  prepareAgentTurnText?(event: IMMessageEvent): Promise<{
    agentText: string;
    commit?: () => void;
  } | null>;
  /**
   * 按入站事件给该轮挂 per-turn 权限策略(telegram 群成员触发 → 破坏性调用
   * 强制确认卡, 卡片只认 owner 点击)。返回 undefined = 本轮不挂策略。
   * 会话权限档不支持 turn 策略(acceptEdits/bypassPermissions)时 maker 拒跑
   * 该轮(fail-closed), 不会静默放开。
   */
  turnPermissionPolicyFor?(event: IMMessageEvent): TurnPermissionPolicy | undefined;
}

// ── UI 文案包 ─────────────────────────────────────────────────────────────────
// 形状与 feishu uiText.ts 的 `ui` 对象逐字段对齐。新渠道必须完整提供。

export interface ImUiTextPack {
  slash: {
    new: string;
    help: string;
    /**
     * `/start` 欢迎语(Telegram 私聊首次必发 /start — 点 START 按钮)。
     * 提供则 /start 回它, 缺省渠道回 unknownCommand。
     */
    start?: string;
    unknownCommand: (cmd: string) => string;
    /**
     * Text-only channels use this when a slash command requires interactive
     * cards. Missing copy falls back to unknownCommand.
     */
    interactiveCommandUnsupported?: (cmd: string) => string;
    detachedBySlash: string;
    detachedByRevoke: string;
    notAttached: string;
  };
  agent: {
    completedNoText: string;
    runtimeError: (errMsg: string) => string;
    sendInternalError: (errMsg: string) => string;
    apiKeyMissing: string;
    /** 按实际会话路由生成鉴权失败提示；未提供时回退到 apiKeyMissing。 */
    authMissing?: (details: {
      agentKind: string;
      model: string;
      providerId: string | null;
      providerLabel: string | null;
      missing: string | null;
      /** 接管 desktop session 时为 true；此时 /new 不会重置被接管的会话。 */
      attached?: boolean;
    }) => string;
    controlInProgress: string;
    credentialBusy: string;
    queuedNotice: (position: number) => string;
    /** `!stop` 生效 — 当前 turn 已中止(droppedQueued = 一并丢弃的排队消息数)。 */
    stopDone: (droppedQueued: number) => string;
    /** `!stop` 时没有任何在跑/排队的任务 — 轻量提示。 */
    stopIdle: string;
    /** 远程控制时转播自动任务(scheduler)turn 的卡片头。name 为空时用通用文案。 */
    scheduledTaskHeader: (name: string | null) => string;
    unsupportedOnly: (entries: IMUnsupportedEntry[]) => string;
    unsupportedNotice: (entries: IMUnsupportedEntry[]) => string;
  };
  cards: {
    permission: {
      title: (toolName: string) => string;
      paramsLabel: string;
      btnAllowOnce: string;
      btnAllowAlways: string;
      btnDeny: string;
      resolvedAllowOnce: string;
      resolvedAllowAlways: string;
      resolvedDeny: string;
    };
    ask: {
      title: (header: string) => string;
      noOptionsHint: string;
      resolved: (optionLabel: string) => string;
    };
    plan: {
      title: string;
      btnApprove: string;
      btnReject: string;
      resolvedApproved: string;
      resolvedRejected: string;
    };
    model: {
      title: string;
      currentLine: (label: string, effort: string | null, description: string) => string;
      hint: string;
      /** 每行模型按钮文案:供应商名 + 模型名 (+ effort)。 */
      optionLabel: (providerName: string, label: string, effort: string | null) => string;
      resolved: (label: string, effort: string | null) => string;
      failed: (reason: string) => string;
    };
    permissionMode: {
      title: string;
      currentLine: (label: string, description: string) => string;
      hint: string;
      optionLabel: (label: string) => string;
      resolved: (label: string) => string;
      failed: (reason: string) => string;
      fullAccessConfirmTitle: string;
      fullAccessConfirmBody: string;
      btnConfirmFullAccess: string;
      btnCancelFullAccess: string;
      fullAccessCancelled: string;
    };
    /**
     * `/project` 项目切换卡 — 仅 projectSwitching 渠道提供(接线期断言),
     * 其它渠道省略。
     */
    project?: {
      title: string;
      /** 卡片提示行; currentName = 当前目录显示名('对话' 或项目名)。 */
      hint: (currentName: string) => string;
      emptyBody: string;
      btnDialogue: string;
      btnCancel: string;
      resolvedPick: (displayName: string) => string;
      resolvedDialogue: string;
      resolvedCancel: string;
      switchFailed: (reason: string) => string;
      /** /ctr 接管期间不支持切项目(先 /exctr)。 */
      attachedUnsupported: string;
      /** 当前目录显示名为托管对话目录时的称呼。 */
      dialogueName: string;
    };
    control: {
      title: string;
      emptyBody: string;
      /**
       * `/session` 最近会话直达卡(可选;提供才放行 /session 命令)。
       * 与 /ctr 的差异: 不按工作区分步, 直接列跨工作区最近 N 条。
       */
      recentSessions?: {
        title: string;
        hint: string;
        emptyBody: string;
        /** 按钮 label: `标题 · 目录名`(目录未知只有标题)。 */
        optionLabel: (title: string, workspaceName: string | null) => string;
      };
      hint: string;
      attachedSwitchHint: (sessionTitle: string) => string;
      btnExit: string;
      resolvedExit: string;
      sessionPickerTitle: (displayName: string) => string;
      sessionPickerHint: string;
      sessionPickerEmptyBody: (displayName: string) => string;
      btnNew: string;
      btnBack: string;
      resolvedSessionPick: (sessionTitle: string, workspaceName: string) => string;
      resolvedNewSession: (workspaceName: string) => string;
      attachFailed: (reason: string) => string;
      sessionBusyOldCardPlaceholder: string;
      sessionBusyPrompts: ReadonlyArray<(sessionTitle: string) => string>;
      takeoverLoadingPrompts: ReadonlyArray<(sessionTitle: string) => string>;
      sessionAttachedOneshotPrompts: ReadonlyArray<string>;
      newSessionWelcomePrompts: ReadonlyArray<(workspaceName: string) => string>;
    };
  };
  /**
   * thread = session 模型专属文案 — threadScoped 渠道必须提供
   * (orchestrator 接线期断言), 非 thread 渠道(feishu)省略。
   */
  thread?: {
    /**
     * 新 thread 会话的"名片"卡 — bot 在该 thread 第一条回复之前发出,
     * 向用户解释 thread = 独立会话;标题生成后升级为 sessionHeaderTitled。
     */
    sessionHeaderCard: { title: string; body: string };
    /** 首条消息生成正式标题后, 名片卡的升级形态。 */
    sessionHeaderTitled: (title: string) => { title: string; body: string };
    /** /ctr 锚点卡(顶层;选择流程与最终接管会话都在它的 thread 里)。 */
    controlAnchorCard: { title: string; body: string };
    /** 选择流程被 🚪 取消后锚点卡的收口文案。 */
    controlCancelled: string;
    /** "发起远程控制"按钮(收口卡/欢迎卡上的免打字入口, 常驻可反复按)。 */
    btnStartControl: string;
    /** 接管 root 卡标题/正文(顶层消息, 该卡的 thread 即接管会话)。 */
    takeoverCard: (sessionTitle: string, workspaceName: string) => { title: string; body: string };
    /** 新建+接管 root 卡。 */
    takeoverNewSessionCard: (workspaceName: string) => { title: string; body: string };
    /** root 卡上的退出接管按钮文案。 */
    btnExitTakeover: string;
    /**
     * 点退出按钮后 root 卡的收口卡 — 标题保留曾控制的 session 名
     * (顶层可追溯这个 thread 控制过谁);title 查不到时省略。
     */
    takeoverExited: (sessionTitle: string | null) => { title?: string; body: string };
    /** 旧接管被新 thread 替换后, 旧锚点/root 卡的收口文案。 */
    takeoverReplaced: (sessionTitle: string) => string;
    /** /new 在 thread 模型下的废弃提示。 */
    newDeprecated: string;
    /** /model /permission 在 thread 模型下暂不支持的提示。 */
    perThreadConfigUnsupported: string;
    /** /exctr 全退完成(count ≥ 1)。 */
    exctrAllDone: (count: number) => string;
    /** /exctr 时没有任何接管。 */
    exctrNothing: string;
  };
}
