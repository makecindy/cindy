// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@/lib/toast', () => ({ toast }));

import { CodexResetAutoUseRow } from '../CodexResetAutoUseRow';

const off = { providerId: 'openai', enabled: false, isCustomized: false, defaultEnabled: false };
const on = { ...off, enabled: true, isCustomized: true };

function installApi(state = off) {
  const api = {
    getCodexResetAutoUse: vi.fn().mockResolvedValue(state),
    setCodexResetAutoUse: vi.fn(),
  };
  (window as unknown as { electronAPI: unknown }).electronAPI = { maker: { usage: api } };
  return api;
}

describe('CodexResetAutoUseRow', () => {
  beforeEach(() => {
    toast.success.mockReset();
    toast.error.mockReset();
  });
  afterEach(() => cleanup());

  it('reads the account setting and turns it on', async () => {
    const api = installApi();
    api.setCodexResetAutoUse.mockResolvedValue(on);
    render(<CodexResetAutoUseRow providerId="openai" />);

    const toggle = await screen.findByRole('switch', {
      name: 'settings.providers.codexResetAutoUse.label',
    });
    expect(api.getCodexResetAutoUse).toHaveBeenCalledWith('openai');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText('settings.providers.codexResetAutoUse.description')).toBeTruthy();

    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
    expect(api.setCodexResetAutoUse).toHaveBeenCalledWith('openai', true);
    expect(toast.success).toHaveBeenCalledWith('settings.providers.codexResetAutoUse.enabledToast');
  });

  it('restores the default by clearing the explicit setting', async () => {
    const api = installApi(on);
    api.setCodexResetAutoUse.mockResolvedValue(off);
    render(<CodexResetAutoUseRow providerId="openai" />);

    const toggle = await screen.findByRole('switch');
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'settings.defaults.restore' }));
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'));
    expect(api.setCodexResetAutoUse).toHaveBeenCalledWith('openai', null);
    expect(toast.success).toHaveBeenCalledWith('settings.defaults.restored');
  });

  it('keeps the previous value and reports a failed save', async () => {
    const api = installApi();
    api.setCodexResetAutoUse.mockRejectedValue(new Error('[INTERNAL] busy'));
    render(<CodexResetAutoUseRow providerId="openai" />);

    const toggle = await screen.findByRole('switch');
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('settings.providers.codexResetAutoUse.saveFailed'),
    );
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });

  it('renders nothing until the setting has been read', () => {
    const api = installApi();
    api.getCodexResetAutoUse.mockReturnValue(new Promise(() => undefined));
    const { container } = render(<CodexResetAutoUseRow providerId="openai" />);
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing with an older preload that lacks the setting', () => {
    (window as unknown as { electronAPI: unknown }).electronAPI = { maker: { usage: {} } };
    const { container } = render(<CodexResetAutoUseRow providerId="openai" />);
    expect(container.innerHTML).toBe('');
  });
});
