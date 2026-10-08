/**
 * @cindy/im
 *
 * Pure IM transport package. Provides the BaseIM abstraction and one or more
 * channel implementations (currently feishu). Hosts inject storage / IPC /
 * paths via IMHost; no electron / drizzle / maker imports here.
 */

export const VERSION = '0.0.0';

export { BaseIM } from './BaseIM.js';
export { createIM } from './createIM.js';
export type { IM } from './createIM.js';
export type {
  ChannelIM,
  TextChannelIM,
  RichChannelIM,
  ImFinalOutput,
  ImOutputDriver,
} from './channelIM.js';

export type { Logger } from './logger.js';

export type {
  IMHost,
  IMAttachment,
  IMUnsupportedEntry,
  IMMessageEvent,
  IMCardActionEvent,
  IMStatus,
  IMErrorCode,
  IMSecretReadResult,
  InteractiveCardButton,
  InteractiveCardSpec,
  StreamingTextHandle,
  SendFileResult,
} from './types.js';

export { FeishuIM, createFeishuIM } from './feishu/index.js';
export {
  decodeLaneUserId as decodeFeishuLaneUserId,
  encodeLaneUserId as encodeFeishuLaneUserId,
} from './feishu/codec.js';
export type { FeishuLane } from './feishu/codec.js';
export type {
  RecentChatMessage as FeishuRecentChatMessage,
  ChatHistoryPage as FeishuChatHistoryPage,
} from './feishu/outbound.js';
export type { AttachmentRef as FeishuAttachmentRef } from './feishu/incomingContent.js';
export type { DownloadResult as FeishuDownloadResult } from './feishu/attachmentDownloader.js';

export { DiscordIM, createDiscordIM } from './discord/index.js';
export type { DiscordIMOptions } from './discord/index.js';

export { TelegramIM, createTelegramIM } from './telegram/index.js';
// expressive 档变体池 —— 官方 bot 的 ack 表情复用同一份, 两个 bot 的表情语义
// 不该各说各话(#1855)。
export {
  PROCESSING_REACTION_POOL,
  EXPRESSIVE_DONE_POOL,
  EXPRESSIVE_ERROR_POOL,
  pickExpressiveReaction,
} from './telegram/reactionPool.js';
export type { TelegramIMOptions, TelegramGroupWindowEntry } from './telegram/index.js';
export { TELEGRAM_DEFAULT_BEHAVIOR } from './telegram/index.js';
export type { TelegramBehaviorConfig } from './telegram/index.js';
export { TELEGRAM_PERSONAL_CAPABILITIES } from './telegram/presentationCapabilities.js';
export type { TelegramDriverCapabilities } from './telegram/presentationCapabilities.js';
// 运行中过程消息: 生命周期、单帧上限、渲染与失败判据 —— 官方 bot 的 msg.op 进度
// 消息与个人 driver 同源(官方只实现 TelegramProgressDeps 的 msg.op 版)。
export { TELEGRAM_PROGRESS_FRAME_MAX_CHARS } from './telegram/progressFrame.js';
export {
  startTelegramProgressCarrier,
  startTelegramTurnCarrier,
} from './telegram/streamingText.js';
export type {
  TelegramProgressCarrier,
  TelegramProgressDeps,
  TelegramStreamingDeps,
  TelegramTurnCarrier,
} from './telegram/streamingText.js';
export { markdownToTelegramHtml, stripTelegramHtmlTags } from './telegram/markdown.js';
export { chunkTelegramSource } from './telegram/chunk.js';
export { layoutTelegramCard } from './telegram/components.js';
export type { TelegramCardLayoutInput } from './telegram/components.js';
export {
  callWithTelegramRateLimitRetry,
  isTelegramBadRequest,
  editTelegramHtmlWithFallback,
  sendTelegramHtmlWithFallback,
} from './telegram/outboundPolicy.js';
export type { TelegramErrorShape } from './telegram/outboundPolicy.js';
export { createTelegramMessageLifecycle } from './telegram/messageLifecycle.js';
export { TelegramFinalUnconfirmedError } from './telegram/streamingText.js';
export type {
  TelegramFinalIntent,
  TelegramMessageLifecycle,
  TelegramMessageLifecyclePhase,
} from './telegram/messageLifecycle.js';
export { WecomIM, createWecomIM } from './wecom/index.js';
export type { WecomIMOptions } from './wecom/index.js';
export {
  decodeWecomLane,
  encodeWecomGroupLane,
  chunkWecomMarkdown,
  escapeWecomMarkdown,
} from './wecom/codec.js';
export {
  collectXdtFileRefs,
  collectXdtImageRefs,
  normalizeXdtAbsPath,
  stripXdtFileLinks,
  stripXdtImageLinks,
  transformXdtRefs,
} from './xdtRefs.js';
export type { XdtFileRef, XdtImageRef, XdtRefTransform } from './xdtRefs.js';
export {
  decodeLaneUserId as decodeTelegramLaneUserId,
  encodeLaneUserId as encodeTelegramLaneUserId,
  decodeMessageId as decodeTelegramMessageId,
} from './telegram/codec.js';

export { DingTalkIM, createDingTalkIM } from './dingtalk/index.js';
export type {
  DingTalkIMOptions,
  DingTalkPublicState,
  DingTalkStreamClient,
} from './dingtalk/index.js';
export {
  decodeLaneUserId as decodeDingTalkLaneUserId,
  encodeLaneUserId as encodeDingTalkLaneUserId,
} from './dingtalk/codec.js';

export type {
  IdentityKey,
  BindingStore,
  BindingChangeEvent,
  BindingChangeListener,
} from './binding/index.js';
