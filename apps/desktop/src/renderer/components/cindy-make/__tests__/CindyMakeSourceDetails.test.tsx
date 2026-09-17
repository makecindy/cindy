// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { CindyMakeSourceDetails } from '../CindyMakeSourceDetails';
import type { MakeSourcePreparation } from '../../../../shared/cindyMakeDoctor';
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
) {
  const i18n = createInstance();
  await i18n.init({ lng: locale, resources: { [locale]: { translation: locales[locale] } } });
  return render(
    <I18nextProvider i18n={i18n}>
      <CindyMakeSourceDetails source={{ ...source, ...overrides }} />
    </I18nextProvider>,
  );
}

afterEach(cleanup);

describe('Cindy Make source summary', () => {
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
        expect(hash.className).toContain('break-all');
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
