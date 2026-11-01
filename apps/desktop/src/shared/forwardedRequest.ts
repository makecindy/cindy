import { DEFAULT_LOCALE, SUPPORTED_LOCALES, type SupportedLocale } from './locale.js';
export { verifiedOwnerRequestText } from '@cindy/maker-shared/auto-review-intent';
import en from '../renderer/i18n/locales/en/common.json';
import zhCN from '../renderer/i18n/locales/zh-CN/common.json';
import zhTW from '../renderer/i18n/locales/zh-TW/common.json';
import ja from '../renderer/i18n/locales/ja/common.json';
import ko from '../renderer/i18n/locales/ko/common.json';

// The same locale resources serve persisted text and host task context.
const FORWARDED_REQUEST_COPY = {
  en: en.forwardedRequest,
  'zh-CN': zhCN.forwardedRequest,
  'zh-TW': zhTW.forwardedRequest,
  ja: ja.forwardedRequest,
  ko: ko.forwardedRequest,
} satisfies Record<SupportedLocale, typeof en.forwardedRequest>;

import type { ForwardedRequestSource, AgentRequestReceipt } from '@cindy/maker-shared/forwarded-request-types';
export type { ForwardedRequestSource, AgentRequestReceipt } from '@cindy/maker-shared/forwarded-request-types';

export {readForwardedRequestSource} from '@cindy/maker-shared/forwarded-request-types';
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
export { FORWARDED_REQUEST_RECEIPT } from '@cindy/maker-shared/forwarded-request-types';
