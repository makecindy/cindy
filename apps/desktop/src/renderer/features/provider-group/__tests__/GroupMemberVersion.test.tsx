// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { afterEach, describe, expect, it } from 'vitest';

import en from '@/i18n/locales/en/common.json';
import ja from '@/i18n/locales/ja/common.json';
import ko from '@/i18n/locales/ko/common.json';
import zhCN from '@/i18n/locales/zh-CN/common.json';
import zhTW from '@/i18n/locales/zh-TW/common.json';

import type { ProviderGroupMemberStatus } from '../../../../shared/providerGroup';
import { GroupMemberDetailsButton, GroupMemberVersion } from '../GroupMemberVersion';

const catalogs = { en, ja, ko, 'zh-CN': zhCN, 'zh-TW': zhTW };
const status: ProviderGroupMemberStatus = {
  key: 'local', kind: 'local', label: 'Computer', state: 'available', running: 0, limit: 4, weight: 1, paused: false,
  appVersion: '0.1.103', guestSupport: 'needs-update',
};
afterEach(cleanup);

describe('group member version translations', () => {
  it.each([
    ['en', 'Update needed'],
    ['ja', '更新が必要'],
    ['ko', '업데이트 필요'],
    ['zh-CN', '需要更新'],
    ['zh-TW', '需要更新'],
  ] as const)('keeps %s rows compact and makes the full diagnosis available on focus', async (lang, warning) => {
    const i18n = createInstance();
    await i18n.init({ lng: lang, fallbackLng: false, resources: { [lang]: { translation: catalogs[lang] } } });
    const element = (value: ProviderGroupMemberStatus) => (
      <I18nextProvider i18n={i18n}>
        <GroupMemberDetailsButton status={value}>Computer <GroupMemberVersion status={value} /></GroupMemberDetailsButton>
      </I18nextProvider>
    );
    const { rerender } = render(element(status));
    expect(screen.getByText('v0.1.103')).toBeTruthy();
    expect(screen.getByText(warning)).toBeTruthy();
    expect(document.body.textContent).not.toContain('???');
    const row = screen.getByRole('button');
    expect(row.textContent).not.toContain(catalogs[lang].providerGroup.member.version.needsUpdate);
    act(() => row.focus());
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip.textContent).toContain(catalogs[lang].providerGroup.member.version.needsUpdate);
    rerender(element({ ...status, appVersion: undefined, guestSupport: undefined }));
    expect(row.textContent?.trim()).toBe('Computer');
    expect(tooltip.textContent).toContain(catalogs[lang].providerGroup.member.version.unknown);
    expect(tooltip.textContent).toContain(catalogs[lang].providerGroup.member.version.supportUnknown);
  });
});
