// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { afterAll, beforeAll, afterEach, describe, expect, it, vi } from 'vitest';

import zhCN from '@/i18n/locales/zh-CN/common.json';
import zhTW from '@/i18n/locales/zh-TW/common.json';
import en from '@/i18n/locales/en/common.json';
import ja from '@/i18n/locales/ja/common.json';
import ko from '@/i18n/locales/ko/common.json';

vi.mock('../botStore', () => ({ useBotProfiles: () => [], useBotUnreadCounts: () => ({}) }));
vi.mock('../useRemoteBots', () => ({ useRemoteBots: () => [] }));
vi.mock('@/features/device-link/useDeviceLinkDeviceList', () => ({
  useDeviceLinkDeviceList: () => [],
}));

import { CindyDevicePicker } from '../CindyDevicePicker';
import { CindyDeviceRow } from '../CindyDeviceRow';
import { cindyDeviceOptions } from '../cindyDeviceRoster';
import type { BotProfile } from '../botStore';

const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
beforeAll(() => { HTMLElement.prototype.scrollIntoView = vi.fn(); });
afterAll(() => { HTMLElement.prototype.scrollIntoView = originalScrollIntoView; });

afterEach(cleanup);

it.each([true, false])(
  'keeps the sidebar device picker on its row surface (selected=%s)',
  async (selected) => {
    const i18n = createInstance();
    await i18n.init({ lng: 'en', resources: { en: { translation: en } } });
    const options = cindyDeviceOptions(
      [{ id: 'cindy-default', name: 'Cindy', status: 'active' } as BotProfile],
      [],
      [],
      {},
      'This Device',
    );
    render(
      <I18nextProvider i18n={i18n}>
        <CindyDeviceRow
          current={options[0]}
          options={options}
          selected={selected}
          subtitle="Ready"
          timestamp="12:00"
          onOpen={vi.fn()}
          onSelect={vi.fn()}
        />
      </I18nextProvider>,
    );
    const trigger = screen.getByRole('combobox');
    expect(trigger.className).toContain('text-inherit');
    expect(trigger.className).toContain('[--button-face-bg:transparent]');
    expect(trigger.className).toContain('[--button-face-border:transparent]');
    expect(trigger.className).not.toContain('[--button-face-bg:var(--surface-elevated)]');
    expect(trigger.className).not.toContain('text-[var(--text-primary)]');
    expect(trigger.className).not.toContain(
      'hover:[--button-face-bg:var(--button-secondary-hover)]',
    );
    expect(trigger.className).toContain(
      selected
        ? 'hover:[--button-face-bg:color-mix(in_srgb,currentColor_10%,transparent)]'
        : 'hover:[--button-face-bg:var(--sidebar-item-hover)]',
    );
  },
);

describe('Cindy device menu with real translations', () => {
  it.each([
    ['zh-CN', zhCN, '本机'],
    ['zh-TW', zhTW, '本機'],
    ['en', en, 'This Device'],
    ['ja', ja, 'この端末'],
    ['ko', ko, '이 기기'],
  ] as const)('renders usable %s labels and keyboard switching', async (lng, common, label) => {
    const i18n = createInstance();
    await i18n.init({
      lng,
      fallbackLng: false,
      resources: { [lng]: { translation: common } },
      interpolation: { escapeValue: false },
    });
    const options = cindyDeviceOptions(
      [{ id: 'cindy-default', name: 'Cindy', status: 'active' } as BotProfile],
      [
        {
          id: 'cindy-default',
          deviceId: 'remote',
          deviceName: 'Mac mini',
          name: 'Cindy',
          avatar: '',
          avatarColor: '',
          description: '',
          preview: '',
          activityAt: 0,
          sessionId: 'remote-chat',
          online: false,
          lastReplyAt: 20,
          readAt: 10,
        },
      ],
      [],
      {},
      i18n.t('bots.devicePicker.local'),
    );
    const onSelect = vi.fn();
    render(
      <I18nextProvider i18n={i18n}>
        <CindyDevicePicker options={options} current={options[0]} onSelect={onSelect} />
      </I18nextProvider>,
    );
    expect(screen.getByRole('combobox').textContent).toContain(label);
    expect(screen.getByRole('combobox').textContent).not.toMatch(/[?]{2,}|bots[.]/);
    expect(screen.getByLabelText(common.bots.devicePicker.otherUnread)).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' });
    const remote = await screen.findByRole('option', { name: /Mac mini/ });
    expect(screen.getByRole('listbox')).toBeTruthy();
    expect(screen.queryByText(common.bots.devicePicker.title)).toBeNull();
    expect(screen.queryByText(common.bots.remote.online)).toBeNull();
    expect(remote.textContent).toContain(common.bots.remote.offline);
    expect(remote.hasAttribute('data-disabled')).toBe(false);
    expect(
      screen.getByRole('option', { name: new RegExp(label) }).getAttribute('aria-selected'),
    ).toBe('true');
    fireEvent.click(remote);
    expect(onSelect).toHaveBeenCalledWith(options[1]);
  });
});
