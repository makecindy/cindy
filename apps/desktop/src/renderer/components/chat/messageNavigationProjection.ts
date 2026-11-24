import type { ChatMessage } from '@/lib/makerChatStore';
import { deriveNavRailEntries, type NavRailEntry } from './messageNavRailModel';
import { isStreamingTextOnlyUpdate } from './streamingMessageProjection';

// 预览署名实际读取的来源字段。流式时历史行会换成浅拷贝，按字段比较才能复用；字段本身的引用不变。
const SENDER_FIELDS = ['sourceDevice', 'sourcePlugin', 'automationOrigin', 'hookSource', 'sharedAuthorName', 'createdAt'] as const;

function sameSender(before: NavRailEntry, after: NavRailEntry): boolean {
  return before.isOwn === after.isOwn
    && before.orcaSource === after.orcaSource
    && SENDER_FIELDS.every((field) => before.sender[field] === after.sender[field]);
}

function sameEntries(before: readonly NavRailEntry[], after: readonly NavRailEntry[]): boolean {
  return (
    before.length === after.length &&
    before.every((entry, index) => {
      const next = after[index];
      return (
        entry.id === next.id &&
        sameSender(entry, next) &&
        entry.preview === next.preview &&
        entry.isAutomation === next.isAutomation &&
        entry.attachmentsOnly === next.attachmentsOnly &&
        entry.answerExcerpt === next.answerExcerpt
      );
    })
  );
}

/** One mounted task owns the cache; the existing model remains the only source of excerpt rules. */
export function createMessageNavigationProjection(derive = deriveNavRailEntries) {
  const empty: NavRailEntry[] = [];
  let previous:
    | {
        messages: readonly ChatMessage[];
        entries: NavRailEntry[];
        tailStart: number;
        prefixCount: number;
      }
    | undefined;
  return (messages: readonly ChatMessage[], enabled: boolean): NavRailEntry[] => {
    if (!enabled) {
      previous = undefined;
      return empty;
    }
    if (previous?.messages === messages) return previous.entries;
    if (previous && isStreamingTextOnlyUpdate(previous.messages, messages)) {
      const tail = derive(messages.slice(previous.tailStart));
      const entries = sameEntries(previous.entries.slice(previous.prefixCount), tail)
        ? previous.entries
        : [...previous.entries.slice(0, previous.prefixCount), ...tail];
      previous = { ...previous, messages, entries };
      return entries;
    }
    // Steer belongs to the current question; synthetic/system/empty user rows
    // close ownership too, so include them when selecting the last boundary.
    const tailStart = Math.max(
      0,
      messages.findLastIndex((row) => row.role === 'user' && row.delivery !== 'steer'),
    );
    const entries = derive(messages);
    const tailCount = tailStart === 0 ? entries.length : derive(messages.slice(tailStart)).length;
    previous = { messages, entries, tailStart, prefixCount: entries.length - tailCount };
    return entries;
  };
}
