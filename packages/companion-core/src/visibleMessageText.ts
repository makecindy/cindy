import { forwardedRequestDisplayText } from '@cindy/maker-shared/message-source';
import { stripInternalWebCitations } from '@cindy/maker-shared/internal-citation';
import { isSyntheticTriggerText } from '@cindy/maker-shared/synthetic-trigger';
export function visibleMessageTextForConversationSearch(role: string, content: unknown, agentMeta?: string | null): string {
  const text = visibleMessageText(role, content);
  const meta = tryParseJsonLike(agentMeta ?? '') as { origin?: { kind?: unknown } } | null;
  const displayText = role === 'user' && meta?.origin?.kind === 'session'
    ? forwardedRequestDisplayText(text) : text;
  return displayText.replace(/\s+/g, ' ').trim();
}

/** Full visible content for result rendering; only search previews flatten Markdown. */
export function visibleMessageText(role: string, content: unknown, options?: { preserveWhitespace?: boolean }): string {
  const parsed = typeof content === 'string' ? tryParseJsonLike(content) : content;
  const rawText = roleVisibleText(role, parsed);
  const text = role === 'assistant' ? stripInternalWebCitations(rawText) : rawText;
  return options?.preserveWhitespace ? text : text.trim();
}

function roleVisibleText(role: string, content: unknown): string {
  if (role === 'user') return userVisibleText(content);
  if (role === 'assistant') return assistantVisibleText(content);
  if (role === 'ask_user') return askUserVisibleText(content);
  if (role === 'plan_review') return planReviewVisibleText(content);
  return extractText(content);
}

function userVisibleText(content: unknown): string {
  const text = userVisibleTextRaw(content);
  // 合成 UI 指令行(隐藏续跑指令等)对用户不可见,全文检索/learn-host 证据链
  // 同样不可见:返回空串 → keywordMatchedVisibleText=false → 命中被上游丢弃。
  // 与 mapper(sidebar 预览)/任务摘要/embedder 的排除口径一致,防隐藏英文指令
  // 经搜索 preview/snippet 泄漏给用户。
  return isSyntheticTriggerText(text) ? '' : text;
}

function userVisibleTextRaw(content: unknown): string {
  if (typeof content === 'string') return content;
  const blocksText = textBlocksText(content);
  if (blocksText) return blocksText;
  if (content && typeof content === 'object') {
    const obj = content as Record<string, unknown>;
    if (typeof obj.text === 'string') return obj.text;
    return preferredObjectText(obj);
  }
  return '';
}

function assistantVisibleText(content: unknown): string {
  if (typeof content === 'string') return content;
  const blocksText = textBlocksText(content);
  if (blocksText) return blocksText;
  if (
    content &&
    typeof content === 'object' &&
    (content as { type?: unknown }).type === 'text' &&
    typeof (content as { text?: unknown }).text === 'string'
  ) {
    return (content as { text: string }).text;
  }
  return extractText(content);
}

function askUserVisibleText(content: unknown): string {
  if (!content || typeof content !== 'object') return typeof content === 'string' ? content : '';
  const obj = content as Record<string, unknown>;
  const parts: string[] = [];
  const questions = obj.questions;
  if (Array.isArray(questions)) {
    for (const question of questions) {
      if (
        question &&
        typeof question === 'object' &&
        typeof (question as { question?: unknown }).question === 'string'
      ) {
        parts.push((question as { question: string }).question);
      }
    }
  }
  if (typeof obj.question === 'string') parts.push(obj.question);
  if (obj.answers && typeof obj.answers === 'object') {
    for (const answer of Object.values(obj.answers)) {
      if (typeof answer === 'string') parts.push(answer);
    }
  }
  if (typeof obj.reply === 'string') parts.push(obj.reply);
  return parts.join('\n');
}

function planReviewVisibleText(content: unknown): string {
  if (!content || typeof content !== 'object') return typeof content === 'string' ? content : '';
  const obj = content as Record<string, unknown>;
  return [obj.plan, obj.feedback].filter((value): value is string => typeof value === 'string').join('\n');
}

function textBlocksText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (
      block &&
      typeof block === 'object' &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string'
    ) {
      parts.push((block as { text: string }).text);
    }
  }
  return parts.join('\n\n');
}

function preferredObjectText(obj: Record<string, unknown>): string {
  return [obj.text, obj.content, obj.message, obj.question, obj.plan]
    .map(extractText)
    .filter(Boolean)
    .join(' ');
}

function extractText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map(extractText).filter(Boolean).join(' ');
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const preferred = [obj.text, obj.content, obj.message, obj.question, obj.plan]
      .map(extractText)
      .filter(Boolean)
      .join(' ');
    if (preferred) return preferred;
    return Object.values(obj).map(extractText).filter(Boolean).join(' ');
  }
  return '';
}

function tryParseJsonLike(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return value;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}
