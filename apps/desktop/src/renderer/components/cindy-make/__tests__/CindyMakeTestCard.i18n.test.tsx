// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInstance } from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import en from '@/i18n/locales/en/common.json';
import zhCN from '@/i18n/locales/zh-CN/common.json';
import zhTW from '@/i18n/locales/zh-TW/common.json';
import ja from '@/i18n/locales/ja/common.json';
import ko from '@/i18n/locales/ko/common.json';
import type { CindyMakeCompletionMeta } from '../../../../shared/cindyMakeSession';
import type { CindyVersionsState } from '../../../../shared/cindyVersions';
import { CindyMakeTestCard } from '../CindyMakeTestCard';

vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: async () => false }),
}));
vi.mock('@/lib/makerChatStore', () => ({ makerChatStore: { updateSystemCardData: vi.fn() } }));
vi.mock('@/features/device-link/stickySessionOrigin', () => ({
  getStickySessionDeviceId: () => undefined,
}));

const cases = [
  { locale: 'en', resource: en },
  { locale: 'zh-CN', resource: zhCN },
  { locale: 'zh-TW', resource: zhTW },
  { locale: 'ja', resource: ja },
  { locale: 'ko', resource: ko },
];

beforeEach(() => setDataOwnerGeneration('test-card-real-locales'));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe.each(cases)('Cindy Make completion actions in $locale', ({ locale, resource }) => {
  it.each([
    { currentId: 'original', personalUpdateAvailable: false, hint: 'readyHint', disabled: false },
    { currentId: 'personal', personalUpdateAvailable: true, hint: 'updateHint', disabled: false },
    { currentId: 'personal', personalUpdateAvailable: false, hint: 'usingHint', disabled: true },
  ] as const)(
    'shows $hint for $currentId and targets the single personal version',
    async ({ currentId, personalUpdateAvailable, hint, disabled }) => {
      const state: CindyVersionsState = {
        currentId,
        selectedId: currentId,
        switching: false,
        personalUpdateAvailable,
        versions: [
          { id: 'original', kind: 'original', available: true, compatible: true },
          { id: 'personal', kind: 'personal', available: true, compatible: true },
        ],
      };
      const meta: CindyMakeCompletionMeta = {
        reportedAt: 123,
        commit: 'a'.repeat(40),
        changedFiles: 2,
        lastAction: 'build',
        personal: { status: 'ready', versionId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' },
      };
      const switchVersion = vi.fn().mockResolvedValue({ ...state, switching: true });
      const testAction = vi.fn().mockResolvedValue(meta);
      vi.stubGlobal('electronAPI', {
        cindyMakeTest: testAction,
        getCindyVersions: async () => state,
        actCindyVersion: switchVersion,
      });
      const i18n = createInstance();
      await i18n.use(initReactI18next).init({
        lng: locale,
        fallbackLng: false,
        defaultNS: 'common',
        resources: { [locale]: { common: resource } },
        interpolation: { escapeValue: false },
      });
      const { container } = render(
        <I18nextProvider i18n={i18n}>
          <CindyMakeTestCard sessionId="session" completionId="completion" meta={meta} />
        </I18nextProvider>,
      );
      const label = disabled
        ? resource.cindyMake.versions.using
        : personalUpdateAvailable
          ? resource.cindyMake.versions.updatePersonal
          : resource.cindyMake.versions.switchPersonal;
      const button = await screen.findByRole('button', { name: label });
      await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(disabled));
      expect(screen.getByText(resource.cindyMake.versions[hint])).toBeTruthy();
      for (const otherHint of ['readyHint', 'updateHint', 'usingHint'] as const) {
        if (otherHint !== hint)
          expect(screen.queryByText(resource.cindyMake.versions[otherHint])).toBeNull();
      }
      expect(container.textContent).not.toMatch(/cindyMake\.|\{\{|\?{2,}|\uFFFD/);
      fireEvent.click(button);
      if (disabled) expect(switchVersion).not.toHaveBeenCalled();
      else
        await waitFor(() =>
          expect(switchVersion).toHaveBeenCalledExactlyOnceWith('switch', 'personal'),
        );
      expect(testAction).toHaveBeenCalledExactlyOnceWith('session', 'completion', 'status');
    },
  );
});
