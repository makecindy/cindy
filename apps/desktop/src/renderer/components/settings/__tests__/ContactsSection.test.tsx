// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  prefill: vi.fn(),
  settingsGet: vi.fn(),
  settingsSet: vi.fn(),
  stats: vi.fn(),
  syncStatusGet: vi.fn(),
  syncEnabledSet: vi.fn(),
  syncNow: vi.fn(),
  onChanged: vi.fn(() => () => {}),
  onSyncStatusChanged: vi.fn(() => () => {}),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => mocks.navigate,
}));

vi.mock('@/lib/contactsService', () => ({
  contactsService: {
    settingsGet: mocks.settingsGet,
    settingsSet: mocks.settingsSet,
    stats: mocks.stats,
    syncStatusGet: mocks.syncStatusGet,
    syncEnabledSet: mocks.syncEnabledSet,
    syncNow: mocks.syncNow,
    onChanged: mocks.onChanged,
    onSyncStatusChanged: mocks.onSyncStatusChanged,
  },
  contactsErrorI18nKey: () => 'settings.contacts.ipcError.INTERNAL',
}));

vi.mock('../contacts/ContactsManagerDialog', () => ({
  ContactsManagerDialog: () => null,
}));

vi.mock('../contacts/startContactsAiSession', () => ({
  prefillContactsAiSessionDraft: mocks.prefill,
}));

import { ContactsSection } from '../contacts/ContactsSection';

const syncStatus = {
  available: false,
  enabled: false,
  phase: 'off' as const,
  onlineDeviceCount: 0,
  lastSyncAt: null,
  lastSyncDeviceName: null,
  lastRoute: null,
  errorCode: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.settingsGet.mockResolvedValue({ enabled: true, isCustomized: true });
  mocks.settingsSet.mockResolvedValue({ enabled: true, codexMcpRefreshed: true });
  mocks.syncStatusGet.mockResolvedValue(syncStatus);
  mocks.syncEnabledSet.mockResolvedValue(syncStatus);
  mocks.syncNow.mockResolvedValue(syncStatus);
  mocks.onChanged.mockReturnValue(() => {});
  mocks.onSyncStatusChanged.mockReturnValue(() => {});
});

afterEach(() => cleanup());

describe('ContactsSection AI 管理入口', () => {
  it.each([
    { label: '空库', stats: { people: 0, orgs: 0, groups: 0, pending: 0 } },
    { label: '已有联系人', stats: { people: 12, orgs: 3, groups: 2, pending: 1 } },
  ])('$label 时都常驻同一个入口', async ({ stats }) => {
    mocks.stats.mockResolvedValue(stats);
    render(<ContactsSection />);

    expect(await screen.findByRole('button', { name: 'settings.contacts.guide.cta' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'settings.contacts.guide.cta' })).toHaveLength(1);
    expect(screen.queryByText('settings.contacts.guide.sources.mail')).toBeNull();
    expect(screen.queryByText('settings.contacts.guide.sources.im')).toBeNull();
    expect(screen.queryByText('settings.contacts.guide.sources.import')).toBeNull();
  });

  it('点击后写入统一管理意图并进入新任务页', async () => {
    mocks.stats.mockResolvedValue({ people: 8, orgs: 1, groups: 1, pending: 0 });
    render(<ContactsSection />);

    fireEvent.click(await screen.findByRole('button', { name: 'settings.contacts.guide.cta' }));

    expect(mocks.prefill).toHaveBeenCalledWith('settings.contacts.guide.managementPrompt');
    expect(mocks.navigate).toHaveBeenCalledWith('/cc-agent/new');
  });

  it('功能关闭时不启动拿不到 cindy_contacts 的空任务', async () => {
    mocks.settingsGet.mockResolvedValue({ enabled: false, isCustomized: true });
    mocks.stats.mockResolvedValue({ people: 8, orgs: 1, groups: 1, pending: 0 });
    render(<ContactsSection />);

    await waitFor(() => expect(mocks.settingsGet).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'settings.contacts.guide.cta' })).toBeNull();
  });
});
