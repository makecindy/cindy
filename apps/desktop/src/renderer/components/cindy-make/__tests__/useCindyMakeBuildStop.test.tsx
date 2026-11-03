// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { ConfirmDialogProvider } from '@/components/ui/confirm-dialog-provider';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { useCindyMakeBuildStop } from '../useCindyMakeBuildStop';
import en from '@/i18n/locales/en/common.json';
import zhCN from '@/i18n/locales/zh-CN/common.json';
import zhTW from '@/i18n/locales/zh-TW/common.json';
import ja from '@/i18n/locales/ja/common.json';
import ko from '@/i18n/locales/ko/common.json';
const locales = [
  ['en', en],
  ['zh-CN', zhCN],
  ['zh-TW', zhTW],
  ['ja', ja],
  ['ko', ko],
] as const;
function Probe({ id }: { id?: string }) {
  const { stop, stopping } = useCindyMakeBuildStop(id);
  return (
    <button
      disabled={stopping}
      onClick={() =>
        void stop(
          () => true,
          () => {},
          () => {},
        )
      }
    >
      Stop
    </button>
  );
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
async function fixture(locale = 'en', resource: (typeof locales)[number][1] = en) {
  const api = vi.fn(async () => ({ items: [], busy: true, canBuild: false }));
  vi.stubGlobal('electronAPI', { cancelCindyMakePersonal: api });
  setDataOwnerGeneration('stop-owner');
  const i18n = createInstance();
  await i18n.init({
    lng: locale,
    fallbackLng: false,
    resources: { [locale]: { translation: resource } },
  });
  const ui = (id?: string) => (
    <I18nextProvider i18n={i18n}>
      <ConfirmDialogProvider>
        <Probe id={id} />
      </ConfirmDialogProvider>
    </I18nextProvider>
  );
  const view = render(ui('build-a'));
  return { api, ui, view };
}
it.each(locales)(
  'renders a readable Stop confirmation in %s and only cancels after approval',
  async (locale, resource) => {
    const h = await fixture(locale, resource);
    const trigger = screen.getByRole('button', { name: 'Stop' });
    fireEvent.click(trigger);
    fireEvent.click(trigger);
    const dialog = await screen.findByRole('alertdialog');
    expect(
      within(dialog).getByText(resource.cindyMake.history.stopConfirm.description),
    ).toBeTruthy();
    expect(dialog.textContent).not.toMatch(/cindyMake[.]|[?]{2,}|�/);
    expect(h.api).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: resource.cindyMake.history.stop }));
    await waitFor(() => expect(h.api).toHaveBeenCalledExactlyOnceWith('build-a'));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  },
);
it.each(['cancel', 'owner', 'build', 'finished', 'unmount'])(
  'does not cancel after %s while the prompt is open',
  async (change) => {
    const h = await fixture();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    const dialog = await screen.findByRole('alertdialog');
    if (change === 'cancel') fireEvent.keyDown(dialog, { key: 'Escape' });
    else if (change === 'unmount') h.view.unmount();
    else {
      if (change === 'owner') setDataOwnerGeneration('other-owner');
      h.view.rerender(
        h.ui(change === 'build' ? 'build-b' : change === 'finished' ? undefined : 'build-a'),
      );
    }
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(h.api).not.toHaveBeenCalled();
  },
);
