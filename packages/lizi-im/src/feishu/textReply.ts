/**
 * feishu/textReply.ts
 * ---------------------------------------------------------------------------
 * `replyFormat: 'text'` 的纯文本终稿通道。
 *
 * 与 streamingText(卡片流式)的区别:
 *   - 不建卡片、不出现「过程记录」: 中间帧只留在内存里, 进度不推到聊天;
 *   - 整段回答在收口时一次性发出(msg_type='text');
 *   - 超过飞书单条消息内容上限时, 在内容边界(段落 / 行 / 字符)切片, 按顺序发
 *     多条, 不截断;
 *   - 图片 / 文件附件单独成条发送(与卡片模式同样的解析结果, 只是不再内联)。
 *
 * 纯函数 `splitFeishuPlainText` 与 IO 都放在这里, 卡片模式的 streamingText 不受影响。
 */

import type { StreamingTextHandle } from '../types.js';
import {
  collectXdtFileLinks,
  collectXdtImageUrls,
  stripXdtFileLinks,
  stripXdtImageLinks,
} from '../xdtRefs.js';

/**
 * 飞书单条消息 `content` 的上限: 150 KB(序列化后的 JSON 体)。
 *
 * 留 2 KB 余量给信封字段与 JSON 转义带来的膨胀: 判定时直接用
 * `JSON.stringify({ text })` 的真实字节数, 余量只防平台侧口径差异。
 */
export const FEISHU_TEXT_CONTENT_MAX_BYTES = 150 * 1024;

/** 按内容体积切片的保守预算。 */
export const FEISHU_TEXT_SAFE_CONTENT_BYTES = FEISHU_TEXT_CONTENT_MAX_BYTES - 2 * 1024;

/** 切段时, 段落 / 行边界至少要用掉窗口这么大比例, 否则宁可硬切。 */
const BOUNDARY_MIN_RATIO = 0.6;

/** `msg_type='text'` 的 content 实际字节数(含 JSON 转义)。 */
export function textMessageBytes(text: string): number {
  return Buffer.byteLength(JSON.stringify({ text }), 'utf8');
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * 找出「装得下」的最长前缀, 优先切在段落 / 行边界上, 且不拆代理对。
 * 返回 0 表示连一个字符都装不下(预算配错), 调用方须整段交回。
 */
function fittingCutIndex(text: string, budget: number): number {
  let lo = 1;
  let hi = text.length;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (textMessageBytes(text.slice(0, mid)) <= budget) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (best <= 0) return 0;
  if (best >= text.length) return text.length;
  if (isHighSurrogate(text.charCodeAt(best - 1)) && isLowSurrogate(text.charCodeAt(best))) {
    best -= 1;
  }
  const window = text.slice(0, best);
  const paragraph = window.lastIndexOf('\n\n');
  if (paragraph >= 0 && paragraph + 2 >= Math.floor(best * BOUNDARY_MIN_RATIO)) {
    return paragraph + 2;
  }
  const line = window.lastIndexOf('\n');
  if (line >= 0 && line + 1 >= Math.floor(best * BOUNDARY_MIN_RATIO)) {
    return line + 1;
  }
  return best;
}

/**
 * 把一段回答切成若干条都能装进飞书文本消息的片段。
 *
 * 空 / 纯空白回答返回 `[]`(text 模式不发空消息, 也不建占位卡片)。
 * 切不动时把剩余内容整段作为最后一段返回, 保证不丢内容、不死循环。
 */
export function splitFeishuPlainText(
  text: string,
  budget: number = FEISHU_TEXT_SAFE_CONTENT_BYTES,
): string[] {
  if (budget <= 0) throw new Error('feishu text chunk budget must be positive');
  const normalized = text.replace(/\r\n?/g, '\n').trim();
  if (!normalized) return [];
  const chunks: string[] = [];
  let rest = normalized;
  while (rest.length > 0) {
    if (textMessageBytes(rest) <= budget) {
      chunks.push(rest);
      break;
    }
    const cut = fittingCutIndex(rest, budget);
    if (cut <= 0) {
      chunks.push(rest);
      break;
    }
    // 不在切点两侧修剪空白: 切片只决定「在哪里断开」, 不改变回答内容。
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  return chunks;
}

/** 一次纯文本终稿投递需要的 IO(由 FeishuIM 注入, 便于单测)。 */
export interface PlainTextReplyDeps {
  /** 发一条 `msg_type='text'` 消息。 */
  sendText(text: string): Promise<{ messageId: string }>;
  /** 发一个附件(图片走飞书的图片消息快路径)。失败由实现自己记日志。 */
  sendAttachment(absPath: string, displayName?: string): Promise<boolean | void>;
  /** 正文里的托管图片地址 → 本机绝对路径; 认不出返回 null。 */
  resolveImageUrl(url: string): string | null;
  log?: { warn(message: string): void };
}

/**
 * 投递一条纯文本终稿: 正文按上限切片顺序发出, 附件随后单独发送。
 *
 * 正文与附件都为空时什么都不发(空回复不制造空消息)。
 */
export async function deliverPlainTextFinal(
  deps: PlainTextReplyDeps,
  text: string,
  extraAbsPaths: readonly string[] = [],
): Promise<{ messageId: string }> {
  const attachments: Array<{ absPath: string; displayName?: string }> = [];
  const seen = new Set<string>();
  const addAttachment = (absPath: string, displayName?: string): void => {
    if (seen.has(absPath)) return;
    seen.add(absPath);
    attachments.push({ absPath, ...(displayName ? { displayName } : {}) });
  };

  for (const url of collectXdtImageUrls(text)) {
    const absPath = deps.resolveImageUrl(url);
    if (absPath) addAttachment(absPath);
    else deps.log?.warn(`[feishu/textReply] resolve managed image failed for ${url}`);
  }
  for (const link of collectXdtFileLinks(text)) {
    addAttachment(link.absPath, link.alt || undefined);
  }
  for (const absPath of extraAbsPaths) addAttachment(absPath);

  const body = stripXdtFileLinks(stripXdtImageLinks(text)).trim();
  let lastMessageId = '';
  for (const chunk of splitFeishuPlainText(body)) {
    const sent = await deps.sendText(chunk);
    lastMessageId = sent.messageId;
  }
  for (const attachment of attachments) {
    await deps.sendAttachment(attachment.absPath, attachment.displayName);
  }
  return { messageId: lastMessageId };
}

/**
 * 建一条纯文本回复 handle。
 *
 * `bind` 把内部异步入口绑到创建时的连接作用域 —— handle 会活过
 * `startStreamingText` 的 AsyncLocalStorage 调用, agent 事件可能来自别的作用域。
 */
export function createPlainTextReplyHandle(options: {
  messageId: string;
  deliver: (text: string, extraAbsPaths: readonly string[]) => Promise<void>;
  bind?: <A extends unknown[], R>(fn: (...args: A) => R) => (...args: A) => R;
}): StreamingTextHandle {
  const extraAbsPaths: string[] = [];
  let finalized = false;
  const run = (text: string): Promise<void> =>
    options.deliver(text, [...extraAbsPaths]);
  const deliver = options.bind ? options.bind(run) : run;
  const handle: StreamingTextHandle = {
    messageId: options.messageId,
    append() {
      // 纯文本模式不推中间帧: 正文由 StreamingTextHandle 的终稿决定。
    },
    replace() {
      // 同上 —— 工具进度 / 逐字增量都不进聊天。
    },
    // 过程记录(replyFormat='text' 不展示): 收口参数里带了也不渲染。
    async finalize(finalText: string) {
      if (finalized) return;
      finalized = true;
      await deliver(finalText);
    },
    close() {
      finalized = true;
    },
    addExtraImageAbsPath(absPath: string) {
      if (!extraAbsPaths.includes(absPath)) extraAbsPaths.push(absPath);
    },
  };
  return handle;
}
