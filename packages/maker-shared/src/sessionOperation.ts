export type ComposerVoiceState =
  | 'idle'
  | 'listening'
  | 'submitting'
  | 'refining'
  | 'done'
  | 'error';

export type SessionComposerSlot = 'missing-session' | 'pending-interaction' | 'read-only' | 'editable';
export type SessionMessageHistoryMode = 'hidden' | 'collapsed' | 'visible';
export type SessionComposerDensity = 'compact' | 'expanded';
export type SessionComposerPrimaryAction = 'none' | 'send' | 'stop';

// Mirrors desktop ccAgent.layout.chatPlaceholder for existing session chat input.
const DESKTOP_SESSION_CHAT_PLACEHOLDER_ZH_CN = '继续聊一聊…';

export interface SessionComposerLayoutInput {
  attachmentBusy: boolean;
  attachmentCount: number;
  attachmentPickerOpen: boolean;
  canStop: boolean;
  draftText: string;
  queueBusy: boolean;
  /** 待发送的选中文字引用条数(chat-text-quote)。缺省 0;纯引用无草稿也可发送。 */
  quoteCount?: number;
  sendUnavailableReason?: string | null;
  sending: boolean;
  voiceState: ComposerVoiceState;
}

export interface SessionComposerLayout {
  attachment: {
    active: boolean;
    disabled: boolean;
    disabledReason: string | null;
    label: string;
    remove: {
      disabled: boolean;
      disabledReason: string | null;
    };
  };
  density: SessionComposerDensity;
  input: {
    disabled: boolean;
    disabledReason: string | null;
    placeholder: string;
  };
  primaryAction: SessionComposerPrimaryAction;
  send: {
    disabled: boolean;
    disabledReason: string | null;
    label: string;
    visible: boolean;
  };
  stop: {
    disabled: boolean;
    disabledReason: string | null;
    label: string;
    visible: boolean;
  };
  voice: {
    active: boolean;
    disabled: boolean;
    disabledReason: string | null;
    label: string;
  };
  guidanceText: string;
  statusText: string;
}

export interface SessionOperationLayoutInput {
  hasCurrentSession: boolean;
  hasActivePendingInteraction: boolean;
  /**
   * 待处理卡是否该接管输入框。
   *
   * 判据是**整个 pending 集合**里还有没有本端能终结的卡,调用方请用
   * `pendingInteractionsBlockRemoteComposer(interactions)` 计算 —— 不要按「当前正在
   * 看的那张卡能不能终结」传值:队列里还有权限 / 提问 / 计划卡在等回答时,用户切到
   * 一张本端终结不了的卡不该把输入框放开,否则就绕过了那张阻塞交互。
   *
   * 传 false 时卡只展示、输入框继续可用;否则会话会被一张本端处理不了的卡锁死。
   * 缺省 true 保持既有调用方语义。
   */
  pendingInteractionBlocksComposer?: boolean;
  remoteUnavailableReason?: string | null;
  readOnlyReason?: string | null;
}

/** 待处理卡放哪:接管输入框 / 贴在输入框上方 / 不显示。 */
export type SessionPendingInteractionPlacement = 'composer' | 'above-composer' | 'none';

/**
 * 禁发理由的来源标识,locale 无关。
 *
 * `session-syncing` / `pending-interaction` 两条文案由本模型自己造(中文默认值),
 * 控制端要按 locale 翻译后再展示 —— 它会经 composer 与队列行的 accessibility
 * hint 读给用户,直出中文会让读屏在 en / ja / ko 下念混语(#530 review)。
 * `caller-provided` 表示理由是调用方传进来的(remoteUnavailableReason /
 * readOnlyReason),已由调用方负责本地化,原样展示即可。
 */
export type SessionComposerDisabledReasonSource =
  | 'session-syncing'
  | 'pending-interaction'
  | 'caller-provided';

export interface SessionOperationLayout {
  canUseComposer: boolean;
  composerDisabledReason: string | null;
  /** 上面那条理由的来源;null 表示没有禁发理由。 */
  composerDisabledReasonSource: SessionComposerDisabledReasonSource | null;
  composerSlot: SessionComposerSlot;
  messageHistoryMode: SessionMessageHistoryMode;
  pendingInteractionPlacement: SessionPendingInteractionPlacement;
  showPendingInteraction: boolean;
  showQueue: boolean;
}

export function composerVoiceStateLabel(state: ComposerVoiceState): string {
  switch (state) {
    case 'listening':
      return '正在听';
    case 'submitting':
      return '转写中';
    case 'refining':
      return '正在润色';
    case 'error':
      return '语音出错';
    default:
      return '语音';
  }
}

function isVoiceInputBusy(state: ComposerVoiceState): boolean {
  return state === 'listening' || state === 'submitting' || state === 'refining';
}

function isVoiceInputProcessing(state: ComposerVoiceState): boolean {
  return state === 'submitting' || state === 'refining';
}

export function buildSessionComposerLayout(input: SessionComposerLayoutInput): SessionComposerLayout {
  const hasDraft = input.draftText.trim().length > 0;
  const hasAttachments = input.attachmentCount > 0;
  const hasQuotes = (input.quoteCount ?? 0) > 0;
  const canSend = hasDraft || hasAttachments || hasQuotes;
  // 语音生命周期(listening/submitting/refining)内发送槽常驻(对齐桌面主槽永远占位):
  // 录音期间发送键就是「结束并发送」,转写落地前后布局都不变——否则首段转写让 canSend
  // 翻 true 的瞬间发送键才冒出来,右对齐按钮组整体左移,语音按钮让出的位置正好被
  // 停止任务按钮占据,手指原地再点一下会误停任务。
  const voiceBusy = isVoiceInputBusy(input.voiceState);
  const sendVisible = canSend || input.sending || voiceBusy;
  const stopVisible = input.canStop || input.queueBusy;
  const sendUnavailableReason = normalizeOptionalReason(input.sendUnavailableReason);
  const voiceLabel = composerVoiceStateLabel(input.voiceState);
  const attachmentDisabledReason = buildAttachmentDisabledReason(input);
  const inputDisabledReason = buildComposerInputDisabledReason(input);
  return {
    attachment: {
      active: input.attachmentPickerOpen || hasAttachments,
      disabled: attachmentDisabledReason !== null,
      disabledReason: attachmentDisabledReason,
      label: hasAttachments ? `附件 ${input.attachmentCount}` : input.attachmentPickerOpen ? '收起附件' : '附件',
      remove: {
        disabled: attachmentDisabledReason !== null,
        disabledReason: attachmentDisabledReason,
      },
    },
    density: shouldUseCompactComposer(input) ? 'compact' : 'expanded',
    input: {
      disabled: inputDisabledReason !== null,
      disabledReason: inputDisabledReason,
      placeholder: buildComposerPlaceholder({
        voiceState: input.voiceState,
      }),
    },
    primaryAction: resolveComposerPrimaryAction({
      canSend,
      canStop: input.canStop,
      queueBusy: input.queueBusy,
      sending: input.sending,
    }),
    send: {
      // attachmentBusy 必须挡发送:附件仍在异步上传时(典型:粘贴图片,无系统
      // picker 遮挡、UI 完全可交互),抢发会发出不含该附件的消息并把图滞留托盘。
      // listening 期间即使草稿还空着也可按(语义是「结束录音并发送」,对齐桌面
      // finish-and-send);submitting/refining 期间转写还没落地,禁用等润色完成。
      disabled: input.sending
        || input.attachmentBusy
        || sendUnavailableReason !== null
        || isVoiceInputProcessing(input.voiceState)
        || (!canSend && input.voiceState !== 'listening'),
      disabledReason: input.sending
        ? '消息正在发送到电脑端。'
        : input.attachmentBusy
          ? '附件上传中，完成后再发送。'
          : sendUnavailableReason
            ?? (isVoiceInputProcessing(input.voiceState)
              ? '语音正在处理，完成后再发送。'
              : canSend || input.voiceState === 'listening'
                ? null
                : '输入文字、添加附件或引用后才能发送。'),
      label: input.sending ? '发送中' : '发送',
      visible: sendVisible,
    },
    stop: {
      disabled: input.queueBusy || !input.canStop,
      disabledReason: input.queueBusy
        ? '队列操作同步中，暂时不能停止。'
        : input.canStop
          ? null
          : '电脑端当前没有可停止的执行。',
      label: input.queueBusy ? '处理中' : '停止',
      visible: stopVisible,
    },
    voice: {
      active: input.voiceState === 'listening',
      disabled: input.sending || isVoiceInputProcessing(input.voiceState),
      disabledReason: input.sending
        ? '消息正在发送到电脑端，完成后再录音。'
        : isVoiceInputProcessing(input.voiceState) ? '语音正在处理，完成后再录音。' : null,
      label: voiceLabel,
    },
    guidanceText: buildComposerGuidanceText(input),
    statusText: buildComposerStatusText({
      attachmentBusy: input.attachmentBusy,
      attachmentCount: input.attachmentCount,
      canStop: input.canStop,
      draftText: input.draftText,
      queueBusy: input.queueBusy,
      sending: input.sending,
      voiceLabel,
      voiceState: input.voiceState,
    }),
  };
}

function shouldUseCompactComposer(input: SessionComposerLayoutInput): boolean {
  return (input.voiceState === 'idle' || input.voiceState === 'done' || input.voiceState === 'error')
    && input.draftText.trim().length === 0
    && input.attachmentCount === 0
    && (input.quoteCount ?? 0) === 0
    && !input.attachmentPickerOpen
    && !input.attachmentBusy
    && !input.canStop
    && !input.queueBusy
    && !input.sending;
}

function buildAttachmentDisabledReason(input: SessionComposerLayoutInput): string | null {
  if (input.attachmentBusy) return '附件处理中，完成后再继续添加。';
  if (input.sending) return '消息正在发送到电脑端，完成后再调整附件。';
  return null;
}

function buildComposerInputDisabledReason(input: SessionComposerLayoutInput): string | null {
  if (input.sending) return '消息正在发送到电脑端。';
  return null;
}

function normalizeOptionalReason(reason: string | null | undefined): string | null {
  const normalized = reason?.trim();
  return normalized ? normalized : null;
}

export function buildSessionOperationLayout(input: SessionOperationLayoutInput): SessionOperationLayout {
  if (!input.hasCurrentSession) {
    return {
      canUseComposer: false,
      composerDisabledReason: '当前任务还没有同步完成。',
      composerDisabledReasonSource: 'session-syncing',
      composerSlot: 'missing-session',
      messageHistoryMode: 'hidden',
      pendingInteractionPlacement: 'none',
      showPendingInteraction: false,
      showQueue: false,
    };
  }

  if (input.remoteUnavailableReason) {
    return {
      canUseComposer: false,
      composerDisabledReason: input.remoteUnavailableReason,
      composerDisabledReasonSource: 'caller-provided',
      composerSlot: 'editable',
      messageHistoryMode: 'visible',
      pendingInteractionPlacement: 'none',
      showPendingInteraction: false,
      showQueue: false,
    };
  }

  const blocksComposer = input.pendingInteractionBlocksComposer !== false;
  if (input.hasActivePendingInteraction && blocksComposer) {
    return {
      canUseComposer: false,
      composerDisabledReason: '先处理电脑端的待处理请求后才能继续输入。',
      composerDisabledReasonSource: 'pending-interaction',
      composerSlot: 'pending-interaction',
      messageHistoryMode: 'visible',
      pendingInteractionPlacement: 'composer',
      showPendingInteraction: true,
      showQueue: false,
    };
  }

  // 本端处理不了的卡只贴在输入框上方:用户能看到电脑端在等什么、能取消(若该
  // 类型支持),同时继续发消息 —— 卡不再是死路。
  const placement: SessionPendingInteractionPlacement = input.hasActivePendingInteraction
    ? 'above-composer'
    : 'none';

  if (input.readOnlyReason) {
    return {
      canUseComposer: false,
      composerDisabledReason: input.readOnlyReason,
      composerDisabledReasonSource: 'caller-provided',
      composerSlot: 'read-only',
      messageHistoryMode: 'visible',
      pendingInteractionPlacement: placement,
      showPendingInteraction: placement !== 'none',
      showQueue: true,
    };
  }

  return {
    canUseComposer: true,
    composerDisabledReason: null,
    composerDisabledReasonSource: null,
    composerSlot: 'editable',
    messageHistoryMode: 'visible',
    pendingInteractionPlacement: placement,
    showPendingInteraction: placement !== 'none',
    showQueue: true,
  };
}

function resolveComposerPrimaryAction(input: {
  canSend: boolean;
  canStop: boolean;
  queueBusy: boolean;
  sending: boolean;
}): SessionComposerPrimaryAction {
  if (input.sending || input.canSend) return 'send';
  if (input.canStop || input.queueBusy) return 'stop';
  return 'none';
}

function buildComposerPlaceholder(input: Pick<SessionComposerLayoutInput, 'voiceState'>): string {
  if (input.voiceState === 'listening') return '正在听……';
  if (input.voiceState === 'submitting') return '正在转写语音';
  if (input.voiceState === 'refining') return '正在润色语音';
  return DESKTOP_SESSION_CHAT_PLACEHOLDER_ZH_CN;
}

function buildComposerGuidanceText(input: SessionComposerLayoutInput): string {
  const hasDraft = input.draftText.trim().length > 0;
  const hasAttachments = input.attachmentCount > 0;
  const hasQuotes = (input.quoteCount ?? 0) > 0;
  if (input.sending) return '消息正在写入桌面端队列，完成前请不要重复发送。';
  if (input.queueBusy) return '正在同步队列操作，完成后会刷新队列状态。';
  if (input.voiceState === 'listening' && hasDraft) {
    return '点发送会结束语音并发送当前文字；点输入框会结束语音并弹出键盘。';
  }
  if (input.voiceState === 'listening') return '正在听；点发送会结束语音并发送识别的文字，点输入框可结束语音并弹出键盘。';
  if (input.voiceState === 'submitting') return '正在转写语音，输入框会暂时锁定。';
  if (input.voiceState === 'refining') return '正在润色语音，完成后会更新输入框。';
  if (input.attachmentBusy) return '正在检查或上传附件，完成后会出现在附件列表。';
  if (input.sendUnavailableReason && (hasDraft || hasAttachments || hasQuotes)) return input.sendUnavailableReason;
  if (hasAttachments && hasDraft) return `将发送 ${input.attachmentCount} 个附件和输入框里的文字。`;
  if (hasAttachments) return `将只发送 ${input.attachmentCount} 个附件，也可以补充说明后再发送。`;
  if (input.attachmentPickerOpen) return '可以添加手机上的照片、截图或文件。';
  if (hasDraft) return '点发送后会进入桌面端队列，按当前任务设置执行。';
  if (hasQuotes) return `将发送 ${input.quoteCount} 处引用，也可以补充说明后再发送。`;
  if (input.canStop) return '电脑端正在执行；可继续排队输入，或点停止保留当前队列。';
  return '输入文字开始，使用 / 调命令，使用 @ 引用项目资源。';
}

function buildComposerStatusText(input: Pick<
  SessionComposerLayoutInput,
  'attachmentBusy' | 'attachmentCount' | 'canStop' | 'draftText' | 'queueBusy' | 'sending' | 'voiceState'
> & { voiceLabel: string }): string {
  if (input.sending) return '正在发送到电脑端';
  if (input.queueBusy) return '正在处理队列操作';
  if (isVoiceInputBusy(input.voiceState)) return input.voiceLabel;
  if (input.attachmentBusy) return '正在处理附件';
  return '就绪';
}
