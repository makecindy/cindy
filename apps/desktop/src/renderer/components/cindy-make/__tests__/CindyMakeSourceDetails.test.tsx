// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { CindyMakeSourceDetails } from '../CindyMakeSourceDetails';
import type {
  MakeSourceLatestVersion,
  MakeSourcePreparation,
} from '../../../../shared/cindyMakeDoctor';
import en from '@/i18n/locales/en/common.json';
import zhCN from '@/i18n/locales/zh-CN/common.json';
import zhTW from '@/i18n/locales/zh-TW/common.json';
import ja from '@/i18n/locales/ja/common.json';
import ko from '@/i18n/locales/ko/common.json';

const source: MakeSourcePreparation = {
  status: 'ready',
  path: 'managed-source',
  branch: 'cindy-personal',
  currentBranch: 'feature/active',
  ref: 'main',
  commit: 'a'.repeat(40),
  baseCommit: 'b'.repeat(40),
  mainCommit: 'c'.repeat(40),
  mainRemoteCommit: 'd'.repeat(40),
  mainBehind: 7,
  mainAhead: 2,
};

const locales = { en, 'zh-CN': zhCN, 'zh-TW': zhTW, ja, ko };
async function show(
  overrides: Partial<MakeSourcePreparation> = {},
  locale: keyof typeof locales = 'zh-CN',
  latestVersion?: MakeSourceLatestVersion,
) {
  const i18n = createInstance();
  await i18n.init({ lng: locale, resources: { [locale]: { translation: locales[locale] } } });
  return render(
    <I18nextProvider i18n={i18n}>
      <CindyMakeSourceDetails source={{ ...source, ...overrides }} latestVersion={latestVersion} />
    </I18nextProvider>,
  );
}

afterEach(cleanup);

describe('Cindy Make source summary', () => {
  it.each([
    [0, 0, '个人版与本地 main 提交一致'],
    [0, 6, '本地 main 领先 6 个提交'],
    [2, 0, '已包含本地 main，另有 2 个个人提交'],
    [2, 6, '本地 main 领先 6 个提交，个人版另有 2 个提交'],
    [undefined, undefined, '暂时无法比较提交，请同步最新源码重试。'],
  ] as const)(
    'summarizes the verified local comparison (%s ahead, %s behind)',
    async (personalAhead, personalBehind, expected) => {
      await show({ personalAhead, personalBehind }, 'zh-CN', {
        status: 'unavailable',
        channel: 'dev',
      });
      expect(screen.getByRole('status').textContent).toBe(expected);
      expect(screen.getByText(source.commit!.slice(0, 12))).toBeTruthy();
      expect(screen.getByText(source.mainCommit!.slice(0, 12))).toBeTruthy();
      expect(screen.queryByText(source.baseCommit!.slice(0, 12))).toBeNull();
      expect(screen.queryByText(source.currentBranch!)).toBeNull();
      expect(screen.queryByText(source.mainRemoteCommit!.slice(0, 12))).toBeNull();
      expect(screen.getByText(/暂未查到/)).toBeTruthy();
    },
  );
  it.each(Object.keys(locales) as (keyof typeof locales)[])(
    'shows live latest main and verified comparison counts in %s',
    async (locale) => {
      const { container } = await show({}, locale, {
        status: 'ready',
        channel: 'dev',
        ref: 'main',
        commit: 'e'.repeat(40),
        ahead: 0,
        behind: 9,
      });
      expect(screen.getByText('e'.repeat(12)).title).toBe('e'.repeat(40));
      expect(screen.getByText(locales[locale].cindyMake.source.details.latest.dev)).toBeTruthy();
      expect(
        screen.getByText(
          locales[locale].cindyMake.overview.localMain +
            ' ' +
            locales[locale].cindyMake.source.details.latest.behind_other.replace('{{count}}', '9'),
        ),
      ).toBeTruthy();
      expect(container.textContent).not.toMatch(/cindyMake\.source|\{\{/);
    },
  );

  it.each(['beta', 'release'] as const)(
    'labels the latest %s tag separately from local main',
    async (channel) => {
      const ref = channel === 'beta' ? 'v2.0.0-beta' : 'v2.0.0';
      await show({}, 'zh-CN', { status: 'ready', channel, ref, commit: 'e'.repeat(40) });
      expect(screen.getByText(zhCN.cindyMake.source.details.latest[channel])).toBeTruthy();
      expect(screen.getByText(ref)).toBeTruthy();
      expect(screen.getByText(source.mainCommit!.slice(0, 12))).toBeTruthy();
      expect(screen.queryByText(/main （落后/)).toBeNull();
    },
  );

  it('shows matching versions without displaying stale cached counts', async () => {
    await show({}, 'zh-CN', {
      status: 'ready',
      channel: 'dev',
      ref: 'main',
      commit: source.mainCommit!,
      ahead: 0,
      behind: 0,
    });
    expect(screen.getByText('本地 main （已同步）')).toBeTruthy();
    expect(screen.queryByText(/main 落后/)).toBeNull();
  });

  it('shows a lookup failure rather than treating cached origin/main as latest', async () => {
    const { container } = await show({}, 'zh-CN', { status: 'unavailable', channel: 'dev' });
    expect(container.textContent).toContain('暂未查到');
    expect(container.textContent).not.toContain(source.mainRemoteCommit!.slice(0, 12));
    expect(screen.getByText(source.mainCommit!.slice(0, 12))).toBeTruthy();
  });

  it.each([
    { ahead: 0, behind: 24, expected: '（落后 24 个提交）' },
    { ahead: 3, behind: 0, expected: '（领先 3 个提交）' },
    { ahead: 2, behind: 7, expected: '（落后 7，领先 2 个提交）' },
  ])(
    'keeps the difference compact without hiding a nonzero side: $expected',
    async ({ ahead, behind, expected }) => {
      await show({}, 'zh-CN', {
        status: 'ready',
        channel: 'dev',
        ref: 'main',
        commit: 'e'.repeat(40),
        ahead,
        behind,
      });
      expect(screen.getByText('本地 main ' + expected)).toBeTruthy();
      expect(screen.queryByText(/(?:落后|领先) 0/)).toBeNull();
    },
  );

  it('uses the singular form for one commit', async () => {
    await show({}, 'en', {
      status: 'ready',
      channel: 'dev',
      ref: 'main',
      commit: 'e'.repeat(40),
      ahead: 0,
      behind: 1,
    });
    expect(screen.getByText('Local main (1 commit behind)')).toBeTruthy();
  });

  it.each(Object.keys(locales) as (keyof typeof locales)[])(
    'shows personal and local main hashes without branch internals in %s',
    async (locale) => {
      const { container } = await show({}, locale);
      expect(
        Array.from(container.querySelectorAll('dt')).map((label) => label.textContent),
      ).toEqual([
        locales[locale].cindyMake.versions.personal,
        locales[locale].cindyMake.overview.localMain,
      ]);
      for (const commit of [source.commit!, source.mainCommit!]) {
        expect(screen.getByText(commit.slice(0, 12)).title).toBe(commit);
      }
      for (const hidden of [
        source.branch!,
        source.currentBranch!,
        source.baseCommit!.slice(0, 12),
        source.mainRemoteCommit!.slice(0, 12),
      ]) {
        expect(container.textContent).not.toContain(hidden);
      }
      expect(container.textContent).not.toMatch(/cindyMake\.source|\{\{/);
    },
  );

  it('keeps personal and upstream comparison counts separate', async () => {
    await show({ personalAhead: 3, personalBehind: 2 }, 'zh-CN', {
      status: 'ready',
      channel: 'dev',
      ref: 'main',
      commit: 'e'.repeat(40),
      ahead: 0,
      behind: 23,
    });
    expect(screen.getByRole('status').textContent).toBe(
      '本地 main 领先 2 个提交，个人版另有 3 个提交',
    );
    const online = screen.getByText('e'.repeat(12)).parentElement!;
    expect(online.textContent).toContain('本地 main （落后 23 个提交）');
    expect(within(online).queryByText(/领先 2/)).toBeNull();
  });

  it('shows unknown counts even when the online hash is available', async () => {
    await show({}, 'zh-CN', {
      status: 'ready',
      channel: 'dev',
      ref: 'main',
      commit: 'e'.repeat(40),
    });
    expect(screen.getByText('本地 main （暂时无法比较提交）')).toBeTruthy();
    expect(screen.queryByText(/已同步/)).toBeNull();
  });

  it('keeps missing local hashes unknown for old snapshots', async () => {
    await show({ mainCommit: undefined, currentBranch: undefined, ref: 'v1.2.3' });
    expect(screen.getByText('本地 main').nextElementSibling?.textContent).toBe('更新源码后查看');
    expect(screen.getByText(source.commit!.slice(0, 12))).toBeTruthy();
    expect(screen.queryByText(source.baseCommit!.slice(0, 12))).toBeNull();
    expect(screen.queryByText(source.mainRemoteCommit!.slice(0, 12))).toBeNull();
    expect(screen.queryByText(/已同步/)).toBeNull();
  });
});
