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
import { downloadAttachments, type DownloadResult } from './attachmentDownloader.js';
import type { AttachmentRef } from './incomingContent.js';

export class FeishuIM extends BaseIM implements ChannelIM {
  /** 重连空窗暂存的开场白卡消费在连接就绪后排空(见 deferOpenerConsume)。 */
  private readonly offImStatus: () => void;

  constructor(host: IMHost) {
    super('feishu', host);
    setHost(host, this.log);
    const onImStatus = (status: IMStatus) => {
      if (status.kind !== 'connected') return;
      void this.flushDeferredOpenerConsumes();
    };
    feishuEvents.on('imStatus', onImStatus);
    this.offImStatus = () => feishuEvents.off('imStatus', onImStatus);
  }

  /** 排空重连空窗暂存的开场白卡消费(claim + patch/替换), 失败只 log。 */
  private async flushDeferredOpenerConsumes(): Promise<void> {
    // 排空开始时的 client — 撤回与失败兜底都 pin 到它: 排空期间换账号
    // 不得经新 client 删除旧账号的开场白。
    const pinnedClient = outbound.getBoundClient();
    if (!pinnedClient) return;
    const pending = outbound.drainDeferredOpenerConsumes();
    const epoch = outbound.getAccountEpoch();
    // 容量淘汰的开场白卡: 撤回它们(条目没了, 但卡还在话题里 — 不撤回就是
    // 永久「思考中」)。撤回经 pinnedClient, 失败只 log。
    for (const evictedId of outbound.drainEvictedOpeners()) {
      try {
        await outbound.recallOwnMessageWith(pinnedClient, evictedId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.warn(`flushDeferredOpenerConsumes evicted-opener recall failed: ${msg}`);
      }
    }
    for (const entry of pending) {
      // 每个条目处理前重新校验账号代次: 前一个条目的 patch await 期间换代
      // 时, 剩余条目不得经新 client 修改旧账号的开场白 — 直接丢弃整批。
      if (outbound.getAccountEpoch() !== epoch) {
        this.log.info('flushDeferredOpenerConsumes: account changed — dropping remaining entries');
        break;
      }
      // 条目在暂存时就原子预留了 opener(携带 id)— 排空直接使用, 不会被
      // 后续轮次认领。
      const openerId = entry.openerId;
      try {
        if ('markdown' in entry) {
          await streamingText.patchMarkdown(openerId, entry.markdown);
        } else {
          await outbound.updateInteractive(openerId, entry.spec);
          outbound.registerCardLane(entry.userId, openerId);
        }
      } catch (err) {
        // patch/替换失败: 与即时消费同口径 — 撤回开场白卡(pin 到排空开始
        // 时的 client)并回拨锚点, 然后**补发终态兜底**。
        const msg = err instanceof Error ? err.message : String(err);
        this.log.warn(`flushDeferredOpenerConsumes failed: ${msg}`);
        // 排空期间账号已换代/清凭证: 丢弃条目, 不撤回、不发送(旧账号终态
        // 不得经新账号 client 呈现 — 跨账号红线)。
        if (outbound.getAccountEpoch() !== epoch) {
          this.log.info('flushDeferredOpenerConsumes: account changed — dropping entry');
          continue;
        }
        // 撤回始终 pin 到排空开始时的 client — 同账号再次重连(而非换账号)
        // 时旧 REST client 仍可尝试撤回, 不会留下永久「思考中」卡; 换账号
        // 时 pinnedClient 属于旧账号, 用它撤回旧卡正是安全方向。
        await outbound.recallOwnMessageWith(pinnedClient, openerId);
        // 撤回 await 期间也可能换代/清凭证 — 发送前**再次**校验账号代次,
        // 旧账号终态不得经新 client 呈现(跨账号红线)。
        if (outbound.getAccountEpoch() !== epoch) {
          this.log.info('flushDeferredOpenerConsumes: account changed during recall — dropping entry');
          continue;
        }
        outbound.rearmAnchorToTrigger(entry.userId);
        try {
          if ('markdown' in entry) {
            await this.sendMarkdownText(entry.userId, entry.markdown);
          } else {
            await this.sendInteractiveCard(entry.userId, entry.spec);
          }
        } catch (sendErr) {
          // 兜底发送也失败(排空期间再次重连): 条目已 drain, 重新入队 —
          // 下一次 connected 排空重试, 终态不会因一次失败永久丢失。但清
          // 凭证(账号代次变化)后不得重新入队 — 否则登出前的终态会被重新
          // 呈现给新一轮会话。
          const sendMsg = sendErr instanceof Error ? sendErr.message : String(sendErr);
          if (outbound.getAccountEpoch() === epoch) {
            this.log.warn(`flushDeferredOpenerConsumes fallback send failed (re-deferred): ${sendMsg}`);
            outbound.deferOpenerConsume(entry);
          } else {
            this.log.info('flushDeferredOpenerConsumes: credentials cleared — dropping entry');
          }
        }
      }
    }
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
    this.offImStatus();
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

  async sendText(userId: string, text: string): Promise<{ messageId: string }> {
    return this.sendWithDeferredOpenerConsume(userId, 'markdown', () =>
      outbound.sendText(userId, text),
    );
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
  async sendMarkdownText(userId: string, markdown: string): Promise<{ messageId: string }> {
    return this.sendWithDeferredOpenerConsume(userId, 'markdown', () =>
      outbound.sendInteractive(userId, { body: markdown, buttons: [] }),
    );
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

  /**
   * 消费群主流 @ 开话题的 pending 开场白卡: 认领并把 markdown patch 上去 —
   * 非流式终态(!stop / 纯 unsupported)截流时, 「思考中」卡就地变成回复,
   * 不会卡住也不会被同话题下一条消息 patch 错卡。无 pending opener 返回
   * false(调用方走正常发送)。
   */
  async consumePendingOpenerCard(userId: string, markdown: string): Promise<boolean> {
    // 重连空窗(stop→start 之间 client 已解绑): 暂存消费, 连接就绪后由
    // flushDeferredOpenerConsumes 排空(claim + patch)— 不认领(注册保留)、
    // 也不让本轮终态丢失或残留被下一条消息误认领。返回 **false**(仅入队,
    // 未送达): 调用方走兜底发送(空窗内必然失败、被既有 catch 收口), 且
    // /ctr 等「仅送达后进入控制态」的调用方不会被误导。
    // 重连空窗(stop→start 之间 client 已解绑): **原子预留** opener(claim
    // 并随条目携带 id)— 后续消息的 streamingText.start 不会误认领这张卡,
    // 排空时也不会因已被领取而静默丢弃; 排空失败可重新入队重试。
    const reservedOpenerId = outbound.claimPatchableOpener(userId);
    if (!outbound.getBoundClient()) {
      if (reservedOpenerId) {
        outbound.deferOpenerConsume({ userId, openerId: reservedOpenerId, markdown });
      }
      return false;
    }
    const openerId = reservedOpenerId;
    if (!openerId) return false;
    // 触发时的 client — patch 失败后撤回必须 pin 到它: 中途换凭证时不得
    // 拿新账号的 client 删除旧账号的开场白(客户端 close 后撤回自然失败,
    // 由 log 兜底, 不会跨账号操作)。
    const triggeringClient = outbound.getBoundClient();
    try {
      await streamingText.patchMarkdown(openerId, markdown);
      return true;
    } catch (err) {
      // patch 失败: 认领已完成, 卡不会再被后续流式 patch — 撤回它让兜底
      // 发送成为唯一回复; 同时把 held 锚点回拨到触发消息(带 reply_in_thread),
      // 否则兜底发送会向已删除的开场白卡 reply 失败。撤回也失败则卡残留
      // (与孤儿撤回同一最终边界, 已 log)。
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn(`consumePendingOpenerCard patch failed — recalling opener: ${msg}`);
      if (triggeringClient) {
        await outbound.recallOwnMessageWith(triggeringClient, openerId);
      }
      outbound.rearmAnchorToTrigger(userId);
      return false;
    }
  }

  /**
   * 消费群主流 @ 开话题的 pending 开场白卡并把卡片 spec 原地替换上去 —
   * slash 的首个卡片反馈(/ctr picker、/model 选择卡等)就地变成开场白卡,
   * 话题里只有一张卡且锚点有效(不是撤回后拿已删消息当锚点)。无 pending
   * opener 返回 false(调用方走正常发卡)。
   */
  async consumePendingOpenerAsCard(userId: string, spec: InteractiveCardSpec): Promise<boolean> {
    // 同 consumePendingOpenerCard: 重连空窗暂存(未送达, 返回 false),
    // 连接就绪后排空。false 让 safeSendCard 报告未送达 — /ctr 不会在
    // 卡片尚未可见时 enterControl(否则重连失败/排空失败会把用户锁死)。
    const reservedOpenerId = outbound.claimPatchableOpener(userId);
    if (!outbound.getBoundClient()) {
      if (reservedOpenerId) {
        outbound.deferOpenerConsume({ userId, openerId: reservedOpenerId, spec });
      }
      return false;
    }
    const openerId = reservedOpenerId;
    if (!openerId) return false;
    // 同 consumePendingOpenerCard: 撤回 pin 到触发时的 client。
    const triggeringClient = outbound.getBoundClient();
    try {
      await outbound.updateInteractive(openerId, spec);
      // 替换后的交互卡同样要登记发卡 lane — 否则按钮回调 resolveCardLane
      // 查不到, 被 cardActionHandler 的群卡 fail-closed 门当旧卡拒绝。
      outbound.registerCardLane(userId, openerId);
      return true;
    } catch (err) {
      // 同 consumePendingOpenerCard: 替换失败撤回开场白卡并回拨锚点到触发
      // 消息, 回落正常发卡。
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn(`consumePendingOpenerAsCard replace failed — recalling opener: ${msg}`);
      if (triggeringClient) {
        await outbound.recallOwnMessageWith(triggeringClient, openerId);
      }
      outbound.rearmAnchorToTrigger(userId);
      return false;
    }
  }

  async sendInteractiveCard(
    userId: string,
    spec: InteractiveCardSpec,
    opts?: { threadTs?: string; deliverToOwnerDm?: boolean; ownerDmNote?: string },
  ): Promise<{ messageId: string }> {
    return this.sendWithDeferredOpenerConsume(userId, 'spec', () =>
      outbound.sendInteractive(userId, spec, opts),
    );
  }

  /**
   * 兜底发送包装: 空窗暂存后连接已恢复时, 优先**就地收口**被预留的 opener
   * (patch/替换暂存内容)而不是另发 — 不留「思考中」卡、不重复呈现同一终态。
   * 收口失败则撤回预留卡 + 回拨锚点, 回落正常发送。
   */
  private async sendWithDeferredOpenerConsume(
    userId: string,
    kind: 'markdown' | 'spec',
    send: () => Promise<{ messageId: string }>,
  ): Promise<{ messageId: string }> {
    const epoch = outbound.getAccountEpoch();
    const clientAtTake = outbound.getBoundClient();
    const entry = outbound.takeMatchingDeferredOpenerConsume(userId, kind);
    if (entry) {
      if (entry.epoch !== epoch) {
        // 条目属于旧账号: 丢弃(不得跨账号 patch/撤回/发送), 调用方内容
        // 是当前账号的, 照常发送。
        this.log.info('sendWithDeferredOpenerConsume: stale-account entry dropped');
        return send();
      }
      try {
        if ('markdown' in entry) {
          await streamingText.patchMarkdown(entry.openerId, entry.markdown);
        } else {
          await outbound.updateInteractive(entry.openerId, entry.spec);
          outbound.registerCardLane(userId, entry.openerId);
        }
        return { messageId: entry.openerId };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // 就地收口失败。换代/清凭证: 丢弃(跨账号红线); 空窗(仍无 client):
        // 重新入队等下一次 connected 排空; 否则撤回预留卡 + 回拨 + 回落。
        if (outbound.getAccountEpoch() !== epoch) {
          this.log.info('sendWithDeferredOpenerConsume: account changed mid-patch — dropping entry');
          throw err;
        }
        if (!outbound.getBoundClient()) {
          this.log.warn(`sendWithDeferredOpenerConsume patch failed in reconnect window (re-deferred): ${msg}`);
          outbound.deferOpenerConsume(entry);
          throw err;
        }
        this.log.warn(`sendWithDeferredOpenerConsume patch failed (recalling reserved opener): ${msg}`);
        await outbound.recallOwnMessageWith(clientAtTake ?? outbound.getBoundClient()!, entry.openerId);
        // 撤回 await 期间也可能再次断线 — 发送前复查代次(跨账号红线)。
        if (outbound.getAccountEpoch() !== epoch) {
          this.log.info('sendWithDeferredOpenerConsume: account changed during recall — dropping entry');
          throw err;
        }
        outbound.rearmAnchorToTrigger(userId);
        // fallthrough: 回落正常发送
      }
    }
    const sendClient = outbound.getBoundClient();
    try {
      return await send();
    } catch (sendErr) {
      // 最终兜底失败: 条目已从队列移除 — 代次未变且发起发送的 client 已不
      // 是当前 client(仍处空窗 / 同账号已重绑新 client)时重新入队, 下一次
      // connected 排空重试, 终态不因一次失败永久丢失。
      if (
        entry &&
        outbound.getAccountEpoch() === epoch &&
        outbound.getBoundClient() !== sendClient
      ) {
        this.log.warn('sendWithDeferredOpenerConsume final send failed across reconnect (re-deferred)');
        outbound.deferOpenerConsume(entry);
      }
      throw sendErr;
    }
  }

  updateInteractiveCard(messageId: string, spec: InteractiveCardSpec): Promise<void> {
    return outbound.updateInteractive(messageId, spec);
  }

  sendFile(userId: string, absPath: string, displayName?: string): Promise<SendFileResult> {
    return outbound.sendFile(userId, absPath, displayName);
  }

  /**
   * 按页拉群/话题历史(群 lane 触发时 adapter 拼上下文用)。话题 lane 传
   * threadId 走 thread 容器。**权限不足/调用失败直接抛错** — 调用方据此
   * 区分「无历史」与「拉取失败」并给 owner 可见提示;turn 降级照跑由调用方兜。
   */
  fetchChatHistoryPage(args: {
    chatId: string;
    threadId?: string;
    pageToken?: string;
    pageSize?: number;
  }): Promise<outbound.ChatHistoryPage> {
    return outbound.fetchChatHistoryPage(args);
  }

  /**
   * 拉群名称(群 lane 会话标题用)。需要「获取群基本信息」权限;失败/无权限
   * 返回 null(调用方回落 chatId 后 6 位)。
   */
  getChatName(chatId: string): Promise<string | null> {
    return outbound.getChatName(chatId);
  }

  /**
   * 下载任意历史消息的附件(群历史图片/文件进上下文用)。复用私聊入站的
   * messageResource 下载与 mediaStore 缓存;client 未就绪时全部进 unsupported。
   */
  async downloadMessageAttachments(
    messageId: string,
    refs: AttachmentRef[],
  ): Promise<DownloadResult> {
    const c = outbound.getBoundClient();
    if (!c) {
      return {
        attachments: [],
        unsupported: refs.map((ref) => ({
          type: 'no_client',
          label: `${ref.kind === 'file' ? ref.fileName : '图片'} 下载失败：客户端未就绪`,
        })),
      };
    }
    return downloadAttachments(c, messageId, refs);
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
