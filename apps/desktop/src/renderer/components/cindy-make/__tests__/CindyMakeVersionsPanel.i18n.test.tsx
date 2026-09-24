// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInstance } from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import en from '@/i18n/locales/en/common.json';
import zhCN from '@/i18n/locales/zh-CN/common.json';
import zhTW from '@/i18n/locales/zh-TW/common.json';
import ja from '@/i18n/locales/ja/common.json';
import ko from '@/i18n/locales/ko/common.json';
import type { CindyVersionsState } from '../../../../shared/cindyVersions';
import { CindyMakeVersionsPanel } from '../CindyMakeVersionsPanel';

vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: async () => false }),
}));

const cases = [
  {
    locale: 'en',
    resource: en,
    title: 'My Versions',
    switchLabel: 'Switch and Restart',
    remove: 'Delete Version',
    update: 'Restart to Update',
  },
  {
    locale: 'zh-CN',
    resource: zhCN,
    title: '我的版本',
    switchLabel: '切换并重启',
    remove: '删除版本',
    update: '重启更新',
  },
  {
    locale: 'zh-TW',
    resource: zhTW,
    title: '我的版本',
    switchLabel: '切換並重新啟動',
    remove: '刪除版本',
    update: '重新啟動以更新',
  },
  {
    locale: 'ja',
    resource: ja,
    title: 'マイバージョン',
    switchLabel: '切り替えて再起動',
    remove: 'バージョンを削除',
    update: '再起動して更新',
  },
  {
    locale: 'ko',
    resource: ko,
    title: '내 버전',
    switchLabel: '전환 후 다시 시작',
    remove: '버전 삭제',
    update: '다시 시작하여 업데이트',
  },
];

beforeEach(() => {
  setDataOwnerGeneration('versions-real-locales');
  const state: CindyVersionsState = {
    currentId: 'original',
    selectedId: 'original',
    switching: false,
    versions: [
      { id: 'original', kind: 'original', available: true, compatible: true },
      { id: 'personal', kind: 'personal', available: true, compatible: true },
    ],
  };
  vi.stubGlobal('electronAPI', {
    getCindyVersions: async () => state,
    actCindyVersion: async () => state,
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Cindy Make versions with real translations', () => {
  it.each(cases)(
    'renders the personal update action in $locale',
    async ({ locale, resource, update }) => {
      const state: CindyVersionsState = {
        currentId: 'personal',
        selectedId: 'personal',
        switching: false,
        personalUpdateAvailable: true,
        versions: [
          { id: 'original', kind: 'original', available: true, compatible: true },
          {
            id: 'personal',
            kind: 'personal',
            title: 'Legacy task title',
            available: true,
            compatible: true,
          },
        ],
      };
      vi.stubGlobal('electronAPI', {
        getCindyVersions: async () => state,
        actCindyVersion: async () => state,
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
          <CindyMakeVersionsPanel />
        </I18nextProvider>,
      );
      expect(await screen.findByRole('button', { name: update })).toBeTruthy();
      expect(screen.getAllByText(resource.cindyMake.versions.personal)).toHaveLength(1);
      expect(screen.queryByText('Legacy task title')).toBeNull();
      expect(container.textContent).not.toMatch(/cindyMake\.|\{\{|\?{2,}|\uFFFD/);
    },
  );
  it.each(cases)(
    'renders $locale labels without missing translations or damaged characters',
    async ({ locale, resource, switchLabel, remove }) => {
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
          <CindyMakeVersionsPanel />
        </I18nextProvider>,
      );
      fireEvent.click(
        await screen.findByRole('button', { name: resource.cindyMake.overview.switchVersion }),
      );
      expect(await screen.findByRole('button', { name: switchLabel })).toBeTruthy();
      expect(screen.getByRole('region', { name: resource.cindyMake.overview.title })).toBeTruthy();
      expect(screen.getByRole('button', { name: remove })).toBeTruthy();
      expect(screen.getByText(resource.cindyMake.versions.personal)).toBeTruthy();
      expect(container.textContent).not.toMatch(/cindyMake\.|\{\{|\?{2,}|\uFFFD/);
    },
  );
});
