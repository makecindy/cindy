// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  prefill: vi.fn(),
  pluginGetState: vi.fn(),
  pluginSetEnabled: vi.fn(),
  toastError: vi.fn(),
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

vi.mock('@/lib/toast', () => ({
  toast: {
    error: mocks.toastError,
    success: vi.fn(),
    warning: vi.fn(),
  },
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
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      maker: {
        plugins: {
          getState: mocks.pluginGetState,
          setEnabled: mocks.pluginSetEnabled,
        },
      },
    },
  });
  mocks.pluginGetState.mockResolvedValue({
    effectiveEnabled: false,
    productDefaultEnabled: true,
    projectOverride: null,
    userOverride: { enabled: false },
    globalOverride: null,
  });
  mocks.pluginSetEnabled.mockResolvedValue({ codexMcpRefreshed: true });
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

  it('点击后先打开 contacts 插件，再预填并进入新任务页', async () => {
    mocks.stats.mockResolvedValue({ people: 8, orgs: 1, groups: 1, pending: 0 });
    render(<ContactsSection />);

    fireEvent.click(await screen.findByRole('button', { name: 'settings.contacts.guide.cta' }));

    await waitFor(() => expect(mocks.pluginGetState).toHaveBeenCalledWith('contacts'));
    expect(mocks.pluginSetEnabled).toHaveBeenCalledWith('contacts', true);
    expect(mocks.prefill).toHaveBeenCalledWith('settings.contacts.guide.managementPrompt');
    expect(mocks.navigate).toHaveBeenCalledWith('/cc-agent/new');
    expect(mocks.pluginSetEnabled.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.prefill.mock.invocationCallOrder[0]!,
    );
  });

  it('contacts 已随默认值启用时不固化 true override', async () => {
    mocks.pluginGetState.mockResolvedValue({
      effectiveEnabled: true,
      productDefaultEnabled: true,
      projectOverride: null,
      userOverride: null,
      globalOverride: null,
    });
    mocks.stats.mockResolvedValue({ people: 8, orgs: 1, groups: 1, pending: 0 });
    render(<ContactsSection />);

    fireEvent.click(await screen.findByRole('button', { name: 'settings.contacts.guide.cta' }));

    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith('/cc-agent/new'));
    expect(mocks.pluginSetEnabled).not.toHaveBeenCalled();
    expect(mocks.prefill).toHaveBeenCalledWith('settings.contacts.guide.managementPrompt');
  });

  it('contacts 插件打开失败时留在设置页', async () => {
    mocks.pluginSetEnabled.mockRejectedValue(new Error('plugin unavailable'));
    mocks.stats.mockResolvedValue({ people: 8, orgs: 1, groups: 1, pending: 0 });
    render(<ContactsSection />);

    fireEvent.click(await screen.findByRole('button', { name: 'settings.contacts.guide.cta' }));

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalled());
    expect(mocks.prefill).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('功能关闭时隐藏 AI 引导入口', async () => {
    mocks.settingsGet.mockResolvedValue({ enabled: false, isCustomized: true });
    mocks.stats.mockResolvedValue({ people: 8, orgs: 1, groups: 1, pending: 0 });
    render(<ContactsSection />);

    await waitFor(() => expect(mocks.settingsGet).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'settings.contacts.guide.cta' })).toBeNull();
  });
});
