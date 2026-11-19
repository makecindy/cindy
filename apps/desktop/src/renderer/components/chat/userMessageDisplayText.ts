import { mailTextParagraphs } from '@cindy/maker-shared/mail-text-edit';
import { forwardedRequestDisplayText } from '@cindy/maker-shared/message-source';
import { captureImContext, type ImMessageSource } from '../../../shared/imMessageSource';
/**
 * userMessageDisplayText
 * ---------------------------------------------------------------------------
 * user 消息「显示文本」的唯一推导处:气泡正文(UserMessage)与提问导航条预览
 * (messageNavRailModel)共用。两类特殊消息的显示文本与存库 content 不同:
 *   - hook 消息(IM 转入):正文优先 hookSource.userText(干净原文,与 agent
 *     prompt 分离);过渡期消息(有 hookSource 无 userText)回退正则剥
 *     <thread_context> 块;
 *   - Orca 通信行:content 是 {orcaSource, content} 的 JSON 封装,显示的是
 *     内层 content。
 * 各消费方自行解析会走偏 —— 导航条曾直接用原始 content,把 hook 消息的隐藏
 * prompt / thread 上下文和 Orca 行的 JSON 原文暴露进预览卡与 aria-label
 * (PR #830 review)。无 DOM 依赖,node 环境直接单测。
 */

export interface OrcaCommunicationContent {
  orcaSource: 'lead' | 'worker';
  content: string;
}

export function hasEmbeddedImPrompt(source?: ImMessageSource): boolean {
  return Boolean(source && source.contentFormat !== 'user-text');
}

export function parseOrcaCommunicationContent(content: string): OrcaCommunicationContent | null {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (record.orcaSource !== 'lead' && record.orcaSource !== 'worker') return null;
    if (typeof record.content !== 'string') return null;
    return {
      orcaSource: record.orcaSource,
      content: record.content,
    };
  } catch {
    return null;
  }
}

/**
 * 过渡期 hook 消息的兜底:剥正文开头的 <thread_context> 块与紧随的提示行。
 * 刻意不带 /m:^ 只匹配字符串起始(主机拼装的块必在串首),带 /m 会让正文
 * 中间恰好以 <thread_context> 开头的行也被误剥(Copilot review;旧实现的
 * /m 系历史遗留,原样迁入本文件后一并修正)。
 */
const THREAD_CONTEXT_PREFIX_RE =
  /^<thread_context>[\s\S]*?<\/thread_context>\s*(?:\(thread 历史中的.*?\)\s*)?/;

/**
 * Display-only projection of the groupWindowCore snapshot saved with this message.
 * Only recognize its complete, anchored envelope on attributed IM messages;
 * never scan user text for arbitrary tags or fetch today's group history.
 * Preserve multiline messages and the omission marker verbatim. The legacy
 * snapshot has no structured entries, so line counts are not message counts.
 */
export function resolveHookGroupContext(source: {
  content: string;
  hookSource?: ImMessageSource | null;
}): string | null {
  // TaskSource.im is an open set. The saved shape, not the platform name,
  // determines whether there is context to show (including future channels).
  if (typeof source.hookSource?.im !== 'string' || !source.hookSource.im.trim()) return null;
  if (source.hookSource.contextSnapshot) {
    const context = source.hookSource.contextSnapshot.groupContext;
    return typeof context === 'string' ? context : null;
  }
  return captureImContext({ groupPrefix: source.content }).groupContext ?? null;
}

export function isFeishuIm(im: string | undefined): boolean {
  return im === 'feishu' || im === 'lark';
}

const paragraphFormattingTags = /<\/?(?:p|strong|b|em|i|s|u|del|sub|sup|span)\s*>|<br\s*\/?>/gi;
const remainingMarkup = /<(?:[!?]|\/?[a-z][\w:-]*(?:[\s/>]|$))/i;
const codeWithMarkup = /```|`[^`\r\n]*<[^`\r\n]*`/;

function paragraphsAsText(fragment: string): string {
  // Old producers flatten both text and rich text, with no format marker.
  // Only decode the paragraph compatibility subset and keep other examples intact.
  if (codeWithMarkup.test(fragment) || remainingMarkup.test(fragment.replace(paragraphFormattingTags, ''))) {
    return fragment;
  }
  const text = mailTextParagraphs(fragment).map((paragraph) => paragraph.text).join('\n\n');
  return text.trim() ? text : fragment;
}

/** Feishu/Lark rich text can arrive as a paragraph-wrapped string. */
function displayImParagraphs(im: string | undefined, text: string): string {
  if (!isFeishuIm(im)) return text;
  const fragment = text.trim();
  if (!/^<p(?:\s[^>]*)?>/i.test(fragment) || !/<\/p>$/i.test(fragment)) return text;
  return paragraphsAsText(fragment);
}

const historyTime = String.raw`(?:\d{4}-)?(?:\d{2}-\d{2} )?\d{2}:\d{2}(?: UTC| \(UTC[+-]\d{2}:\d{2}\))?`;
const contextAuthor = String.raw`\[[^\r\n]*?\][ \t]+`;
// Do not consume a later opening paragraph when a closing tag is missing.
const contextParagraph = String.raw`<p(?:[ \t][^>\r\n]*)?>(?:(?!<\/?p(?:\s|>))[\s\S])*?(?:<\/p>|\[…已截断\])`;
const contextParagraphRun = String.raw`${contextParagraph}(?:\s*${contextParagraph})*`;
const groupAuthor = String.raw`${contextAuthor}${historyTime}[ \t]+`;
const contextParagraphEnd = String.raw`(?=\r?$|[ \t]+\[(?:图片[；\]]|文件[:：]))`;
const groupParagraphs = new RegExp(
  String.raw`^(${groupAuthor})(${contextParagraphRun})${contextParagraphEnd}`,
  'gim',
);
const replyParagraphs = new RegExp(
  String.raw`^((?:${contextAuthor}(?:(?:${historyTime}|\[时间未知\])[ \t]+)?)?)(${contextParagraphRun})${contextParagraphEnd}`,
  'gim',
);
// The group snapshot timestamps only the outer forward, not its child messages.
const groupForwards = new RegExp(
  String.raw`^(${groupAuthor}\[合并转发消息\][ \t]*\r?\n)((?:(?!^${groupAuthor})[\s\S])*)`,
  'gm',
);
const forwardedParagraphs = new RegExp(
  String.raw`^(${contextAuthor})(${contextParagraphRun})${contextParagraphEnd}`,
  'gim',
);

function replaceContextParagraphs(_matched: string, prefix: string, markup: string): string {
  const truncation = '[…已截断]';
  return markup.endsWith(truncation)
    ? prefix + paragraphsAsText(markup.slice(0, -truncation.length)) + truncation
    : prefix + paragraphsAsText(markup);
}

/** Convert paragraph runs while retaining author lines, attachments and the saved appendix. */
export function displayImContext(im: string, text: string, kind: 'group' | 'reply'): string {
  if (!isFeishuIm(im)) return text;
  // Group snapshots may end with actual file text, where tags are content.
  const appendix = kind === 'group'
    ? text.search(/\n(?:历史附件实际提供情况（JSON 数据）：|\[历史消息 [^\r\n]+ 的内容\])/)
    : -1;
  const context = appendix < 0 ? text : text.slice(0, appendix);
  const trailing = appendix < 0 ? '' : text.slice(appendix);
  if (kind === 'reply') return context.replace(replyParagraphs, replaceContextParagraphs);
  const displayed = context
    .replace(groupForwards, (_, heading: string, children: string) =>
      heading + children.replace(forwardedParagraphs, replaceContextParagraphs))
    .replace(groupParagraphs, replaceContextParagraphs);
  return displayed + trailing;
}

/**
 * 输入按结构收敛到两个字段,不 import ChatMessage / props 类型:
 * UserMessage 传的是 props(content + hookSource),导航条传的是 ChatMessage,
 * 两者都结构性满足;也让本模块保持零依赖可单测。
 */
export interface UserDisplayTextSource {
  content: string;
  hookSource?: { im?: string; userText?: string } | null;
  automationOrigin?: { kind: string };
}

export function resolveUserDisplayText(
  source: UserDisplayTextSource,
  // 渲染热路径(UserMessage 本就要单独解析 Orca 结果画卡片)可把已解析值
  // 传进来复用,免得每条 user 消息渲染都重复 JSON.parse(Copilot review);
  // 省略时自行解析,导航条 / chip 侧的单参调用形态不变。
  orcaCommunication: OrcaCommunicationContent | null = parseOrcaCommunicationContent(
    source.content,
  ),
): string {
  const rawDisplayContent = orcaCommunication?.content ?? source.content;
  if (!source.hookSource) return source.automationOrigin?.kind === 'session'
    ? forwardedRequestDisplayText(rawDisplayContent) : rawDisplayContent;
  return displayImParagraphs(
    source.hookSource.im,
    source.hookSource.userText ?? rawDisplayContent.replace(THREAD_CONTEXT_PREFIX_RE, '').trim(),
  );
}
