/**
 * DingTalkDwsIM —— 通过官方 dws CLI 以「钉钉账号」身份收发的钉钉传输。
 *
 * 与机器人传输（../dingtalk）对外能力一致（文字收发、文件、文字交互），由
 * DingTalkChannelIM 二选一启用：
 *   - 入站：长驻 `dws event consume <o2o_all> <at> --flatten -f ndjson`，
 *     stderr 出现 `[event] ready` 才算连上；进程退出按指数退避重连。
 *   - 出站：`dws chat +messages-send`（单聊 open-dingtalk-id / 群 group）。
 *   - 身份：dws 当前登录账号（`dws auth status`）；Cindy 不读取、不保存其凭证。
 *   - 主人：私聊发送设置页一次性配对码的人。dws 登录的是真实账号，不能沿用
 *     机器人「第一个私聊者即主人」的规则。单聊只认主人；群里任何人 @ 都能
 *     触发，但非主人轮次受逐轮强确认约束（动手要主人拍板）。
 */

import { createHash, randomInt, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { BaseIM } from '../BaseIM.js';
import type { ImFinalOutput } from '../channelIM.js';
import { decodeLaneUserId, encodeLaneUserId } from '../dingtalk/codec.js';
import { imageAttachment } from '../dingtalk/inbound.js';
import { mimeTypeForFilename, safeWecomFilename } from '../wecom/media.js';
import { PendingReplies, type SharedReplyDecision } from '../dingtalk/pendingReplies.js';
import type {
  IMAttachment,
  IMHost,
  IMMessageEvent,
  IMStatus,
  IMUnsupportedEntry,
  SendFileResult,
} from '../types.js';
import {
  DWS_EVENT_DIRECT,
  DWS_EVENT_MENTION,
  isDwsReadyLine,
  parseDwsEventLine,
  parseDwsTransportState,
  stripSelfMention,
  type DwsInboundMessage,
} from './events.js';
import {
  DwsCommandError,
  DWS_NOT_INSTALLED,
  type DwsRunner,
  type DwsStreamProcess,
} from './runner.js';

export { DwsCommandError, DWS_NOT_INSTALLED, parseDwsJsonOutput } from './runner.js';
export type { DwsRunner, DwsStreamProcess } from './runner.js';

const ENABLED_SECRET = 'dingtalk-dws-enabled';
const OWNER_SECRET = 'dingtalk-dws-owner';
const DEDUP_TTL_MS = 5 * 60 * 1_000;
const GROUP_TITLE_TTL_MS = 30 * 60_000;
const GROUP_TITLE_MISS_TTL_MS = 5 * 60_000;
const DEDUP_CAPACITY = 2_048;
const READY_TIMEOUT_MS = 45_000;
const STOP_GRACE_MS = 5_000;
const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;
const INTERACTION_TIMEOUT_MS = 30 * 60 * 1_000;
const OUTBOUND_CHUNK_SIZE = 3_500;
const MAX_OUTBOUND_FILES = 4;
const MAX_LINE_CHARS = 1_000_000;
const SEND_TIMEOUT_MS = 60_000;
// 只重试服务端明确拒绝的限流；回执未知或普通错误不重发，避免制造重复消息。
const SEND_RETRY_DELAYS_MS = [5_000, 15_000, 30_000] as const;
const MAX_INBOUND_IMAGES = 6;
const MAX_INBOUND_FILES = 4;
const MAX_CONTEXT_IMAGES = 6;
const MAX_CONTEXT_FILES = 4;

export const DINGTALK_DWS_ERROR = {
  notInstalled: 'DINGTALK_DWS_NOT_INSTALLED',
  notLoggedIn: 'DINGTALK_DWS_NOT_LOGGED_IN',
  streamFailed: 'DINGTALK_DWS_STREAM_FAILED',
} as const;

export interface DingTalkDwsIdentity {
  corpId: string;
  corpName: string;
  userId: string;
  userName: string;
}

export interface DingTalkDwsPublicState {
  status: IMStatus;
  enabled: boolean;
  installed: boolean;
  identity: Omit<DingTalkDwsIdentity, 'corpId' | 'userId'> | null;
  ownerName: string | null;
  /** 尚未绑定主人且已开启时的一次性配对码；主人私聊发送它完成绑定。 */
  pairingCode: string | null;
  /** 最近一次发送失败；只公开分类，不含消息正文、目标或 CLI 诊断。 */
  lastSendError?: 'rate_limited' | 'failed' | null;
}

export interface GroupHistoryMessage {
  messageId: string;
  senderName: string;
  senderId: string;
  text: string;
  createTime: string;
  /** 仅在 fetchRecentGroupMessages 指定 withResources 时填充。 */
  attachments: IMAttachment[];
}

interface OwnerRecord {
  contextId: string;
  openId: string;
  name: string;
}

type Target = { kind: 'direct'; openId: string } | { kind: 'group'; conversationId: string };
type SendOperation = (
  args: readonly string[],
  options: { cwd?: string; timeoutMs?: number },
) => Promise<unknown>;

export class DingTalkDwsIM extends BaseIM {
  private readonly messageHandlers = new Set<(event: IMMessageEvent) => void>();
  private readonly statusHandlers = new Set<(status: IMStatus) => void>();
  private readonly stateHandlers = new Set<() => void>();
  private readonly seen = new Map<string, number>();
  private readonly laneQueues = new Map<string, Promise<void>>();
  /** 群名缓存（conversationId → 名称 + 查询时刻）；查不到的也短暂记一下，避免每条消息都去查。 */
  private readonly groupTitles = new Map<string, { title: string; at: number }>();
  private readonly pendingReplies = new PendingReplies({
    alreadyPending: 'DINGTALK_INTERACTION_ALREADY_PENDING',
    timeout: 'DINGTALK_INTERACTION_TIMEOUT',
  });

  private status: IMStatus = { kind: 'idle' };
  private identity: DingTalkDwsIdentity | null = null;
  private installed = false;
  private pairingCode: string | null = null;
  private proc: DwsStreamProcess | null = null;
  private generation = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private readonly sendRetryWaits = new Set<() => void>();
  private lastSendError: 'rate_limited' | 'failed' | null = null;

  constructor(
    host: IMHost,
    private readonly runner: DwsRunner,
  ) {
    super('dingtalk', host);
  }

  /** 连接标识（会话隔离键）：`<corpId>:<userId>`。未连接时为空串。 */
  get contextId(): string {
    return this.identity ? `${this.identity.corpId}:${this.identity.userId}` : '';
  }

  isEnabled(): boolean {
    return this.host.secrets.read(ENABLED_SECRET) === '1';
  }

  async init(): Promise<void> {
    if (!this.isEnabled()) {
      this.setStatus({ kind: 'idle' });
      return;
    }
    try {
      await this.connect();
    } catch (error) {
      this.setStatus({ kind: 'error', reason: safeErrorCode(error) });
    }
  }

  async dispose(): Promise<void> {
    await this.stop();
    this.setStatus({ kind: 'idle' });
  }

  /** 由 DingTalkChannelIM 统一注册 IPC；本类不直接持有通道名。 */
  registerIpc(): void {}

  // ── 控制面（供 DingTalkChannelIM 的 IPC 调用）────────────────────────────

  /** 探测本机 dws 安装与登录状态；不改变连接。 */
  async probe(): Promise<DingTalkDwsPublicState> {
    this.installed = await this.runner.isAvailable().catch(() => false);
    // 事件流在跑或正在重连时，身份由连接流程持有；探测不能悄悄换掉它
    // （否则断线期间换号会让旧主人绑定落到新账号上）。
    if (this.installed && !this.proc && !this.reconnectTimer) {
      this.identity = await this.readIdentity().catch(() => null);
    }
    return this.getPublicState();
  }

  getPublicState(): DingTalkDwsPublicState {
    // 身份已知时只认属于当前账号的绑定；未连接（身份未知）时展示已存的绑定。
    const owner = this.identity ? this.currentOwner() : this.readOwner();
    return {
      // 渲染层只需要连接态；不外送 corpId / userId 组成的内部会话键。
      status:
        this.status.kind === 'connected' ? { kind: 'connected', appId: 'dws' } : this.status,
      enabled: this.isEnabled(),
      installed: this.installed,
      identity: this.identity
        ? { corpName: this.identity.corpName, userName: this.identity.userName }
        : null,
      ownerName: owner ? owner.name : null,
      pairingCode: !owner && this.isEnabled() ? this.ensurePairingCode() : null,
      lastSendError: this.lastSendError,
    };
  }

  /** 开启并连接；失败时抛出带 `[CODE]` 前缀的错误，并保持未启用。 */
  async enable(): Promise<DingTalkDwsPublicState> {
    if (!this.host.secrets.write(ENABLED_SECRET, '1')) {
      throw new Error('[DINGTALK_DWS_STREAM_FAILED] secure storage unavailable');
    }
    try {
      await this.connect();
    } catch (error) {
      this.host.secrets.remove(ENABLED_SECRET);
      await this.stop();
      this.setStatus({ kind: 'idle' });
      throw toCodedError(error);
    }
    return this.getPublicState();
  }

  async disable(): Promise<DingTalkDwsPublicState> {
    this.host.secrets.remove(ENABLED_SECRET);
    await this.stop();
    this.setStatus({ kind: 'idle' });
    return this.getPublicState();
  }

  /** 解除主人绑定：之后需用新的配对码重新绑定。 */
  clearOwner(): void {
    this.host.secrets.remove(OWNER_SECRET);
    this.pairingCode = null;
    this.emitStateChange();
  }

  onStateChange(handler: () => void): () => void {
    this.stateHandlers.add(handler);
    return () => this.stateHandlers.delete(handler);
  }

  // ── ChannelIM 收发面 ────────────────────────────────────────────────────

  onMessage(handler: (event: IMMessageEvent) => void): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onStatusChange(handler: (status: IMStatus) => void): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  getStatus(): IMStatus {
    return this.status;
  }

  async sendText(userId: string, text: string): Promise<{ messageId: string }> {
    return this.sendBody(userId, text, '--text');
  }

  async sendMarkdownText(userId: string, markdown: string): Promise<{ messageId: string }> {
    return this.sendBody(userId, markdown, '--markdown');
  }

  async sendFile(userId: string, absPath: string): Promise<SendFileResult> {
    return this.sendFileWith(userId, absPath, this.createSendOperation());
  }

  private async sendFileWith(
    userId: string,
    absPath: string,
    send: SendOperation,
  ): Promise<SendFileResult> {
    if (!path.isAbsolute(absPath)) return { ok: false, reason: 'NOT_FOUND' };
    try {
      // dws 只接受工作目录内的相对路径：以文件所在目录为 cwd，只传文件名。
      await send(
        [
          'chat',
          '+messages-send',
          ...targetArgs(this.resolveTarget(userId)),
          '--file',
          path.basename(absPath),
          '--yes',
          '-f',
          'json',
        ],
        { cwd: path.dirname(absPath), timeoutMs: SEND_TIMEOUT_MS },
      );
      return { ok: true };
    } catch {
      this.log.warn('dingtalk dws file send failed');
      return { ok: false, reason: 'SEND_FAIL' };
    }
  }

  async commitFinal(output: ImFinalOutput): Promise<void> {
    const send = this.createSendOperation();
    await this.sendBody(output.userId, normalizeFinalText(output.text), '--markdown', send);
    const files = Array.from(new Set(output.mediaAbsPaths ?? [])).slice(0, MAX_OUTBOUND_FILES);
    for (const absPath of files) {
      const result = await this.sendFileWith(output.userId, absPath, send);
      if (!result.ok) throw new Error('DINGTALK_DWS_FILE_SEND_FAILED');
    }
  }

  requestTextReply<T>(
    userId: string,
    prompt: string,
    parse: (text: string) => T | null,
    timeoutMs = INTERACTION_TIMEOUT_MS,
    shared?: SharedReplyDecision<T>,
  ): Promise<T> {
    return this.pendingReplies.request(userId, prompt, parse, timeoutMs, shared, (text) =>
      this.sendText(userId, text),
    );
  }

  /**
   * 以当前账号身份读取群最近消息（时间正序），供群上下文注入。
   * withResources 指定时，最近 N 条（不含 excludeMessageId，即本轮触发消息——它的
   * 附件已随入站事件下载）里的图片与文件一并下载，挂在对应消息的 attachments 上。
   */
  async fetchRecentGroupMessages(
    conversationId: string,
    limit: number,
    options: { withResources?: number; excludeMessageId?: string } = {},
  ): Promise<GroupHistoryMessage[]> {
    const result = await this.runner.runJson(
      [
        'chat',
        '+chat-messages',
        '--open-conversation-id',
        conversationId,
        '--limit',
        String(Math.max(1, Math.min(100, Math.floor(limit)))),
        '--no-reactions',
        '-f',
        'json',
      ],
      { timeoutMs: 30_000 },
    );
    const messages = isRecord(result) && Array.isArray(result.messages) ? result.messages : [];
    const history = messages
      .filter(isRecord)
      .map(
        (m): GroupHistoryMessage => ({
          messageId: str(m.messageId),
          senderName: str(m.sender) || '钉钉用户',
          senderId: str(m.senderId),
          text: str(m.text),
          createTime: str(m.createTime),
          attachments: [],
        }),
      )
      // 只有图片、没有文字的消息也保留，附件下载后才挂得上。
      .filter((m) => m.messageId)
      .sort((a, b) => a.createTime.localeCompare(b.createTime));
    const take = Math.max(0, Math.floor(options.withResources ?? 0));
    if (take > 0) {
      const recent = history.filter((m) => m.messageId !== options.excludeMessageId).slice(-take);
      const downloaded = await this.downloadResources(
        recent.map((m) => m.messageId),
        { maxImages: MAX_CONTEXT_IMAGES, maxFiles: MAX_CONTEXT_FILES, contextFiles: true },
      );
      for (const m of recent) m.attachments = downloaded.byMessage.get(m.messageId) ?? [];
    }
    return history;
  }

  // ── 连接 ────────────────────────────────────────────────────────────────

  private async connect(): Promise<void> {
    await this.stop();
    const generation = this.generation;
    this.setStatus({ kind: 'connecting' });
    this.installed = await this.runner.isAvailable().catch(() => false);
    if (!this.installed) throw codedError(DINGTALK_DWS_ERROR.notInstalled);
    const identity = await this.readIdentity();
    if (generation !== this.generation) throw new Error('DINGTALK_DWS_CONNECTION_REPLACED');
    this.adoptIdentity(identity);
    await this.startStream(generation);
  }

  private async readIdentity(): Promise<DingTalkDwsIdentity> {
    let result: unknown;
    try {
      result = await this.runner.runJson(['auth', 'status', '-f', 'json'], { timeoutMs: 30_000 });
    } catch (error) {
      if (error instanceof Error && error.message === DWS_NOT_INSTALLED) {
        throw codedError(DINGTALK_DWS_ERROR.notInstalled);
      }
      throw codedError(DINGTALK_DWS_ERROR.notLoggedIn);
    }
    if (
      !isRecord(result) ||
      result.authenticated !== true ||
      (result.token_valid !== true && result.refresh_token_valid !== true)
    ) {
      throw codedError(DINGTALK_DWS_ERROR.notLoggedIn);
    }
    const corpId = str(result.corp_id);
    const userId = str(result.user_id);
    if (!corpId || !userId) throw codedError(DINGTALK_DWS_ERROR.notLoggedIn);
    return {
      corpId,
      userId,
      corpName: str(result.corp_name),
      userName: str(result.user_name),
    };
  }

  private startStream(generation: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let proc: DwsStreamProcess;
      try {
        proc = this.runner.spawnStream([
          'event',
          'consume',
          DWS_EVENT_DIRECT,
          DWS_EVENT_MENTION,
          '--flatten',
          '-f',
          'ndjson',
        ]);
      } catch {
        reject(codedError(DINGTALK_DWS_ERROR.notInstalled));
        return;
      }
      this.proc = proc;
      const readyTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(codedError(DINGTALK_DWS_ERROR.streamFailed));
        // 只结束这一次未就绪的进程；首次连接由调用方收口，重连路径由退避继续接管。
        try {
          proc.forceKill();
        } catch {
          // 进程可能已经退出。
        }
      }, READY_TIMEOUT_MS);

      readLines(proc.stdout, (line) => {
        if (generation !== this.generation) return;
        const message = parseDwsEventLine(line);
        if (message) this.accept(message, generation);
      });
      readLines(proc.stderr, (line) => {
        if (generation !== this.generation) return;
        if (isDwsReadyLine(line)) {
          this.reconnectAttempt = 0;
          this.setStatus({ kind: 'connected', appId: this.contextId });
          if (!settled) {
            settled = true;
            clearTimeout(readyTimer);
            resolve();
          }
          return;
        }
        const state = parseDwsTransportState(line);
        if (state === 'connected' && this.status.kind !== 'connected' && settled) {
          this.setStatus({ kind: 'connected', appId: this.contextId });
        } else if (state === 'reconnecting' || state === 'disconnected') {
          if (this.status.kind === 'connected') this.setStatus({ kind: 'connecting' });
        }
      });
      proc.onError(() => {
        // 'exit' 一般随后到达；就绪前的 spawn 失败直接收口。
        if (!settled) {
          settled = true;
          clearTimeout(readyTimer);
          reject(codedError(DINGTALK_DWS_ERROR.notInstalled));
        }
      });
      proc.onExit(() => {
        clearTimeout(readyTimer);
        if (this.proc === proc) this.proc = null;
        if (!settled) {
          settled = true;
          reject(codedError(DINGTALK_DWS_ERROR.streamFailed));
          return;
        }
        if (generation !== this.generation) return;
        this.scheduleReconnect(generation);
      });
    });
  }

  private scheduleReconnect(generation: number): void {
    if (this.reconnectTimer) return;
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.setStatus({ kind: 'connecting' });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (generation !== this.generation) return;
      void (async () => {
        // 断线期间 dws 可能换了登录账号：重连前重新核对身份，换号就清旧绑定。
        const identity = await this.readIdentity();
        if (generation !== this.generation) return;
        this.adoptIdentity(identity);
        await this.startStream(generation);
      })().catch((error) => {
        if (generation !== this.generation) return;
        this.log.warn(`dingtalk dws stream restart failed: ${safeErrorCode(error)}`);
        this.scheduleReconnect(generation);
      });
    }, delay);
  }

  private async stop(): Promise<void> {
    this.generation += 1;
    this.setLastSendError(null);
    // 取消退避等待，唤醒后由发送闭包的代次检查拒绝；停渠道不留下迟到补发。
    for (const finish of this.sendRetryWaits) finish();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.laneQueues.clear();
    this.groupTitles.clear();
    this.pendingReplies.rejectAll('DINGTALK_DISCONNECTED');
    const proc = this.proc;
    this.proc = null;
    if (!proc) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        // 优雅停机超时才强杀；强杀会跳过服务端退订，所以只作兜底。
        try {
          proc.forceKill();
        } catch {
          // 进程可能已经退出。
        }
        resolve();
      }, STOP_GRACE_MS);
      proc.onExit(() => {
        clearTimeout(timer);
        resolve();
      });
      try {
        proc.closeStdin();
      } catch {
        clearTimeout(timer);
        try {
          proc.forceKill();
        } catch {
          // ignore
        }
        resolve();
      }
    });
  }

  // ── 入站 ────────────────────────────────────────────────────────────────

  private accept(message: DwsInboundMessage, generation: number): void {
    // event_id 标识一次事件投递，同一消息重投时可能变化；按账号、会话和消息本身
    // 去重，并在异步附件处理 / lane 排队之前占位。不同消息的相同正文仍正常派发。
    const dedupeKey = JSON.stringify([this.contextId, message.conversationId, message.messageId]);
    if (this.isDuplicate(dedupeKey)) return;
    const userId =
      message.kind === 'mention' ? encodeLaneUserId(message.conversationId) : message.senderOpenId;
    const accountToken = this.host.accountScope?.capture();
    if (this.host.accountScope && accountToken === null) return;
    const prior = this.laneQueues.get(userId) ?? Promise.resolve();
    const next = prior
      .catch(() => undefined)
      .then(() => this.runInCapturedAccountScope(accountToken, () => this.process(userId, message, generation)))
      .catch((error) => {
        this.log.warn(`dingtalk dws inbound processing failed: ${safeErrorCode(error)}`);
      })
      .finally(() => {
        if (this.laneQueues.get(userId) === next) this.laneQueues.delete(userId);
      });
    this.laneQueues.set(userId, next);
  }

  private async process(userId: string, message: DwsInboundMessage, generation: number): Promise<void> {
    if (generation !== this.generation) return;
    const isGroup = message.kind === 'mention';
    const owner = this.currentOwner();
    if (!owner) {
      // dws 登录的是真实账号，同事随时可能私聊它，不能像新建机器人那样
      // 「第一个私聊者即主人」：只有私聊发送设置页配对码的人才会被绑定。
      // 群里绝不认主；绑定前的其他消息一律忽略，也不回复。
      if (!isGroup && this.pairingCode && message.text.trim() === this.pairingCode) {
        this.claimOwner(message);
      }
      return;
    }
    const isOwner = message.senderOpenId === owner.openId;
    // 单聊只认主人。群里任何人 @ 都能触发（与机器人方式、Telegram 同口径：
    // 「谁都能问，动手要主人拍板」）——非主人轮次带 speaker.isOwner=false，
    // 由 adapter 挂逐轮强确认策略，「完全访问」也不扩给他们。
    if (!isGroup && !isOwner) return;

    const text = isGroup
      ? stripSelfMention(message.text, this.identity?.userName ?? '')
      : message.text.trim();
    // 等待回复期间，群里非主人的回答被吞掉（只有主人能确认），不落成普通消息。
    if (text && this.pendingReplies.tryResolve(userId, text, isOwner)) return;

    // 截图 / 文件：连同被引用的原消息一起经 dws 下载。按消息归属拆开——当前消息
    // 自己的附件才算本条附件；被引消息的附件放在 replyAttachments，只供模型理解
    // 引用、不当作当前发言人发送的附件落库。
    const quotedId = message.quoted?.messageId;
    const media = await this.downloadResources(
      [message.messageId, ...(quotedId ? [quotedId] : [])],
      { maxImages: MAX_INBOUND_IMAGES, maxFiles: MAX_INBOUND_FILES },
    );
    if (generation !== this.generation) return;
    const ownAttachments = media.byMessage.get(message.messageId) ?? [];
    const replyAttachments = quotedId ? (media.byMessage.get(quotedId) ?? []) : [];
    // 群名写进渠道说明，Agent 知道是哪个群；查询失败只是不带群名。
    const groupTitle = isGroup ? await this.groupTitle(message.conversationId) : '';
    if (generation !== this.generation) return;

    const event: IMMessageEvent = {
      channelName: 'dingtalk',
      interactionSource: {
        senderName: message.senderName,
        ...(groupTitle ? { chatName: groupTitle } : {}),
      },
      senderId: userId,
      chatId: message.conversationId,
      contextId: this.contextId,
      messageId: message.messageId,
      // 群里纯 @（无正文）仍是召唤，补成裸 `@`，与机器人模式同口径。
      text: isGroup && !text ? '@' : text,
      ...(isGroup
        ? { speaker: { id: message.senderOpenId, name: message.senderName, isOwner } }
        : {}),
      ...(message.quoted
        ? { replyContext: { author: message.quoted.author, text: message.quoted.text } }
        : {}),
      ...(replyAttachments.length > 0 ? { replyAttachments } : {}),
      attachments: ownAttachments,
      unsupported: media.unsupported,
    };
    // 只发图片、没有文字的私聊照常处理；真正的空消息才丢弃。
    if (
      !event.text &&
      event.attachments.length === 0 &&
      replyAttachments.length === 0 &&
      event.unsupported.length === 0
    ) {
      return;
    }
    for (const handler of this.messageHandlers) {
      try {
        handler(event);
      } catch {
        // 单个订阅者异常不影响其他订阅者。
      }
    }
  }

  /**
   * 用 `chat +messages-mget --download-resources` 把消息里的资源下到临时目录：
   * - 图片（png/jpg/gif/webp）存进宿主媒体缓存，作为 image 附件；
   * - 其他文件（PDF/docx/zip…）按媒体规范不进媒体总仓，落到宿主注入的
   *   `paths.dingtalkMediaDir`（与企业微信同一套落盘规则），作为 file 附件；
   * - 不另设资源体积上限；普通文件直接复制，图片经宿主媒体缓存处理。
   * 整次查询失败不臆造提示（无法判断是否真有资源）。临时目录用完即删。
   */
  private async downloadResources(
    messageIds: string[],
    limits: { maxImages: number; maxFiles: number; contextFiles?: boolean },
  ): Promise<{
    unsupported: IMUnsupportedEntry[];
    byMessage: Map<string, IMAttachment[]>;
  }> {
    const unsupported: IMUnsupportedEntry[] = [];
    const byMessage = new Map<string, IMAttachment[]>();
    const media = this.host.media;
    const filesDir = this.host.paths.dingtalkMediaDir;
    const ids = Array.from(new Set(messageIds.filter(Boolean))).slice(0, 50);
    if (!media || ids.length === 0) return { unsupported, byMessage };
    let images = 0;
    let files = 0;
    let dir: string | null = null;
    try {
      dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cindy-dws-'));
      const result = await this.runner.runJson(
        [
          'chat',
          '+messages-mget',
          '--msg-ids',
          ids.join(','),
          '--download-resources',
          '--output-dir',
          'downloads',
          '--no-reactions',
          '--no-threads',
          '-f',
          'json',
        ],
        { cwd: dir, timeoutMs: 120_000 },
      );
      const ledger =
        isRecord(result) && isRecord(result.resourceDownloads) ? result.resourceDownloads : null;
      if (!ledger) return { unsupported, byMessage };
      // dws 对 fileId 下载去重后可能不填 messageId；从消息的资源引用恢复全部归属。
      const resourceOwners = new Map<string, Set<string>>();
      const messages = isRecord(result) && Array.isArray(result.messages) ? result.messages : [];
      for (const message of messages) {
        if (!isRecord(message) || !ids.includes(str(message.messageId))) continue;
        const refs = Array.isArray(message.resourceRefs) ? message.resourceRefs : [];
        for (const ref of refs) {
          if (!isRecord(ref) || !str(ref.resourceId)) continue;
          const key = resourceIdentity(str(ref.resourceIdType) || str(ref.type), str(ref.resourceId));
          const owners = resourceOwners.get(key) ?? new Set<string>();
          owners.add(str(message.messageId));
          resourceOwners.set(key, owners);
        }
      }
      const failedCount = typeof ledger.failedCount === 'number' ? ledger.failedCount : 0;
      for (let i = 0; i < failedCount && i < limits.maxImages; i += 1) {
        unsupported.push({ type: 'picture', label: '图片（下载失败）' });
      }
      const downloads = Array.isArray(ledger.downloads) ? ledger.downloads.filter(isRecord) : [];
      for (const entry of downloads) {
        const resourceKey = resourceIdentity(str(entry.resourceType), str(entry.resourceId));
        const explicitId = str(entry.messageId);
        const owners = resourceOwners.get(resourceKey) ?? new Set(
          explicitId ? (ids.includes(explicitId) ? [explicitId] : []) : (ids.length === 1 ? ids : []),
        );
        // 多消息查询中，无法确定来源的附件不能冒充当前发言人或被引消息的附件。
        if (owners.size === 0) continue;
        const localPath = str(entry.localPath);
        const absPath = path.resolve(dir, localPath);
        // 只信任落在临时目录内的文件（防御异常的相对路径）。
        if (!localPath || !absPath.startsWith(dir + path.sep)) continue;
        const stat = await fs.promises.stat(absPath).catch(() => null);
        if (!stat?.isFile() || stat.size === 0) continue;
        const handle = await fs.promises.open(absPath, 'r');
        const header = Buffer.alloc(12);
        let bytesRead: number;
        try {
          ({ bytesRead } = await handle.read(header, 0, header.length, 0));
        } finally {
          await handle.close();
        }
        const mimeType = detectImageMime(header.subarray(0, bytesRead));
        let attachment: IMAttachment;
        if (mimeType) {
          if (images >= limits.maxImages) continue;
          const buffer = await fs.promises.readFile(absPath);
          const resourceId = str(entry.resourceId);
          const stored = await media
            .cacheImage({
              integration: 'dingtalk',
              token: 'dws:' + (resourceId || str(entry.messageId) + ':' + localPath),
              buffer,
              mimeType,
            })
            .catch(() => null);
          if (!stored) {
            unsupported.push({ type: 'picture', label: '图片（保存失败）' });
            continue;
          }
          attachment = imageAttachment(stored.absPath, stored.url, mimeType);
          images += 1;
        } else {
          if (files >= limits.maxFiles) continue;
          if (!filesDir) {
            unsupported.push({ type: 'file', label: '文件' });
            continue;
          }
          // 单个文件落盘失败只影响它自己，不中断其余资源。
          const persisted = await persistDownloadedFile(
            filesDir,
            absPath,
            limits.contextFiles ? (str(entry.resourceId) || `${explicitId}:${localPath}`) : undefined,
          ).catch(() => null);
          if (!persisted) {
            unsupported.push({ type: 'file', label: '文件（保存失败）' });
            continue;
          }
          attachment = { kind: 'file', ...persisted };
          files += 1;
        }
        for (const messageId of owners) {
          byMessage.set(messageId, [...(byMessage.get(messageId) ?? []), attachment]);
        }
      }
    } catch {
      this.log.warn('dingtalk dws resource download failed');
    } finally {
      if (dir) await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
    if (limits.contextFiles && filesDir) void pruneContextFiles(filesDir);
    return { unsupported, byMessage };
  }

  private claimOwner(message: DwsInboundMessage): OwnerRecord | null {
    const record: OwnerRecord = {
      contextId: this.contextId,
      openId: message.senderOpenId,
      name: message.senderName,
    };
    if (!this.host.secrets.write(OWNER_SECRET, JSON.stringify(record))) return null;
    // 配对码一次性：用过即作废，解除绑定后再生成新的。
    this.pairingCode = null;
    this.emitStateChange();
    return record;
  }

  private ensurePairingCode(): string {
    this.pairingCode ??= String(randomInt(100_000, 1_000_000));
    return this.pairingCode;
  }

  /** 只有属于当前登录账号的主人绑定才有效；换号后旧绑定一律视为未绑定。 */
  private currentOwner(): OwnerRecord | null {
    const owner = this.readOwner();
    if (!owner || !this.identity || owner.contextId !== this.contextId) return null;
    return owner;
  }

  /** 采用新读到的身份；与已存主人绑定的账号不一致时清掉旧绑定与等待中的确认。 */
  private adoptIdentity(identity: DingTalkDwsIdentity): void {
    const previous = this.contextId;
    this.identity = identity;
    const owner = this.readOwner();
    if (owner && owner.contextId !== this.contextId) {
      this.host.secrets.remove(OWNER_SECRET);
      this.pairingCode = null;
    }
    if (previous && previous !== this.contextId) {
      this.lastSendError = null;
      this.pendingReplies.rejectAll('DINGTALK_ACCOUNT_CHANGED');
      this.emitStateChange();
    }
  }

  private readOwner(): OwnerRecord | null {
    const raw = this.host.secrets.read(OWNER_SECRET);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (
        isRecord(parsed) &&
        typeof parsed.contextId === 'string' &&
        typeof parsed.openId === 'string' &&
        parsed.openId
      ) {
        return { contextId: parsed.contextId, openId: parsed.openId, name: str(parsed.name) };
      }
    } catch {
      // 损坏的记录按未绑定处理。
    }
    return null;
  }

  private async groupTitle(conversationId: string): Promise<string> {
    const now = Date.now();
    const cached = this.groupTitles.get(conversationId);
    if (cached && now - cached.at < (cached.title ? GROUP_TITLE_TTL_MS : GROUP_TITLE_MISS_TTL_MS)) {
      return cached.title;
    }
    let title = '';
    try {
      const result = await this.runner.runJson(
        ['chat', '+conversation-info', '--group', conversationId, '-f', 'json'],
        { timeoutMs: 15_000 },
      );
      const root = isRecord(result) && isRecord(result.result) ? result.result : result;
      const info = isRecord(root) && isRecord(root.conversationInfo) ? root.conversationInfo : null;
      title = info ? str(info.title).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 64) : '';
    } catch (error) {
      this.log.warn(`dingtalk dws group title lookup failed: ${safeErrorCode(error)}`);
    }
    this.groupTitles.set(conversationId, { title, at: now });
    return title;
  }

  private isDuplicate(key: string): boolean {
    const now = Date.now();
    for (const [id, at] of this.seen) {
      if (now - at > DEDUP_TTL_MS) this.seen.delete(id);
    }
    if (this.seen.has(key)) return true;
    this.seen.set(key, now);
    while (this.seen.size > DEDUP_CAPACITY) {
      const oldest = this.seen.keys().next().value;
      if (!oldest) break;
      this.seen.delete(oldest);
    }
    return false;
  }

  // ── 出站 ────────────────────────────────────────────────────────────────

  private async sendBody(
    userId: string,
    body: string,
    flag: '--text' | '--markdown',
    send: SendOperation = this.createSendOperation(),
  ): Promise<{ messageId: string }> {
    const target = this.resolveTarget(userId);
    for (const chunk of chunkText(body)) {
      await send(
        ['chat', '+messages-send', ...targetArgs(target), flag, chunk, '--yes', '-f', 'json'],
        { timeoutMs: SEND_TIMEOUT_MS },
      );
    }
    return { messageId: `out:${Date.now().toString(36)}` };
  }

  private createSendOperation(): SendOperation {
    const generation = this.generation;
    const contextId = this.contextId;
    const accountToken = this.host.accountScope?.capture();
    const isCurrent = () =>
      generation === this.generation &&
      contextId === this.contextId &&
      (!this.host.accountScope ||
        (accountToken !== null && this.host.accountScope.isCurrent(accountToken)));
    // 每一段 / 每个附件各有一个键，重试复用原键；显式绑定发起账号，避免 CLI 切号后错发。
    return async (args, options) => {
      if (!contextId) throw new Error('DINGTALK_DWS_NOT_CONNECTED');
      const sendArgs = [...args, '--profile', contextId, '--idempotency-key', randomUUID()];
      for (let attempt = 0; ; attempt += 1) {
        if (generation !== this.generation || contextId !== this.contextId) {
          throw new Error('DINGTALK_DWS_CONNECTION_REPLACED');
        }
        try {
          const result = await this.runInCapturedAccountScope(accountToken, () =>
            this.runner.runJson(sendArgs, options),
          );
          if (isCurrent()) this.setLastSendError(null);
          return result;
        } catch (error) {
          const delay = SEND_RETRY_DELAYS_MS[attempt];
          if (
            !(error instanceof DwsCommandError) ||
            error.code !== 'RATE_LIMIT_ERROR' ||
            delay === undefined
          ) {
            if (isCurrent()) {
              this.setLastSendError(
                error instanceof DwsCommandError && error.code === 'RATE_LIMIT_ERROR'
                  ? 'rate_limited'
                  : 'failed',
              );
            }
            throw error;
          }
          // stop 也可能发生在上一条命令尚未返回时，不能再挂上新的等待器。
          if (generation !== this.generation || contextId !== this.contextId) {
            throw new Error('DINGTALK_DWS_CONNECTION_REPLACED');
          }
          this.log.warn(`dingtalk dws send rate limited; retry=${attempt + 1}, delayMs=${delay}`);
          await new Promise<void>((resolve) => {
            const finish = () => {
              clearTimeout(timer);
              this.sendRetryWaits.delete(finish);
              resolve();
            };
            const timer = setTimeout(finish, delay);
            this.sendRetryWaits.add(finish);
          });
        }
      }
    };
  }

  private resolveTarget(userId: string): Target {
    const lane = decodeLaneUserId(userId);
    return lane
      ? { kind: 'group', conversationId: lane.conversationId }
      : { kind: 'direct', openId: userId };
  }

  // ── 状态 ────────────────────────────────────────────────────────────────

  private setLastSendError(error: 'rate_limited' | 'failed' | null): void {
    if (this.lastSendError === error) return;
    this.lastSendError = error;
    this.emitStateChange();
  }

  private setStatus(status: IMStatus): void {
    this.status = status;
    for (const handler of this.statusHandlers) {
      try {
        handler(status);
      } catch {
        // best effort
      }
    }
    this.emitStateChange();
  }

  private emitStateChange(): void {
    for (const handler of this.stateHandlers) {
      try {
        handler();
      } catch {
        // best effort
      }
    }
  }

  private async runInCapturedAccountScope<T>(
    token: unknown,
    operation: () => Promise<T>,
  ): Promise<T> {
    const scope = this.host.accountScope;
    if (!scope) return operation();
    if (token === null || !scope.isCurrent(token)) {
      throw new Error('[IM_NOT_READY] IM account changed');
    }
    return scope.run(token, operation);
  }
}

export function createDingTalkDwsIM(host: IMHost, runner: DwsRunner): DingTalkDwsIM {
  return new DingTalkDwsIM(host, runner);
}

function targetArgs(target: Target): string[] {
  return target.kind === 'group'
    ? ['--group', target.conversationId]
    : ['--open-dingtalk-id', target.openId];
}

function readLines(stream: NodeJS.ReadableStream, onLine: (line: string) => void): void {
  let buffer = '';
  stream.setEncoding?.('utf8');
  stream.on('data', (chunk: string | Buffer) => {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      if (line.trim()) onLine(line);
      index = buffer.indexOf('\n');
    }
    // 单行超长视为异常输出，丢弃以免无界增长。
    if (buffer.length > MAX_LINE_CHARS) buffer = '';
  });
}

function chunkText(text: string): string[] {
  const normalized = text.trim() || '（空回复）';
  const chunks: string[] = [];
  let remaining = normalized;
  while (remaining.length > OUTBOUND_CHUNK_SIZE) {
    let splitAt = remaining.lastIndexOf('\n', OUTBOUND_CHUNK_SIZE);
    if (splitAt < OUTBOUND_CHUNK_SIZE / 2) splitAt = OUTBOUND_CHUNK_SIZE;
    if (
      /[\uD800-\uDBFF]/.test(remaining[splitAt - 1] ?? '') &&
      /[\uDC00-\uDFFF]/.test(remaining[splitAt] ?? '')
    ) {
      splitAt -= 1;
    }
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n+/, '');
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function normalizeFinalText(text: string): string {
  return text.trim() || '✅ 本轮已完成，没有文本输出。';
}

function codedError(code: string): Error {
  return new Error(`[${code}] ${code}`);
}

function toCodedError(error: unknown): Error {
  const code = safeErrorCode(error);
  return code === 'DINGTALK_DWS_CONNECTION_ERROR' ? codedError(DINGTALK_DWS_ERROR.streamFailed) : codedError(code);
}

function safeErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  for (const code of Object.values(DINGTALK_DWS_ERROR)) {
    if (message.startsWith(`[${code}]`)) return code;
  }
  return 'DINGTALK_DWS_CONNECTION_ERROR';
}

const CONTEXT_FILES_SUBDIR = 'context';
const CONTEXT_FILE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

/**
 * 群上下文文件按资源 ID 固定落盘位置：同一资源被反复 @ 时复用同一份，而不是
 * 每次新增一份。复用时刷新 mtime，配合 pruneContextFiles 的 7 天回收。
 */
async function persistDownloadedFile(
  filesDir: string,
  sourcePath: string,
  resourceKey?: string,
): Promise<{ absPath: string; originalName: string; mimeType: string }> {
  const originalName = safeWecomFilename(path.basename(sourcePath));
  if (resourceKey === undefined) {
    await fs.promises.mkdir(filesDir, { recursive: true });
    const absPath = path.join(filesDir, `${randomUUID()}-${originalName}`);
    await fs.promises.copyFile(sourcePath, absPath, fs.constants.COPYFILE_EXCL);
    return { absPath, originalName, mimeType: mimeTypeForFilename(originalName) };
  }
  const digest = createHash('sha256').update(resourceKey).digest('hex').slice(0, 24);
  const dir = path.join(filesDir, CONTEXT_FILES_SUBDIR, digest);
  const absPath = path.join(dir, originalName);
  const existing = await fs.promises.stat(absPath).catch(() => null);
  if (existing?.isFile() && existing.size === (await fs.promises.stat(sourcePath)).size) {
    const now = new Date();
    await fs.promises.utimes(absPath, now, now).catch(() => undefined);
  } else {
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.copyFile(sourcePath, absPath);
  }
  return { absPath, originalName, mimeType: mimeTypeForFilename(originalName) };
}

function resourceIdentity(type: string, id: string): string {
  return JSON.stringify([type, id]);
}

/** 尽力回收 7 天未再被引用的群上下文文件；失败静默，下次再试。 */
async function pruneContextFiles(filesDir: string): Promise<void> {
  const root = path.join(filesDir, CONTEXT_FILES_SUBDIR);
  const entries = await fs.promises.readdir(root, { withFileTypes: true }).catch(() => []);
  const cutoff = Date.now() - CONTEXT_FILE_TTL_MS;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    const files = await fs.promises.readdir(dir).catch(() => [] as string[]);
    let newest = 0;
    for (const file of files) {
      const stat = await fs.promises.stat(path.join(dir, file)).catch(() => null);
      if (stat) newest = Math.max(newest, stat.mtimeMs);
    }
    if (newest < cutoff) await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** 按文件头识别图片类型；非图片返回 null（与机器人方式同一组格式）。 */
function detectImageMime(bytes: Uint8Array): string | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  const head = String.fromCharCode(...bytes.slice(0, 12));
  if (head.startsWith('GIF87a') || head.startsWith('GIF89a')) return 'image/gif';
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
