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

/** 连接仍在时重新入队后的排空退避: 100ms / 300ms / 900ms / 2.7s, 耗尽坐等下一次 connected。 */
const CONNECTED_FLUSH_RETRY_DELAYS_MS = [100, 300, 900, 2700] as const;

export class FeishuIM extends BaseIM implements ChannelIM {
  /** 重连空窗暂存的开场白卡消费在连接就绪后排空(见 deferOpenerConsume)。 */
  private readonly offImStatus: () => void;
  /** 串行排空, 避免 connected 与失败重试重叠处理同一条目。 */
  private flushChain: Promise<void> = Promise.resolve();
  /** 正在排空的条目: 兜底发送等它结束, 不另发一份相同终态。 */
  private readonly flushingOpenerConsumes = new Map<
    string,
    Promise<{ messageId: string } | null>
  >();
  /** 排空已成功、尚未被原兜底发送认领的收据(按 openerId, 当拍过期)。 */
  private readonly completedOpenerConsumes = new Map<string, { messageId: string }>();
  private readonly completedOpenerConsumeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * 空窗暂存后, 只有「原兜底发送」可以认领排空结果。按 openerId 记账 —
   * 同 lane 的后续发送(/help 等)不得复用上一轮的 messageId。
   */
  private readonly pendingFallbackOpenerIds = new Map<
    string,
    { userId: string; kind: 'markdown' | 'spec' }
  >();
  /** consume 暂存后按轮次压栈, 原兜底发送 pop 出本轮 openerId。 */
  private readonly notedFallbackStacks = new Map<string, string[]>();
  private retryFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private retryFlushAttempt = 0;
  private disposed = false;

  constructor(host: IMHost) {
    super('feishu', host);
    setHost(host, this.log);
    const onImStatus = (status: IMStatus) => {
      if (status.kind !== 'connected') return;
      this.resetConnectedFlushRetry();
      void this.flushDeferredOpenerConsumes();
    };
    feishuEvents.on('imStatus', onImStatus);
    this.offImStatus = () => feishuEvents.off('imStatus', onImStatus);
  }

  private openerConsumeKey(userId: string, kind: 'markdown' | 'spec'): string {
    return `${kind}:${userId}`;
  }

  private notePendingFallback(
    userId: string,
    kind: 'markdown' | 'spec',
    openerId: string,
    rememberForCaller = false,
  ): void {
    this.pendingFallbackOpenerIds.set(openerId, { userId, kind });
    if (!rememberForCaller) return;
    const key = this.openerConsumeKey(userId, kind);
    const stack = this.notedFallbackStacks.get(key) ?? [];
    stack.push(openerId);
    this.notedFallbackStacks.set(key, stack);
  }

  takeNotedFallbackOpenerId(userId: string, kind: 'markdown' | 'spec'): string | undefined {
    const key = this.openerConsumeKey(userId, kind);
    const stack = this.notedFallbackStacks.get(key);
    const openerId = stack?.pop();
    if (stack && stack.length === 0) this.notedFallbackStacks.delete(key);
    return openerId;
  }

  private claimFallbackOpenerId(
    userId: string,
    kind: 'markdown' | 'spec',
    fallbackOpenerId: string | undefined,
  ): string | undefined {
    if (!fallbackOpenerId) return undefined;
    const meta = this.pendingFallbackOpenerIds.get(fallbackOpenerId);
    if (!meta || meta.userId !== userId || meta.kind !== kind) return undefined;
    this.pendingFallbackOpenerIds.delete(fallbackOpenerId);
    return fallbackOpenerId;
  }

  private rememberCompletedOpenerConsume(openerId: string, messageId: string): void {
    this.completedOpenerConsumes.set(openerId, { messageId });
    const prev = this.completedOpenerConsumeTimers.get(openerId);
    if (prev) clearTimeout(prev);
    this.completedOpenerConsumeTimers.set(
      openerId,
      setTimeout(() => {
        this.completedOpenerConsumeTimers.delete(openerId);
        this.completedOpenerConsumes.delete(openerId);
      }, 0),
    );
  }

  private takeCompletedOpenerConsume(openerId: string): { messageId: string } | undefined {
    const receipt = this.completedOpenerConsumes.get(openerId);
    if (!receipt) return undefined;
    this.completedOpenerConsumes.delete(openerId);
    const timer = this.completedOpenerConsumeTimers.get(openerId);
    if (timer) {
      clearTimeout(timer);
      this.completedOpenerConsumeTimers.delete(openerId);
    }
    return receipt;
  }

  /** 取消挂起的排空重试并把退避进度清零(connected / 成功排空 / dispose)。 */
  private resetConnectedFlushRetry(): void {
    if (this.retryFlushTimer) {
      clearTimeout(this.retryFlushTimer);
      this.retryFlushTimer = null;
    }
    this.retryFlushAttempt = 0;
  }

  /**
   * 当前连接仍在时重新入队后主动再排空, 不坐等下一次 connected。
   * 用递增延迟 + 次数上限, 避免限流/权限/服务故障持续失败时零延迟 REST 风暴。
   */
  private scheduleConnectedFlushRetry(): void {
    if (this.disposed || this.retryFlushTimer) return;
    const delay = CONNECTED_FLUSH_RETRY_DELAYS_MS[this.retryFlushAttempt];
    if (delay === undefined) {
      this.log.warn(
        'flushDeferredOpenerConsumes: retry budget exhausted — waiting for next connected',
      );
      return;
    }
    this.retryFlushTimer = setTimeout(() => {
      this.retryFlushTimer = null;
      if (this.disposed || !outbound.getBoundClient()) return;
      this.retryFlushAttempt += 1;
      void this.flushDeferredOpenerConsumes();
    }, delay);
  }

  private flushDeferredOpenerConsumes(): Promise<void> {
    // drain + 登记在途必须同步: connected 与兜底发送发生在同一轮时,
    // 发送才能看见正在排空的条目。
    const batch = this.claimFlushBatch();
    this.flushChain = this.flushChain.then(
      () => this.processFlushBatch(batch),
      () => this.processFlushBatch(batch),
    );
    return this.flushChain;
  }

  private claimFlushBatch(): {
    pinnedClient: NonNullable<ReturnType<typeof outbound.getBoundClient>>;
    epoch: number;
    evicted: string[];
    items: Array<{
      entry: ReturnType<typeof outbound.drainDeferredOpenerConsumes>[number];
      openerId: string;
      resolveFlush: (result: { messageId: string } | null) => void;
    }>;
  } | null {
    const pinnedClient = outbound.getBoundClient();
    if (!pinnedClient) return null;
    const pending = outbound.drainDeferredOpenerConsumes();
    const evicted = outbound.drainEvictedOpeners();
    if (pending.length === 0 && evicted.length === 0) return null;
    const items = pending.map((entry) => {
      let resolveFlush!: (result: { messageId: string } | null) => void;
      const flushPromise = new Promise<{ messageId: string } | null>((resolve) => {
        resolveFlush = resolve;
      });
      this.flushingOpenerConsumes.set(entry.openerId, flushPromise);
      return { entry, openerId: entry.openerId, resolveFlush };
    });
    return { pinnedClient, epoch: outbound.getAccountEpoch(), evicted, items };
  }

  /** 排空重连空窗暂存的开场白卡消费(claim + patch/替换), 失败只 log。 */
  private async processFlushBatch(
    batch: ReturnType<FeishuIM['claimFlushBatch']>,
  ): Promise<void> {
    if (!batch) return;
    const { pinnedClient, epoch, evicted, items } = batch;
    let requeued = false;
    // 容量淘汰的开场白卡: 撤回它们(条目没了, 但卡还在话题里 — 不撤回就是
    // 永久「思考中」)。撤回经 pinnedClient, 失败只 log。
    for (const evictedId of evicted) {
      try {
        await outbound.recallOwnMessageWith(pinnedClient, evictedId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.warn(`flushDeferredOpenerConsumes evicted-opener recall failed: ${msg}`);
      }
    }
    for (const { entry, openerId, resolveFlush } of items) {
      // 每个条目处理前重新校验账号代次: 前一个条目的 patch await 期间换代
      // 时, 剩余条目不得经新 client 修改旧账号的开场白 — 直接丢弃整批。
      if (outbound.getAccountEpoch() !== epoch) {
        this.log.info('flushDeferredOpenerConsumes: account changed — dropping remaining entries');
        resolveFlush(null);
        this.flushingOpenerConsumes.delete(openerId);
        this.completedOpenerConsumes.delete(openerId);
        continue;
      }
      // 条目在暂存时就原子预留了 opener(携带 id)— 排空直接使用, 不会被
      // 后续轮次认领。在途 promise 已在 claimFlushBatch 同步登记。
      try {
        if ('markdown' in entry) {
          await streamingText.patchMarkdown(openerId, entry.markdown);
        } else {
          await outbound.updateInteractive(openerId, entry.spec);
          outbound.registerCardLane(entry.userId, openerId);
        }
        this.rememberCompletedOpenerConsume(openerId, openerId);
        resolveFlush({ messageId: openerId });
      } catch (err) {
        // patch/替换失败: 与即时消费同口径 — 撤回开场白卡(pin 到排空开始
        // 时的 client)并回拨锚点, 然后**补发终态兜底**。
        const msg = err instanceof Error ? err.message : String(err);
        this.log.warn(`flushDeferredOpenerConsumes failed: ${msg}`);
        // 排空期间账号已换代/清凭证: 丢弃条目, 不撤回、不发送(旧账号终态
        // 不得经新账号 client 呈现 — 跨账号红线)。
        if (outbound.getAccountEpoch() !== epoch) {
          this.log.info('flushDeferredOpenerConsumes: account changed — dropping entry');
          resolveFlush(null);
          continue;
        }
        // 撤回始终 pin 到排空开始时的 client — 同账号再次重连(而非换账号)
        // 时旧 REST client 仍可尝试撤回, 不会留下永久「思考中」卡; 换账号
        // 时 pinnedClient 属于旧账号, 用它撤回旧卡正是安全方向。
        const recalled = await outbound.recallOwnMessageWith(pinnedClient, openerId);
        // 撤回 await 期间也可能换代/清凭证 — 发送前**再次**校验账号代次,
        // 旧账号终态不得经新 client 呈现(跨账号红线)。
        if (outbound.getAccountEpoch() !== epoch) {
          this.log.info('flushDeferredOpenerConsumes: account changed during recall — dropping entry');
          resolveFlush(null);
          continue;
        }
        if (!recalled) {
          // 撤回失败: 思考中卡还在。不得回拨+另发, 否则用户同时看到卡和新回答。
          this.log.warn('flushDeferredOpenerConsumes: recall failed — re-deferred');
          outbound.deferOpenerConsume(entry);
          this.notePendingFallback(
            entry.userId,
            'markdown' in entry ? 'markdown' : 'spec',
            entry.openerId,
          );
          requeued = true;
          resolveFlush(null);
          continue;
        }
        outbound.rearmAnchorToTrigger(entry.userId);
        try {
          // 走 outbound 直发, 避免再进 sendWithDeferred 等待自己造成死锁。
          const sent =
            'markdown' in entry
              ? await outbound.sendInteractive(entry.userId, {
                  body: entry.markdown,
                  buttons: [],
                })
              : await outbound.sendInteractive(entry.userId, entry.spec);
          this.rememberCompletedOpenerConsume(openerId, sent.messageId);
          resolveFlush(sent);
        } catch (sendErr) {
          // 兜底发送也失败: 重新入队并在当前连接上主动再排空。清凭证后
          // 不得重新入队 — 否则登出前的终态会被重新呈现给新一轮会话。
          const sendMsg = sendErr instanceof Error ? sendErr.message : String(sendErr);
          if (outbound.getAccountEpoch() === epoch) {
            this.log.warn(`flushDeferredOpenerConsumes fallback send failed (re-deferred): ${sendMsg}`);
            outbound.deferOpenerConsume(entry);
            this.notePendingFallback(
              entry.userId,
              'markdown' in entry ? 'markdown' : 'spec',
              entry.openerId,
            );
            requeued = true;
          } else {
            this.log.info('flushDeferredOpenerConsumes: credentials cleared — dropping entry');
          }
          resolveFlush(null);
        }
      } finally {
        this.flushingOpenerConsumes.delete(openerId);
      }
    }
    if (requeued) this.scheduleConnectedFlushRetry();
    else this.retryFlushAttempt = 0;
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
    this.disposed = true;
    this.resetConnectedFlushRetry();
    for (const timer of this.completedOpenerConsumeTimers.values()) clearTimeout(timer);
    this.completedOpenerConsumeTimers.clear();
    this.completedOpenerConsumes.clear();
    this.pendingFallbackOpenerIds.clear();
    this.notedFallbackStacks.clear();
    this.offImStatus();
    cancelAppRegistration();
    await this.flushChain.catch(() => undefined);
    await wsClient.stop({
      offlineTimeoutMs: wsClient.QUIT_OFFLINE_ANNOUNCE_TIMEOUT_MS,
      reason: 'transport-dispose',
      discardPendingTopicLeases: true,
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

  async sendText(
    userId: string,
    text: string,
    opts?: { threadTs?: string; fallbackOpenerId?: string },
  ): Promise<{ messageId: string }> {
    return this.sendWithDeferredOpenerConsume(
      userId,
      'markdown',
      () => outbound.sendText(userId, text),
      opts?.fallbackOpenerId,
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
  async sendMarkdownText(
    userId: string,
    markdown: string,
    opts?: { threadTs?: string; fallbackOpenerId?: string },
  ): Promise<{ messageId: string }> {
    return this.sendWithDeferredOpenerConsume(
      userId,
      'markdown',
      () => outbound.sendInteractive(userId, { body: markdown, buttons: [] }),
      opts?.fallbackOpenerId,
    );
  }

  startStreamingText(
    userId: string,
    initial?: string,
  ): Promise<StreamingTextHandle> {
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
   * 不会卡住也不会被同话题下一条消息 patch 错卡。无 pending opener、或
   * 同账号空窗暂存, 返回 false(调用方走正常发送)。patch 失败且账号已换代
   * 时返回 true: 旧轮次已丢弃, 调用方不得用新 client 跨账号发。
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
        this.notePendingFallback(userId, 'markdown', reservedOpenerId, true);
      }
      return false;
    }
    const openerId = reservedOpenerId;
    if (!openerId) return false;
    // 触发时的 client / 账号代次 — patch 失败后撤回必须 pin 到它们:
    // 中途换凭证时不得拿新账号的 client 删除旧账号的开场白, 也不得指示
    // 调用方用新 client 向旧 lane 回落发送。
    const triggeringClient = outbound.getBoundClient();
    const epoch = outbound.getAccountEpoch();
    try {
      await streamingText.patchMarkdown(openerId, markdown);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn(`consumePendingOpenerCard patch failed: ${msg}`);
      return this.recoverFailedOpenerConsume(userId, openerId, epoch, triggeringClient, {
        markdown,
      });
    }
  }

  /**
   * 消费群主流 @ 开话题的 pending 开场白卡并把卡片 spec 原地替换上去 —
   * slash 的首个卡片反馈(/ctr picker、/model 选择卡等)就地变成开场白卡,
   * 话题里只有一张卡且锚点有效(不是撤回后拿已删消息当锚点)。无 pending
   * opener、或同账号空窗暂存, 返回 false(调用方走正常发卡)。替换失败且
   * 账号已换代时返回 true: 旧轮次已丢弃, 调用方不得跨账号发卡。
   */
  async consumePendingOpenerAsCard(userId: string, spec: InteractiveCardSpec): Promise<boolean> {
    // 同 consumePendingOpenerCard: 重连空窗暂存(未送达, 返回 false),
    // 连接就绪后排空。false 让 safeSendCard 报告未送达 — /ctr 不会在
    // 卡片尚未可见时 enterControl(否则重连失败/排空失败会把用户锁死)。
    const reservedOpenerId = outbound.claimPatchableOpener(userId);
    if (!outbound.getBoundClient()) {
      if (reservedOpenerId) {
        outbound.deferOpenerConsume({ userId, openerId: reservedOpenerId, spec });
        this.notePendingFallback(userId, 'spec', reservedOpenerId, true);
      }
      return false;
    }
    const openerId = reservedOpenerId;
    if (!openerId) return false;
    // 同 consumePendingOpenerCard: 撤回 pin 到触发时的 client, 失败路径核代次。
    const triggeringClient = outbound.getBoundClient();
    const epoch = outbound.getAccountEpoch();
    try {
      await outbound.updateInteractive(openerId, spec);
      // 替换后的交互卡同样要登记发卡 lane — 否则按钮回调 resolveCardLane
      // 查不到, 被 cardActionHandler 的群卡 fail-closed 门当旧卡拒绝。
      outbound.registerCardLane(userId, openerId);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn(`consumePendingOpenerAsCard replace failed: ${msg}`);
      return this.recoverFailedOpenerConsume(userId, openerId, epoch, triggeringClient, {
        spec,
      });
    }
  }

  /**
   * patch/替换失败后的账号代次门。未换账号且撤回成功才能回拨+回落发送;
   * 撤回失败重新暂存走有界排空(思考中卡还在, 不得另发); 同账号空窗重新暂存;
   * 已换账号丢弃旧轮次并返回 true, 避免调用方用新 client 向旧 lane 发送。
   */
  private async recoverFailedOpenerConsume(
    userId: string,
    openerId: string,
    epoch: number,
    triggeringClient: ReturnType<typeof outbound.getBoundClient>,
    payload: { markdown: string } | { spec: InteractiveCardSpec },
  ): Promise<boolean> {
    if (outbound.getAccountEpoch() !== epoch) {
      this.log.info('consumePendingOpener: account changed — dropping turn');
      if (triggeringClient) {
        const recalled = await outbound.recallOwnMessageWith(triggeringClient, openerId);
        if (!recalled) {
          this.log.warn('consumePendingOpener: recall failed after account change — dropping turn');
        }
      }
      return true;
    }
    if (!outbound.getBoundClient()) {
      this.log.warn('consumePendingOpener: reconnect window — re-deferred');
      outbound.deferOpenerConsume({ userId, openerId, ...payload });
      this.notePendingFallback(
        userId,
        'markdown' in payload ? 'markdown' : 'spec',
        openerId,
        true,
      );
      return false;
    }
    if (triggeringClient) {
      const recalled = await outbound.recallOwnMessageWith(triggeringClient, openerId);
      if (outbound.getAccountEpoch() !== epoch) {
        this.log.info('consumePendingOpener: account changed during recall — dropping turn');
        return true;
      }
      if (!recalled) {
        // 撤回失败: 思考中卡还在。不回拨、不让调用方另发; 重新暂存走有界排空。
        this.log.warn('consumePendingOpener: recall failed — re-deferred');
        outbound.deferOpenerConsume({ userId, openerId, ...payload });
        this.notePendingFallback(
          userId,
          'markdown' in payload ? 'markdown' : 'spec',
          openerId,
          true,
        );
        this.scheduleConnectedFlushRetry();
        return false;
      }
    } else if (outbound.getAccountEpoch() !== epoch) {
      this.log.info('consumePendingOpener: account changed during recall — dropping turn');
      return true;
    }
    outbound.rearmAnchorToTrigger(userId);
    return false;
  }

  getPendingOpenerTrigger(userId: string): string | undefined {
    return outbound.getOpenerTrigger(userId);
  }

  async sendInteractiveCard(
    userId: string,
    spec: InteractiveCardSpec,
    opts?: {
      threadTs?: string;
      fallbackOpenerId?: string;
      deliverToOwnerDm?: boolean;
      ownerDmNote?: string;
    },
  ): Promise<{ messageId: string }> {
    return this.sendWithDeferredOpenerConsume(
      userId,
      'spec',
      () => outbound.sendInteractive(userId, spec, opts),
      opts?.fallbackOpenerId,
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
    requestedFallbackOpenerId?: string,
  ): Promise<{ messageId: string }> {
    const epoch = outbound.getAccountEpoch();
    const clientAtTake = outbound.getBoundClient();
    const fallbackOpenerId = this.claimFallbackOpenerId(userId, kind, requestedFallbackOpenerId);
    if (fallbackOpenerId) {
      const flushing = this.flushingOpenerConsumes.get(fallbackOpenerId);
      if (flushing) {
        const flushed = await flushing;
        this.takeCompletedOpenerConsume(fallbackOpenerId);
        // 排空已成功就复用收据, 即使等待期间换了代 — 旧卡已就地收口,
        // 不再经新账号 client 另发。只有排空以 null 收口时才要拦回落发送。
        if (flushed) return flushed;
        if (outbound.getAccountEpoch() !== epoch) {
          // 等待期间换代: 排空以 null 收口并丢掉旧条目。这里若继续
          // send() 会用新账号 client 把旧轮次终态打到旧 lane。
          this.log.info(
            'sendWithDeferredOpenerConsume: account changed while waiting for flush — dropping turn',
          );
          throw new Error('account changed while waiting for opener flush');
        }
      } else {
        const completed = this.takeCompletedOpenerConsume(fallbackOpenerId);
        if (completed) return completed;
      }
    }
    const entry = fallbackOpenerId
      ? outbound.takeDeferredOpenerConsumeById(fallbackOpenerId)
      : undefined;
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
          this.notePendingFallback(userId, kind, entry.openerId);
          throw err;
        }
        this.log.warn(`sendWithDeferredOpenerConsume patch failed (recalling reserved opener): ${msg}`);
        const recalled = await outbound.recallOwnMessageWith(
          clientAtTake ?? outbound.getBoundClient()!,
          entry.openerId,
        );
        // 撤回 await 期间也可能再次断线 — 发送前复查代次(跨账号红线)。
        if (outbound.getAccountEpoch() !== epoch) {
          this.log.info('sendWithDeferredOpenerConsume: account changed during recall — dropping entry');
          throw err;
        }
        if (!recalled) {
          // 撤回失败: 思考中卡还在。不回拨、不另发; 外层 catch 重新入队排空。
          this.log.warn('sendWithDeferredOpenerConsume: recall failed — keeping opener for retry');
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
      // 最终兜底失败: 条目已从队列移除。账号代次未变时重新入队并走有界
      // 退避排空 — 限流/临时故障时 client 可能没换代, 不能只在换 client
      // 时才重试, 否则终态永久丢失。
      if (entry && outbound.getAccountEpoch() === epoch) {
        this.log.warn(
          outbound.getBoundClient() !== sendClient
            ? 'sendWithDeferredOpenerConsume final send failed across reconnect (re-deferred)'
            : 'sendWithDeferredOpenerConsume final send failed (re-deferred for flush retry)',
        );
        outbound.deferOpenerConsume(entry);
        this.notePendingFallback(userId, kind, entry.openerId);
        this.scheduleConnectedFlushRetry();
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
