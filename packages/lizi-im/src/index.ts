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
  InteractiveCardButton,
  InteractiveCardSpec,
  StreamingTextHandle,
  SendFileResult,
} from './types.js';

export { FeishuIM, createFeishuIM } from './feishu/index.js';

export { DiscordIM, createDiscordIM } from './discord/index.js';
export type { DiscordIMOptions } from './discord/index.js';

export type {
  IdentityKey,
  BindingStore,
  BindingChangeEvent,
  BindingChangeListener,
} from './binding/index.js';
