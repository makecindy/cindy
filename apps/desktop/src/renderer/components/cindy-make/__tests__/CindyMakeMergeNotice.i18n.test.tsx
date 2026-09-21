// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { ConfirmDialogProvider } from '@/components/ui/confirm-dialog-provider';
import { CindyMakeMergeNotice } from '../CindyMakeMergeNotice';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import en from '@/i18n/locales/en/common.json';
import zhCN from '@/i18n/locales/zh-CN/common.json';
import zhTW from '@/i18n/locales/zh-TW/common.json';
import ja from '@/i18n/locales/ja/common.json';
import ko from '@/i18n/locales/ko/common.json';

const locales = [
  ['en', en, 'Source update has conflicts'],
  ['zh-CN', zhCN, '源码更新遇到冲突'],
  ['zh-TW', zhTW, '原始碼更新遇到衝突'],
  ['ja', ja, 'ソース更新で競合が発生しました'],
  ['ko', ko, '소스 업데이트 중 충돌 발생'],
] as const;
function CurrentTask() {
  return <output data-testid="current-task">{useLocation().pathname}</output>;
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('source conflict confirmation translations', () => {
  it.each(locales)(
    'opens retained task records in %s without recreating a cleaned workspace',
    async (locale, resource) => {
      const api = vi.fn();
      vi.stubGlobal('electronAPI', { cindyMakeMerge: api });
      const i18n = createInstance();
      await i18n.init({ lng: locale, resources: { [locale]: { translation: resource } } });
      render(
        <MemoryRouter>
          <I18nextProvider i18n={i18n}>
            <CindyMakeMergeNotice
              state={{
                id: 'merge',
                status: 'merged',
                ref: 'personal',
                upstreamCommit: '',
                sessionId: 'resolver',
                hasWorkspace: false,
              }}
            />
            <CurrentTask />
          </I18nextProvider>
        </MemoryRouter>,
      );
      fireEvent.click(screen.getByRole('button', { name: resource.cindyMake.merge.openTask }));
      expect(screen.getByTestId('current-task').textContent).toBe('/cc-agent/resolver');
      expect(api).not.toHaveBeenCalled();
    },
  );
  it('dismisses an old account prompt without cancelling and lets the current account decide again', async () => {
    const operation = {
      id: '12345678-1234-1234-1234-123456789abc',
      status: 'conflict' as const,
      ref: 'main',
      upstreamCommit: 'a'.repeat(40),
      hasWorkspace: true,
    };
    const api = vi.fn(async () => ({ ...operation, status: 'cancelled', hasWorkspace: false }));
    vi.stubGlobal('electronAPI', { cindyMakeMerge: api });
    const i18n = createInstance();
    await i18n.init({ lng: 'en', resources: { en: { translation: en } } });
    const ui = () => (
      <MemoryRouter>
        <I18nextProvider i18n={i18n}>
          <ConfirmDialogProvider>
            <CindyMakeMergeNotice state={operation} />
          </ConfirmDialogProvider>
        </I18nextProvider>
      </MemoryRouter>
    );
    setDataOwnerGeneration('merge-owner');
    const view = render(ui());
    fireEvent.click(screen.getByRole('button', { name: en.cindyMake.merge.resolve }));
    await screen.findByRole('alertdialog');
    setDataOwnerGeneration('merge-owner');
    view.rerender(ui());
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(api).not.toHaveBeenCalled();
    const resolve = screen.getByRole('button', { name: en.cindyMake.merge.resolve });
    expect(resolve.hasAttribute('disabled')).toBe(false);
    fireEvent.click(resolve);
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(
      within(dialog).getByRole('button', { name: en.cindyMake.merge.conflictConfirm.cancel }),
    );
    await waitFor(() =>
      expect(api).toHaveBeenCalledExactlyOnceWith({ action: 'cancel', operationId: operation.id }),
    );
  });
  it.each(locales)(
    'explains the decision and cancels without starting an Agent in %s',
    async (locale, resource, title) => {
      const operation = {
        id: '12345678-1234-1234-1234-123456789abc',
        status: 'conflict' as const,
        ref: 'main',
        upstreamCommit: 'a'.repeat(40),
        hasWorkspace: true,
      };
      const api = vi.fn(async () => ({ ...operation, status: 'cancelled', hasWorkspace: false }));
      vi.stubGlobal('electronAPI', { cindyMakeMerge: api });
      const i18n = createInstance();
      await i18n.init({
        lng: locale,
        fallbackLng: false,
        resources: { [locale]: { translation: resource } },
      });
      render(
        <MemoryRouter>
          <I18nextProvider i18n={i18n}>
            <ConfirmDialogProvider>
              <CindyMakeMergeNotice state={operation} />
            </ConfirmDialogProvider>
          </I18nextProvider>
        </MemoryRouter>,
      );
      fireEvent.click(screen.getByRole('button', { name: resource.cindyMake.merge.resolve }));
      const dialog = await screen.findByRole('alertdialog');
      expect(within(dialog).getByText(title)).toBeTruthy();
      expect(
        within(dialog).getByText(resource.cindyMake.merge.conflictConfirm.description),
      ).toBeTruthy();
      expect(
        within(dialog).getByRole('button', {
          name: resource.cindyMake.merge.conflictConfirm.confirm,
        }),
      ).toBeTruthy();
      expect(dialog.textContent).not.toMatch(/cindyMake[.]|[?]{2,}|�/);
      expect(api).not.toHaveBeenCalled();
      fireEvent.click(
        within(dialog).getByRole('button', {
          name: resource.cindyMake.merge.conflictConfirm.cancel,
        }),
      );
      await waitFor(() =>
        expect(api).toHaveBeenCalledExactlyOnceWith({
          action: 'cancel',
          operationId: operation.id,
        }),
      );
    },
  );
});
