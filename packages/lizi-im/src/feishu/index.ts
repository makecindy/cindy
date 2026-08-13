/**
 * feishu/index.ts
 * ---------------------------------------------------------------------------
 * FeishuIM — concrete BaseIM implementation for the feishu channel.
 *
 * Public surface:
 *   - lifecycle: init / dispose / registerIpc (BaseIM contract)
 *   - inbound events: onMessage / onCardAction / onStatusChange
 *   - outbound: sendText / startStreamingText / sendInteractiveCard /
 *               updateInteractiveCard / sendFile
 *   - status: getStatus
 *
 * Owner whitelist is owned internally — no host API; first p2p sender is
 * TOFU-claimed (see ownerGuard.ts) and persisted via storage.ts. Reset by
 * the Settings → "clear credentials" path (feishuBot:clear IPC).
 */

import { BaseIM } from '../BaseIM.js';
import type { ChannelIM } from '../channelIM.js';
import type {
  IMHost,
  IMCardActionEvent,
  IMMessageEvent,
  IMStatus,
  InteractiveCardSpec,
  SendFileResult,
  StreamingTextHandle,
} from '../types.js';

import { setHost } from './moduleScope.js';
import * as wsClient from './wsClient.js';
import * as storage from './storage.js';
import * as ownerGuard from './ownerGuard.js';
import { feishuEvents } from './events.js';
import { cancelAppRegistration, reconnectSavedCredentials, registerFeishuIpc } from './ipc.js';
import * as outbound from './outbound.js';
import * as streamingText from './streamingText.js';

export class FeishuIM extends BaseIM implements ChannelIM {
  constructor(host: IMHost) {
    super('feishu', host);
    setHost(host, this.log);
  }

  // ── lifecycle ───────────────────────────────────────────────────────────────

  async init(): Promise<void> {
    this.log.info('init starting');
    const announceEnabled = storage.readLifecycleAnnouncement();
    wsClient.setLifecycleAnnouncement(announceEnabled);
    ownerGuard.loadFromDisk();
    const owner = ownerGuard.firstAllowed();
    this.log.info(
      `init: owner=${owner ? `...${owner.slice(-8)}` : '<none, will TOFU on first message>'}`,
    );
    const creds = storage.readCredentials();
    if (!creds) {
      this.log.info('no saved credentials, stay idle');
      return;
    }
    this.log.info(`auto-connecting with appId=${creds.appId}`);
    try {
      const verdict = await wsClient.start(creds);
      this.log.info(`init verdict: ${verdict}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error(`init threw: ${msg}`);
    }
  }

  async dispose(): Promise<void> {
    this.log.info('dispose');
    cancelAppRegistration();
    await wsClient.stop({
      offlineTimeoutMs: wsClient.QUIT_OFFLINE_ANNOUNCE_TIMEOUT_MS,
      reason: 'transport-dispose',
    });
  }

  registerIpc(): void {
    registerFeishuIpc();
  }

  /** Re-negotiate Feishu permissions while preserving credentials and TOFU owner. */
  reconnect(): Promise<{ verdict: 'connected' | 'conflict' | 'error' }> {
    return reconnectSavedCredentials();
  }

  // ── inbound subscriptions ───────────────────────────────────────────────────

  onMessage(handler: (e: IMMessageEvent) => void): () => void {
    feishuEvents.on('message', handler);
    return () => feishuEvents.off('message', handler);
  }

  onCardAction(handler: (e: IMCardActionEvent) => void): () => void {
    feishuEvents.on('cardAction', handler);
    return () => feishuEvents.off('cardAction', handler);
  }

  onStatusChange(handler: (s: IMStatus) => void): () => void {
    feishuEvents.on('imStatus', handler);
    return () => feishuEvents.off('imStatus', handler);
  }

  // ── outbound ────────────────────────────────────────────────────────────────

  sendText(userId: string, text: string): Promise<{ messageId: string }> {
    return outbound.sendText(userId, text);
  }

  /**
   * 发一条支持 markdown 渲染的消息 (粗体 / 行内 code / 链接 等)。
   *
   * 飞书原生 msg_type='text' 是纯文本, 不渲染 ** ` 等; 想要 markdown 必须走
   * msg_type='interactive' (卡片) 或 'post' (rich text post 节点)。这个方法
   * 选择前者: 一张 body-only 的最简卡片 (无 header / 无 button), 视觉上跟纯
   * text 消息接近, 但 body 里 ** ` # > 等 markdown 标记会渲染。
   *
   * 适合发"提示语"类消息 — 文案里有 *strong*, `code`, [link] 等且想让用户
   * 看到正确渲染的场合。
   */
  sendMarkdownText(userId: string, markdown: string): Promise<{ messageId: string }> {
    return outbound.sendInteractive(userId, { body: markdown, buttons: [] });
  }

  startStreamingText(userId: string, initial?: string): Promise<StreamingTextHandle> {
    return streamingText.start(userId, initial);
  }

  /**
   * 一次性把已有 card patch 成 v2 markdown 内容。/ctr 接管路径用这个把 picker
   * card 转成"已接管 + 总结"视图, 替代发新消息。
   */
  patchMarkdownCard(messageId: string, markdown: string): Promise<void> {
    return streamingText.patchMarkdown(messageId, markdown);
  }

  sendInteractiveCard(
    userId: string,
    spec: InteractiveCardSpec,
    opts?: { threadTs?: string; deliverToOwnerDm?: boolean; ownerDmNote?: string },
  ): Promise<{ messageId: string }> {
    return outbound.sendInteractive(userId, spec, opts);
  }

  updateInteractiveCard(messageId: string, spec: InteractiveCardSpec): Promise<void> {
    return outbound.updateInteractive(messageId, spec);
  }

  sendFile(userId: string, absPath: string, displayName?: string): Promise<SendFileResult> {
    return outbound.sendFile(userId, absPath, displayName);
  }

  /**
   * 拉群会话最近历史(群 lane 触发时 adapter 拼上下文前缀用)。权限不足或
   * 调用失败返回空数组 — 上下文降级, turn 照跑。
   */
  fetchRecentChatMessages(
    chatId: string,
    opts?: { limit?: number },
  ): Promise<outbound.RecentChatMessage[]> {
    return outbound.fetchRecentChatMessages(chatId, opts);
  }

  /**
   * Emoji react to an incoming message — used as a "received" ack before any
   * text/card reply lands. Returns the `reaction_id` (or null on failure) so
   * the caller can later cancel it via {@link removeMessageReaction} when the
   * agent turn finishes. `emojiType` is feishu's emoji_type enum string
   * (case-sensitive); see `REACTION_PROCESSING` in the orchestrator for a
   * reasonable default.
   */
  reactToMessage(messageId: string, emojiType: string): Promise<string | null> {
    return outbound.addReaction(messageId, emojiType);
  }

  /**
   * Remove a previously-added reaction. Pair this with the `reaction_id`
   * returned by {@link reactToMessage}. Failures are swallowed (cleanup is
   * best-effort and must not block the host's turn-completion flow).
   *
   * Feishu rule: only the original adder (this bot) can delete its reaction,
   * so the `reaction_id` is per-bot and not shareable across processes.
   */
  removeMessageReaction(messageId: string, reactionId: string): Promise<void> {
    return outbound.removeReaction(messageId, reactionId);
  }

  // ── lifecycle announcement toggle ────────────────────────────────────────

  setLifecycleAnnouncement(enabled: boolean): void {
    storage.writeLifecycleAnnouncement(enabled);
    wsClient.setLifecycleAnnouncement(enabled);
  }

  // ── status ──────────────────────────────────────────────────────────────────

  getStatus(): IMStatus {
    const s = wsClient.getCurrentStatus();
    const appId = wsClient.getCurrentBotAppId();
    if (s === 'idle') return { kind: 'idle' };
    if (s === 'testing' || s === 'reconnecting') return { kind: 'connecting' };
    if (s === 'connected') return { kind: 'connected', appId: appId ?? '' };
    if (s === 'conflict') return { kind: 'conflict', appId: appId ?? '' };
    return { kind: 'error', reason: 'unknown' };
  }

  /**
   * The TOFU-bound owner's open_id, or null when the bot hasn't been bound yet.
   * Used by host code that needs to push notifications to the operator
   * (e.g. scheduler completion notifications, alarms).
   */
  getOwnerOpenId(): string | null {
    return ownerGuard.firstAllowed();
  }

  /** Active Open Platform service; legacy credentials default to Feishu. */
  getService(): 'feishu' | 'lark' {
    return storage.readCredentials()?.service ?? 'feishu';
  }
}

export function createFeishuIM(host: IMHost): FeishuIM {
  return new FeishuIM(host);
}
