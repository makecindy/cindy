/**
 * sessionOutbox.ts — 会话页本地待发队列(outbox)的纯状态模型。
 * ---------------------------------------------------------------------------
 * 带附件消息的乐观发送:点发送时附件可能仍在上传,消息不再卡在 composer 等
 * waitForPendingUploads,而是立刻以「outbox 条目」形态进消息流(InlineQueueSection
 * 尾部,气泡带上传进度),后台等附件落定后按 FIFO 逐条真正 enqueue 给被控端。
 *
 * 不变量:
 * - FIFO:只有队首条目可以 dispatch(附件齐 + 无失败),后发消息(含纯文本)在
 *   outbox 非空时必须排在其后,保证到达被控端的顺序与用户发送顺序一致;
 * - 失败阻塞:任一条目失败(附件上传失败 / enqueue 失败)时它留在队首挡住后续,
 *   用户重试或删除后队列继续——静默跳过会打乱顺序预期;
 * - 附件槽位:发送时刻已就绪的附件占前段槽位,在途上传按托盘顺序占后段,
 *   onUploaded 按 localId 填槽,全部就位后按槽序组装,附件顺序与用户所见一致。
 *
 * 本模块只做纯数据变换(node 可单测);上传路由、enqueue RPC、React state 接线
 * 在 [sessionId].tsx。
 */
import { i18n } from '@/i18n';
import type { MobileSessionReference } from '@/session/sessionReferences';
import type { RemoteSerializedAttachment } from '@/session/types';
import type { AgentInputReference } from '@cindy/maker-shared/agent-input-projection';
import {
  composerDocumentFromSerializedMessage,
  normalizeComposerDocument,
  type ComposerDocument,
  type ComposerNode,
} from '@/session/composerDocument';
import {
  joinChatQuoteTextSegments,
  parseChatQuoteSegments,
  stripChatQuoteMarkerLines,
  type ChatQuote,
} from '@cindy/maker-shared/chat-quotes';

/** 预生成消息 clientId(与 inputProjection.buildQueuedTextMessage 的缺省实现同构)。 */
export function createOutboxClientId(): string {
  const cryptoWithUuid = globalThis.crypto as Crypto | undefined;
  if (typeof cryptoWithUuid?.randomUUID === 'function') return cryptoWithUuid.randomUUID();
  return `mobile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export type MobileOutboxPhase =
  /** 等附件落定(waitingIds 非空),或已就绪等待轮到队首。 */
  | 'uploading'
  /** 已开始 enqueue RPC(防重复派发;RPC 落定后条目被移除或转 failed)。 */
  | 'dispatching'
  /** 附件上传失败或 enqueue 失败:气泡保留,用户可重试 / 删除;阻塞后续条目。 */
  | 'failed';

export interface MobileOutboxItem {
  /** 预生成的消息 clientId,贯穿 outbox → queued → enqueue(被控端幂等去重)。 */
  clientId: string;
  /**
   * 条目所属会话:会话页实例在原地切 session 时复用,outbox ref 是组件级共享——
   * 派发失败回插、上传结果路由、cleanup 草稿写回都必须按此归属校验,
   * 否则弱网 dispatch 在途窗口跨会话切换会把 A 会话的消息串进 B(review P1)。
   */
  sessionId: string;
  /** 最终发送文本(引用块已前置)。 */
  text: string;
  /** 发送文本包含产品引用块；dispatch 时必须同步写进 persistedContent。 */
  quotesEncoded: boolean;
  /** 点击发送时解析出的来源设备提示；附件上传期间不得重新依赖易失的远程镜像。 */
  sessionRefs?: MobileSessionReference[];
  agentReferences: AgentInputReference[];
  pastedTextRanges: Array<{ start: number; end: number; display: string }>;
  slashCommandRanges: Array<{ start: number; end: number }>;
  /**
   * 发送时刻的权限档快照:plan 一次性语义在点发送时就恢复会话档,dispatch 重读
   * store 拿到的已是恢复后的值,消息本身必须仍按发送时刻的档位派发。
   */
  permissionModeAtSend: string;
  /** 附件槽位(按用户可见顺序);null = 对应上传任务尚未落定。 */
  attachmentSlots: ReadonlyArray<RemoteSerializedAttachment | null>;
  /**
   * 槽位静态元信息(构建时定死,不随上传落定变化):kind 决定渲染形态
   * (图片 = 缩略图方块,文件 = 计数行),previewUri 为本地预览(file://,
   * 上传中即可显示——乐观语义下图从第一帧就该以图的形态出现,不做「附件→图片」跳变)。
   */
  slotMeta: ReadonlyArray<{ kind: 'image' | 'file'; previewUri: string | null }>;
  /** 上传任务 localId → 槽位下标。 */
  slotByLocalId: Readonly<Record<string, number>>;
  /** 尚未落定的上传任务。 */
  waitingIds: readonly string[];
  /** 已失败的上传任务(可经 controller.retry 重跑)。 */
  failedIds: readonly string[];
  /** enqueue RPC 失败的错误文案(附件失败时为 null,错误看 failedIds)。 */
  enqueueError: string | null;
  phase: MobileOutboxPhase;
}

/** outbox 气泡里单个图片缩略格的渲染数据。 */
export interface MobileOutboxThumb {
  key: string;
  /** 本地预览 uri(file://);null = 无本地预览,渲染层可按 ossRef 查兜底映射。 */
  uri: string | null;
  /** 已落定槽位的 OSS 引用(sentAttachmentThumbStore 兜底查询键);未落定为 null。 */
  ossRef: string | null;
  /** 对应上传任务尚未落定(渲染转圈遮罩)。 */
  uploading: boolean;
}

/** InlineQueueSection 渲染 outbox 行所需的最小视图数据。 */
export interface MobileOutboxDisplayItem {
  clientId: string;
  text: string;
  quotesEncoded: boolean;
  attachmentCount: number;
  uploadedCount: number;
  /** 图片槽缩略格(按槽序);非图片附件走 fileCount 计数行。 */
  thumbnails: MobileOutboxThumb[];
  /** 非图片附件数(pdf / office 等,渲染「N 个文件」计数行)。 */
  fileCount: number;
  failed: boolean;
  /** 失败原因(附件失败给统一文案,enqueue 失败给 RPC 错误)。 */
  errorText: string | null;
}

/**
 * Outbox 条目无法回插消息流时，恢复 composer 所需的可见正文与引用真相。
 * `encodedBody` 保留 marker/交错顺序，仅在 quote store 校验仍通过时复用；
 * `visibleText` 永不暴露私有 marker，供普通草稿输入框直接显示。
 */
export interface MobileOutboxDraftRecovery {
  visibleText: string;
  encodedBody: string;
  quotes: ChatQuote[];
  document: ComposerDocument;
}

export interface MobileOutboxExistingDraft {
  visibleText: string;
  encodedBody: string;
  quotes: readonly ChatQuote[];
  document?: ComposerDocument;
}

export function buildOutboxItem(input: {
  clientId: string;
  sessionId: string;
  text: string;
  quotesEncoded?: boolean;
  sessionRefs?: readonly MobileSessionReference[];
  agentReferences?: AgentInputReference[];
  pastedTextRanges?: Array<{ start: number; end: number; display: string }>;
  slashCommandRanges?: Array<{ start: number; end: number }>;
  permissionModeAtSend: string;
  /** 发送时刻已就绪的附件(占前段槽位)。 */
  readyAttachments: readonly RemoteSerializedAttachment[];
  /** 就绪附件的本地预览 uri(与 readyAttachments 对齐;缺失传 null)。 */
  readyPreviews?: ReadonlyArray<string | null>;
  /** 发送时刻在途 / 失败的上传任务(按托盘顺序占后段槽位)。 */
  claimedUploads: ReadonlyArray<{
    localId: string;
    failed: boolean;
    kind?: 'image' | 'file';
    previewUri?: string;
  }>;
}): MobileOutboxItem {
  const slots: Array<RemoteSerializedAttachment | null> = [...input.readyAttachments];
  const slotMeta: Array<{ kind: 'image' | 'file'; previewUri: string | null }> =
    input.readyAttachments.map((attachment, index) => ({
      kind: attachment.category === 'image' ? 'image' : 'file',
      previewUri: input.readyPreviews?.[index] ?? null,
    }));
  const slotByLocalId: Record<string, number> = {};
  const waitingIds: string[] = [];
  const failedIds: string[] = [];
  for (const upload of input.claimedUploads) {
    slotByLocalId[upload.localId] = slots.length;
    slots.push(null);
    slotMeta.push({ kind: upload.kind ?? 'image', previewUri: upload.previewUri ?? null });
    if (upload.failed) failedIds.push(upload.localId);
    else waitingIds.push(upload.localId);
  }
  return {
    clientId: input.clientId,
    sessionId: input.sessionId,
    text: input.text,
    quotesEncoded: input.quotesEncoded === true,
    ...(input.sessionRefs && input.sessionRefs.length > 0
      ? { sessionRefs: [...input.sessionRefs] }
      : {}),
    agentReferences: input.agentReferences ?? [],
    pastedTextRanges: input.pastedTextRanges ?? [],
    slashCommandRanges: input.slashCommandRanges ?? [],
    permissionModeAtSend: input.permissionModeAtSend,
    attachmentSlots: slots,
    slotMeta,
    slotByLocalId,
    waitingIds,
    failedIds,
    enqueueError: null,
    phase: failedIds.length > 0 ? 'failed' : 'uploading',
  };
}

/** 将一组同会话 outbox 条目按 FIFO 顺序合并回一个可持久化 composer 草稿。 */
export function recoverOutboxItemsToComposerDraft(
  items: readonly MobileOutboxItem[],
  existingDraft?: MobileOutboxExistingDraft | null,
): MobileOutboxDraftRecovery {
  const visibleParts: string[] = [];
  const encodedParts: string[] = [];
  const quotes: ChatQuote[] = [];
  const documents: ComposerDocument[] = [];

  for (const item of items) {
    const encodedText = item.text.trim();
    if (!encodedText) continue;
    encodedParts.push(encodedText);
    documents.push(composerDocumentFromSerializedMessage(encodedText, {
      quotesEncoded: item.quotesEncoded,
      pastedTextRanges: item.pastedTextRanges,
      slashCommandRanges: item.slashCommandRanges,
      agentReferences: item.agentReferences,
    }));
    if (!item.quotesEncoded) {
      visibleParts.push(encodedText);
      continue;
    }

    const segments = parseChatQuoteSegments(encodedText);
    const itemQuotes = segments.flatMap((segment) => (
      segment.kind === 'quote' ? [segment.quote] : []
    ));
    quotes.push(...itemQuotes);
    const visibleText = (
      itemQuotes.length > 0
        ? joinChatQuoteTextSegments(segments)
        : stripChatQuoteMarkerLines(encodedText)
    ).trim();
    if (visibleText) visibleParts.push(visibleText);
  }

  const normalizedExistingVisibleText = existingDraft?.visibleText.trim() ?? '';
  const normalizedExistingEncodedBody = existingDraft?.encodedBody.trim() ?? '';
  if (normalizedExistingVisibleText) {
    visibleParts.push(normalizedExistingVisibleText);
  }
  if (normalizedExistingEncodedBody) {
    encodedParts.push(normalizedExistingEncodedBody);
  }
  quotes.push(...(existingDraft?.quotes ?? []));
  if (existingDraft?.document) {
    documents.push(existingDraft.document);
  } else if (normalizedExistingEncodedBody) {
    documents.push(composerDocumentFromSerializedMessage(normalizedExistingEncodedBody, {
      quotesEncoded: (existingDraft?.quotes.length ?? 0) > 0,
    }));
  }

  const nodes: ComposerNode[] = [];
  documents.forEach((document, index) => {
    const previous = nodes.at(-1);
    const first = document.nodes[0];
    if (index > 0 && previous?.type !== 'quote' && first?.type !== 'quote') {
      nodes.push({ type: 'text', text: '\n\n' });
    }
    nodes.push(...document.nodes);
  });

  return {
    visibleText: visibleParts.join('\n\n'),
    encodedBody: encodedParts.join('\n\n'),
    quotes,
    document: normalizeComposerDocument({ version: 1, nodes }),
  };
}

/** 上传成功:按 localId 填槽;不属于本条目的 localId 返回原引用(调用方据此路由)。 */
export function outboxItemWithUpload(
  item: MobileOutboxItem,
  localId: string,
  attachment: RemoteSerializedAttachment,
): MobileOutboxItem {
  const slot = item.slotByLocalId[localId];
  if (slot === undefined) return item;
  const attachmentSlots = item.attachmentSlots.map((existing, index) => (
    index === slot ? attachment : existing
  ));
  const waitingIds = item.waitingIds.filter((id) => id !== localId);
  // 重试成功的任务同时从 failedIds 摘除;全部失败清零后 failed 态自动解除。
  const failedIds = item.failedIds.filter((id) => id !== localId);
  return {
    ...item,
    attachmentSlots,
    waitingIds,
    failedIds,
    phase: item.phase === 'failed' && failedIds.length === 0 && item.enqueueError === null
      ? 'uploading'
      : item.phase,
  };
}

/** 上传失败:waiting → failed,条目转失败态(阻塞派发,等用户重试 / 删除)。 */
export function outboxItemWithUploadFailure(item: MobileOutboxItem, localId: string): MobileOutboxItem {
  if (item.slotByLocalId[localId] === undefined) return item;
  if (item.failedIds.includes(localId)) return item;
  return {
    ...item,
    waitingIds: item.waitingIds.filter((id) => id !== localId),
    failedIds: [...item.failedIds, localId],
    phase: 'failed',
  };
}

/** 重试:失败任务回到等待集(调用方同步对每个 localId 调 controller.retry)。 */
export function outboxItemRetrying(item: MobileOutboxItem): MobileOutboxItem {
  return {
    ...item,
    waitingIds: [...item.waitingIds, ...item.failedIds],
    failedIds: [],
    enqueueError: null,
    phase: 'uploading',
  };
}

/** enqueue RPC 失败:条目回队首失败态(附件都在,重试只需重新派发)。 */
export function outboxItemWithEnqueueFailure(item: MobileOutboxItem, error: string): MobileOutboxItem {
  return { ...item, enqueueError: error, phase: 'failed' };
}

/** 条目是否已可派发(附件齐、无失败、未在派发中)。 */
export function outboxItemReady(item: MobileOutboxItem): boolean {
  return item.phase === 'uploading' && item.waitingIds.length === 0 && item.failedIds.length === 0;
}

/** 就绪条目的最终附件列表(按槽序;调用前先过 outboxItemReady)。 */
export function outboxItemAttachments(item: MobileOutboxItem): RemoteSerializedAttachment[] {
  const out: RemoteSerializedAttachment[] = [];
  for (const slot of item.attachmentSlots) {
    if (slot) out.push(slot);
  }
  return out;
}

export function outboxDisplayItem(item: MobileOutboxItem): MobileOutboxDisplayItem {
  const attachmentCount = item.attachmentSlots.length;
  const uploadedCount = item.attachmentSlots.filter((slot) => slot !== null).length;
  const thumbnails: MobileOutboxThumb[] = [];
  let fileCount = 0;
  item.attachmentSlots.forEach((slot, index) => {
    const meta = item.slotMeta[index];
    if (meta?.kind !== 'image') {
      fileCount += 1;
      return;
    }
    thumbnails.push({
      key: `${item.clientId}-slot-${index}`,
      uri: meta.previewUri,
      ossRef: slot ? (slot.url ?? slot.path) : null,
      uploading: slot === null,
    });
  });
  return {
    clientId: item.clientId,
    text: item.text,
    quotesEncoded: item.quotesEncoded,
    attachmentCount,
    uploadedCount,
    thumbnails,
    fileCount,
    failed: item.phase === 'failed',
    errorText: item.phase !== 'failed'
      ? null
      : (item.enqueueError ?? (item.failedIds.length > 0 ? i18n.t('session.row.attachmentUploadFailed') : null)),
  };
}

/** 队列变换助手:按 clientId 原位替换(找不到返回原数组引用)。 */
export function replaceOutboxItem(
  items: readonly MobileOutboxItem[],
  next: MobileOutboxItem,
): readonly MobileOutboxItem[] {
  const index = items.findIndex((item) => item.clientId === next.clientId);
  if (index < 0) return items;
  const out = [...items];
  out[index] = next;
  return out;
}

/**
 * 用上传结果更新队列:localId 命中某条目时返回新数组,否则返回原引用——
 * 调用方以「引用是否变化」判断该上传是否属于 outbox(不属于则走 composer 托盘路径)。
 */
export function outboxWithUploadResult(
  items: readonly MobileOutboxItem[],
  localId: string,
  result: { attachment: RemoteSerializedAttachment } | { failed: true },
): readonly MobileOutboxItem[] {
  for (const item of items) {
    if (item.slotByLocalId[localId] === undefined) continue;
    const next = 'failed' in result
      ? outboxItemWithUploadFailure(item, localId)
      : outboxItemWithUpload(item, localId, result.attachment);
    return next === item ? items : replaceOutboxItem(items, next);
  }
  return items;
}

/** localId 是否属于队列中任一条目(同步判断,路由用)。 */
export function outboxOwnsUpload(items: readonly MobileOutboxItem[], localId: string): boolean {
  return items.some((item) => item.slotByLocalId[localId] !== undefined);
}
