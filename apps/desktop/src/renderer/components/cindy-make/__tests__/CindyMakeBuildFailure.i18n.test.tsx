// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { createInstance } from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import en from '@/i18n/locales/en/common.json';
import zhCN from '@/i18n/locales/zh-CN/common.json';
import zhTW from '@/i18n/locales/zh-TW/common.json';
import ja from '@/i18n/locales/ja/common.json';
import ko from '@/i18n/locales/ko/common.json';
import { CindyMakeBuildFailure } from '../CindyMakeBuildFailure';

afterEach(cleanup);

it.each([
  ['en', en, 'memory limit'],
  ['zh-CN', zhCN, '内存上限'],
  ['zh-TW', zhTW, '記憶體上限'],
  ['ja', ja, 'メモリ上限'],
  ['ko', ko, '메모리 한도'],
] as const)(
  'shows the actual failure and exit code in %s without expanding the log',
  async (locale, resource, phrase) => {
    const i18n = createInstance();
    await i18n
      .use(initReactI18next)
      .init({
        lng: locale,
        resources: { [locale]: { translation: resource } },
        interpolation: { escapeValue: false },
      });
    render(
      <I18nextProvider i18n={i18n}>
        <CindyMakeBuildFailure
          build={{
            status: 'failed',
            error: 'buildFailed',
            logs: [
              { step: 'packaging', at: 1 },
              { step: 'failed', at: 2 },
            ],
            diagnostic: {
              kind: 'outOfMemory',
              exitCode: 134,
              message: 'FATAL ERROR: JavaScript heap out of memory',
            },
          }}
        />
      </I18nextProvider>,
    );
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain(phrase);
    expect(alert.textContent).toContain('134');
    expect(alert.textContent).toContain('FATAL ERROR: JavaScript heap out of memory');
    expect(alert.textContent).not.toMatch(/cindyMake\.|\?{2,}|\uFFFD/);
    expect(alert.closest('details')).toBeNull();
  },
);

it('explains that old receipts have no saved cause rather than inventing one', async () => {
  const i18n = createInstance();
  await i18n
    .use(initReactI18next)
    .init({ lng: 'zh-CN', resources: { 'zh-CN': { translation: zhCN } } });
  render(
    <I18nextProvider i18n={i18n}>
      <CindyMakeBuildFailure build={{ status: 'failed', error: 'buildFailed' }} />
    </I18nextProvider>,
  );
  expect(screen.getByRole('alert').textContent).toContain('这次生成没有保存具体错误');
  expect(screen.getByRole('alert').textContent).not.toContain('内存上限');
});
