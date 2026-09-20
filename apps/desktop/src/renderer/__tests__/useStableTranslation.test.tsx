// @vitest-environment jsdom
import { act, render } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider, initReactI18next, useTranslation } from 'react-i18next';
import { describe, expect, it, vi } from 'vitest';
import { useStableTranslation } from '../hooks/useStableTranslation';

async function instance() {
  const i18n = createInstance();
  await i18n.use(initReactI18next).init({ lng: 'en', fallbackLng: 'en',
    resources: { en: { translation: { greeting: 'Hello' } }, zh: { translation: { greeting: '你好' } } },
    react: { useSuspense: false },
  });
  return i18n;
}

describe('stable translation subscriptions', () => {
  it.each([false, true])('preserves language updates with stable=%s', async (stable) => {
    const i18n = await instance();
    const on = vi.spyOn(i18n, 'on');
    const off = vi.spyOn(i18n, 'off');
    const hook = stable ? useStableTranslation : useTranslation;
    function Probe({ revision }: { revision: number }) {
      const { t } = hook();
      return <div data-revision={revision}>{t('greeting')}</div>;
    }
    const tree = (revision: number) => <I18nextProvider i18n={i18n}><Probe revision={revision} /></I18nextProvider>;
    const view = render(tree(0));
    const subscriptions = () => on.mock.calls.filter(([event]) => event === 'languageChanged').length;
    const initial = subscriptions();
    expect(initial).toBeGreaterThan(0);
    for (let revision = 1; revision <= 4; revision++) view.rerender(tree(revision));
    if (stable) { expect(subscriptions()).toBe(initial); expect(off).not.toHaveBeenCalled(); }
    else expect(subscriptions()).toBeGreaterThan(initial);
    await act(async () => { await i18n.changeLanguage('zh'); });
    expect(view.getByText('你好')).toBeTruthy();
    const beforeUnmount = off.mock.calls.length;
    view.unmount();
    expect(off.mock.calls.length).toBeGreaterThan(beforeUnmount);
    expect(off.mock.calls.some(([event, listener]) => event === 'languageChanged' &&
      on.mock.calls.some(([e, fn]) => e === event && fn === listener))).toBe(true);
  });
});
