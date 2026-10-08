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
 * 未派发条目保持队列 / outbox 顺序。已派发气泡在分组前占据本地用户消息的位置，
 * 正式回流以同一个 clientId 原位替换，不比较控制端与主机的时钟。
 */
import { queueItemVisibleText } from '@cindy/maker-shared/queue';
import { syntheticTriggerKind } from '@cindy/maker-shared/synthetic-trigger';
import {
  isHookSchedulerOrigin,
  readMessageSourceDevice,
  readMessageSourcePlugin,
  sanitizeSourceName,
  type MessageSourceDevice,
} from '@cindy/maker-shared/message-source';
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
import type { GetSentMessageImagePreview } from '@/session/sentMessageImagePreviews';
import type { MobileMessageRenderItem } from '@/session/messageRenderModel';
import {
  automationOriginLabel,
  orcaMessageTitle,
  sessionOriginLabel,
  sourceIdText,
  sourcePluginLabel,
} from '@/session/messageSourceLabels';
import { parseOrcaPersistedMessage, readOrcaPersistedSource } from '@/session/orcaCollab';

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

/** 排队气泡上方的来源标签种类(对齐桌面排队面板:自动化 / 任务 / 伙伴 / Orca / 插件)。 */
export type MobilePendingSendSourceKind = 'automation' | 'session' | 'teammate' | 'orca' | 'plugin';

export interface MobilePendingSendSource {
  kind: MobilePendingSendSourceKind;
  /** 已本地化的标签,同时用于无障碍播报。 */
  label: string;
  /** 已本地化的来源 ID(长按显示,对齐已发送消息的来源标签);脱敏来源没有。 */
  idText?: string;
}

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
  fileNames?: string[];
  /** 附件总数与已上传数(uploading 阶段渲染「上传中 k/N」)。 */
  attachmentCount: number;
  uploadedCount: number;
  errorText: string | null;
  /** Local outbox may defer cancellation while the first-message creation task owns recovery. */
  canCancel?: boolean;
  /** 可否轻点展开操作行:只有还在队列里的条目能取消 / 编辑 / 插队。 */
  actions: MobilePendingSendActions | null;
  /** 展开后显示的提示(插队限制等)。 */
  hint: string | null;
  /** 非本人手动输入的排队条目的来源标签;本人输入与本地 outbox 为 null。 */
  source?: MobilePendingSendSource | null;
  /** 手机 / 另一台电脑发来的排队消息的设备来源(气泡按查看设备决定是否显示,与已发送消息同一规则)。 */
  sourceDevice?: MessageSourceDevice;
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
  item: Pick<MobilePendingSendItem, 'actions' | 'canCancel' | 'clientId' | 'phase' | 'queueIndex'>,
  selectedClientId: string | null,
): boolean {
  return isPendingSendItemInteractive(item) && selectedClientId === item.clientId;
}

/** Local outbox rows can be cancelled before desktop accepts them; settled rows cannot. */
export function isPendingSendItemInteractive(
  item: Pick<MobilePendingSendItem, 'actions' | 'canCancel' | 'phase' | 'queueIndex'>,
): boolean {
  return item.actions !== null
    || (item.canCancel !== false && (item.phase === 'uploading'
      || item.phase === 'failed'
      || (item.phase === 'sending' && item.queueIndex === null)));
}

export function pendingSendItemKey(clientId: string): string {
  return `message-${clientId}`;
}

/**
 * History and queue snapshots can arrive independently. Deduplicate against the
 * rows actually being rendered, even when the queue's hidden-id snapshot is stale.
 * Duplicate keys reserve two list positions while mounting only one bubble.
 */
export function appendPendingSendItems<T extends { key: string }>(
  rendered: readonly T[],
  pending: readonly MobilePendingSendItem[],
): readonly (T | MobilePendingSendItem)[] {
  if (pending.length === 0) return rendered;
  const renderedKeys = new Set(rendered.map((item) => item.key));
  const remaining = pending.filter((item) => !renderedKeys.has(item.key));
  return remaining.length === 0 ? rendered : [...rendered, ...remaining];
}

/** Replace only local placeholders; durable echoes win even with stale queue state. */
export function mergePendingSendItems(
  rendered: readonly MobileMessageRenderItem[],
  pending: readonly MobilePendingSendItem[],
  optimisticClientIds: ReadonlySet<string>,
): readonly MobileMessageRenderItem[] {
  const byId = new Map(pending.map((item) => [item.clientId, item]));
  const replaced = optimisticClientIds.size === 0 ? rendered : rendered.map((item) =>
    item.type === 'message' && optimisticClientIds.has(item.message.source.clientId)
      ? byId.get(item.message.source.clientId) ?? item : item);
  return appendPendingSendItems(replaced, pending);
}

type PendingSendTextSource = Pick<QueuedRemoteMessage, 'text' | 'chatMessage'>
  & Partial<Pick<QueuedRemoteMessage, 'persistedContent' | 'files' | 'origin'>>;

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * 排队条目给人看的正文(不含合成指令遮蔽)。Orca 条目的 `text` 是发给 Agent 的原文
 * (带「[From Orca …]」前缀),与桌面排队面板一样优先显示 origin.displayText,其次
 * 落库 JSON 里的正文;其余条目沿用共享判据 queueItemVisibleText。
 */
function pendingSendAgentText(item: PendingSendTextSource): string {
  const origin = readRecord(item.origin);
  if (origin?.kind === 'orca') {
    if (typeof origin.displayText === 'string') return origin.displayText;
    const persisted = parseOrcaPersistedMessage(item.persistedContent);
    if (persisted) return persisted.body;
  }
  return queueItemVisibleText(item);
}

/**
 * 合成 UI 指令判定:以发给 Agent 的 `text` 为准(syntheticTrigger.ts 的唯一判据),
 * 可见正文也带前缀时同样遮蔽 —— 任一处命中,气泡只显示标签,绝不显示存储的原文。
 */
function pendingSendSyntheticKind(
  item: PendingSendTextSource,
  visibleText: string,
): 'continue' | 'generic' | null {
  return syntheticTriggerKind(item.text ?? '') ?? syntheticTriggerKind(visibleText);
}

/**
 * 气泡显示文本:合成 UI 指令行(桌面「失败后继续」等隐藏 prompt)用遮蔽标签替代原文
 * —— 裸英文指令不能给用户看(对齐桌面 PendingQueuePanel 的 i18n 遮蔽标签)。
 * 自动化 / 其他任务发来的条目显示落库可见正文(不带发给 Agent 的前缀或协议),
 * 与回流后的正式消息一致(queueItemVisibleText,与桌面排队面板同判据)。
 */
export function pendingSendBubbleText(item: PendingSendTextSource): string {
  const agentText = pendingSendAgentText(item);
  const visibleText = item.chatMessage.quotesEncoded === true
    ? stripChatQuoteMarkerLines(agentText)
    : agentText;
  const kind = pendingSendSyntheticKind(item, visibleText);
  if (kind === 'continue') return i18n.t('message.queue.continueSystemInstruction');
  if (kind === 'generic') return i18n.t('message.queue.systemInstruction');
  return visibleText;
}

/** 排队来源的 ID 文案:与已发送消息、桌面排队悬停共用 messageSourceIdEntries(插件优先、伙伴带伙伴 ID)。 */
function idTextField(item: unknown): { idText?: string } {
  const idText = sourceIdText(item);
  return idText ? { idText } : {};
}

/**
 * 排队条目的来源标签(对齐桌面 pendingQueueRowPresentation):自动化、其他任务 / 伙伴、
 * Orca Lead / Worker、插件。只认主机盖章的 origin / sourcePlugin;本人输入返回 null。
 * 名字来自用户或插件,按不可信展示文本净化(去换行、限长)。
 */
export function pendingSendSource(
  item: Partial<Pick<QueuedRemoteMessage, 'origin' | 'persistedContent'>> & { sourcePlugin?: unknown },
): MobilePendingSendSource | null {
  const origin = readRecord(item.origin);
  // Hook 渠道消息复用 scheduler 形态,不是自动化;与历史消息一致,不出自动化标签。
  if (isHookSchedulerOrigin(origin)) return null;
  if (origin?.kind === 'scheduler') {
    // 共享任务访客拿到的来源可能已脱敏(无 scheduleId):不显示名字。
    const scheduleId = readNonEmptyString(origin.scheduleId);
    const scheduleName = scheduleId ? sanitizeSourceName(origin.scheduleName) : undefined;
    return {
      kind: 'automation',
      label: automationOriginLabel({ scheduleName }),
      ...idTextField(item),
    };
  }
  // 插件优先(与 messageSourceSenderFromMeta 同序):插件在某任务里派发时同时带来源任务 origin。
  const plugin = origin?.kind === 'orca' ? undefined : readMessageSourcePlugin(item);
  if (plugin) {
    return {
      kind: 'plugin',
      label: sourcePluginLabel(plugin),
      ...idTextField(item),
    };
  }
  if (origin?.kind === 'session') {
    const senderBotName = readNonEmptyString(origin.senderBotId)
      ? sanitizeSourceName(origin.senderBotName) ?? sanitizeSourceName(origin.senderBotId)
      : undefined;
    const senderSessionTitle = sanitizeSourceName(origin.senderSessionTitle);
    return {
      kind: senderBotName ? 'teammate' : 'session',
      label: sessionOriginLabel({ senderBotName, senderSessionTitle }),
      ...idTextField(item),
    };
  }
  if (origin?.kind === 'orca') {
    const senderLabel = readNonEmptyString(origin.senderLabel);
    const direction = readOrcaPersistedSource(item.persistedContent)
      ?? (senderLabel?.toLowerCase() === 'lead' ? 'lead' : 'worker');
    return { kind: 'orca', label: orcaMessageTitle(direction, senderLabel) };
  }
  return null;
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
  getImagePreview?: GetSentMessageImagePreview,
): { thumbs: MobileOutboxThumb[]; fileCount: number } {
  const thumbs: MobileOutboxThumb[] = [];
  let fileCount = 0;
  (item.files ?? []).forEach((file, index) => {
    if (file.category !== 'image') {
      fileCount += 1;
      return;
    }
    const ossRef = file.url ?? file.path;
    const preview = getImagePreview?.(item.clientId, thumbs.length, file.name, file.id);
    thumbs.push({
      key: `${item.clientId}-slot-${index}`,
      // 发送时刻抓下的本地预览优先:sentAttachmentThumbStore 那条兜底链要等「上传落定 →
      // 拷进自有目录 → AsyncStorage hydrate」全部完成才查得到,期间 getSentAttachmentThumbUri
      // 一律返回 null,排队气泡只能画空占位格(实测:兜底文件已生成,气泡仍是空方块)。
      // 乐观语义下图必须从第一帧就在,所以直接用手边的 file:// 预览,store 只作为
      // 「重开会话 / 预览已失效」时的后备。
      uri: preview?.uri ?? ((ossRef && previewByOssRef?.get(ossRef)) || null),
      ...(preview ? { previewRef: preview.sourceRef } : {}),
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
  getImagePreview?: GetSentMessageImagePreview;
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
    const attachments = queuedAttachmentThumbs(item, input.previewByOssRef, input.getImagePreview);
    const presentation = queueIndex === null
      ? null
      : input.presentationByClientId.get(item.clientId) ?? null;
    const agentText = pendingSendAgentText(item);
    // 合成指令只显示标签:结构化 atom 也不能从原文里重建出来。
    const synthetic = pendingSendSyntheticKind(item, agentText) !== null;
    items.push({
      type: 'pending_send',
      key: pendingSendItemKey(item.clientId),
      clientId: item.clientId,
      text: pendingSendBubbleText(item),
      sentInlineTokens: synthetic ? [] : buildPendingSentInlineTokens({
        text: agentText,
        quotesEncoded: item.chatMessage.quotesEncoded,
        pastedTextRanges: item.chatMessage.pastedTextRanges,
        slashCommandRanges: item.chatMessage.slashCommandRanges,
      }),
      phase,
      queueIndex,
      thumbs: attachments.thumbs,
      fileCount: attachments.fileCount,
      fileNames: (item.files ?? []).filter((file) => file.category !== 'image').map((file) => file.name),
      attachmentCount: attachments.thumbs.length + attachments.fileCount,
      uploadedCount: attachments.thumbs.length + attachments.fileCount,
      errorText: null,
      actions: presentation?.actions ?? null,
      hint: presentation?.hint ?? null,
      source: pendingSendSource(item),
      ...(readMessageSourceDevice(item) ? { sourceDevice: readMessageSourceDevice(item) } : {}),
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
      : input.steeringClientIds.has(item.clientId)
        || input.sendingClientIds.has(item.clientId)
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
      fileNames: item.fileNames,
      attachmentCount: item.attachmentCount,
      uploadedCount: item.uploadedCount,
      errorText: item.errorText,
      canCancel: item.canCancel,
      actions: null,
      hint: null,
      source: null,
    });
  }
  return items;
}

/** 气泡徽标该不该转圈(未确认发出 / 已出队待回流 / 上传中)。 */
export function pendingSendSpins(phase: MobilePendingSendPhase): boolean {
  return phase === 'sending' || phase === 'settling' || phase === 'uploading';
}
