// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { CindyMakeVersionSummary } from '../CindyMakeVersionSummary';
import type {
  MakeSourceLatestVersion,
  MakeSourcePreparation,
} from '../../../../shared/cindyMakeDoctor';
import en from '@/i18n/locales/en/common.json';
import zhCN from '@/i18n/locales/zh-CN/common.json';
import zhTW from '@/i18n/locales/zh-TW/common.json';
import ja from '@/i18n/locales/ja/common.json';
import ko from '@/i18n/locales/ko/common.json';

const MAIN = 'c'.repeat(40);
const source: MakeSourcePreparation = {
  status: 'ready',
  path: 'managed-source',
  branch: 'cindy-personal',
  channel: 'release',
  ref: 'v0.9.3',
  commit: 'a'.repeat(40),
  mainCommit: MAIN,
  personalAhead: 4,
  personalBehind: 0,
};
const latest: MakeSourceLatestVersion = {
  status: 'ready',
  channel: 'release',
  ref: 'v0.9.3',
  commit: MAIN,
  ahead: 0,
  behind: 0,
};

const locales = { en, 'zh-CN': zhCN, 'zh-TW': zhTW, ja, ko };
async function show(
  props: {
    source?: Partial<MakeSourcePreparation>;
    latestVersion?: MakeSourceLatestVersion;
    changes?: number;
  } = {},
  locale: keyof typeof locales = 'zh-CN',
) {
  const i18n = createInstance();
  await i18n.init({
    lng: locale,
    interpolation: { escapeValue: false },
    resources: { [locale]: { translation: locales[locale] } },
  });
  return render(
    <I18nextProvider i18n={i18n}>
      <CindyMakeVersionSummary
        source={{ ...source, ...props.source }}
        latestVersion={'latestVersion' in props ? props.latestVersion : latest}
        changes={props.changes}
      />
    </I18nextProvider>,
  );
}

afterEach(cleanup);

describe('Cindy Make version summary', () => {
  it('describes the personal version in plain words without hashes or branches', async () => {
    const { container } = await show({ changes: 3 });
    expect(screen.getByText('官方 v0.9.3 ＋ 你的 3 项修改')).toBeTruthy();
    expect(screen.getByText('正式版 v0.9.3')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('个人版已包含');
    expect(screen.getByRole('status').className).toContain('--status-success');
    const text = container.textContent ?? '';
    for (const technical of ['cindy-personal', 'main', MAIN.slice(0, 12), 'SHA'])
      expect(text).not.toContain(technical);
  });

  it('says when an official release is not in the personal version yet', async () => {
    await show({
      source: { mainCommit: 'b'.repeat(40), personalAhead: 2, personalBehind: 0 },
      latestVersion: { ...latest, ref: 'v0.9.4', ahead: 0, behind: 5 },
    });
    expect(screen.getByText('正式版 v0.9.4')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('个人版还没包含');
    expect(screen.getByRole('status').className).toContain('--upgrade-banner-fg');
  });

  it.each([
    [{ changes: 0, source: { personalAhead: 0 } }, '官方 v0.9.3，还没有你的修改'],
    // Changes made on another computer are not in this computer's history.
    [{ changes: 0 }, '官方 v0.9.3 ＋ 你的修改'],
    [{ source: { channel: 'dev' as const, ref: 'main' } }, '官方开发中的版本 ＋ 你的修改'],
  ])('names the basis of the personal version (%o)', async (props, expected) => {
    await show(props);
    expect(screen.getByText(expected)).toBeTruthy();
  });

  it('never claims the version is included when the lookup failed', async () => {
    await show({ latestVersion: { status: 'unavailable', channel: 'release' } });
    expect(screen.getByText('暂时查不到')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('还不能确认个人版是否已包含');
    expect(screen.getByRole('status').className).not.toContain('--status-success');
  });

  it.each(Object.keys(locales) as (keyof typeof locales)[])(
    'renders complete copy in %s',
    async (locale) => {
      const { container } = await show({ changes: 1 }, locale);
      expect(container.textContent).not.toMatch(/cindyMake\.|\{\{/);
    },
  );
});
