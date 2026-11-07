/**
 * CustomIM — 自定义 HTTP 渠道的传输层。
 *
 * 与其它渠道的差别: 没有平台 SDK, 入站由宿主的回环 server 调 handleInbound(),
 * 出站由本类 POST 到用户配置的 callbackUrl。会话维度键是 conversationId
 * (宿主侧当 scopeKey 用), userId 缺省等于 conversationId。
 *
 * 凭证(token)由宿主注入, 本类只负责校验与投递; 不在包内读写文件或 Electron。
 */

import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';

import { BaseIM } from '../BaseIM.js';
import type { TextChannelIM, ImFinalOutput } from '../channelIM.js';
import type { IMAttachment, IMHost, IMMessageEvent, IMStatus, SendFileResult } from '../types.js';
import type { CustomInboundMessage, CustomOutboundAttachment } from './types.js';
import { collectXdtFileRefs, stripXdtFileLinks } from '../xdtRefs.js';

export interface CustomIMOptions {
  /** 连接编号(会话路由身份; 同名连接也互不干扰)。 */
  connectionId: string;
  /** 连接显示名(用于会话标题与日志)。 */
  displayName: string;
  /** 入站鉴权 token; 常量时间比较。 */
  token: string;
  /** 终稿投递地址; 未配置时只做入站(调用方靠自己的轮询取结果)。 */
  callbackUrl: string | null;
  /** 投递实现(宿主注入, 便于单测)。 */
  deliver?: (url: string, body: unknown, token: string) => Promise<void>;
  /** 本机绝对路径的附件元信息(宿主注入: mimeType 推断)。 */
  resolveAttachment?: (absPath: string) => { name: string; mimeType: string } | null;
}

export class CustomIM extends BaseIM implements TextChannelIM {
  private status: IMStatus = { kind: 'idle' };
  private readonly messageHandlers = new Set<(e: IMMessageEvent) => void>();
  private readonly statusHandlers = new Set<(s: IMStatus) => void>();
  private readonly options: CustomIMOptions;
  private token: string;
  /**
   * conversationId → 尚未消费的回调地址队列。
   *
   * 入站消息各自带回调地址, 而终稿/直接回复是按 conversationId 发出去的。
   * 同一地址连续入站只留一条(终端客户端每条消息都用同一个地址), 消费时按
   * 先入先出取, 避免第二条消息把第一条的地址覆盖掉。
   */
  private readonly pendingCallbacks = new Map<string, string[]>();

  constructor(host: IMHost, options: CustomIMOptions) {
    super('custom', host);
    this.options = options;
    this.token = options.token;
  }

  /** 当前入站 token(添加/轮换时由宿主设置)。 */
  getToken(): string {
    return this.token;
  }

  setToken(token: string): void {
    this.token = token;
  }

  async init(): Promise<void> {
    this.setStatus({ kind: 'connected', appId: this.options.displayName });
  }

  async dispose(): Promise<void> {
    this.messageHandlers.clear();
    this.statusHandlers.clear();
    this.setStatus({ kind: 'idle' });
  }

  registerIpc(): void {
    /* 自定义渠道没有设置卡 IPC: 配置走伙伴页 / 设置页的通用表单。 */
  }

  /** 宿主回环 server 调进来; token 不符返回 false, 不产生任何副作用。 */
  handleInbound(token: string, payload: CustomInboundMessage): boolean {
    if (!this.tokenMatches(token)) return false;
    const event: IMMessageEvent = {
      channelName: 'custom',
      // 自定义渠道没有平台用户身份: 路由与会话一律锚在 conversationId 上,
      // 发言人(userId/userName)只用于展示, 不参与会话查找。
      senderId: payload.conversationId,
      chatId: payload.conversationId,
      contextId: this.options.connectionId,
      messageId: `custom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      text: payload.text,
      ...(payload.userName ? { speaker: { id: payload.userId ?? payload.conversationId, name: payload.userName, isOwner: false } } : {}),
      attachments: this.toAttachments(payload),
      unsupported: [],
      scopeKey: payload.conversationId,
    };
    this.noteCallback(payload.conversationId, payload.callbackUrl);
    for (const handler of [...this.messageHandlers]) handler(event);
    return true;
  }

  onMessage(handler: (e: IMMessageEvent) => void): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onStatusChange(handler: (s: IMStatus) => void): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  async sendText(userId: string, text: string): Promise<{ messageId: string }> {
    await this.deliver(userId, text, 'done', [], undefined, undefined, this.takeCallback(userId));
    return { messageId: `custom-out-${Date.now()}` };
  }

  async sendMarkdownText(userId: string, markdown: string): Promise<{ messageId: string }> {
    // chunked-text 渠道的终稿走这里: xdt-file 引用在这里剥成附件。
    const split = this.splitFileRefs(markdown);
    await this.deliver(userId, split.text, 'done', split.absPaths, undefined, undefined, this.takeCallback(userId));
    return { messageId: `custom-out-${Date.now()}` };
  }

  async sendFile(
    userId: string,
    absPath: string,
    displayName?: string,
  ): Promise<SendFileResult> {
    const meta = this.options.resolveAttachment?.(absPath);
    if (!meta) return { ok: false, reason: 'NOT_FOUND' };
    await this.deliver(
      userId,
      '',
      'done',
      [absPath],
      undefined,
      displayName ?? meta.name,
      this.takeCallback(userId),
    );
    return { ok: true };
  }

  getStatus(): IMStatus {
    return this.status;
  }

  /** 终稿投递(由 adapter 的 commitFinal 调用)。 */
  async commitFinal(output: ImFinalOutput): Promise<void> {
    const override = this.takeCallback(output.userId);
    const split = this.splitFileRefs(output.text);
    await this.deliver(
      output.userId,
      split.text,
      output.terminal,
      [...(output.mediaAbsPaths ?? []), ...split.absPaths],
      output.errorCode,
      undefined,
      override,
    );
  }

  /** 登记一条入站消息的回调地址; 相同地址连续入站不重复排队。 */
  private noteCallback(conversationId: string, callbackUrl: string | null | undefined): void {
    const url = callbackUrl?.trim();
    if (!url) return;
    const queue = this.pendingCallbacks.get(conversationId) ?? [];
    if (queue[queue.length - 1] !== url) queue.push(url);
    this.pendingCallbacks.set(conversationId, queue);
  }

  /** 取走本次外发要用的回调地址; 队列空了才回连接默认值。 */
  private takeCallback(conversationId: string): string | undefined {
    const queue = this.pendingCallbacks.get(conversationId);
    if (!queue || queue.length === 0) return undefined;
    const url = queue.shift();
    if (queue.length === 0) this.pendingCallbacks.delete(conversationId);
    return url;
  }

  private async deliver(
    conversationId: string,
    text: string,
    terminal: 'done' | 'aborted' | 'error',
    mediaAbsPaths: readonly string[],
    errorCode?: string,
    singleFileName?: string,
    callbackOverride?: string,
  ): Promise<void> {
    const url = callbackOverride ?? this.options.callbackUrl;
    if (!url) return;
    const attachments: CustomOutboundAttachment[] = [];
    for (const absPath of mediaAbsPaths) {
      const meta = this.options.resolveAttachment?.(absPath);
      if (!meta) continue;
      attachments.push({ absPath, name: singleFileName ?? meta.name });
    }
    const body = {
      conversationId,
      text,
      terminal,
      attachments,
      ...(errorCode ? { errorCode } : {}),
    };
    const deliver =
      this.options.deliver ??
      (async (target: string, payload: unknown, token: string) => {
        const response = await fetch(target, {
          method: 'POST',
          headers: {
            'content-type': 'application/json; charset=utf-8',
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(payload),
          redirect: 'error',
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) throw new Error(`custom callback returned ${response.status}`);
        await response.arrayBuffer();
      });
    await deliver(url, body, this.token);
  }

  private tokenMatches(presented: string): boolean {
    const a = Buffer.from(presented, 'utf8');
    const b = Buffer.from(this.token, 'utf8');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  /** 正文里的 xdt-file 引用 → 本机绝对路径; 正文剥离链接。非法引用直接跳过。 */
  private splitFileRefs(text: string): { text: string; absPaths: string[] } {
    const absPaths: string[] = [];
    for (const ref of collectXdtFileRefs(text)) {
      try {
        const absPath = xdtFileUrlToAbsPath(ref.url);
        if (this.options.resolveAttachment?.(absPath)) absPaths.push(absPath);
      } catch {
        /* 与 hook 出站同口径: 非法引用不阻断整轮 */
      }
    }
    return { text: absPaths.length > 0 ? stripXdtFileLinks(text) : text, absPaths };
  }

  private toAttachments(payload: CustomInboundMessage): IMAttachment[] {
    const out: IMAttachment[] = [];
    for (const item of payload.attachments ?? []) {
      if (typeof item.absPath !== 'string' || !path.isAbsolute(item.absPath)) continue;
      const meta = this.options.resolveAttachment?.(item.absPath);
      if (!meta) continue;
      out.push({
        kind: meta.mimeType.startsWith('image/') ? 'image' : 'file',
        absPath: item.absPath,
        originalName: item.name ?? meta.name,
        mimeType: item.mimeType ?? meta.mimeType,
      });
    }
    return out;
  }

  private setStatus(next: IMStatus): void {
    this.status = next;
    for (const handler of [...this.statusHandlers]) handler(next);
  }
}

/** xdt-file URL → 绝对路径; 相对路径 / 非法编码一律拒绝(fail-closed)。 */
function xdtFileUrlToAbsPath(url: string): string {
  if (!url.startsWith('xdt-file://')) throw new Error('not an xdt-file URL');
  const decoded = decodeURIComponent(url.slice('xdt-file://'.length));
  if (decoded.includes('\0') || !path.isAbsolute(decoded)) {
    throw new Error('xdt-file URL must contain an absolute path');
  }
  return decoded;
}

export function createCustomIM(
  host: IMHost,
  options: CustomIMOptions,
): CustomIM {
  return new CustomIM(host, options);
}
