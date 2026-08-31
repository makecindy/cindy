import {
  buildAttachmentPersistFileRefs,
  buildAttachmentPersistImageRefs,
} from '@/session/attachments';
import { stripChatQuoteMarkerLines } from '@cindy/maker-shared/chat-quotes';
import {
  readAgentInputReferences,
  type AgentInputReference,
} from '@cindy/maker-shared/agent-input-projection';
import type { InputProjection, QueuedRemoteMessage, RemoteImageRef, RemoteSession } from '@/session/types';
import type { RemoteSerializedAttachment } from '@/session/types';
import { parseMobileToolLoopErrorDetails } from '@/session/toolLoopErrorI18n';
import { permissionModeOrAsk } from '@cindy/maker-shared/permission-mode';
import {
  composerDocumentsEqual,
  composerDocumentFromSerializedMessage,
  composerDocumentProjectedText,
  serializeComposerDocument,
  type ComposerDocument,
} from '@/session/composerDocument';
import {
  readSentPastedTextRanges,
  readSentSlashCommandRanges,
} from '@/session/sentMessageAtoms';
import {
  buildQueuePanelSummary as buildQueuePanelSummaryShared,
  buildQueueRowPresentation as buildQueueRowPresentationShared,
  type QueuePanelSummary,
  type QueueRowPresentation,
} from '@cindy/maker-shared/queue';
import { mobilePresentationLocalizer } from '@/i18n/presentationLocalizer';
export {
  isOrcaQueueItem,
  queueMoveTargetIndex,
  stopOptionsForProjection,
  type QueueRowActionId,
  type QueueRowActionPresentation,
} from '@cindy/maker-shared/queue';

export type { QueuePanelSummary, QueueRowPresentation };

export function buildQueuePanelSummary(
  projection: Parameters<typeof buildQueuePanelSummaryShared>[0],
  readOnlyReason?: Parameters<typeof buildQueuePanelSummaryShared>[1],
  collapsedVisibleRows?: Parameters<typeof buildQueuePanelSummaryShared>[2],
): QueuePanelSummary {
  return buildQueuePanelSummaryShared(
    projection,
    readOnlyReason,
    collapsedVisibleRows,
    mobilePresentationLocalizer,
  );
}

export function buildQueueRowPresentation(
  input: Parameters<typeof buildQueueRowPresentationShared>[0],
): QueueRowPresentation {
  return buildQueueRowPresentationShared(input, mobilePresentationLocalizer);
}

export const EMPTY_INPUT_PROJECTION: InputProjection = Object.freeze({
  sessionId: '',
  pendingQueue: [],
  steeringQueueClientIds: [],
  queuePaused: false,
  queueExpanded: false,
  queueInteractionLocks: [],
  queueEditLocks: [],
  queueAbortPending: false,
  error: null,
  errorReason: null,
  toolLoop: null,
  recovery: null,
  errorRetryText: null,
  credentialSwitchWait: null,
  continuationTurnClientId: null,
  continuationInFlightProjectionCapability: 'unknown',
});

export function normalizeInputProjection(value: unknown, fallbackSessionId = ''): InputProjection {
  const record = readRecord(value);
  const pendingQueue = readQueuedMessages(record?.pendingQueue);
  const continuationInFlightProjectionCapability = record === null
    ? 'unknown'
    : Object.prototype.hasOwnProperty.call(record, 'continuationTurnClientId')
      ? 'supported'
      : 'legacy';
  return {
    sessionId: readString(record?.sessionId) ?? fallbackSessionId,
    pendingQueue,
    steeringQueueClientIds: readStringArray(record?.steeringQueueClientIds),
    queuePaused: record?.queuePaused === true,
    queueExpanded: record?.queueExpanded === true,
    queueInteractionLocks: readStringArray(record?.queueInteractionLocks),
    queueEditLocks: readStringArray(record?.queueEditLocks),
    queueAbortPending: record?.queueAbortPending === true,
    error: readString(record?.error),
    errorReason: readString(record?.errorReason),
    toolLoop: parseMobileToolLoopErrorDetails(record?.toolLoop),
    recovery: record?.recovery,
    errorRetryText: readString(record?.errorRetryText),
    autoResumePending: readRecord(record?.autoResumePending),
    continuationTurnClientId: readString(record?.continuationTurnClientId),
    continuationInFlightProjectionCapability,
    credentialSwitchWait: readCredentialSwitchWait(record?.credentialSwitchWait),
  };
}

/** 宽松解析凭证切换等待态:非对象/blockedBySessionIds 缺失或为空一律视作无等待。 */
function readCredentialSwitchWait(
  value: unknown,
): InputProjection['credentialSwitchWait'] {
  const record = readRecord(value);
  if (!record) return null;
  const blockedBySessionIds = readStringArray(record.blockedBySessionIds);
  // 空列表 = 没有任何挡路任务:返回 truthy 对象会让排队区渲染出无法消除的常驻
  // 「等待其它 Codex 任务」横幅,必须归一化为 null。
  if (blockedBySessionIds.length === 0) return null;
  const clientId = readString(record.clientId) ?? undefined;
  return { ...(clientId ? { clientId } : {}), blockedBySessionIds };
}

export function buildQueuedTextMessage(
  session: RemoteSession,
  text: string,
  now = new Date(),
  clientId = createUuid(),
  options: {
    attachments?: readonly RemoteSerializedAttachment[];
    quotesEncoded?: boolean;
    agentReferences?: AgentInputReference[];
    pastedTextRanges?: Array<{ start: number; end: number; display: string }>;
    slashCommandRanges?: Array<{ start: number; end: number }>;
  } = {},
): QueuedRemoteMessage {
  const trimmed = text.trim();
  const attachments = options.attachments ?? [];
  const persistedImageRefs = buildAttachmentPersistImageRefs(attachments);
  const persistedFileRefs = buildAttachmentPersistFileRefs(attachments);
  const workingDir = session.workingDir || '';
  const effort = session.effort || '';
  const permissionMode = permissionModeOrAsk(session.permissionMode);
  const agentKind = session.agentKind === 'codex' || session.agentKind === 'pi'
    ? session.agentKind
    : 'claude-code';
  const persistedContent = stringifyUserContent(
    trimmed,
    persistedImageRefs,
    persistedFileRefs,
    options.quotesEncoded === true,
    options.pastedTextRanges,
    options.slashCommandRanges,
    options.agentReferences,
  );
  const createdAt = now.toISOString();

  return {
    clientId,
    text: trimmed,
    persistedContent,
    ...(attachments.length > 0 ? { files: [...attachments] } : {}),
    ...(options.agentReferences?.length ? { agentReferences: options.agentReferences } : {}),
    model: session.model,
    effort,
    permissionMode,
    workingDir,
    chatMessage: {
      clientId,
      role: 'user',
      content: trimmed,
      ...(persistedImageRefs.length > 0 ? { images: persistedImageRefs } : {}),
      ...(persistedFileRefs.length > 0 ? { files: persistedFileRefs } : {}),
      ...(options.quotesEncoded === true ? { quotesEncoded: true } : {}),
      ...(options.pastedTextRanges?.length ? { pastedTextRanges: options.pastedTextRanges } : {}),
      ...(options.slashCommandRanges !== undefined ? { slashCommandRanges: options.slashCommandRanges } : {}),
      isStreaming: false,
      createdAt,
    },
    createOpts: {
      agentKind,
      workingDir,
      model: session.model,
      effort,
      permissionMode,
      fastMode: session.fastMode,
      displayReasoning: 'summarized',
      // 被控端 lazy-create(桌面 app 重启后 live session 不在内存)直接用本 createOpts
      // 起会话,不从 DB 兜底 resumeSessionId——缺它会另起全新 SDK thread,上文全丢
      // (review P1)。对齐桌面 buildQueuedMessage / sendUiTrigger:带上持久化的
      // sdkSessionId;live session 在内存时该字段被忽略,新会话 sdkSessionId 为空
      // 不带,行为不变。同样补 providerId / remoteHostId(缺失时 lazy-create 会
      // 丢来源路由、把远端 SSH 会话的 workingDir 当本地路径,桌面 sendUiTrigger 同款)。
      ...(session.sdkSessionId ? { resumeSessionId: session.sdkSessionId } : {}),
      ...(session.providerId ? { providerId: session.providerId } : {}),
      ...(session.remoteHostId ? { remoteHostId: session.remoteHostId } : {}),
    },
  };
}

function stringifyUserContent(
  text: string,
  images: RemoteImageRef[] = [],
  files: Array<{ name: string; path: string }> = [],
  quotesEncoded = false,
  pastedTextRanges: Array<{ start: number; end: number; display: string }> = [],
  slashCommandRanges?: Array<{ start: number; end: number }>,
  agentReferences: AgentInputReference[] = [],
): string {
  return JSON.stringify({
    text,
    images,
    files,
    ...(quotesEncoded ? { quotesEncoded: true } : {}),
    ...(pastedTextRanges.length > 0 ? { pastedTextRanges } : {}),
    ...(slashCommandRanges !== undefined ? { slashCommandRanges } : {}),
    ...(agentReferences.length > 0 ? { agentReferences } : {}),
  });
}

/** 排队编辑时从持久化信封恢复引用标志，避免整条替换后 marker 退化为正文。 */
export function queuedMessageHasEncodedQuotes(
  message: Pick<QueuedRemoteMessage, 'persistedContent'>,
): boolean {
  try {
    return readRecord(JSON.parse(message.persistedContent))?.quotesEncoded === true;
  } catch {
    return false;
  }
}

/** 排队引用消息进入 composer 时的可见文本与无损提交基线。 */
export interface QueueEditTextState {
  visibleText: string;
  encodedText: string;
  quotesEncoded: boolean;
  document: ComposerDocument;
  pastedTextRanges: Array<{ start: number; end: number; display: string }>;
  slashCommandRanges: Array<{ start: number; end: number }> | undefined;
  agentReferences: AgentInputReference[];
}

export function createQueueEditTextState(
  message: Pick<QueuedRemoteMessage, 'text' | 'persistedContent'>,
): QueueEditTextState {
  const quotesEncoded = queuedMessageHasEncodedQuotes(message);
  const metadata = readQueuedTextMetadata(message.persistedContent, message.text);
  const document = composerDocumentFromSerializedMessage(message.text, {
    quotesEncoded,
    agentReferences: metadata.agentReferences,
    pastedTextRanges: metadata.pastedTextRanges,
    slashCommandRanges: metadata.slashCommandRanges,
  });
  return {
    visibleText: composerDocumentProjectedText(document),
    encodedText: message.text,
    quotesEncoded,
    document,
    pastedTextRanges: metadata.pastedTextRanges,
    slashCommandRanges: metadata.slashCommandRanges,
    agentReferences: metadata.agentReferences,
  };
}

/**
 * 文档未改时复用原持久化正文与 metadata；修改后从结构化文档重新序列化，
 * 保留仍存在的引用 / 粘贴文本 / Slash atom，删除的 atom 则自然退出 metadata。
 */
export function resolveQueueEditTextSubmission(
  state: QueueEditTextState,
  document: ComposerDocument,
): {
  text: string;
  quotesEncoded: boolean;
  pastedTextRanges?: Array<{ start: number; end: number; display: string }>;
  slashCommandRanges?: Array<{ start: number; end: number }>;
  agentReferences: AgentInputReference[];
} {
  const documentUnchanged = composerDocumentsEqual(document, state.document);
  if (!documentUnchanged) {
    const serialized = serializeComposerDocument(document);
    return {
      text: serialized.text,
      quotesEncoded: serialized.quotesEncoded,
      agentReferences: serialized.agentReferences,
      ...(serialized.pastedTextRanges.length > 0
        ? { pastedTextRanges: serialized.pastedTextRanges }
        : {}),
      slashCommandRanges: serialized.slashCommandRanges,
    };
  }
  return {
    text: state.encodedText,
    quotesEncoded: state.quotesEncoded,
    agentReferences: state.agentReferences,
    ...(state.pastedTextRanges.length > 0
      ? { pastedTextRanges: state.pastedTextRanges }
      : {}),
    ...(state.slashCommandRanges !== undefined
      ? { slashCommandRanges: state.slashCommandRanges }
      : {}),
  };
}

function readQueuedTextMetadata(persistedContent: string, text: string): {
  pastedTextRanges: Array<{ start: number; end: number; display: string }>;
  slashCommandRanges: Array<{ start: number; end: number }> | undefined;
  agentReferences: AgentInputReference[];
} {
  try {
    const record = readRecord(JSON.parse(persistedContent));
    const pastedTextRanges = readSentPastedTextRanges(record?.pastedTextRanges, text) ?? [];
    const slashCommandRanges = readSentSlashCommandRanges(record?.slashCommandRanges, text);
    const agentReferences = readAgentInputReferences(record?.agentReferences, text);
    return { pastedTextRanges, slashCommandRanges, agentReferences };
  } catch {
    return { pastedTextRanges: [], slashCommandRanges: undefined, agentReferences: [] };
  }
}

function readQueuedMessages(value: unknown): QueuedRemoteMessage[] {
  if (!Array.isArray(value)) return [];
  const out: QueuedRemoteMessage[] = [];
  for (const item of value) {
    if (!isQueuedRemoteMessage(item)) continue;
    // projection 只服务展示/交互，永远不携带引用历史正文。即使本地乐观队列或
    // 异常旧被控端回包夹带可信字段，也在进入 mobile store 前统一剥离。
    const projected = { ...(item as QueuedRemoteMessage) };
    delete projected.trustedSessionReferenceContexts;
    delete projected.sessionReferencesRequireTrustedSnapshot;
    out.push(projected);
  }
  return out;
}

function isQueuedRemoteMessage(value: unknown): boolean {
  const record = readRecord(value);
  const createOpts = readRecord(record?.createOpts);
  const chatMessage = readRecord(record?.chatMessage);
  return !!(
    record
    && readString(record.clientId)
    && typeof record.text === 'string'
    && typeof record.persistedContent === 'string'
    && typeof record.model === 'string'
    && typeof record.workingDir === 'string'
    && createOpts
    && chatMessage
    && chatMessage.role === 'user'
  );
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === 'string' && item.length > 0) out.push(item);
  }
  return out;
}

function createUuid(): string {
  const cryptoWithUuid = globalThis.crypto as Crypto | undefined;
  if (typeof cryptoWithUuid?.randomUUID === 'function') return cryptoWithUuid.randomUUID();
  return `mobile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
