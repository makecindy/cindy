/**
 * main/im/feishu/uiText.ts
 * ---------------------------------------------------------------------------
 * User-facing strings sent BACK to the feishu user. Centralised so wording
 * tweaks don't require touching logic files. Mirrors the legacy
 * apps/desktop/src/main/feishuBot/messages.ts groupings (slash / agent /
 * cards / streaming).
 *
 * Tone: 我们是游戏公司, 文案保持有温度、有人味 — 别那么"系统提示"的刻板。
 * 该清楚的地方仍然清楚 (按钮 / 错误信息), 但语气放松, 偶尔带点游戏味的隐喻
 * (上号、存档、副本、AFK 之类), 让用户感觉跟队友对话, 而不是跟 dialog box。
 */

import type { IMUnsupportedEntry } from '@cindy/im';

import { t } from '../../i18n';
import type { ImUiTextPack } from '../shared/types';

export const ui = {
  // ── slash command replies ──────────────────────────────────────────────────
  slash: {
    new: '🌱 新存档已开 — 之前的对话清掉了，从头聊~',
    help: `🤖 我能帮你做这些：

/new         开个新存档（清掉当前对话上下文）
/model       换个模型上场
/permission  调一下权限模式（auto / bypass / ask 等）
/ctr         远程接管 desktop 上的某个工作区（接管中再发可直接换任务）
/exctr       结束接管，回到我们俩的私聊
/help        看看我会啥

有活儿在跑想让它停？直接发 \`!stop\`，我会立刻中止当前执行、把排队的消息也撤掉，任务保留可继续。

平时直接发消息就行，我在听~`,
    unknownCommand: (cmd: string) =>
      `没认出 \`${cmd}\` 这个命令 🤔\n我能听懂的: /new、/model、/permission、/ctr、/exctr、/help`,
    detachedBySlash: '🚪 接管结束，咱们回到私聊频道。下次想远程操控 desktop 再 /ctr',
    detachedByRevoke: '⚠️ 你在 desktop 那边把接管收回去了，后续消息回到我们俩的私聊。',
    notAttached: '🤷 你现在没在接管任何任务，/exctr 闲着也没事可干。',
  },

  // ── agent runtime feedback ─────────────────────────────────────────────────
  agent: {
    completedNoText: '✅ 跑完啦（这一轮 agent 没说话）',
    runtimeError: (errMsg: string) => `⚠️ Agent 翻车了：${errMsg.slice(0, 200)}`,
    sendInternalError: (errMsg: string) => `❌ 内部出 bug 了：${errMsg}`,
    apiKeyMissing:
      '⚠️ Cindy AI Key 还没配呢~\n去 desktop 的 Settings → 模型供应商里连接 Cindy AI，再来 ping 我',
    authMissing: ({ providerLabel, providerId, missing, agentKind, model, attached }) => {
      const provider = providerLabel ?? providerId ?? '当前供应商';
      const reason =
        missing === 'gateway-key'
          ? '需要先配置 Cindy AI Key'
          : missing === 'provider-key'
            ? '还没有配置该供应商的 API Key'
            : missing === 'provider-disconnected'
              ? '未连接或连接已失效'
              : `需要先登录 ${agentKind} 凭证`;
      const message = `⚠️ 当前对话使用供应商「${provider}」（${model}），${reason}。`;
      return attached
        ? `${message}\n请在 desktop 的 Settings → 模型供应商中修复认证后，直接继续发送消息。`
        : `${message}\n“新对话配置”只影响新对话；修改后请发送 \`/new\`，再继续聊天。`;
    },
    controlInProgress:
      '🎮 你 /ctr 还在选择中呢 — 先把上面那张卡片操作完（或点 🚪 退出），再来发别的~',
    credentialBusy:
      '⏳ 本地 agent 正在跑另一轮，暂时不能切换凭证模式。等上一轮结束后再发一次就行。',
    /** turn 进行中收到新消息 — 入队提示（跑完自动按序派发, 不报错）。 */
    queuedNotice: (position: number) =>
      position <= 1
        ? '⏳ 上一轮还在跑，这条先排队——跑完自动接上。想直接叫停就发 `!stop`'
        : `⏳ 上一轮还在跑，这条排在第 ${position} 位——会按顺序发给 agent。想直接叫停就发 \`!stop\``,
    /** `!stop` 生效 — 当前执行已中止, 任务保留可继续。 */
    stopDone: (droppedQueued: number) =>
      droppedQueued > 0
        ? `⏹ 已叫停当前执行，排队中的 ${droppedQueued} 条消息也一并撤了。任务还在——想继续随时发新指令~`
        : '⏹ 已叫停当前执行。任务还在——想继续随时发新指令~',
    /** `!stop` 时没有任务在跑。 */
    stopIdle: '🤷 现在没有正在跑的任务，`!stop` 落了个空。等有活儿要停的时候再喊我~',
    /** 远程控制时转播自动化 turn 的卡片头(系统自动发起,非用户)。 */
    scheduledTaskHeader: (name: string | null) => (name ? `🤖 自动化「${name}」` : '🤖 自动化'),
    /** 用户发的内容**全部**模型都处理不了——单独发，不进 Agent。 */
    unsupportedOnly: (entries: IMUnsupportedEntry[]) =>
      `🙏 这条消息我吞不下：\n${entries.map((e) => `• ${e.label}`).join('\n')}\n\n` +
      `我能消化的: 文本、图片（jpg/png/gif/webp）、PDF、代码与配置类文本文件。`,
    /** 用户发的内容**部分**能处理——先 ack 提示，再继续把能处理的部分送给 Agent。 */
    unsupportedNotice: (entries: IMUnsupportedEntry[]) =>
      `ℹ️ 以下内容我消化不了，先丢一边了：\n${entries.map((e) => `• ${e.label}`).join('\n')}\n\n` +
      `其它部分收到啦，正在处理~`,
  },

  // ── pre-dispatch 失败细分文案 ──────────────────────────────────────────────
  error: {
    agentUnsupported:
      '🤔 当前选择的 Agent 在这个渠道需要逐条权限确认，暂时上不了场，换一个 Agent 再试~',
    permissionModeUnsupported: () =>
      t('settings.imBot.defaults.permissionModeUnsupportedOnChannelHint'),
  },

  // ── card text (sent via @cindy/im InteractiveCardSpec) ──────────────────────
  cards: {
    permission: {
      title: (toolName: string) => `🔧 工具调用：${toolName}`,
      paramsLabel: '**参数预览**',
      btnAllowOnce: '✅ 仅本次允许',
      btnAllowAlways: '✅ 总是允许',
      btnDeny: '❌ 拒绝',
      /** 授权卡转投 owner 私聊后, 在原群/话题里留的指路提示 — 带工具名, 点出具体是什么操作。 */
      dmRoutedNotice: (toolName: string) =>
        `🔐 \`${toolName}\` 这个操作需要你确认 — 授权卡片已经发到你的私聊，去那里点一下继续~`,
      resolvedAllowOnce: '✅ 已允许（仅本次）',
      resolvedAllowAlways: '✅ 已允许（这个工具以后都放行）',
      resolvedDeny: '❌ 已拒绝',
    },
    ask: {
      title: (header: string) => `❓ ${header}`,
      noOptionsHint: '_（这个问题没有预设选项，直接发文字回我吧）_',
      resolved: (optionLabel: string) => `✅ 已选：${optionLabel}`,
      // 多题/多选打勾卡: 依赖飞书卡片原地更新(im.v1.message.patch), 提供
      // 这份文案即启用 buildAskUserCard 的多题分发(见 cardBuilders)。
      multi: {
        title: '❓ 需要你确认几件事',
        multiSelectHint: '（可多选）',
        submitLabel: '提交答案',
        selectedMark: '✓ ',
      },
    },
    plan: {
      title: '📋 我打算这么干',
      btnApprove: '✅ 干吧',
      btnReject: '❌ 等等',
      resolvedApproved: '✅ 已批准，开干',
      resolvedRejected: '❌ 已暂停',
    },
    model: {
      title: '🤖 换个模型',
      currentLine: (label: string, effort: string | null, description: string) =>
        effort
          ? `**当前**：${label} · effort \`${effort}\`\n_${description}_`
          : `**当前**：${label}\n_${description}_`,
      hint: '点下面切换。我会自动给所选模型用最高 effort 跑',
      optionLabel: (providerName: string, label: string, effort: string | null) =>
        effort ? `${providerName} / ${label} · ${effort}` : `${providerName} / ${label}`,
      resolved: (label: string, effort: string | null) =>
        effort ? `✅ 已切到 ${label}（effort：${effort}）` : `✅ 已切到 ${label}`,
      failed: (reason: string) => `❌ 模型没切过去：${reason}`,
    },
    permissionMode: {
      title: '🛡️ 调一下权限模式',
      currentLine: (label: string, description: string) => `**当前**：${label}\n_${description}_`,
      hint: '点下面切换。auto = 常规放行+敏感操作弹卡片；bypass = 全放行；ask/default/plan/acceptEdits = 走卡片审批',
      optionLabel: (label: string) => label,
      resolved: (label: string) => `✅ 权限模式切到 ${label} 了`,
      failed: (reason: string) => `❌ 权限模式没切过去：${reason}`,
      fullAccessConfirmTitle: '⚠️ 确认开启 Full access？',
      fullAccessConfirmBody:
        'Full access 会关闭工作区沙箱并跳过常规审批。Cindy 可以修改工作区外的文件、执行联网命令且不再询问；内置高风险操作仍会要求确认。',
      btnConfirmFullAccess: '开启 Full access',
      btnCancelFullAccess: '保留当前权限',
      fullAccessCancelled: '已取消，保留当前权限',
    },
    /**
     * 群会话「完全访问」档被强确认策略拒绝时, 发到 owner 私聊的一键修复卡 —
     * 点按钮把该会话切回 auto(自动审批), 群里就能继续发消息了。
     */
    permissionModeFix: {
      title: '🛡️ 把群会话切回「自动审批」',
      body: (sessionTitle: string) =>
        `刚才在群里/话题里的消息没能开跑：**${sessionTitle}** 用的是「完全访问」权限档，` +
        '但群上下文里有成员可控的内容，必须保留操作确认。\n\n点下面按钮把它切到「自动审批」（auto），' +
        '切完回群里继续发消息就行。',
      btnFix: '✅ 切到自动审批',
      resolved: '✅ 已切到「自动审批」— 回群里继续发消息吧~',
      failed: (reason: string) => `❌ 没切过去：${reason}。可以发 /permission auto 手动切换`,
    },
    control: {
      title: '🎮 挑个工作区上号',
      emptyBody: '_暂时还没有可接管的工作区~ 在 desktop 端打开/创建一个任务再来_',
      hint: '点工作区往下走；点 🚪 退出 取消这次',
      /** 接管态下重发 /ctr — picker 顶部提示当前接管中的任务, 选新的直接换乘。 */
      attachedSwitchHint: (sessionTitle: string) =>
        `🎮 当前接管中：**${sessionTitle}**\n选个新任务直接换乘；点 🚪 退出则保持现状`,
      btnExit: '🚪 撤了',
      resolvedExit: '🚪 走了，下次想远程操控再 /ctr',
      sessionPickerTitle: (displayName: string) => `🎮 ${displayName} 里的存档`,
      sessionPickerHint: '挑个任务继续打 · ➕ 新建 开新存档 · ↩️ 后退 换工作区 · 🚪 退出 取消',
      sessionPickerEmptyBody: (displayName: string) =>
        `_工作区 **${displayName}** 这边还没有 active 任务~ 不如点 ➕ 新建 开一个？_`,
      btnNew: '➕ 新建',
      btnBack: '↩️ 后退',
      resolvedSessionPick: (sessionTitle: string, workspaceName: string) =>
        `🎯 上号了：**${sessionTitle}**（${workspaceName}）\n接下来你发消息我就直接进这个任务；想撤随时 \`/exctr\``,
      resolvedNewSession: (workspaceName: string) =>
        `✨ 新存档已建 + 接管完成（在 **${workspaceName}** 里）\n直接发指令开聊；想退就 \`/exctr\``,
      attachFailed: (reason: string) => `❌ 没接上：${reason}`,
      // 群卡认不出自己在哪条话题(应用重启过, 卡片和话题的对应关系只存在内存里)。
      // 这时候按回调身份接管会把绑定挂到私聊上, 所以宁可不接, 让用户重发一次。
      staleGroupCard:
        '❌ 没接上：这张卡片是应用重启前发的，已经认不出它属于哪条话题了。\n' +
        '请在你想接管的那条话题里重新发一次 `/ctr`（绑定只跟话题走，不会串到别处）',
      /** 旧卡片(被点了 busy session 那张)被 freeze 时的占位文字, 让用户知道这张
       *  卡片不再活跃, 下面会新发一张可重选的卡片。 */
      sessionBusyOldCardPlaceholder: '⏳ 那个任务还在跑——下方给你刷了张新卡片，重选一下吧',
      // ── /ctr session-pick: 目标 session 正在跑 turn — 4 套有温度的提示 ──
      // 共同核心: agent 在干活, 强行接管会乱; 等会儿再来。话术尽量像队友说话。
      sessionBusyPrompts: [
        (sessionTitle: string) =>
          `⏳ **${sessionTitle}** 这会儿正在 BOSS 战~\nagent 还在思考/敲代码，等它这把打完再 \`/ctr\` 上号`,
        (sessionTitle: string) =>
          `🚧 抢不进去——**${sessionTitle}** 还有一回合没收尾。\n喝口水等几秒，agent 把手头这把跑完就来叫你`,
        (sessionTitle: string) =>
          `🤖 **${sessionTitle}** 正忙着呢——agent 还在键盘上飞舞，强插会让它分神。\n稍等几秒再 \`/ctr\` 试一下`,
        (sessionTitle: string) =>
          `☕ 别急别急——**${sessionTitle}** 这一局还没打完。\nagent 干完手头的事，指挥权立刻交给你`,
      ],
      // ── /ctr session-pick idle 路径, attach + 生成回顾这段 3-5s 的 loading 卡 ──
      // 用途: 用户点了 session 之后立刻把卡片换成无按钮的 loading 占位, 杜绝
      // 重复点击; 同时给个有温度的等待文案让用户安心。文案带轻微游戏味,
      // 跟 sessionBusyPrompts / newSessionWelcomePrompts 同语气。
      takeoverLoadingPrompts: [
        (sessionTitle: string) =>
          `⏳ 正在让你接管 **${sessionTitle}**…\n_📦 加载存档元数据_  ·  _🔌 接通 agent 通道_  ·  _🧠 复盘上回合战况_\n_三两秒就好，咖啡别一口闷完_`,
        (sessionTitle: string) =>
          `🎮 登入 **${sessionTitle}** 中…\n_早期版本里，等不及的玩家会狂点聊天工具图标，但其实并没有用_`,
        (sessionTitle: string) =>
          `⌛ **${sessionTitle}** 加载中…  99%\n_这条进度条是真的——Haiku 正在翻你们上回合聊了啥_`,
        (sessionTitle: string) =>
          `🛰️ 正在与 **${sessionTitle}** 建立连接…\n_(WiFi 信号好像有点弱…哦不，是 Haiku 在想该怎么给你 brief)_`,
      ],
      // ── /ctr session-pick 接管成功后, 自动给 agent 发的 oneshot prompt ──
      // 这个是给 agent 的指令(不是给用户看的), 让 agent 用一段简短话回顾现状 +
      // 问用户下一步意图。fanout listener 会把 agent 输出推到飞书卡片。
      sessionAttachedOneshotPrompts: [
        '我刚通过 IM 远程上号了——简单同步下战况：上回合咋样、当前在哪一步，然后问我下一步咋走。',
        '我接力了——一句话过下进度，告诉我现在到哪、刚做了啥，再问我要不要继续推进或者换方向。',
        'Hi 我从 IM 接手了——快速 brief 一下当前形势、最新结果是啥，最后问我下一步指令。',
        '切到我了——简单复盘下，告诉我现在是什么阶段，然后问我要不要继续干。',
      ],
      // ── /ctr new: 新建空白 session 接管成功后 ──
      newSessionWelcomePrompts: [
        (workspaceName: string) =>
          `🎯 接管 + 开档 一气呵成——**${workspaceName}** 已就位，agent 待命中。\n发第一条指令开聊；想撤随时 \`/exctr\``,
        (workspaceName: string) =>
          `✨ 新存档已建——工作目录 **${workspaceName}** 已经备好，agent 等你发话。\n第一条消息开打；\`/exctr\` 随时退出`,
        (workspaceName: string) =>
          `🎮 准备就绪——在 **${workspaceName}** 给你开了个全新存档。\n要做啥告诉我，agent 在线~  \`/exctr\` 收手`,
        (workspaceName: string) =>
          `🆕 全新开局——**${workspaceName}** 工作目录已经 ready。\n第一条指令开聊；不想玩了就 \`/exctr\``,
      ],
    },
  },

  // NOTE: streaming card placeholder texts (thinking / preparingImage /
  // preparingFile / fileSentDone / emptyReply) live in @cindy/im's feishu
  // transport layer — see packages/lizi-im/src/feishu/messages.ts. They're
  // owned by the streaming-card subsystem there, not duplicated in host.
} satisfies ImUiTextPack;

/** Feishu emoji_type for "I see this" reaction (most ack-friendly). */
export const REACTION_PROCESSING = 'SMUG';
