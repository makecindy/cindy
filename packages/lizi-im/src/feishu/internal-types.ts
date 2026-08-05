/**
 * feishu/internal-types.ts
 * ---------------------------------------------------------------------------
 * Types used internally inside the feishu channel that aren't part of the
 * @cindy/im public API. Keep public-facing types (IMHost, IMMessageEvent, ...)
 * in `src/types.ts`.
 */

export type FeishuConnectionStatus =
  | 'idle'
  | 'testing'
  | 'connected'
  | 'reconnecting'
  | 'conflict'
  | 'error';

export interface FeishuStatusUpdate {
  status: FeishuConnectionStatus;
  error?: string;
  botAppId: string | null;
  ownerOpenId: string | null;
}

export type ConnectVerdict =
  | { kind: 'connected' }
  | { kind: 'conflict' }
  | { kind: 'error'; message: string };

/**
 * Public state surfaced to the renderer through `feishuBot:get-state` —
 * shape preserved verbatim from the legacy `FeishuBotPublicState` so renderer
 * code does not need to change.
 *
 * `ownerOpenId` is now derived from the in-memory whitelist's first entry
 * (legacy semantics). Renderer treats it as an informational "currently
 * authorised user" hint.
 */
export interface FeishuPublicState {
  status: FeishuConnectionStatus;
  appId: string | null;
  appSecret: string | null;
  hasSecret: boolean;
  ownerOpenId: string | null;
  error?: string;
  lifecycleAnnouncement: boolean;
}

export interface BotCredentials {
  appId: string;
  appSecret: string;
}
