/**
 * main/im/telegram/uiText.ts
 * ---------------------------------------------------------------------------
 * 个人 Telegram bot 渠道的用户文案包。DM + 群 lane 双形态, 不启用 threadScoped,
 * 只提供共享编排层的非 thread 文案字段。与 Discord 包同一基调(IM 侧控制文案
 * 硬编码中文, 不进 renderer i18n — 与 hook-control/interactions.ts 同规)。
 */

import type { IMUnsupportedEntry } from '@cindy/im';

import type { ImUiTextPack } from '../shared/types';

export const telegramUiText = {
  expiredCardNotice: '卡片已过期',
} as const;

export const ui = {
  slash: {
    start:
      '👋 你好，我是你的个人 Cindy 助理~\n\n私聊直接发消息就行；群里 @ 我或回复我的消息才会触发。发 /help 看全部命令。',
    new: '🌱 新任务已创建 — 已在任务列表显示，从头开始吧~',
    help: `🤖 我能帮你做这些：

/new         创建新任务（旧任务保留；群里按当前群话题创建）
/project     切到某个项目目录干活（在 bot 这边跑，不接管 desktop）
/session     列最近的 desktop 任务，点一个直接接管续聊
/model       换个模型上场
/permission  调一下权限模式（auto / bypass / ask 等）
/settings    看看当前项目、Agent、模型、推理强度、权限
/ctr         远程接管 desktop 上的某个工作区（接管中再发可直接换任务）
/exctr       结束接管，回到 Telegram 对话
/help        看看我会啥

有活儿在跑想让它停？发 /stop（或 \`!stop\`），我会立刻中止当前执行、把排队的消息也撤掉，任务保留可继续。

私聊直接发消息就行；群里 @ 我或回复我的消息才会触发，我也会记住群里最近的聊天做上下文~`,
    unknownCommand: (cmd: string) =>
      `没认出 \`${cmd}\` 这个命令 🤔\n我能听懂的: /new、/session、/project、/model、/permission、/settings、/ctr、/exctr、/stop、/help`,
    settings: ({ workspace, agent, model, effort, permission }) =>
      `⚙️ 当前设置\n\n项目：${workspace}\nAgent：${agent}\n模型：${model}\n推理强度：${effort}\n权限：${permission}\n\n想改就发 /project、/model、/permission～`,
    detachedBySlash: '🚪 接管结束，咱们回到 Telegram 对话。下次想远程操控 desktop 再 /ctr',
    detachedByRevoke: '⚠️ 你在 desktop 那边把接管收回去了，后续消息回到 Telegram 对话。',
    notAttached: '🤷 你现在没在接管任何任务，/exctr 闲着也没事可干。',
  },

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
      const message = `⚠️ 当前 Telegram 对话使用供应商「${provider}」（${model}），${reason}。`;
      return attached
        ? `${message}\n请在 desktop 的 Settings → 模型供应商中修复认证后，直接继续发送消息。`
        : `${message}\n“新对话配置”会用于新任务；修改后请发送 \`/new\`，再继续聊天。`;
    },
    controlInProgress:
      '🎮 你 /ctr 还在选择中呢 — 先把上面那张卡片操作完（或点 🚪 退出），再来发别的~',
    credentialBusy:
      '⏳ 本地 agent 正在跑另一轮，暂时不能切换凭证模式。等上一轮结束后再发一次就行。',
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
    scheduledTaskHeader: (name: string | null) => (name ? `🤖 自动化「${name}」` : '🤖 自动化'),
    unsupportedOnly: (entries: IMUnsupportedEntry[]) =>
      `🙏 这条消息我吞不下：\n${entries.map((e) => `• ${e.label}`).join('\n')}\n\n` +
      `我能消化的: 文本、图片（jpg/png/gif/webp）、PDF、代码与配置类文本文件。`,
    unsupportedNotice: (entries: IMUnsupportedEntry[]) =>
      `ℹ️ 以下内容我消化不了，先丢一边了：\n${entries.map((e) => `• ${e.label}`).join('\n')}\n\n` +
      `其它部分收到啦，正在处理~`,
  },

  error: {
    agentUnsupported: '🤔 当前 Agent 无法在 Telegram 群里完成所需的权限确认，请换一个 Agent 再试。',
    permissionModeUnsupported:
      '🤔 当前权限设置无法用于这条 Telegram 群对话。发 /permission 换成「自动审批」后再试。',
  },

  cards: {
    permission: {
      title: (toolName: string) => `🔧 工具调用：${toolName}`,
      paramsLabel: '**参数预览**',
      btnAllowOnce: '✅ 仅本次允许',
      btnAllowAlways: '✅ 总是允许',
      btnDeny: '❌ 拒绝',
      resolvedAllowOnce: '✅ 已允许（仅本次）',
      resolvedAllowAlways: '✅ 已允许（这个工具以后都放行）',
      resolvedDeny: '❌ 已拒绝',
    },
    ask: {
      title: (header: string) => `❓ ${header}`,
      noOptionsHint: '_（这个问题没有预设选项，直接发文字回我吧）_',
      resolved: (optionLabel: string) => `✅ 已选：${optionLabel}`,
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
    project: {
      title: '📂 切个项目目录',
      hint: (currentName: string) =>
        `**当前**：${currentName}\n选一个项目，接下来的消息就在那个目录里干活（会重开上下文，模型和权限设置保留）`,
      emptyBody: '_desktop 端还没有活跃的项目工作区~ 先在 desktop 里打开一个项目再来_',
      btnDialogue: '💬 回到对话',
      btnCancel: '🚪 算了',
      resolvedPick: (displayName: string) =>
        `📂 已切到 **${displayName}** —— 新上下文已就位，直接发指令开干。想回普通聊天发 /project 选「回到对话」`,
      resolvedDialogue: '💬 已回到对话目录，上下文重新开始~',
      resolvedCancel: '🚪 没切，保持现状',
      switchFailed: (reason: string) => `❌ 没切过去：${reason}（目录可能已被移动或删除）`,
      attachedUnsupported:
        '🎮 你正在 /ctr 接管一个 desktop 任务——接管期间消息直接进那个任务，不需要 /project。想切项目先 `/exctr` 退出接管',
      dialogueName: '对话（托管目录）',
    },
    control: {
      title: '🎮 挑个工作区上号',
      emptyBody: '_暂时还没有可接管的工作区~ 在 desktop 端打开/创建一个任务再来_',
      recentSessions: {
        title: '🕑 最近的任务',
        hint: '点一个直接接管续聊（跨工作区按时间排）· 想按工作区挑用 /ctr · 🚪 退出取消',
        emptyBody: '_desktop 端还没有活跃任务~ 先在 desktop 里开一个再来_',
        optionLabel: (title: string, workspaceName: string | null) =>
          workspaceName ? `${title} · ${workspaceName}` : title,
      },
      hint: '点工作区往下走；点 🚪 退出 取消这次',
      attachedSwitchHint: (sessionTitle: string) =>
        `🎮 当前接管中：**${sessionTitle}**\n选个新任务直接换乘；点 🚪 退出则保持现状`,
      btnExit: '🚪 撤了',
      resolvedExit: '🚪 走了，下次想远程操控再 /ctr',
      sessionPickerTitle: (displayName: string) => `🎮 ${displayName} 里的任务`,
      sessionPickerHint: '挑个任务继续 · ➕ 新建 开新任务 · ↩️ 后退 换工作区 · 🚪 退出 取消',
      sessionPickerEmptyBody: (displayName: string) =>
        `_工作区 **${displayName}** 这边还没有 active 任务~ 不如点 ➕ 新建 开一个？_`,
      btnNew: '➕ 新建',
      btnBack: '↩️ 后退',
      resolvedSessionPick: (sessionTitle: string, workspaceName: string) =>
        `🎯 上号了：**${sessionTitle}**（${workspaceName}）\n接下来你发消息我就直接进这个任务；想撤随时 \`/exctr\``,
      resolvedNewSession: (workspaceName: string) =>
        `✨ 新任务已建 + 接管完成（在 **${workspaceName}** 里）\n直接发指令开聊；想退就 \`/exctr\``,
      attachFailed: (reason: string) => `❌ 没接上：${reason}`,
      sessionBusyOldCardPlaceholder: '⏳ 那个任务还在跑——下方给你刷了张新卡片，重选一下吧',
      sessionBusyPrompts: [
        (sessionTitle: string) =>
          `⏳ **${sessionTitle}** 这会儿正忙~\nagent 还在思考/敲代码，等它这轮跑完再 \`/ctr\` 上号`,
        (sessionTitle: string) =>
          `🚧 抢不进去——**${sessionTitle}** 还有一轮没收尾。\n喝口水等几秒，agent 把手头的事跑完就来叫你`,
        (sessionTitle: string) =>
          `🤖 **${sessionTitle}** 正忙着呢——agent 还在键盘上飞舞，强插会让它分神。\n稍等几秒再 \`/ctr\` 试一下`,
        (sessionTitle: string) =>
          `☕ 别急别急——**${sessionTitle}** 这一轮还没跑完。\nagent 干完手头的事，指挥权立刻交给你`,
      ],
      takeoverLoadingPrompts: [
        (sessionTitle: string) =>
          `⏳ 正在让你接管 **${sessionTitle}**…\n_📦 加载任务元数据_  ·  _🔌 接通 agent 通道_  ·  _🧠 复盘上一轮进展_\n_三两秒就好_`,
        (sessionTitle: string) =>
          `🎮 接入 **${sessionTitle}** 中…\n_正在把上下文搬过来，马上就好_`,
        (sessionTitle: string) =>
          `⌛ **${sessionTitle}** 加载中…  99%\n_这条进度条是真的——正在翻你们上一轮聊了啥_`,
        (sessionTitle: string) =>
          `🛰️ 正在与 **${sessionTitle}** 建立连接…\n_(在想该怎么给你 brief)_`,
      ],
      sessionAttachedOneshotPrompts: [
        '我刚通过 Telegram 远程接入了——简单同步下现状：上一轮做了啥、当前在哪一步，然后问我下一步咋走。',
        '我接力了——一句话过下进度，告诉我现在到哪、刚做了啥，再问我要不要继续推进或者换方向。',
        'Hi 我从 Telegram 接手了——快速 brief 一下当前形势、最新结果是啥，最后问我下一步指令。',
        '切到我了——简单复盘下，告诉我现在是什么阶段，然后问我要不要继续干。',
      ],
      newSessionWelcomePrompts: [
        (workspaceName: string) =>
          `🎯 接管 + 新建 一气呵成——**${workspaceName}** 已就位，agent 待命中。\n发第一条指令开聊；想撤随时 \`/exctr\``,
        (workspaceName: string) =>
          `✨ 新任务已建——工作目录 **${workspaceName}** 已经备好，agent 等你发话。\n第一条消息开聊；\`/exctr\` 随时退出`,
        (workspaceName: string) =>
          `🎮 准备就绪——在 **${workspaceName}** 给你开了个全新任务。\n要做啥告诉我，agent 在线~  \`/exctr\` 收手`,
        (workspaceName: string) =>
          `🆕 全新开局——**${workspaceName}** 工作目录已经 ready。\n第一条指令开聊；不想继续就 \`/exctr\``,
      ],
    },
  },
} satisfies ImUiTextPack;

export const PROCESSING_EMOJI = '👀';
