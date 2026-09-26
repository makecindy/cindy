// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

const h = vi.hoisted(() => ({ make: {}, error: vi.fn(), success: vi.fn() }));
vi.mock('@/lib/cindyMakeState', () => ({ useCindyMakeState: () => h.make }));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: async () => false }),
}));
vi.mock('@/lib/toast', () => ({ toast: { error: h.error, success: h.success } }));

const cases = [
  {
    locale: 'en',
    resource: en,
    title: 'Make history · Tasks: 1',
    conflict: 'Resolving conflicts…',
    build: 'Rebuild personal version',
    integrate: 'Integrate into personal version',
    counts: '1 make tasks · 1 pending integration · 0 integrated',
    script: /[a-z]/i,
  },
  {
    locale: 'zh-CN',
    resource: zhCN,
    title: '制作历史 · 1 个任务',
    conflict: '正在处理冲突…',
    build: '重新生成个人版',
    integrate: '合入个人版',
    counts: '共 1 个制作任务 · 待合入 1 个 · 已合入 0 个',
    script: /\p{Script=Han}/u,
  },
  {
    locale: 'zh-TW',
    resource: zhTW,
    title: '製作歷史 · 1 個任務',
    conflict: '正在處理衝突…',
    build: '重新產生個人版',
    integrate: '合入個人版',
    counts: '共 1 個製作任務 · 待合入 1 個 · 已合入 0 個',
    script: /\p{Script=Han}/u,
  },
  {
    locale: 'ja',
    resource: ja,
    title: '制作履歴 · 1 件のタスク',
    conflict: '競合を解決中…',
    build: '個人版を再生成',
    integrate: '個人版に取り込む',
    counts: '制作タスク 1 件 · 取り込み待ち 1 件 · 取り込み済み 0 件',
    script: /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u,
  },
  {
    locale: 'ko',
    resource: ko,
    title: '제작 기록 · 작업 1개',
    conflict: '충돌 해결 중…',
    build: '개인 버전 다시 생성',
    integrate: '개인 버전에 반영',
    counts: '제작 작업 1개 · 반영 대기 1개 · 반영 완료 0개',
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
  h.error.mockClear();
  h.success.mockClear();
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
        actions: ['continue', 'test', 'integrate', 'end', 'build'],
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
    'shows conflict resolution, cleanup and automatic continuation in $locale',
    async ({ locale, resource, conflict }) => {
      const state = await window.electronAPI.getCindyMakeHistory();
      state.busy = true;
      state.canBuild = false;
      state.batch = { current: 1, total: 1, runId: 'aaaa', title: 'Example make' };
      state.items[0].conflict = true;
      state.items[0].actions = ['open'];
      state.build = {
        status: 'merging',
        mergeStep: 'conflicts',
        buildId: 'build-1',
        logs: [{ step: 'resolving-conflicts', at: 1 }],
      };
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
            <CindyMakeHistoryPanel hasPersonalVersion />
          </I18nextProvider>
        </MemoryRouter>,
      );
      expect((await screen.findAllByText(conflict)).length).toBeGreaterThan(1);
      expect(view.container.querySelector('[aria-current="step"]')?.textContent).toBe(
        resource.cindyMake.personal.buildLog.steps['resolving-conflicts'],
      );
      expect(screen.queryByRole('alert')).toBeNull();
      state.items[0].conflict = false;
      state.build = {
        ...state.build,
        mergeStep: 'cleanup',
        logs: [...state.build.logs!, { step: 'cleaning-merge', at: 2 }],
      };
      fireEvent(window, new Event('focus'));
      await waitFor(() =>
        expect(view.container.querySelector('[aria-current="step"]')?.textContent).toBe(
          resource.cindyMake.personal.buildLog.steps['cleaning-merge'],
        ),
      );
      state.build = {
        status: 'checking',
        checkStep: 'tests',
        buildId: 'build-1',
        logs: state.build.logs,
      };
      fireEvent(window, new Event('focus'));
      await screen.findAllByText(resource.cindyMake.personal.checkStep.tests);
      expect(view.container.querySelector('[aria-current="step"]')?.textContent).toBe(
        resource.cindyMake.history.progress.checking,
      );
      expect(screen.queryByRole('alert')).toBeNull();
      expect(view.container.textContent).not.toMatch(/cindyMake\.|\?{2,}|\uFFFD/);
    },
  );
  it.each(cases)(
    'shows the live test stage and useful failure text in $locale',
    async ({ locale, resource }) => {
      const state = await window.electronAPI.getCindyMakeHistory();
      state.busy = true;
      state.canBuild = false;
      state.build = {
        status: 'checking',
        checkStep: 'tests',
        buildId: 'build-1',
        outputLine: 'Test Files 57 passed; token=fake-secret',
      };
      vi.stubGlobal('electronAPI', { getCindyMakeHistory: async () => structuredClone(state) });
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
            <CindyMakeHistoryPanel hasPersonalVersion />
          </I18nextProvider>
        </MemoryRouter>,
      );
      expect(await screen.findByText(resource.cindyMake.personal.checkStep.tests)).toBeTruthy();
      expect(screen.getByText('Test Files 57 passed; token=[REDACTED]').getAttribute('role')).toBe(
        'status',
      );
      expect(screen.queryByRole('button', { name: resource.cindyMake.merge.openTask })).toBeNull();
      expect(view.container.textContent).not.toContain('fake-secret');
      expect(screen.getByRole('button', { name: resource.cindyMake.history.stop })).toBeTruthy();
      state.busy = false;
      state.canBuild = true;
      for (const error of ['checksFailed', 'cleanupFailed'] as const) {
        if (error === 'cleanupFailed') {
          state.build = { status: 'checking', buildId: 'build-2', checkStep: 'tests' };
          fireEvent(window, new Event('focus'));
          await screen.findAllByText(resource.cindyMake.personal.checkStep.tests);
        }
        state.build = { status: 'failed', error };
        fireEvent(window, new Event('focus'));
        await waitFor(() =>
          expect(h.error).toHaveBeenCalledWith(resource.cindyMake.personal.errors[error]),
        );
        expect(await screen.findByText(resource.cindyMake.personal.errors[error])).toBeTruthy();
        expect(screen.queryByText('Test Files 57 passed; token=[REDACTED]')).toBeNull();
        expect(view.container.textContent).not.toMatch(/cindyMake\.|\{\{|\?{2,}|\uFFFD/);
      }
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
            <CindyMakeHistoryPanel hasPersonalVersion />
          </I18nextProvider>
        </MemoryRouter>,
      );
      expect(await screen.findByRole('heading', { name: title })).toBeTruthy();
      expect(screen.getByRole('button', { name: build })).toBeTruthy();
      expect(screen.queryByRole('button', { name: integrate })).toBeNull();
      expect(screen.getByText(counts)).toBeTruthy();
      for (const [key, value] of strings({
        history: resource.cindyMake.history,
        checkStep: resource.cindyMake.personal.checkStep,
        personalErrors: resource.cindyMake.personal.errors,
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
      state.items[0].completions = [
        { id: 'round-a', reportedAt: 1, changedFiles: 2 },
        { id: 'round-b', reportedAt: 60_001, changedFiles: 3 },
      ];
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
            <CindyMakeHistoryPanel hasPersonalVersion />
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
        await screen.findByRole('button', { name: resource.cindyMake.history.regeneratePersonal }),
      ).toBeTruthy();
      expect(
        await screen.findByText(
          resource.cindyMake.versions.development +
            ' · ' +
            resource.cindyMake.versions.localChanges,
        ),
      ).toBeTruthy();
      expect(screen.getAllByText(resource.cindyMake.personal.status.failed)).toHaveLength(2);
      expect(
        screen.getByText(i18n.t('cindyMake.history.files', { count: 2 }), { exact: false }),
      ).toBeTruthy();
      const rounds = Array.from(view.container.querySelectorAll('ol > li'));
      const date = (value: number) =>
        new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(value);
      expect(rounds.map((round) => round.textContent)).toEqual([
        i18n.t('cindyMake.history.round', { number: 2, time: date(60_001) }) +
          ' · ' +
          i18n.t('cindyMake.history.files', { count: 3 }),
        i18n.t('cindyMake.history.round', { number: 1, time: date(1) }) +
          ' · ' +
          i18n.t('cindyMake.history.files', { count: 2 }),
      ]);
      expect(state.items[0].completions.map((completion) => completion.id)).toEqual([
        'round-a',
        'round-b',
      ]);
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
