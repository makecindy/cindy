// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
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
      expect(screen.queryByText(/main 落后/)).toBeNull();
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
    expect(screen.getByText('（已同步）')).toBeTruthy();
    expect(screen.queryByText(/main 落后/)).toBeNull();
  });

  it('shows a lookup failure rather than treating cached origin/main as latest', async () => {
    const { container } = await show({}, 'zh-CN', { status: 'unavailable', channel: 'dev' });
    expect(container.textContent).toContain('未能查询');
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
      expect(screen.getByText(expected)).toBeTruthy();
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
    expect(screen.getByText('(1 commit behind)')).toBeTruthy();
  });

  it.each(Object.keys(locales) as (keyof typeof locales)[])(
    'shows exactly three Git entries with short hashes in %s',
    async (locale) => {
      const { container } = await show({}, locale);
      const terms = locales[locale].cindyMake.source.details;
      expect(
        Array.from(container.querySelectorAll('dt')).map((label) => label.textContent),
      ).toEqual([terms.branch, terms.mainCommit, terms.currentBranch]);
      expect(screen.getByText('cindy-personal')).toBeTruthy();
      expect(screen.getByText('feature/active')).toBeTruthy();
      expect(screen.getByText(terms.baseRef.replace('{{ref}}', 'main'))).toBeTruthy();
      for (const commit of [source.baseCommit!, source.mainCommit!]) {
        const hash = screen.getByText(commit.slice(0, 12));
        expect(hash.className).toContain('font-mono');
        expect(hash.title).toBe(commit);
      }
      for (const hidden of [source.commit!, source.mainRemoteCommit!]) {
        expect(container.textContent).not.toContain(hidden.slice(0, 12));
      }
      expect(container.textContent).not.toMatch(/cindyMake\.source|\{\{/);
    },
  );

  it('shows main without requiring a local main branch or comparison counts', async () => {
    await show({ mainRemoteCommit: undefined, mainBehind: undefined, mainAhead: undefined });
    expect(screen.getByText(source.mainCommit!.slice(0, 12))).toBeTruthy();
    expect(screen.queryByText('更新源码后查看')).toBeNull();
  });

  it('does not substitute stale local main for an unknown fetched main version', async () => {
    await show({ mainCommit: undefined });
    expect(screen.getByText('main 版本').nextElementSibling?.textContent).toBe('更新源码后查看');
    expect(screen.queryByText(source.mainCommit!.slice(0, 12))).toBeNull();
  });

  it('does not use the personal branch or source ref as an unknown current branch', async () => {
    await show({ currentBranch: undefined });
    expect(screen.getByText('当前项目分支').nextElementSibling?.textContent).toBe('更新源码后查看');
    expect(screen.getAllByText('cindy-personal')).toHaveLength(1);
  });

  it('shows detached HEAD as a fixed commit rather than a branch named HEAD', async () => {
    await show({ currentBranch: null });
    expect(screen.getByText('未在分支上（固定提交）')).toBeTruthy();
    expect(screen.queryByText('HEAD')).toBeNull();
  });

  it('supports old snapshots while keeping the available personal baseline', async () => {
    await show({ mainCommit: undefined, mainRemoteCommit: undefined, currentBranch: undefined });
    expect(screen.getByText('cindy-personal')).toBeTruthy();
    expect(screen.getByText(source.baseCommit!.slice(0, 12))).toBeTruthy();
    expect(screen.getAllByText('更新源码后查看')).toHaveLength(2);
  });

  it('keeps a release-tag baseline distinct from main', async () => {
    await show({ ref: 'v1.2.3' });
    expect(screen.getByText('基于 v1.2.3')).toBeTruthy();
    expect(screen.queryByText('基于 main')).toBeNull();
  });
});
