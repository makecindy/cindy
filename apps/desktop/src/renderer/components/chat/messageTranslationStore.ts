/**
 * Display-only translations of assistant replies, keyed by message, source
 * text and target language. Kept in renderer memory: translations never enter
 * the conversation record, and a remounted message reuses its earlier result
 * instead of paying for another request.
 */
import type { SupportedLocale } from '../../../shared/locale';
import type { MessageTranslationResult } from '../../../shared/messageTranslation';

export type MessageTranslationEntry =
  | { status: 'loading' }
  | { status: 'ready'; text: string; shown: boolean }
  | { status: 'error'; reason: Extract<MessageTranslationResult, { ok: false }>['reason'] };

const entries = new Map<string, MessageTranslationEntry>();
const listeners = new Set<() => void>();

function set(key: string, entry: MessageTranslationEntry | undefined): void {
  if (entry) entries.set(key, entry);
  else entries.delete(key);
  for (const listener of listeners) listener();
}

export function messageTranslationKey(messageId: string, source: string, locale: SupportedLocale): string {
  return `${messageId}\u0000${locale}\u0000${source}`;
}

export function subscribeMessageTranslations(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getMessageTranslation(key: string): MessageTranslationEntry | undefined {
  return entries.get(key);
}

/**
 * One click: translate on first use, then switch between translation and
 * original. Returns the failure reason so the caller can tell the user.
 */
export async function toggleMessageTranslation(
  key: string,
  source: string,
  locale: SupportedLocale,
): Promise<MessageTranslationEntry | undefined> {
  const current = entries.get(key);
  if (current?.status === 'loading') return current;
  if (current?.status === 'ready') {
    set(key, { ...current, shown: !current.shown });
    return entries.get(key);
  }
  const translate = window.electronAPI?.maker?.translateMessage;
  if (!translate) return undefined;
  set(key, { status: 'loading' });
  let result: MessageTranslationResult;
  try {
    result = await translate({ text: source, locale });
  } catch {
    result = { ok: false, reason: 'failed' };
  }
  // A failure is not cached: the next click simply tries again.
  set(key, result.ok ? { status: 'ready', text: result.text, shown: true } : undefined);
  return result.ok ? entries.get(key) : { status: 'error', reason: result.reason };
}
