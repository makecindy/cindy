// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInstance } from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { MemoryRouter } from 'react-router-dom';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import en from '@/i18n/locales/en/common.json';
import zhCN from '@/i18n/locales/zh-CN/common.json';
import zhTW from '@/i18n/locales/zh-TW/common.json';
import ja from '@/i18n/locales/ja/common.json';
import ko from '@/i18n/locales/ko/common.json';
import type { CindyMakeHistoryState } from '../../../../shared/cindyMakeHistory';
import { CindyMakeHistoryPanel } from '../CindyMakeHistoryPanel';
import { CindyMakeVersionsPanel } from '../CindyMakeVersionsPanel';
import { CindyMakeMergeNotice } from '../CindyMakeMergeNotice';

const h = vi.hoisted(() => ({ make: {} }));
vi.mock('@/lib/cindyMakeState', () => ({ useCindyMakeState: () => h.make }));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: async () => false }),
}));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn() } }));

const cases = [
  {
    locale: 'en',
    resource: en,
    title: 'Make history',
    build: 'Generate personal version',
    integrate: 'Integrate into personal version',
    counts: '1 total · 1 pending integration · 0 integrated',
    script: /[a-z]/i,
  },
  {
    locale: 'zh-CN',
    resource: zhCN,
    title: '制作历史',
    build: '生成个人版',
    integrate: '合入个人版',
    counts: '共 1 次 · 待合入 1 次 · 已合入 0 次',
    script: /\p{Script=Han}/u,
  },
  {
    locale: 'zh-TW',
    resource: zhTW,
    title: '製作歷史',
    build: '產生個人版',
    integrate: '合入個人版',
    counts: '共 1 次 · 待合入 1 次 · 已合入 0 次',
    script: /\p{Script=Han}/u,
  },
  {
    locale: 'ja',
    resource: ja,
    title: '制作履歴',
    build: '個人版を生成',
    integrate: '個人版に取り込む',
    counts: '合計 1 件 · 未取り込み 1 件 · 取り込み済み 0 件',
    script: /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u,
  },
  {
    locale: 'ko',
    resource: ko,
    title: '제작 기록',
    build: '개인 버전 생성',
    integrate: '개인 버전에 반영',
    counts: '전체 1회 · 반영 대기 1회 · 반영 완료 0회',
    script: /\p{Script=Hangul}/u,
  },
];

function strings(value: Record<string, unknown>, prefix = ''): Array<[string, string]> {
  return Object.entries(value).flatMap(([key, child]) =>
    typeof child === 'string'
      ? [[prefix + key, child] as [string, string]]
      : strings(child as Record<string, unknown>, prefix + key + '.'),
  );
}

beforeEach(() => {
  setDataOwnerGeneration('history-real-locales');
  const state: CindyMakeHistoryState = {
    busy: false,
    canBuild: true,
    items: [
      {
        schema: 1,
        runId: 'aaaa',
        sessionId: 'task-a',
        title: 'Example make',
        request: 'Example request',
        createdAt: 1,
        updatedAt: 2,
        completions: [],
        receipts: [],
        versions: [],
        lifecycle: 'ready',
        integration: 'unintegrated',
        actions: ['continue', 'test', 'integrate', 'end'],
      },
    ],
  };
  vi.stubGlobal('electronAPI', { getCindyMakeHistory: async () => state });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Cindy Make history with real translations', () => {
  it.each(cases)(
    'shows the live test stage and useful failure text in $locale',
    async ({ locale, resource }) => {
      const state = await window.electronAPI.getCindyMakeHistory();
      state.busy = true;
      state.canBuild = false;
      state.build = { status: 'checking', checkStep: 'tests', buildId: 'build-1' };
      const i18n = createInstance();
      await i18n.use(initReactI18next).init({
        lng: locale,
        fallbackLng: false,
        defaultNS: 'common',
        resources: { [locale]: { common: resource } },
      });
      const view = render(
        <MemoryRouter>
          <I18nextProvider i18n={i18n}>
            <CindyMakeHistoryPanel />
          </I18nextProvider>
        </MemoryRouter>,
      );
      expect(await screen.findByText(resource.cindyMake.personal.checkStep.tests)).toBeTruthy();
      expect(screen.getByRole('button', { name: resource.cindyMake.history.stop })).toBeTruthy();
      state.build = { status: 'failed', error: 'checksFailed' };
      state.busy = false;
      state.canBuild = true;
      fireEvent(window, new Event('focus'));
      expect(await screen.findByText(resource.cindyMake.personal.errors.checksFailed)).toBeTruthy();
      expect(view.container.textContent).not.toMatch(/cindyMake\.|\{\{|\?{2,}|\uFFFD/);
    },
  );
  it.each(cases)(
    'renders $locale copy instead of translation keys or encoding placeholders',
    async ({ locale, resource, title, build, integrate, counts, script }) => {
      const i18n = createInstance();
      await i18n.use(initReactI18next).init({
        lng: locale,
        fallbackLng: false,
        defaultNS: 'common',
        resources: { [locale]: { common: resource } },
        interpolation: { escapeValue: false },
      });
      render(
        <MemoryRouter>
          <I18nextProvider i18n={i18n}>
            <CindyMakeHistoryPanel />
          </I18nextProvider>
        </MemoryRouter>,
      );
      expect(await screen.findByRole('heading', { name: title + ' · 1' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: build })).toBeNull();
      expect(screen.getByRole('button', { name: integrate })).toBeTruthy();
      expect(screen.getByText(counts)).toBeTruthy();
      for (const [key, value] of strings({
        history: resource.cindyMake.history,
        checkStep: resource.cindyMake.personal.checkStep,
        merge: resource.cindyMake.merge,
        tabs: resource.settings.cindyMake.tabs,
        localChanges: resource.cindyMake.versions.localChanges,
      })) {
        expect(value, locale + ':' + key).not.toMatch(/\?{2,}|\uFFFD/);
        expect(value.replace(/\{\{[^}]+\}\}/g, ''), locale + ':' + key).toMatch(script);
      }
    },
  );

  it.each(cases)(
    'renders ended builds, local changes and conflicts in $locale',
    async ({ locale, resource }) => {
      const state = await window.electronAPI.getCindyMakeHistory();
      state.items[0].lifecycle = 'ended';
      state.items[0].build = { status: 'failed' };
      state.items[0].actions = ['build'];
      state.items[0].completions = [{ id: 'round-a', reportedAt: 1, changedFiles: 2 }];
      vi.stubGlobal('electronAPI', {
        getCindyMakeHistory: async () => state,
        getCindyVersions: async () => ({
          currentId: 'original',
          selectedId: 'original',
          switching: false,
          versions: [
            {
              id: 'original',
              kind: 'original',
              development: true,
              dirty: true,
              available: true,
              compatible: true,
            },
          ],
        }),
      });
      const missing: string[] = [];
      const i18n = createInstance();
      await i18n.use(initReactI18next).init({
        lng: locale,
        fallbackLng: false,
        defaultNS: 'common',
        resources: { [locale]: { common: resource } },
        interpolation: { escapeValue: false },
        saveMissing: true,
        missingKeyHandler: (_languages, _namespace, key) => {
          missing.push(key);
        },
      });
      const view = render(
        <MemoryRouter>
          <I18nextProvider i18n={i18n}>
            <CindyMakeVersionsPanel />
            <CindyMakeHistoryPanel />
            <CindyMakeMergeNotice
              state={{
                id: 'merge',
                status: 'conflict',
                error: 'checksFailed',
                ref: 'main',
                upstreamCommit: 'a'.repeat(40),
                hasWorkspace: true,
              }}
            />
          </I18nextProvider>
        </MemoryRouter>,
      );
      expect(
        await screen.findByRole('button', { name: resource.cindyMake.history.actions.retryBuild }),
      ).toBeTruthy();
      expect(
        await screen.findByText(
          resource.cindyMake.versions.development +
            ' · ' +
            resource.cindyMake.versions.localChanges,
        ),
      ).toBeTruthy();
      expect(screen.getByText(resource.cindyMake.history.buildStatus.failed)).toBeTruthy();
      expect(
        screen.getByText(i18n.t('cindyMake.history.files', { count: 2 }), { exact: false }),
      ).toBeTruthy();
      expect(screen.getByRole('button', { name: resource.cindyMake.merge.resolve })).toBeTruthy();
      expect(i18n.t('settings.cindyMake.tabs.versions')).toBe(
        resource.settings.cindyMake.tabs.versions,
      );
      expect(i18n.t('settings.cindyMake.tabs.environment')).toBe(
        resource.settings.cindyMake.tabs.environment,
      );
      expect(view.container.textContent).not.toMatch(/cindyMake\.|\{\{|\?{2,}|\uFFFD/);
      expect(missing).toEqual([]);
    },
  );
});
