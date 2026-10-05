// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: { at?: string }) => (params?.at ? `${key} @ ${params.at}` : key),
    i18n: { language: 'en' },
  }),
}));

vi.mock('@/lib/toast', () => ({ toast }));

import type { CodexResetCreditAutoUseState } from '../../../../shared/codexResetCreditAutoUse';
import { CodexResetAutoUseRow } from '../CodexResetAutoUseRow';

const off: CodexResetCreditAutoUseState = {
  providerId: 'openai',
  enabled: false,
  isCustomized: false,
  defaultEnabled: false,
  lastAutoUse: null,
};
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

  it('shows the latest automatic use so a spent reset is never silent', async () => {
    const atMs = Date.UTC(2026, 9, 7, 9, 30);
    installApi({ ...on, lastAutoUse: { atMs, kind: 'expiring' } });
    render(<CodexResetAutoUseRow providerId="openai" />);
    const line = await screen.findByTestId('provider-codex-reset-last-auto-use');
    expect(line.textContent).toContain('settings.providers.codexResetAutoUse.lastAutoUseExpiring @ ');
  });

  it('re-reads the setting while open so a background use shows up', async () => {
    vi.useFakeTimers();
    try {
      const api = installApi();
      render(<CodexResetAutoUseRow providerId="openai" />);
      await vi.advanceTimersByTimeAsync(0);
      expect(api.getCodexResetAutoUse).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(api.getCodexResetAutoUse).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
