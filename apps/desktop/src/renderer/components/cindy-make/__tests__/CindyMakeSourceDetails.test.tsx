// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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
    [0, 0, '与本地 main 的 SHA 相同'],
    [0, 6, '尚缺本地 main 中的 6 条修改记录'],
    [2, 0, '已包含本地 main，个人版源码中另有 2 条修改记录'],
    [2, 6, '尚缺本地 main 中的 6 条修改记录，个人版源码中另有 2 条修改记录'],
    [undefined, undefined, 'SHA 与本地 main 不同，差距未知'],
  ] as const)(
    'summarizes the verified local comparison (%s ahead, %s behind)',
    async (personalAhead, personalBehind, expected) => {
      const commit =
        personalAhead === 0 && personalBehind === 0 ? source.mainCommit : source.commit;
      await show({ commit, personalAhead, personalBehind }, 'zh-CN', {
        status: 'unavailable',
        channel: 'dev',
      });
      expect(screen.getByText(expected)).toBeTruthy();
      expect(screen.getByRole('status').getAttribute('aria-label')).toBe(
        'cindy-personal · 版本状态未确认',
      );
      expect(screen.getByRole('status').className).not.toContain('--status-success');
      expect(screen.queryByTitle(source.commit!)).toBeNull();
      expect(screen.getAllByTitle(source.mainCommit!).length).toBeGreaterThan(0);
      expect(screen.queryByText(source.baseCommit!.slice(0, 12))).toBeNull();
      expect(screen.queryByText(source.currentBranch!)).toBeNull();
      expect(screen.queryByText(source.mainRemoteCommit!.slice(0, 12))).toBeNull();
      expect(screen.getByText('查询失败')).toBeTruthy();
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

  it('collapses matching main hashes into one green value without an arrow or stale counts', async () => {
    await show({}, 'zh-CN', {
      status: 'ready',
      channel: 'dev',
      ref: 'main',
      commit: source.mainCommit!,
      ahead: 0,
      behind: 0,
    });
    const hash = screen.getByTitle(source.mainCommit!);
    expect(hash.className).toContain('--status-success');
    expect(screen.getAllByTitle(source.mainCommit!)).toHaveLength(1);
    expect(screen.getByText('本地 main').className).toContain('--status-success');
    expect(hash.closest('dd')?.querySelector('svg')).toBeNull();
    expect(screen.getByText('与GitHub main 一致，落后 0 条修改记录')).toBeTruthy();
    expect(screen.queryByText(/main 落后/)).toBeNull();
  });

  it.each(Object.keys(locales) as (keyof typeof locales)[])(
    'marks personal changes on top of the latest online version as up to date in %s',
    async (locale) => {
      const { container } = await show({ personalAhead: 1, personalBehind: 0 }, locale, {
        status: 'ready',
        channel: 'dev',
        ref: 'main',
        commit: source.mainCommit!,
      });
      const status = screen.getByRole('status');
      const copy = locales[locale].cindyMake.overview.personalStatus;
      const label = `cindy-personal${copy.suffix.replace('{{status}}', copy.upToDate)}`;
      expect(status.textContent).toBe(label);
      expect(status.getAttribute('aria-label')).toBe(`cindy-personal · ${copy.upToDate}`);
      expect(status.firstElementChild?.tagName.toLowerCase()).toBe('svg');
      expect(status.lastElementChild?.textContent).toBe(label);
      expect(status.className).toContain('--status-success');
      expect(
        screen.getByText(copy.suffix.replace('{{status}}', copy.upToDate).trim()),
      ).toBeTruthy();
      expect(screen.getByText(copy.personalChanges.replace('{{ahead}}', '1'))).toBeTruthy();
      expect(screen.getByText('cindy-personal').closest('dt')).toBe(status.closest('dt'));
      expect(screen.queryByTitle(source.commit!)).toBeNull();
      expect(screen.getByText(copy.personalChanges.replace('{{ahead}}', '1')).closest('dd')).toBe(
        status.closest('dt')?.nextElementSibling,
      );
      expect(container.textContent).not.toMatch(/cindyMake[.]|[{][{]|[?][?]|�/);
      fireEvent.focus(status);
      expect((await screen.findByRole('tooltip')).textContent).toBe(
        `${copy.upToDate} · ${copy.upToDateDescription.replace(
          '{{target}}',
          locales[locale].cindyMake.source.details.latest.dev,
        )}`,
      );
    },
  );

  it.each([
    { personalAhead: 0, personalBehind: 2 },
    { personalAhead: 3, personalBehind: 2 },
  ])('marks missing official updates even with personal changes: %o', async (difference) => {
    await show(difference, 'zh-CN', {
      status: 'ready',
      channel: 'dev',
      ref: 'main',
      commit: source.mainCommit!,
    });
    const status = screen.getByRole('status', { name: 'cindy-personal · 有更新' });
    expect(status.textContent).toBe('cindy-personal（有更新）');
    expect(status.className).toContain('--upgrade-banner-fg');
    expect(status.firstElementChild?.tagName.toLowerCase()).toBe('svg');
    expect(screen.getByText('（有更新）')).toBeTruthy();
    fireEvent.focus(status);
    expect((await screen.findByRole('tooltip')).textContent).toBe('有更新');
  });

  it.each([
    [0, 0, '有更新'],
    [1, 0, '有更新'],
    [4, 1, '有更新'],
    [4, 0, '版本状态未确认'],
  ] as const)(
    'does not mistake an outdated local main for latest (%s ahead, %s behind)',
    async (personalAhead, personalBehind, expected) => {
      await show(
        {
          commit: personalAhead === 0 ? source.mainCommit : source.commit,
          personalAhead,
          personalBehind,
        },
        'zh-CN',
        {
          status: 'ready',
          channel: 'dev',
          ref: 'main',
          commit: 'e'.repeat(40),
          ahead: 0,
          behind: 3,
        },
      );
      expect(screen.getByRole('status').getAttribute('aria-label')).toBe(
        `cindy-personal · ${expected}`,
      );
      expect(screen.getByRole('status').className).not.toContain('--status-success');
    },
  );

  it.each([source.mainCommit, undefined])(
    'recognizes personal matching online directly when local main is %s',
    async (mainCommit) => {
      await show({ mainCommit }, 'zh-CN', {
        status: 'ready',
        channel: 'dev',
        ref: 'main',
        commit: source.commit!,
      });
      expect(screen.getByRole('status', { name: 'cindy-personal · 已是最新' })).toBeTruthy();
      expect(screen.queryByText(/个人修改记录/)).toBeNull();
    },
  );

  it('recognizes a personal branch containing main ahead of the latest release', async () => {
    await show({ personalAhead: 1, personalBehind: 0 }, 'zh-CN', {
      status: 'ready',
      channel: 'release',
      ref: 'v2.0.0',
      commit: 'e'.repeat(40),
      ahead: 3,
      behind: 0,
    });
    const status = screen.getByRole('status', { name: 'cindy-personal · 已是最新' });
    fireEvent.focus(status);
    expect((await screen.findByRole('tooltip')).textContent).toBe(
      '已是最新 · 个人版代码已包含最新正式版的全部更新',
    );
  });

  it('shows a lookup failure rather than treating cached origin/main as latest', async () => {
    const { container } = await show({}, 'zh-CN', { status: 'unavailable', channel: 'dev' });
    expect(container.textContent).toContain('查询失败');
    expect(container.textContent).not.toContain(source.mainRemoteCommit!.slice(0, 12));
    expect(screen.getByText(source.mainCommit!.slice(0, 12))).toBeTruthy();
    expect(screen.getByText('查询失败').closest('[class*="--status-success"]')).toBeNull();
  });

  it.each([
    { ahead: 0, behind: 24, expected: '本地 main 落后 24 条修改记录' },
    { ahead: 3, behind: 0, expected: '本地 main 领先 3 条修改记录' },
    { ahead: 2, behind: 7, expected: '本地 main 落后 7 条修改记录，领先 2 条修改记录' },
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
      expect(screen.getByText(expected).className).not.toContain('--status-success');
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
    expect(screen.getByText('Local main is 1 change record behind')).toBeTruthy();
  });

  it.each(Object.keys(locales) as (keyof typeof locales)[])(
    'keeps local and online main together above personal in %s',
    async (locale) => {
      const { container } = await show({}, locale);
      const labels = container.querySelectorAll('dt');
      expect(labels).toHaveLength(2);
      expect(labels[0].textContent).toBe(locales[locale].cindyMake.overview.localMain);
      expect(within(labels[1]).getByText(locales[locale].cindyMake.overview.personal)).toBeTruthy();
      expect(within(labels[1]).getByRole('status')).toBeTruthy();
      expect(labels[1].parentElement?.className).toContain('items-center');
      expect(labels[1].nextElementSibling?.className).toContain('items-center');
      expect(container.querySelectorAll('dl > div > dd')).toHaveLength(2);
      expect(
        screen.getByText(locales[locale].cindyMake.source.details.latest.dev).closest('dd'),
      ).toBe(screen.getByTitle(source.mainCommit!).closest('dd'));
      expect(screen.getByText(source.mainCommit!.slice(0, 12)).title).toBe(source.mainCommit);
      expect(screen.queryByText(source.commit!.slice(0, 12))).toBeNull();
      expect(screen.getByText('cindy-personal').closest('dt')).toBe(labels[1]);
      expect(screen.queryByText('personal')).toBeNull();
      for (const hidden of [
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
    expect(screen.getByRole('status', { name: 'cindy-personal · 有更新' })).toBeTruthy();
    expect(
      screen.getByText(
        '尚缺本地 main 中的 2 条修改记录，个人版源码中另有 3 条修改记录',
      ),
    ).toBeTruthy();
    const online = screen.getByText('e'.repeat(12)).closest('dd')!;
    expect(online.textContent).toContain('本地 main 落后 23 条修改记录');
    expect(within(online).queryByText(/领先 2/)).toBeNull();
  });

  it('shows unknown counts even when the online hash is available', async () => {
    await show({}, 'zh-CN', {
      status: 'ready',
      channel: 'dev',
      ref: 'main',
      commit: 'e'.repeat(40),
    });
    expect(screen.getByText('本地 main 的差距未读取')).toBeTruthy();
    expect(screen.queryByText(/与线上 main 一致/)).toBeNull();
  });

  it('keeps missing local hashes unknown for old snapshots', async () => {
    await show({ mainCommit: undefined, currentBranch: undefined, ref: 'v1.2.3' });
    expect(screen.getByText('本地 main').nextElementSibling?.firstElementChild?.textContent).toBe(
      '未读取',
    );
    expect(screen.queryByText(source.commit!.slice(0, 12))).toBeNull();
    expect(screen.queryByText(source.baseCommit!.slice(0, 12))).toBeNull();
    expect(screen.queryByText(source.mainRemoteCommit!.slice(0, 12))).toBeNull();
    expect(screen.queryByText(/与线上 main 一致/)).toBeNull();
  });

  it('recognizes matching hashes even without comparison counts', async () => {
    await show({ commit: source.mainCommit }, 'zh-CN', {
      status: 'ready',
      channel: 'dev',
      ref: 'main',
      commit: source.mainCommit!,
    });
    expect(screen.getByRole('status', { name: 'cindy-personal · 已是最新' })).toBeTruthy();
    expect(screen.getByText('与GitHub main 一致，落后 0 条修改记录')).toBeTruthy();
  });

  it('does not claim different hashes match because of inconsistent zero counts', async () => {
    await show({ personalAhead: 0, personalBehind: 0 }, 'zh-CN', {
      status: 'ready',
      channel: 'dev',
      ref: 'main',
      commit: 'e'.repeat(40),
      ahead: 0,
      behind: 0,
    });
    expect(screen.getByRole('status', { name: 'cindy-personal · 版本状态未确认' })).toBeTruthy();
    expect(screen.getByText('SHA 与本地 main 不同，差距未知')).toBeTruthy();
    expect(screen.getByText('本地 main 的差距未读取')).toBeTruthy();
    expect(screen.queryByText(/与线上 main 一致/)).toBeNull();
  });

  it('shows a gray local SHA pointing to the green online SHA on the same row', async () => {
    const { container } = await show({}, 'zh-CN', {
      status: 'ready',
      channel: 'dev',
      ref: 'main',
      commit: 'e'.repeat(40),
      ahead: 0,
      behind: 3,
    });
    const local = screen.getByTitle(source.mainCommit!);
    const online = screen.getByTitle('e'.repeat(40));
    expect(local.closest('[class*="--status-success"]')).toBeNull();
    expect(local.closest('[class*="--text-secondary"]')).not.toBeNull();
    expect(online.closest('[class*="--status-success"]')).not.toBeNull();
    expect(online.closest('dd')).toBe(local.closest('dd'));
    expect(local.closest('dd')?.querySelector('svg')).not.toBeNull();
    expect(container.querySelectorAll('dl > div > dd')).toHaveLength(2);
    expect(screen.getByText('本地 main 落后 3 条修改记录')).toBeTruthy();
  });

  it.each(Object.keys(locales) as (keyof typeof locales)[])(
    'renders translated personal differences without unresolved text in %s',
    async (locale) => {
      const { container } = await show({ personalAhead: 1, personalBehind: 0 }, locale);
      expect(screen.getByRole('status').getAttribute('aria-label')).toBe(
        `cindy-personal · ${locales[locale].cindyMake.overview.personalStatus.unverified}`,
      );
      expect(
        screen.getByText(
          locales[locale].cindyMake.overview.comparison.personalAhead.replace('{{ahead}}', '1'),
        ),
      ).toBeTruthy();
      expect(container.textContent).not.toMatch(/cindyMake\.|\{\{|\?\?|�/);
    },
  );
});
