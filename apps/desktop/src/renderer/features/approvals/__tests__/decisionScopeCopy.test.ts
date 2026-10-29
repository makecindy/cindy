/**
 * Production entry: `approvalsInbox.decisionScope`, the inspector footer (review finding on #7719).
 * The inspector reuses PermissionPrompt, which can offer a session-wide allow (updatedPermissions +
 * `user_permanent`, see PermissionPrompt.test.tsx). A footer saying every decision applies to one
 * request only would be false, so each locale must name both scopes. Minimal input: the five locale
 * files. Tier: unit.
 */
import { describe, expect, it } from 'vitest';

import en from '@/i18n/locales/en/common.json';
import ja from '@/i18n/locales/ja/common.json';
import ko from '@/i18n/locales/ko/common.json';
import zhCN from '@/i18n/locales/zh-CN/common.json';
import zhTW from '@/i18n/locales/zh-TW/common.json';

const LOCALES = {
  en: { json: en, oldClaim: 'Each decision applies to this request only.', thisRequest: /this request/, session: /session/i },
  'zh-CN': { json: zhCN, oldClaim: '每次决定只适用于这一个请求。', thisRequest: /这一个请求/, session: /本任务/ },
  'zh-TW': { json: zhTW, oldClaim: '每次決定只適用於這一個請求。', thisRequest: /這一個請求/, session: /本任務/ },
  ja: { json: ja, oldClaim: '各承認はこのリクエストにのみ適用されます。', thisRequest: /このリクエスト/, session: /セッション/ },
  ko: { json: ko, oldClaim: '각 결정은 이 요청에만 적용됩니다.', thisRequest: /이 요청/, session: /세션/ },
} as const;

describe('approvalsInbox.decisionScope', () => {
  it.each(Object.entries(LOCALES))('%s separates the current request from the session-wide allow', (_locale, spec) => {
    const text = (spec.json as { approvalsInbox: { decisionScope: string } }).approvalsInbox.decisionScope;
    expect(text).not.toBe(spec.oldClaim);
    expect(text).toMatch(spec.thisRequest);
    expect(text).toMatch(spec.session);
  });
});
