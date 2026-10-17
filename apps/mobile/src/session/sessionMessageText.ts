import { joinChatQuoteTextSegments, parseChatQuoteSegments } from '@cindy/maker-shared/chat-quotes';
import {
  parseMobileMarkdown,
  parseMobileMarkdownInlines,
  type MobileMarkdownInline,
} from '@/session/messageMarkdown';
import { normalizeRemoteMessages } from '@/session/messageNormalize';
import {
  createSessionLinkPattern,
  parseSessionDeepLinkUrl,
  trimSessionLinkMatch,
} from '@/session/sessionLinks';
import type { RemoteMessage } from '@/session/types';

const MESSAGE_LABEL_MAX_CHARS = 240;
// 已发送气泡里的消息锚点 chip 是正文里的行内 span,没法像桌面 pill 那样按宽度单行省略;
// 按字数截到约一行气泡宽,完整正文仍可点进目标消息查看。
const SENT_MESSAGE_CHIP_MAX_CHARS = 24;
// 摘要只要开头几十个可见字符:长日志 / 大段输出只解析开头若干整行,不整条走 Markdown 解析。
const SENT_MESSAGE_CHIP_SOURCE_MAX = 2000;
// chip 不变量的唯一判据:无论解析器怎么处理,图片语法、<img>、受管媒体地址都不进摘要。
const RESIDUAL_IMAGE_MARKDOWN = /!\[([^\]\n]*)\]\([^)\n]*\)/g;
const RESIDUAL_MARKUP = /<img\b[^>\n]*>?|\b(?:cindy-media|xdt-[a-z0-9-]+):\/\/\S*|!\[/gi;

/** Readable text only; never stringify tool/SDK metadata into a reference chip. */
export function mobileSessionMessageDisplayText(message: RemoteMessage): string | null {
  const normalized = normalizeRemoteMessages([message]).find((item) => (
    item.kind === 'user' || item.kind === 'assistant'
  ));
  if (!normalized) return null;
  let text = normalized.body.trim();
  if (normalized.kind === 'user' && normalized.quotesEncoded === true) {
    const segments = parseChatQuoteSegments(normalized.body);
    const hasQuote = segments.some((segment) => segment.kind === 'quote');
    if (hasQuote) text = joinChatQuoteTextSegments(segments).trim();
  }
  if (!text) {
    text = (normalized.attachments ?? []).map((item) => item.name).filter(Boolean).join(' · ');
  }
  return text || null;
}

const MAX_EMPHASIS_REPARSE_DEPTH = 4;

/**
 * 解析器把加粗 / 斜体 / 删除线里的内容当整段文字交出(内嵌图片、`<img>`、嵌套强调都不展开),
 * 摘要里需要再解析一层,否则 `**![](cindy-media://…)**` 又会露出原文。
 */
function inlinesPlainText(inlines: readonly MobileMarkdownInline[], depth = 0): string {
  return inlines.map((inline) => {
    if (inline.type === 'image') return inline.alt;
    const emphasized = inline.type === 'strong'
      || inline.type === 'emphasis'
      || inline.type === 'strikethrough'
      || (inline.type !== 'code' && (inline.marks?.length ?? 0) > 0);
    return emphasized && depth < MAX_EMPHASIS_REPARSE_DEPTH
      ? inlinesPlainText(parseMobileMarkdownInlines(inline.text), depth + 1)
      : inline.text;
  }).join('');
}

/** 被引用消息常是带图片 / 强调的 Markdown;chip 只显示读得懂的单行摘要,不露 `**`、`![](…)`。 */
function markdownPlainText(text: string): string {
  return parseMobileMarkdown(text).map((block) => {
    if (block.type === 'table') {
      return [block.header, ...block.rows.map((row) => row.cells)]
        .map((cells) => cells.map(inlinesPlainText).join(' ')).join(' ');
    }
    return 'inlines' in block ? inlinesPlainText(block.inlines) : block.text;
  }).join(' ');
}

// 附着在前一个字符上的码点:组合符、ZWJ、变体选择符、肤色修饰、标签字符。
const CLUSTER_EXTEND = /^[\p{M}\u200D\uFE0E\uFE0F\u{1F3FB}-\u{1F3FF}\u{E0020}-\u{E007F}]$/u;
const REGIONAL_INDICATOR = /^[\u{1F1E6}-\u{1F1FF}]$/u;

/**
 * 按用户看到的字符分组(Hermes 没有 Intl.Segmenter):覆盖 ZWJ 家庭 / 肤色 / 国旗 /
 * 组合附加符,截断时不把一个 emoji 拆成两半。
 */
function displayCharacters(text: string): string[] {
  const clusters: string[] = [];
  let joinNext = false;
  let regionalRun = 0;
  for (const codePoint of text) {
    const last = clusters.length - 1;
    const regional = REGIONAL_INDICATOR.test(codePoint);
    if (last >= 0 && (joinNext || CLUSTER_EXTEND.test(codePoint) || (regional && regionalRun % 2 === 1))) {
      clusters[last] += codePoint;
    } else {
      clusters.push(codePoint);
    }
    regionalRun = regional ? regionalRun + 1 : 0;
    joinNext = codePoint === '\u200D';
  }
  return clusters;
}

export function compactSessionMessageLabel(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= MESSAGE_LABEL_MAX_CHARS) return compact;
  return `${compact.slice(0, MESSAGE_LABEL_MAX_CHARS - 1)}…`;
}

/** 只在行尾截断,不切开任何一行里的语法;超长单行整行保留(结果由调用方按消息缓存)。 */
function chipSourcePrefix(text: string): string {
  if (text.length <= SENT_MESSAGE_CHIP_SOURCE_MAX) return text;
  const lineEnd = text.indexOf('\n', SENT_MESSAGE_CHIP_SOURCE_MAX);
  return lineEnd < 0 ? text : text.slice(0, lineEnd);
}

function scrubResidualMarkup(text: string): string {
  return text.replace(RESIDUAL_IMAGE_MARKDOWN, '$1').replace(RESIDUAL_MARKUP, '');
}

/**
 * 已发送消息里引用 chip 的可见摘要(仅渲染用,不进输入框 atom / 发送数据);
 * 没有可读文字(如只有无说明图片)时返回空串,由调用方给中性占位。
 */
export function sentSessionMessageChipLabel(text: string): string {
  const compact = scrubResidualMarkup(markdownPlainText(chipSourcePrefix(text)))
    .replace(/\s+/g, ' ')
    .trim();
  const chars = displayCharacters(compact);
  if (chars.length <= SENT_MESSAGE_CHIP_MAX_CHARS) return compact;
  return `${chars.slice(0, SENT_MESSAGE_CHIP_MAX_CHARS - 1).join('').trimEnd()}…`;
}

export type AnchoredSessionMessageTextPart =
  | { kind: 'text'; text: string }
  | { kind: 'message-link'; url: string; sessionId: string; messageClientId: string };

/** Split only message-anchored session links; whole-session links stay in normal Markdown. */
export function splitAnchoredSessionMessageLinks(text: string): AnchoredSessionMessageTextPart[] {
  const parts: AnchoredSessionMessageTextPart[] = [];
  const pattern = createSessionLinkPattern();
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const url = trimSessionLinkMatch(match[0]);
    const target = parseSessionDeepLinkUrl(url);
    if (!target?.messageClientId) continue;
    if (match.index > cursor) parts.push({ kind: 'text', text: text.slice(cursor, match.index) });
    parts.push({
      kind: 'message-link',
      url,
      sessionId: target.sessionId,
      messageClientId: target.messageClientId,
    });
    cursor = match.index + url.length;
    pattern.lastIndex = cursor;
  }
  if (cursor < text.length) parts.push({ kind: 'text', text: text.slice(cursor) });
  return parts.length > 0 ? parts : [{ kind: 'text', text }];
}
