/**
 * 待发送消息 → 消息流渲染项。
 * ---------------------------------------------------------------------------
 * 为什么这些气泡必须进消息流(而不是继续挂在列表 footer):
 *
 * 排队 / 落定 / outbox 气泡原来渲染在 LegendList 的 ListFooterComponent 里,正式消息在
 * data 里。消息回流时气泡必须跨容器搬家 —— footer 里卸载、data 里挂载,位置也从「footer
 * 的落点」跳到「列表末项」。空会话时更明显:listData 为空会渲染撑满高度的居中「正在同步」
 * 占位,把 footer 顶到屏幕中间,于是用户看到「气泡在屏幕中间 → 消失 → 在底部重新出现」
 * (实测两张截图位置差约 18% 屏高)。key 统一、同帧提交都救不了跨容器搬家。
 *
 * 进了 data 之后:与正式消息同容器、同 key(`message-${clientId}`)、同一处位置,回流就是
 * 同一个列表位置上的内容替换 —— 原地变实,零跳动;listData 也不再为空,居中占位自然不出现。
 *
 * 顺序契约(与原 footer 一致):落定中(已出队、等回流)在前,排队中居中,本地 outbox 在后
 * —— outbox 是最晚发出的。
 */
import { syntheticTriggerKind } from '@cindy/maker-shared/synthetic-trigger';
import {
  parseChatQuoteSegments,
  stripChatQuoteMarkerLines,
} from '@cindy/maker-shared/chat-quotes';
import { i18n } from '@/i18n';
import type { MobileOutboxDisplayItem, MobileOutboxThumb } from '@/session/sessionOutbox';
import {
  buildVisibleSentInlineTokens,
  type SentInlineToken,
} from '@/session/sentMessageAtoms';
import type { QueuedRemoteMessage } from '@/session/types';

export type MobilePendingSendPhase =
  /** 已确认入队,等被控端派发。 */
  | 'queued'
  /** enqueue RPC 在途,还没有「已入队」这个事实。 */
  | 'sending'
  /** 已被派发出队,消息还没回流。 */
  | 'settling'
  /** 本地 outbox:附件还在上传 / 等轮到队首。 */
  | 'uploading'
  /** 上传或 enqueue 失败,气泡保留待用户重试 / 删除。 */
  | 'failed'
  /** 正在底部 composer 里编辑这一条。 */
  | 'editing';

/** 气泡上的三个队列操作在当前条目上可不可用(由 buildQueueRowPresentation 预先算好)。 */
export interface MobilePendingSendActions {
  remove: { disabled: boolean; disabledReason: string | null };
  edit: { disabled: boolean; disabledReason: string | null };
  steer: { disabled: boolean; disabledReason: string | null };
}

export interface MobilePendingSendItem {
  type: 'pending_send';
  /** 与回流后的正式消息项同 key —— 同一个列表位置,内容原地替换。 */
  key: string;
  clientId: string;
  text: string;
  /** Structured quote / pasted-text / Slash atoms used by the optimistic renderer. */
  sentInlineTokens: SentInlineToken[];
  phase: MobilePendingSendPhase;
  /** 队列序号(从 1 起,用于无障碍播报);不在队列里的条目为 null。 */
  queueIndex: number | null;
  thumbs: MobileOutboxThumb[];
  /** 非图片附件数(pdf / office 等,渲染「N 个文件」计数行)。 */
  fileCount: number;
  /** 附件总数与已上传数(uploading 阶段渲染「上传中 k/N」)。 */
  attachmentCount: number;
  uploadedCount: number;
  errorText: string | null;
  /** 可否轻点展开操作行:只有还在队列里的条目能取消 / 编辑 / 插队。 */
  actions: MobilePendingSendActions | null;
  /** 展开后显示的提示(插队限制等)。 */
  hint: string | null;
}

export interface MobileMessageListExtraData {
  pendingSendSelectedClientId: string | null;
  shareSelectionActive: boolean;
}

/**
 * LegendList 的行外刷新信号。待发送气泡的展开态不改变 data，必须把选中项放进
 * extraData，才能让已复用的可见行重新计算操作区。
 */
export function buildMobileMessageListExtraData(
  pendingSendSelectedClientId: string | null,
  shareSelectionActive: boolean,
): MobileMessageListExtraData {
  return { pendingSendSelectedClientId, shareSelectionActive };
}

/** 待发送气泡是否处于展开态；生产渲染与状态转换测试共用同一判据。 */
export function isPendingSendItemSelected(
  item: Pick<MobilePendingSendItem, 'actions' | 'clientId' | 'phase'>,
  selectedClientId: string | null,
): boolean {
  const interactive = item.actions !== null || item.phase === 'failed';
  return interactive && selectedClientId === item.clientId;
}

export function pendingSendItemKey(clientId: string): string {
  return `message-${clientId}`;
}

/**
 * 气泡显示文本:合成 UI 指令行(桌面「失败后继续」等隐藏 prompt)用遮蔽标签替代原文
 * —— 裸英文指令不能给用户看(对齐桌面 PendingQueuePanel 的 i18n 遮蔽标签)。
 */
export function pendingSendBubbleText(
  item: Pick<QueuedRemoteMessage, 'text' | 'chatMessage'>,
): string {
  const visibleText = item.chatMessage.quotesEncoded === true
    ? stripChatQuoteMarkerLines(item.text)
    : item.text;
  const kind = syntheticTriggerKind(visibleText);
  if (kind === 'continue') return i18n.t('message.queue.continueSystemInstruction');
  if (kind === 'generic') return i18n.t('message.queue.systemInstruction');
  return visibleText;
}

function buildPendingSentInlineTokens(input: {
  text: string;
  quotesEncoded?: boolean;
  pastedTextRanges?: Array<{ start: number; end: number; display: string }>;
  slashCommandRanges?: Array<{ start: number; end: number }>;
}): SentInlineToken[] {
  const quoteSegments = input.quotesEncoded === true && input.text
    ? parseChatQuoteSegments(input.text)
    : [];
  const visibleText = input.quotesEncoded === true
    ? stripChatQuoteMarkerLines(input.text)
    : input.text;
  // 合成 UI 指令(「失败后继续」等)在正式消息流里会被隐藏。即使发送链路意外
  // 给它带了 Slash range，乐观气泡也不能把裸指令重新泄露出来。
  if (syntheticTriggerKind(visibleText)) return [];
  const segments = quoteSegments.length > 0
    ? quoteSegments
    : input.text ? [{ kind: 'text' as const, text: input.text }] : [];
  return buildVisibleSentInlineTokens(
    input.text,
    segments,
    input.pastedTextRanges,
    input.slashCommandRanges,
  );
}

/**
 * 排队 / 落定气泡的图片缩略数据:消息 files 里的图片附件此刻仍是 `cindy-oss-attach://`
 * 中转引用,本地渲染靠 sentAttachmentThumbStore 的兜底映射。非图片附件走计数行。
 */
function queuedAttachmentThumbs(
  item: Pick<QueuedRemoteMessage, 'clientId' | 'files'>,
  previewByOssRef?: ReadonlyMap<string, string>,
): { thumbs: MobileOutboxThumb[]; fileCount: number } {
  const thumbs: MobileOutboxThumb[] = [];
  let fileCount = 0;
  (item.files ?? []).forEach((file, index) => {
    if (file.category !== 'image') {
      fileCount += 1;
      return;
    }
    const ossRef = file.url ?? file.path;
    thumbs.push({
      key: `${item.clientId}-file-${index}`,
      // 发送时刻抓下的本地预览优先:sentAttachmentThumbStore 那条兜底链要等「上传落定 →
      // 拷进自有目录 → AsyncStorage hydrate」全部完成才查得到,期间 getSentAttachmentThumbUri
      // 一律返回 null,排队气泡只能画空占位格(实测:兜底文件已生成,气泡仍是空方块)。
      // 乐观语义下图必须从第一帧就在,所以直接用手边的 file:// 预览,store 只作为
      // 「重开会话 / 预览已失效」时的后备。
      uri: (ossRef && previewByOssRef?.get(ossRef)) || null,
      ossRef,
      uploading: false,
    });
  });
  return { thumbs, fileCount };
}

export interface BuildPendingSendItemsInput {
  /** 权威队列(projection.pendingQueue)。 */
  queue: readonly QueuedRemoteMessage[];
  /** 已出队、等回流的落定条目。 */
  settling: readonly QueuedRemoteMessage[];
  /** 本地待发条目(附件上传中 / enqueue 在途或失败)。 */
  outbox: readonly MobileOutboxDisplayItem[];
  /** 已回流进消息流的 clientId:正式消息已在流里,气泡不再渲染(避免双显)。 */
  hiddenClientIds: ReadonlySet<string>;
  /** enqueue RPC 在途的 clientId(徽标转圈,不谎报「已入队」)。 */
  sendingClientIds: ReadonlySet<string>;
  /** 正在 composer 里编辑的条目。 */
  editingClientId: string | null;
  /** 插队发送中的 clientId(projection.steeringQueueClientIds)。 */
  steeringClientIds: ReadonlySet<string>;
  /** 每个在队条目的操作可用性 + hint,由调用方用 buildQueueRowPresentation 算好。 */
  presentationByClientId: ReadonlyMap<string, { actions: MobilePendingSendActions; hint: string | null }>;
  /**
   * 发送时刻记下的「附件 ossRef → 本地预览 file://」。
   * 排队气泡的图靠它即时显示,不等 sentAttachmentThumbStore 的拷贝 + hydrate 链。
   */
  previewByOssRef?: ReadonlyMap<string, string>;
}

/**
 * 组装消息流末尾的待发送气泡项。
 *
 * 落定中的条目也可能同时还在 queue 里(派发失败被塞回队首):按 clientId 去重,queue 优先
 * —— 它带着可用的队列操作。
 */
export function buildPendingSendItems(input: BuildPendingSendItemsInput): MobilePendingSendItem[] {
  const items: MobilePendingSendItem[] = [];
  const seen = new Set<string>();

  const pushQueued = (item: QueuedRemoteMessage, phase: MobilePendingSendPhase, queueIndex: number | null) => {
    if (seen.has(item.clientId) || input.hiddenClientIds.has(item.clientId)) return;
    seen.add(item.clientId);
    const attachments = queuedAttachmentThumbs(item, input.previewByOssRef);
    const presentation = queueIndex === null
      ? null
      : input.presentationByClientId.get(item.clientId) ?? null;
    items.push({
      type: 'pending_send',
      key: pendingSendItemKey(item.clientId),
      clientId: item.clientId,
      text: pendingSendBubbleText(item),
      sentInlineTokens: buildPendingSentInlineTokens({
        text: item.text,
        quotesEncoded: item.chatMessage.quotesEncoded,
        pastedTextRanges: item.chatMessage.pastedTextRanges,
        slashCommandRanges: item.chatMessage.slashCommandRanges,
      }),
      phase,
      queueIndex,
      thumbs: attachments.thumbs,
      fileCount: attachments.fileCount,
      attachmentCount: attachments.thumbs.length + attachments.fileCount,
      uploadedCount: attachments.thumbs.length + attachments.fileCount,
      errorText: null,
      actions: presentation?.actions ?? null,
      hint: presentation?.hint ?? null,
    });
  };

  // 落定中在前:它们已经离开队列、最先被派发。
  for (const item of input.settling) {
    if (input.queue.some((queued) => queued.clientId === item.clientId)) continue;
    pushQueued(item, 'settling', null);
  }
  input.queue.forEach((item, index) => {
    const phase: MobilePendingSendPhase = input.editingClientId === item.clientId
      ? 'editing'
      : input.steeringClientIds.has(item.clientId) || input.sendingClientIds.has(item.clientId)
        ? 'sending'
        : 'queued';
    pushQueued(item, phase, index + 1);
  });
  // 本地 outbox 恒在最后:它们是最晚发出的消息。
  for (const item of input.outbox) {
    if (seen.has(item.clientId) || input.hiddenClientIds.has(item.clientId)) continue;
    seen.add(item.clientId);
    const uploadsPending = item.attachmentCount > 0 && item.uploadedCount < item.attachmentCount;
    items.push({
      type: 'pending_send',
      key: pendingSendItemKey(item.clientId),
      clientId: item.clientId,
      text: item.quotesEncoded ? stripChatQuoteMarkerLines(item.text) : item.text,
      sentInlineTokens: buildPendingSentInlineTokens(item),
      phase: item.failed ? 'failed' : uploadsPending ? 'uploading' : 'sending',
      queueIndex: null,
      thumbs: item.thumbnails,
      fileCount: item.fileCount,
      attachmentCount: item.attachmentCount,
      uploadedCount: item.uploadedCount,
      errorText: item.errorText,
      actions: null,
      hint: null,
    });
  }
  return items;
}

/** 气泡徽标该不该转圈(未确认发出 / 已出队待回流 / 上传中)。 */
export function pendingSendSpins(phase: MobilePendingSendPhase): boolean {
  return phase === 'sending' || phase === 'settling' || phase === 'uploading';
}
