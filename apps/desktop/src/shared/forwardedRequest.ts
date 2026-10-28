import { DEFAULT_LOCALE, SUPPORTED_LOCALES, type SupportedLocale } from './locale.js';
import en from '../renderer/i18n/locales/en/common.json';
import zhCN from '../renderer/i18n/locales/zh-CN/common.json';
import zhTW from '../renderer/i18n/locales/zh-TW/common.json';
import ja from '../renderer/i18n/locales/ja/common.json';
import ko from '../renderer/i18n/locales/ko/common.json';
export { verifiedOwnerRequestText } from '@cindy/maker-shared/auto-review-intent';

// The same locale resources serve persisted text and host task context.
const FORWARDED_REQUEST_COPY = {
  en: en.forwardedRequest,
  'zh-CN': zhCN.forwardedRequest,
  'zh-TW': zhTW.forwardedRequest,
  ja: ja.forwardedRequest,
  ko: ko.forwardedRequest,
} satisfies Record<SupportedLocale, typeof en.forwardedRequest>;

/** Host-owned source evidence. It describes authorship, never execution permission. */
export interface ForwardedRequestSource {
  userText: string | null;
  sessionId?: string;
  clientId?: string;
  /**
   * The sending host admitted this relay as the owner's request or its accepted continuation.
   * Only then does the receiver treat userText as the owner's
   * request for this task. Optional on the wire; older hosts drop or never send it.
   */
  ownerVerified?: true;
}

/** Kept under the existing protected, non-human input receipt. */
export interface AgentRequestReceipt {
  kind: 'agent-request' | 'delegated-continuation';
  request?: ForwardedRequestSource;
}

export function readForwardedRequestSource(value: unknown): ForwardedRequestSource | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  if (source.userText === null) return { userText: null };
  if (typeof source.userText !== 'string' || typeof source.sessionId !== 'string'
    || !source.sessionId || typeof source.clientId !== 'string' || !source.clientId) return null;
  return { userText: source.userText, sessionId: source.sessionId, clientId: source.clientId,
    ...(source.ownerVerified === true ? { ownerVerified: true as const } : {}) };
}

/** JSON string quoting keeps an agent-written label inside the supplement. No trimming or summarizing. */
export function formatForwardedRequest(source: ForwardedRequestSource, supplement: string, locale: SupportedLocale = DEFAULT_LOCALE): string {
  const copy = FORWARDED_REQUEST_COPY[locale];
  return [
    source.userText === null ? copy.sourceMissing : copy.sourcePresent,
    `${copy.userPrefix}${JSON.stringify(source.userText ?? '')}`,
    `${copy.agentPrefix}${JSON.stringify(supplement)}`,
  ].join('\n');
}

/** Validate the sender's locale independently of this computer's language. Includes the original Chinese format. */
export function matchesForwardedRequest(source: ForwardedRequestSource, body: string): boolean {
  const lines = body.split('\n');
  if (lines.length !== 3) return false;
  return SUPPORTED_LOCALES.some(locale => {
    const prefix = FORWARDED_REQUEST_COPY[locale].agentPrefix;
    // Pre-localization hosts used a lowercase Chinese prefix. Keep their exact bodies valid.
    const legacyPrefix = locale === 'zh-CN' ? 'agent补充：' : null;
    const matchedPrefix = lines[2].startsWith(prefix) ? prefix
      : legacyPrefix && lines[2].startsWith(legacyPrefix) ? legacyPrefix : null;
    if (!matchedPrefix) return false;
    try {
      const supplement: unknown = JSON.parse(lines[2].slice(matchedPrefix.length));
      if (typeof supplement !== 'string') return false;
      const expected = formatForwardedRequest(source, supplement, locale);
      if (expected === body) return true;
      if (locale !== 'zh-CN' || matchedPrefix !== legacyPrefix) return false;
      // Original Chinese hosts predate the localized source wording as well as the capitalized label.
      const legacySource = source.userText === null
        ? '[来源] 未找到可核验的用户原话。'
        : '[来源] 用户原话由宿主从已接收的输入原样保留。';
      return [legacySource, `${FORWARDED_REQUEST_COPY['zh-CN'].userPrefix}${JSON.stringify(source.userText ?? '')}`,
        `${legacyPrefix}${JSON.stringify(supplement)}`].join('\n') === body;
    } catch { return false; }
  });
}

/** Main-process persistence capability: JSON / IPC cannot mint this key. */
export const FORWARDED_REQUEST_RECEIPT = Symbol('forwarded-request-receipt');
