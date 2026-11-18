// @vitest-environment jsdom
/**
 * Unit regression: a signed-in CLI used to be silently reused from Add Provider.
 * The real wizard must show its identity, require an explicit choice, and keep
 * both choices within one provider. Native credentials are mocked at the IPC boundary.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderView } from '@cindy/model-providers';
import type { SubscriptionPoolView } from '../../shared/subscriptionAccounts';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'zh-CN' } }),
}));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/customProviders', () => ({
  createCustomProvider: vi.fn(async () => undefined),
  deleteCustomProvider: vi.fn(async () => undefined),
}));
vi.mock('@/lib/providerModels', () => ({ providerMonogram: () => 'X' }));
vi.mock('@/components/icons/ProviderLogoMark', () => ({
  hasProviderLogo: () => false,
  ProviderLogoMark: () => null,
}));
import { AddProviderWizard } from '@/components/settings/AddProviderWizard';
import { createCustomProvider } from '@/lib/customProviders';

const provider = (id: string): ProviderView => ({
  id,
  name: id === 'anthropic' ? 'Anthropic' : 'OpenAI',
  source: 'builtin',
  agents: [id === 'anthropic' ? 'claude-code' : 'codex'],
  auth: { method: 'oauth' },
  routing: {},
  models: {},
  connected: false,
});
const preview: SubscriptionPoolView = {
  providerId: 'openai',
  configured: false,
  strategy: 'least',
  accounts: [
    {
      id: 'default',
      identity: 'existing@example.com',
      status: 'ready',
      directory: '/default',
      running: 0,
      paused: false,
      limit: 4,
      weight: 1,
    },
  ],
};
/** What the sign-in step reads to offer providers to join (2026-11-13). */
let listedProviders: ProviderView[] = [];
function renderWizard(providerId: string, onDone = vi.fn(), connected = false) {
  listedProviders = ['anthropic', 'openai'].map((id) => ({ ...provider(id), connected }));
  return render(
    <AddProviderWizard
      providers={['anthropic', 'openai'].map((id) => ({ ...provider(id), connected }))}
      entry={{ kind: 'builtin', providerId }}
      onOpenCustomForm={vi.fn()}
      onClose={vi.fn()}
      onDone={onDone}
    />,
  );
}
beforeEach(() => {
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    subscriptionAccounts: { command: vi.fn(async () => preview), onChanged: vi.fn(() => () => undefined) },
    maker: {
      listProviders: vi.fn(async () => ({ providers: listedProviders })),
      listProviderPresets: vi.fn(async () => ({ presets: [] })),
      localModelList: vi.fn(async () => ({
        status: { runtime: 'ollama', kind: 'absent', appInstalled: false },
        models: [],
        memoryGb: 0,
      })),
      providerOAuthLogin: vi.fn(),
      providerOAuthCancel: vi.fn(),
      onProviderOAuthProgress: vi.fn(() => () => undefined),
      scanLocalCli: vi.fn(async () => ({ detections: [] })),
    },
  };
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('AddProviderWizard — explicit subscription account choice', () => {
  it.each(
    ['anthropic', 'openai'].flatMap((providerId) =>
      ['default', 'new'].map((target) => ({ providerId, target })),
    ),
  )(
    'shows the detected $providerId identity before connecting $target',
    async ({ providerId, target }) => {
      const onDone = vi.fn();
      renderWizard(providerId, onDone, target === 'new');
      await screen.findByText('existing@example.com');
      expect(onDone).not.toHaveBeenCalled();
      expect(window.electronAPI.subscriptionAccounts.command).toHaveBeenCalledExactlyOnceWith({
        action: 'preview',
        providerId,
      });
      fireEvent.click(
        screen.getByRole('button', {
          name:
            target === 'default'
              ? /subscriptionAccounts\.signIn\.useAccount/
              : 'subscriptionAccounts.signIn.anotherAccount',
        }),
      );
      // Another account asks where it goes (2026-11-13); joining the built-in keeps this intent.
      if (target === 'new') {
        fireEvent.click((await screen.findAllByRole('radio'))[1]!);
        fireEvent.click(screen.getByText('subscriptionAccounts.placement.signInContinue'));
      }
      await waitFor(() => expect(onDone).toHaveBeenCalledExactlyOnceWith(providerId));
      expect(window.electronAPI.subscriptionAccounts.command).toHaveBeenCalledWith({
        action: 'connect',
        target,
        providerId,
        loginKey: expect.any(String),
      });
      expect(createCustomProvider).not.toHaveBeenCalled();
      expect(window.electronAPI.maker.providerOAuthLogin).not.toHaveBeenCalled();
    },
  );
  it.each(['anthropic', 'openai'])(
    'starts the first %s login in the default directory',
    async (providerId) => {
      vi.mocked(window.electronAPI.subscriptionAccounts.command).mockResolvedValue({
        ...preview,
        accounts: [{ ...preview.accounts[0], status: 'signed-out', identity: undefined }],
      });
      renderWizard(providerId);
      fireEvent.click(
        await screen.findByRole('button', {
          name:
            providerId === 'anthropic'
              ? 'settings.providers.localAccount.useClaude'
              : 'subscriptionAccounts.signIn.useCodex',
        }),
      );
      await waitFor(() =>
        expect(window.electronAPI.subscriptionAccounts.command).toHaveBeenCalledWith({
          action: 'connect',
          target: 'default',
          providerId,
          loginKey: expect.any(String),
        }),
      );
    },
  );
  // 2026-11-14 user decision: a CLI login already in Cindy (built-in provider, or the same identity
  // under another provider) is neither listed nor offered again; only a new sign-in remains.
  it.each(['ready', 'signed-out'] as const)(
    'offers only a new sign-in once the CLI login is already added (CLI %s)',
    async (status) => {
      vi.mocked(window.electronAPI.subscriptionAccounts.command).mockResolvedValue({
        ...preview,
        defaultAdded: true,
        accounts: [{ ...preview.accounts[0], status }],
      });
      renderWizard('openai');
      const another = await screen.findByRole('button', {
        name: 'subscriptionAccounts.signIn.anotherAccount',
      });
      expect(screen.queryByText('existing@example.com')).toBeNull();
      expect(screen.queryByRole('alert')).toBeNull();
      for (const name of [/subscriptionAccounts\.signIn\.useAccount/, 'subscriptionAccounts.signIn.useCodex'])
        expect(screen.queryByRole('button', { name })).toBeNull();
      // No connected provider to join here, so it goes straight to a separate provider.
      fireEvent.click(another);
      await waitFor(() =>
        expect(window.electronAPI.subscriptionAccounts.command).toHaveBeenCalledWith({
          action: 'create',
          providerId: 'openai',
          loginKey: expect.any(String),
        }),
      );
    },
  );
  it('keeps detection failures visible and retries without granting authorization', async () => {
    vi.mocked(window.electronAPI.subscriptionAccounts.command).mockRejectedValueOnce(
      new Error('unavailable'),
    );
    const onDone = vi.fn();
    renderWizard('openai', onDone);
    await screen.findByRole('alert');
    expect(
      screen.queryByRole('button', { name: /subscriptionAccounts\.signIn\.useAccount/ }),
    ).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'subscriptionAccounts.signIn.retry' }));
    await screen.findByText('existing@example.com');
    expect(window.electronAPI.subscriptionAccounts.command).toHaveBeenCalledTimes(2);
    expect(onDone).not.toHaveBeenCalled();
  });
  it('discards an old provider preview after the user changes the selection', async () => {
    let finish!: (result: SubscriptionPoolView) => void;
    vi.mocked(window.electronAPI.subscriptionAccounts.command).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    renderWizard('openai');
    fireEvent.click(screen.getByText('settings.providers.wizard.back'));
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: /Anthropic/ }));
    await screen.findByText('existing@example.com');
    await act(async () =>
      finish({ ...preview, accounts: [{ ...preview.accounts[0], identity: 'late@example.com' }] }),
    );
    expect(screen.queryByText('late@example.com')).toBeNull();
    expect(screen.getByText('existing@example.com')).toBeTruthy();
  });
});
