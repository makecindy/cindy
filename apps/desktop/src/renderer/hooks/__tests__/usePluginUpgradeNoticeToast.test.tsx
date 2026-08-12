// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listener: undefined as (() => void) | undefined,
  secondary: false,
  consume: vi.fn(),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  toastInfo: vi.fn(),
  translate: vi.fn((key: string) => key),
  language: 'en',
  warn: vi.fn(),
}));

vi.mock('@/i18n', () => ({ i18n: { t: mocks.translate, language: mocks.language } }));
vi.mock('@/lib/secondaryWindow', () => ({ isSecondaryWindow: () => mocks.secondary }));
vi.mock('@/lib/toast', () => ({ toast: { info: mocks.toastInfo } }));
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ warn: mocks.warn }) }));

import { usePluginUpgradeNoticeToast } from '../usePluginUpgradeNoticeToast';

describe('usePluginUpgradeNoticeToast', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listener = undefined;
    mocks.secondary = false;
    mocks.consume.mockResolvedValue(null);
    mocks.subscribe.mockImplementation((listener: () => void) => {
      mocks.listener = listener;
      return mocks.unsubscribe;
    });
    (window as unknown as { electronAPI: { pluginMarket: unknown } }).electronAPI = {
      pluginMarket: {
        consumeUpgradeNotice: mocks.consume,
        onUpgradeNoticeAvailable: mocks.subscribe,
      },
    };
  });
  afterEach(() => cleanup());

  it('single notice includes plugin name', async () => {
    mocks.consume.mockResolvedValueOnce({
      count: 1,
      name: 'Team Plugin',
      permissions: null,
      hasPermissionExpansion: false,
    });
    renderHook(() => usePluginUpgradeNoticeToast());
    await waitFor(() => expect(mocks.toastInfo).toHaveBeenCalledTimes(1));
    expect(mocks.translate).toHaveBeenCalledWith('settings.ghosts.market.upgradeNotice.single', {
      name: 'Team Plugin',
    });
  });

  it('multiple notice reports count and consumes push signals', async () => {
    renderHook(() => usePluginUpgradeNoticeToast());
    await waitFor(() => expect(mocks.consume).toHaveBeenCalledTimes(1));
    mocks.consume.mockResolvedValueOnce({
      count: 2,
      name: null,
      permissions: null,
      hasPermissionExpansion: false,
    });
    act(() => mocks.listener?.());
    await waitFor(() => expect(mocks.translate).toHaveBeenCalledWith(
      'settings.ghosts.market.upgradeNotice.multiple',
      { count: 2 },
    ));
  });

  it('single expansion notice translates and names new permissions', async () => {
    mocks.translate.mockImplementation((key: string, args?: Record<string, string>) =>
      args ? `${key}:${JSON.stringify(args)}` : key,
    );
    mocks.consume.mockResolvedValueOnce({
      count: 1,
      name: 'Team Plugin',
      permissions: [
        { key: 'networkHost:api.example.com', labelKey: 'networkHost', labelArgs: { host: 'api.example.com' } },
        { key: 'fs', labelKey: 'fsWrite' },
      ],
      hasPermissionExpansion: true,
    });
    renderHook(() => usePluginUpgradeNoticeToast());
    await waitFor(() => expect(mocks.toastInfo).toHaveBeenCalledTimes(1));
    expect(mocks.translate).toHaveBeenCalledWith('settings.ghosts.perm.networkHost', {
      host: 'api.example.com',
    });
    expect(mocks.translate).toHaveBeenCalledWith(
      'settings.ghosts.market.upgradeNotice.singleWithPermissions',
      expect.objectContaining({
        name: 'Team Plugin',
        permissions: expect.stringContaining(', '),
      }),
    );
  });

  it('multiple expansion notice uses aggregated copy', async () => {
    mocks.consume.mockResolvedValueOnce({
      count: 2,
      name: null,
      permissions: null,
      hasPermissionExpansion: true,
    });
    renderHook(() => usePluginUpgradeNoticeToast());
    await waitFor(() => expect(mocks.toastInfo).toHaveBeenCalledTimes(1));
    expect(mocks.translate).toHaveBeenCalledWith(
      'settings.ghosts.market.upgradeNotice.multipleWithPermissions',
      { count: 2 },
    );
  });
});
