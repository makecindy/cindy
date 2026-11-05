// @vitest-environment jsdom
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderView } from '@cindy/model-providers';
import { CliProxyQuotaSection } from '../CliProxyQuotaSection';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { resolvedLanguage: 'en' } }),
}));
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ dataOwnerId: 'owner', dataOwnerGeneration: 1 }),
}));
vi.mock('../../ui/input', () => ({
  Input: ({ secret: _secret, ...props }: Record<string, unknown>) => <input {...props} />,
}));
vi.mock('../../ui/button', () => ({
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} />,
}));

const provider = {
  id: 'local',
  source: 'user',
  routing: { pi: { upstream: 'http://127.0.0.1:8317/v1' } },
} as ProviderView;
afterEach(() => {
  vi.unstubAllGlobals();
});
describe('Antigravity quota in provider settings', () => {
  it('does not expose connection UI for remote or built-in providers', () => {
    const { container } = render(
      <CliProxyQuotaSection provider={{ ...provider, source: 'builtin' }} />,
    );
    expect(container.textContent).toBe('');
  });
  it('shows disabled quota as not applicable and never displays expired quota as available', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce({ configured: true, accounts: [], observedAt: 0 })
      .mockResolvedValueOnce({
        configured: true,
        observedAt: Date.now(),
        accounts: [
          {
            name: 'Account A',
            disabled: false,
            unavailable: false,
            groups: [
              {
                label: 'Gemini',
                buckets: [
                  {
                    label: 'weekly',
                    window: 'weekly',
                    remainingFraction: 0,
                    resetTime: '2000-01-01T00:00:00Z',
                    disabled: false,
                  },
                  {
                    label: '5h',
                    window: '5h',
                    remainingFraction: 1,
                    resetTime: null,
                    disabled: true,
                  },
                ],
              },
            ],
          },
        ],
      });
    vi.stubGlobal('electronAPI', undefined);
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { maker: { usage: { getCliProxyQuota: read } } },
    });
    render(<CliProxyQuotaSection provider={provider} />);
    const refresh = await screen.findByText('cliProxyQuota.refresh');
    fireEvent.click(refresh);
    await screen.findByText('Account A');
    expect(screen.getByText('cliProxyQuota.notApplicable')).toBeTruthy();
    expect(screen.getByText('cliProxyQuota.unavailable')).toBeTruthy();
    expect(screen.queryByRole('progressbar')).toBeNull();
    await waitFor(() => expect(read).toHaveBeenLastCalledWith('local', undefined, true));
  });
});
