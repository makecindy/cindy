import { describe, expect, it } from 'vitest';

import { ERROR_REASON_I18N_KEYS } from '@/components/chat/errorReasonI18n';
import en from '@/i18n/locales/en/common.json';
import ja from '@/i18n/locales/ja/common.json';
import ko from '@/i18n/locales/ko/common.json';
import zhCN from '@/i18n/locales/zh-CN/common.json';
import zhTW from '@/i18n/locales/zh-TW/common.json';
import {
  CLAUDE_GATEWAY_OPUS_PLAN_MISMATCH_REASON,
  CLAUDE_SUBSCRIPTION_OPUS_PLAN_MISMATCH_REASON,
} from '../../shared/claudeGatewayError';

const LOCALES = { en, 'zh-CN': zhCN, 'zh-TW': zhTW, ja, ko } as Record<
  string,
  { chat: { errorBanner: Record<string, string> } }
>;

function copyFor(locale: string, reason: string): string {
  const key = ERROR_REASON_I18N_KEYS[reason];
  expect(key, `${reason} must have a renderer i18n mapping`).toBeTruthy();
  const leaf = key.split('.').at(-1) as string;
  const text = LOCALES[locale].chat.errorBanner[leaf];
  expect(text, `${locale} is missing ${key}`).toBeTruthy();
  return text;
}

describe('Claude Opus request-attributed renderer copy', () => {
  it.each(Object.keys(LOCALES))('%s keeps both stable reasons free of misleading commands', (locale) => {
    for (const reason of [
      CLAUDE_GATEWAY_OPUS_PLAN_MISMATCH_REASON,
      CLAUDE_SUBSCRIPTION_OPUS_PLAN_MISMATCH_REASON,
    ]) {
      expect(copyFor(locale, reason)).not.toMatch(/Claude Pro|\/logout|\/login/i);
    }
  });
});
