/**
 * threadUiFixture.ts — threadScoped 渠道文案包测试样本。
 *
 * 老 SlackIM relay 渠道 2026-07-17 退役后,生产代码已没有 threadScoped 渠道,
 * 但 shared/ 的 thread = session 路由机制(turnRunner / cardActionHandler /
 * controlFlow)保留给未来渠道。本 fixture 保存原 slack uiText 的完整
 * ImUiTextPack,供 thread 路由类测试当自洽样本断言,不进产品包。
 */

import type { IMUnsupportedEntry } from '@cindy/im';

import type { ImUiTextPack } from '../types';

export const ui = {
  // ── slash command replies ──────────────────────────────────────────────────
  slash: {
    new: '🌱 新存档已开 — 之前的对话清掉了，从头聊~',
    help: `🤖 这里是 thread 玩法：**在顶层发一条消息 = 开一个新会话**，我会在那条消息的 thread 里回复；进 thread 继续聊就是同一个会话。多个 thread 可以同时开打、互不干扰。

命令统一用 \`/xdmaker 子命令\`：

/xdmaker ctr         远程连接 desktop 上的会话（每次开一个新 thread，可同时控多个）
/xdmaker exctr       退出**全部**远程连接（退单个用对应 thread 顶部卡片的 🚪 按钮）
/xdmaker help        看看我会啥

任务跑着想让它停？在对应 thread 里直接发 \`!stop\`（不带 /xdmaker 前缀），我会立刻中止当前任务、把排队的消息也撤掉，会话保留可继续。

不用 /new —— 想开新会话，顶层再发一条消息就行~`,
    unknownCommand: (cmd: string) =>
      `没认出 \`${cmd}\` 这个命令 🤔\n我能听懂的: /xdmaker new、model、permission、ctr、exctr、help`,
    detachedBySlash: '🚪 接管结束，咱们回到私聊频道。下次想远程操控 desktop 再 /xdmaker ctr',
    detachedByRevoke:
      '⚠️ 你在 desktop 那边把接管收回去了，后续消息回到我们俩的私聊。',
    notAttached: '🤷 你现在没在接管任何会话，/xdmaker exctr 闲着也没事可干。',
  },

  // ── agent runtime feedback ─────────────────────────────────────────────────
  agent: {
    completedNoText: '✅ 跑完啦（这一轮 agent 没说话）',
    runtimeError: (errMsg: string) => `⚠️ Agent 翻车了：${errMsg.slice(0, 200)}`,
    sendInternalError: (errMsg: string) => `❌ 内部出 bug 了：${errMsg}`,
    apiKeyMissing:
      '⚠️ XD 网关 Key 还没配呢~\n去 desktop 的 Settings → 模型供应商里连接 XD 网关，再来 ping 我',
    controlInProgress:
      '🖥️ 远程连接还在选择中呢 — 先把 thread 里那张卡片操作完（或点 🚪 退出），再来发别的~',
    credentialBusy:
      '⏳ 本地 agent 正在跑另一轮，暂时不能切换凭证模式。等上一轮结束后再发一次就行。',
    /** turn 进行中收到新消息 — 入队提示（跑完自动按序派发, 不报错）。 */
    queuedNotice: (position: number) =>
      position <= 1
        ? '⏳ 上一轮还在跑，这条先排队——跑完自动接上。想直接叫停就发 `!stop`'
        : `⏳ 上一轮还在跑，这条排在第 ${position} 位——会按顺序发给 agent。想直接叫停就发 \`!stop\``,
    /** `!stop` 生效 — 当前任务已中止, 会话保留可继续。 */
    stopDone: (droppedQueued: number) =>
      droppedQueued > 0
        ? `⏹ 已叫停当前任务，排队中的 ${droppedQueued} 条消息也一并撤了。会话还在——想继续随时发新指令~`
        : '⏹ 已叫停当前任务。会话还在——想继续随时发新指令~',
    /** `!stop` 时没有任务在跑。 */
    stopIdle: '🤷 现在没有正在跑的任务，`!stop` 落了个空。等有活儿要停的时候再喊我~',
    /** 远程连接时转播自动任务 turn 的卡片头(系统自动发起,非用户)。 */
    scheduledTaskHeader: (name: string | null) =>
      name ? `🤖 自动任务「${name}」` : '🤖 自动任务',
    /** 用户发的内容**全部**模型都处理不了——单独发，不进 Agent。 */
    unsupportedOnly: (entries: IMUnsupportedEntry[]) =>
      `🙏 这条消息我吞不下：\n${entries.map((e) => `• ${e.label}`).join('\n')}\n\n` +
      `我能消化的: 文本、图片（jpg/png/gif/webp）、PDF、代码与配置类文本文件。`,
    /** 用户发的内容**部分**能处理——先 ack 提示，再继续把能处理的部分送给 Agent。 */
    unsupportedNotice: (entries: IMUnsupportedEntry[]) =>
      `ℹ️ 以下内容我消化不了，先丢一边了：\n${entries.map((e) => `• ${e.label}`).join('\n')}\n\n` +
      `其它部分收到啦，正在处理~`,
  },

  // ── card text ──────────────────────────────────────────────────────────────
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
      currentLine: (label: string, description: string) =>
        `**当前**：${label}\n_${description}_`,
      hint: '点下面切换。auto = 常规放行+敏感操作弹卡片；bypass = 全放行；ask/default/plan/acceptEdits = 走卡片审批',
      optionLabel: (label: string) => label,
      resolved: (label: string) => `✅ 权限模式切到 ${label} 了`,
      failed: (reason: string) => `❌ 权限模式没切过去：${reason}`,
      fullAccessConfirmTitle: '⚠️ 确认开启 Full access？',
      fullAccessConfirmBody: 'Full access 会关闭工作区沙箱并跳过常规审批。Cindy 可以修改工作区外的文件、执行联网命令且不再询问；内置高风险操作仍会要求确认。',
      btnConfirmFullAccess: '开启 Full access',
      btnCancelFullAccess: '保留当前权限',
      fullAccessCancelled: '已取消，保留当前权限',
    },
    control: {
      title: '🎮 挑个工作区上号',
      emptyBody: '_暂时还没有可接管的工作区~ 在 desktop 端打开/创建一个会话再来_',
      hint: '点工作区往下走；点 🚪 退出 取消这次',
      /** 接管态下重发 /xdmaker ctr — picker 顶部提示当前接管中的会话, 选新的直接换乘。 */
      attachedSwitchHint: (sessionTitle: string) =>
        `🎮 当前接管中：**${sessionTitle}**\n选个新会话直接换乘；点 🚪 退出则保持现状`,
      btnExit: '🚪 撤了',
      resolvedExit: '🚪 已退出，这次就不上号了',
      sessionPickerTitle: (displayName: string) => `🎮 ${displayName} 里的存档`,
      sessionPickerHint:
        '挑个会话继续打 · ➕ 新建 开新存档 · ↩️ 后退 换工作区 · 🚪 退出 取消',
      sessionPickerEmptyBody: (displayName: string) =>
        `_工作区 **${displayName}** 这边还没有 active 会话~ 不如点 ➕ 新建 开一个？_`,
      btnNew: '➕ 新建',
      btnBack: '↩️ 后退',
      resolvedSessionPick: (sessionTitle: string, workspaceName: string) =>
        `🎯 上号了：**${sessionTitle}**（${workspaceName}）\n接下来你在这个 thread 发消息就直接进这个会话；想撤就点顶部卡片的 🚪`,
      resolvedNewSession: (workspaceName: string) =>
        `✨ 新存档已建 + 远程连接就绪（在 **${workspaceName}** 里）\n直接发指令开聊；想退就点顶部卡片的 🚪`,
      attachFailed: (reason: string) => `❌ 没接上：${reason}`,
      sessionBusyOldCardPlaceholder:
        '⏳ 那个会话还在跑——下方给你刷了张新卡片，重选一下吧',
      sessionBusyPrompts: [
        (sessionTitle: string) =>
          `⏳ **${sessionTitle}** 这会儿正在 BOSS 战~\nagent 还在思考/敲代码，等它这把打完再 \`/xdmaker ctr\` 上号`,
        (sessionTitle: string) =>
          `🚧 抢不进去——**${sessionTitle}** 还有一回合没收尾。\n喝口水等几秒，agent 把手头这把跑完就来叫你`,
        (sessionTitle: string) =>
          `🤖 **${sessionTitle}** 正忙着呢——agent 还在键盘上飞舞，强插会让它分神。\n稍等几秒再 \`/xdmaker ctr\` 试一下`,
        (sessionTitle: string) =>
          `☕ 别急别急——**${sessionTitle}** 这一局还没打完。\nagent 干完手头的事，指挥权立刻交给你`,
      ],
      takeoverLoadingPrompts: [
        (sessionTitle: string) =>
          `⏳ 正在让你接管 **${sessionTitle}**…\n_📦 加载存档元数据_  ·  _🔌 接通 agent 通道_  ·  _🧠 复盘上回合战况_\n_三两秒就好，咖啡别一口闷完_`,
        (sessionTitle: string) =>
          `🎮 登入 **${sessionTitle}** 中…\n_早期版本里，等不及的玩家会狂点 Slack 图标，但其实并没有用_`,
        (sessionTitle: string) =>
          `⌛ **${sessionTitle}** 加载中…  99%\n_这条进度条是真的——正在翻你们上回合聊了啥_`,
        (sessionTitle: string) =>
          `🛰️ 正在与 **${sessionTitle}** 建立连接…\n_(WiFi 信号好像有点弱…哦不，是在想该怎么给你 brief)_`,
      ],
      sessionAttachedOneshotPrompts: [
        '我刚通过 Slack 远程上号了——简单同步下战况：上回合咋样、当前在哪一步，然后问我下一步咋走。',
        '我接力了——一句话过下进度，告诉我现在到哪、刚做了啥，再问我要不要继续推进或者换方向。',
        'Hi 我从 Slack 接手了——快速 brief 一下当前形势、最新结果是啥，最后问我下一步指令。',
        '切到我了——简单复盘下，告诉我现在是什么阶段，然后问我要不要继续干。',
      ],
      newSessionWelcomePrompts: [
        (workspaceName: string) =>
          `🎯 接管 + 开档 一气呵成——**${workspaceName}** 已就位，agent 待命中。\n发第一条指令开聊；想撤随时 \`/xdmaker exctr\``,
        (workspaceName: string) =>
          `✨ 新存档已建——工作目录 **${workspaceName}** 已经备好，agent 等你发话。\n第一条消息开打；\`/xdmaker exctr\` 随时退出`,
        (workspaceName: string) =>
          `🎮 准备就绪——在 **${workspaceName}** 给你开了个全新存档。\n要做啥告诉我，agent 在线~  \`/xdmaker exctr\` 收手`,
        (workspaceName: string) =>
          `🆕 全新开局——**${workspaceName}** 工作目录已经 ready。\n第一条指令开聊；不想玩了就 \`/xdmaker exctr\``,
      ],
    },
  },

  // ── thread = session 模型专属文案 ──────────────────────────────────────────
  thread: {
    sessionHeaderCard: {
      title: '🧵 新会话已开启',
      body:
        '你刚才那条消息开出了一条**全新会话**，这个 thread 就是它的家：\n' +
        '· 在 **thread 里回复** = 继续这条会话\n' +
        '· 回到**顶层**再发一条新消息 = 另开一条新会话\n' +
        '_等会话聊出主题后，这张卡片会自动换上它的名字_',
    },
    sessionHeaderTitled: (title: string) => ({
      title: `🧵 ${title}`,
      body: '这个 thread 正在处理这条会话 — 在 thread 里回复即可继续',
    }),
    controlAnchorCard: {
      title: '🖥️ 远程连接',
      body:
        '想远程连接 desktop 上的某条会话？\n' +
        '⬇️ **点开这条消息的 thread**（下方的「回复」入口），在里面挑工作区和会话。\n' +
        '选好后这张卡片会变成那条会话的名片，它的 thread 就是你们的专属频道。',
    },
    controlCancelled: '🚪 已取消这次远程连接',
    btnStartControl: '🖥️ 发起远程连接',
    takeoverCard: (sessionTitle: string, workspaceName: string) => ({
      title: `🧵 ${sessionTitle}`,
      body: `🖥️ 远程连接中 · 工作区 **${workspaceName}**\n在这条消息的 **thread 里回复**，就是直接驱动这条会话\n🚪 想撤就点下方按钮`,
    }),
    takeoverNewSessionCard: (workspaceName: string) => ({
      title: '🧵 新会话（刚建好）',
      body: `🖥️ 远程连接中 · 工作区 **${workspaceName}**\n在这条消息的 **thread 里回复**开聊 — 第一条消息会自动给会话起名，这张卡片会跟着换名字\n🚪 想撤就点下面的按钮`,
    }),
    btnExitTakeover: '🚪 退出连接',
    takeoverExited: (sessionTitle: string | null) => ({
      ...(sessionTitle ? { title: `🧵 ${sessionTitle}` } : {}),
      body: '🚪 已退出远程连接 — 这个 thread 不再驱动该会话',
    }),
    takeoverReplaced: (sessionTitle: string) =>
      `🔁 **${sessionTitle}** 的远程连接已转移到新的 thread — 这个 thread 不再驱动该会话`,
    newDeprecated:
      '🌱 这里不需要 /new — 在**顶层**直接发一条新消息, 就会开一个全新会话 thread~',
    perThreadConfigUnsupported:
      '🙈 每个 thread 都是独立会话, Slack 的斜杠命令带不上 thread 上下文, 所以暂不支持切换模型/权限 — 新 thread 会用默认配置',
    exctrAllDone: (count: number) =>
      `🚪 已退出全部远程连接(${count} 个 thread)。对应 thread 不再驱动 desktop 会话`,
    exctrNothing: '🤷 当前没有正在远程连接的 thread~',
  },
} satisfies ImUiTextPack;

/** Slack emoji 名("已收到" ack 回应)。 */
export const PROCESSING_EMOJI = 'eyes';
