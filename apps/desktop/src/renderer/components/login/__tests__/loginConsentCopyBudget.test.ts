import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { parseLegalSegments } from '../LoginControls';
import { SUPPORTED_LOCALES } from '../../../../shared/locale';
import { CONSENT_DIALOG, CONSENT_ROW } from '../loginDesignTokens';

// Guard tier (engineering-conventions §3.2): a static cross-file design contract between
// the locale catalogs and the login layout tokens, not a render of the login page.
// If it stops running, an overlong consent row or dialog title ships clipped again.
// 手机端镜像:apps/mobile/src/auth/__tests__/loginConsentCopyBudget.test.ts(估宽公式同源)。

function loadLogin(locale: string): Record<string, unknown> {
  const raw = readFileSync(
    resolve(process.cwd(), `src/renderer/i18n/locales/${locale}/common.json`),
    'utf8',
  );
  return (JSON.parse(raw) as { login: Record<string, unknown> }).login;
}

// DESIGN.md §16.2 长度预算:协议行是单行槽,超长只能改文案,禁止缩字号 / 折行吸收。
// 协议行在 680 宽内居中,超预算时两端被裁(de 实测:radio 看不见、句尾被切)。
describe('协议行与弹窗标题单行长度预算(全部语言)', () => {
  const estimate = (value: string) =>
    [...value].reduce((sum, character) => sum + ((character.codePointAt(0) ?? 0) <= 0xff ? 0.5 : 1), 0);
  const budgetUnits = ((CONSENT_ROW.width - CONSENT_ROW.radio.hitSize - CONSENT_ROW.gap) * 0.95) / CONSENT_ROW.fontSize;

  it.each(SUPPORTED_LOCALES)('%s:协议声明不超出协议行', (locale) => {
    const statement = parseLegalSegments(loadLogin(locale).consentStatement as string)
      .map((segment) => segment.text)
      .join('');
    expect(estimate(statement), statement).toBeLessThanOrEqual(budgetUnits);
  });

  it.each(SUPPORTED_LOCALES)('%s:协议弹窗标题不超出单行', (locale) => {
    const title = (loadLogin(locale).consentDialog as { title: string }).title;
    expect(estimate(title), title).toBeLessThanOrEqual((CONSENT_DIALOG.width * 0.95) / CONSENT_DIALOG.title.fontSize);
  });
});
