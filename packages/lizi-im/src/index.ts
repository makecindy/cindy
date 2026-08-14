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
export type { RecentChatMessage as FeishuRecentChatMessage } from './feishu/outbound.js';

export { DiscordIM, createDiscordIM } from './discord/index.js';
export type { DiscordIMOptions } from './discord/index.js';

export { TelegramIM, createTelegramIM } from './telegram/index.js';
// expressive 档变体池 —— 官方 bot 的 ack 表情复用同一份, 两个 bot 的表情语义
// 不该各说各话(#1855)。
export {
  EXPRESSIVE_DONE_POOL,
  EXPRESSIVE_ERROR_POOL,
  pickExpressiveReaction,
} from './telegram/reactionPool.js';
export type { TelegramIMOptions, TelegramGroupWindowEntry } from './telegram/index.js';
export { TELEGRAM_DEFAULT_BEHAVIOR } from './telegram/index.js';
export type { TelegramBehaviorConfig } from './telegram/index.js';
export { TELEGRAM_PERSONAL_CAPABILITIES } from './telegram/presentationCapabilities.js';
export type { TelegramDriverCapabilities } from './telegram/presentationCapabilities.js';
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
