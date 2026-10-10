// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderView } from '@cindy/model-providers';

const { refreshModels, toastError } = vi.hoisted(() => ({
  refreshModels: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'zh-CN' } }),
}));
vi.mock('@/lib/toast', () => ({ toast: { error: toastError, success: vi.fn() } }));
vi.mock('@/lib/customProviders', () => ({
  createCustomProvider: vi.fn(),
  deleteCustomProvider: vi.fn(),
}));
vi.mock('@/lib/providerModels', () => ({ providerMonogram: () => 'C' }));

import { AddProviderWizard } from '@/components/settings/AddProviderWizard';

const cursor: ProviderView = {
  id: 'cursor',
  name: 'Cursor',
  source: 'builtin',
  agents: ['cursor'],
  auth: { method: 'none' },
  access: { kind: 'subscription', product: 'Cursor' },
  routing: {},
  models: { cursor: [] },
  connected: false,
};

function renderWizard(entry = false, provider = cursor) {
  const onDone = vi.fn();
  render(
    <AddProviderWizard
      providers={[provider]}
      entry={entry ? { kind: 'builtin', providerId: 'cursor' } : undefined}
      onDone={onDone}
      onClose={vi.fn()}
      onOpenCustomForm={vi.fn()}
    />,
  );
  return { onDone };
}

beforeEach(() => {
  refreshModels.mockReset().mockResolvedValue({ ok: true, providerId: 'cursor' });
  window.electronAPI = {
    platform: 'darwin',
    openExternal: vi.fn(async () => undefined),
    maker: {
      listProviderPresets: vi.fn(async () => ({ presets: [] })),
      scanLocalCli: vi.fn(async () => ({ detections: [] })),
      localModelList: vi.fn(async () => ({
        status: { runtime: 'ollama', kind: 'absent', appInstalled: false },
        models: [],
        memoryGb: 0,
      })),
      onProviderOAuthProgress: vi.fn(() => () => undefined),
      refreshBuiltinProviderModels: refreshModels,
      providerOAuthLogin: vi.fn(),
      auth: { triggerLogin: vi.fn() },
    },
  } as unknown as typeof window.electronAPI;
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Cursor native provider setup', () => {
  it('offers Cursor before any native models have been discovered, including search', async () => {
    renderWizard();
    fireEvent.change(screen.getByPlaceholderText('settings.providers.wizard.searchPlaceholder'), {
      target: { value: 'cursor' },
    });
    fireEvent.click(await screen.findByText('Cursor'));
    expect(screen.getByTestId('cursor-provider-setup')).toBeTruthy();
    expect(screen.queryByText('settings.providers.button.authorize')).toBeNull();
    expect(screen.queryByText('settings.providers.openai.addIndependentAccount')).toBeNull();
  });

  it('opens native instructions directly instead of an OAuth flow', async () => {
    const { onDone } = renderWizard(true);
    expect(await screen.findByTestId('cursor-provider-setup')).toBeTruthy();
    expect(screen.getByText('cursor-agent login')).toBeTruthy();
    expect(screen.queryByText('settings.providers.button.authorize')).toBeNull();
    expect(onDone).not.toHaveBeenCalled();
    expect(window.electronAPI.maker.providerOAuthLogin).not.toHaveBeenCalled();
  });

  it('refreshes through the existing native provider API before finishing', async () => {
    const { onDone } = renderWizard(true);
    fireEvent.click(
      screen.getByRole('button', { name: 'settings.providers.models.refreshBuiltinAria' }),
    );
    await waitFor(() => expect(onDone).toHaveBeenCalledWith('cursor'));
    expect(refreshModels).toHaveBeenCalledOnce();
    expect(refreshModels).toHaveBeenCalledWith('cursor');
    expect(window.electronAPI.maker.auth.triggerLogin).not.toHaveBeenCalled();
    expect(window.electronAPI.maker.providerOAuthLogin).not.toHaveBeenCalled();
  });

  it('keeps the setup open and retryable when native discovery fails', async () => {
    refreshModels.mockRejectedValueOnce(new Error('native discovery unavailable'));
    const { onDone } = renderWizard(true);
    const refresh = screen.getByRole('button', {
      name: 'settings.providers.models.refreshBuiltinAria',
    });
    fireEvent.click(refresh);
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith('settings.providers.cursor.refreshFailed'),
    );
    expect(onDone).not.toHaveBeenCalled();
    fireEvent.click(refresh);
    await waitFor(() => expect(onDone).toHaveBeenCalledWith('cursor'));
    expect(refreshModels).toHaveBeenCalledTimes(2);
  });

  it('does not offer a duplicate native connection when Cursor is already connected', async () => {
    renderWizard(false, { ...cursor, connected: true });
    await waitFor(() => expect(window.electronAPI.maker.scanLocalCli).toHaveBeenCalled());
    expect(screen.queryByText('Cursor')).toBeNull();
  });
});
