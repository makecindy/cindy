// @vitest-environment jsdom
import { useRef, useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CustomProviderConfig } from '@cindy/model-providers';

import { CustomProviderDialog } from '../CustomProviderDialog';

const customProviderMocks = vi.hoisted(() => ({
  readCustomProviderKey: vi.fn(),
  updateCustomProvider: vi.fn(),
}));

vi.mock('@/lib/customProviders', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/customProviders')>()),
  readCustomProviderKey: customProviderMocks.readCustomProviderKey,
  updateCustomProvider: customProviderMocks.updateCustomProvider,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}));

beforeEach(() => {
  customProviderMocks.readCustomProviderKey.mockReset();
  customProviderMocks.updateCustomProvider.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      maker: {
        listProviderPresets: vi.fn(async () => ({ presets: [] })),
        testProviderConnection: vi.fn(async () => ({ ok: true, latencyMs: 1 })),
      },
    },
  });
});

afterEach(cleanup);

async function waitForInitialDialogFocus(): Promise<void> {
  const nameInput = screen.getByPlaceholderText(
    'settings.providers.custom.fields.namePlaceholder',
  );
  await waitFor(() => expect(document.activeElement).toBe(nameInput));
}

function modelRoutedCodexProvider(): CustomProviderConfig {
  return {
    id: 'glm-coding-plan',
    name: 'GLM Coding Plan',
    auth: { method: 'apiKey' },
    runtimes: {
      codex: {
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
        wireProtocol: 'openai-chat',
        requestPath: '/chat/completions',
        models: [
          {
            id: 'glm-5.3',
            name: 'GLM-5.3',
            route: {
              baseUrl: 'https://open.bigmodel.cn/api/v1',
              wireProtocol: 'openai-responses',
              requestPath: '/responses',
            },
          },
        ],
      },
    },
  };
}

describe('CustomProviderDialog accessibility', () => {
  it('ignores consumed and IME Escape events, then restores focus after closing', async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Add provider
          </button>
          {open && (
            <CustomProviderDialog onSaved={() => setOpen(false)} onClose={() => setOpen(false)} />
          )}
        </>
      );
    }

    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Add provider' });
    await user.click(trigger);

    const dialog = screen.getByRole('dialog', {
      name: 'settings.providers.custom.dialog.createTitle',
    });
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

    fireEvent.keyDown(dialog, { key: 'Escape', isComposing: true, keyCode: 229 });
    expect(screen.getByRole('dialog')).not.toBeNull();

    const consumedEscape = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    consumedEscape.preventDefault();
    fireEvent(dialog, consumedEscape);
    expect(screen.getByRole('dialog')).not.toBeNull();

    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('uses a stable fallback when the immediate opener unmounts during a wizard transition', async () => {
    function Harness() {
      const [stage, setStage] = useState<'idle' | 'wizard' | 'dialog'>('idle');
      const stableTriggerRef = useRef<HTMLButtonElement>(null);
      return (
        <>
          <button ref={stableTriggerRef} type="button" onClick={() => setStage('wizard')}>
            Add provider
          </button>
          {stage === 'wizard' && (
            <button type="button" onClick={() => setStage('dialog')}>
              Custom endpoint
            </button>
          )}
          {stage === 'dialog' && (
            <CustomProviderDialog
              returnFocusRef={stableTriggerRef}
              onSaved={() => setStage('idle')}
              onClose={() => setStage('idle')}
            />
          )}
        </>
      );
    }

    const user = userEvent.setup();
    render(<Harness />);
    const stableTrigger = screen.getByRole('button', { name: 'Add provider' });
    await user.click(stableTrigger);
    await user.click(screen.getByRole('button', { name: 'Custom endpoint' }));
    await user.click(screen.getByText('settings.providers.custom.cancel'));

    await waitFor(() => expect(document.activeElement).toBe(stableTrigger));
  });

  it('does not submit a hydrated key as a replacement when only the endpoint changes', async () => {
    const initial: CustomProviderConfig = {
      id: 'existing-provider',
      name: 'Existing provider',
      auth: { method: 'apiKey' },
      runtimes: {
        codex: {
          baseUrl: 'https://old.example.test/v1',
          models: [{ id: 'test-model', name: 'Test Model' }],
        },
      },
    };
    customProviderMocks.readCustomProviderKey.mockResolvedValue('old-secret');

    const user = userEvent.setup();
    render(<CustomProviderDialog initial={initial} onSaved={vi.fn()} onClose={vi.fn()} />);
    await screen.findByText('settings.providers.custom.fields.apiKeySaved');
    const apiKey = screen.getByPlaceholderText(
      'settings.providers.custom.fields.apiKeyEditPlaceholder',
    );
    expect((apiKey as HTMLInputElement).value).toBe('old-secret');

    const baseUrl = screen.getByPlaceholderText(
      'settings.providers.custom.fields.baseUrlPlaceholder',
    );
    await waitForInitialDialogFocus();
    await user.clear(baseUrl);
    await user.type(baseUrl, 'https://new.example.test/v1');
    await waitFor(() => expect((apiKey as HTMLInputElement).value).toBe(''));
    expect(screen.queryByText('settings.providers.custom.fields.apiKeySaved')).toBeNull();
    expect(apiKey.getAttribute('placeholder')).toBe(
      'settings.providers.custom.fields.apiKeyPlaceholder',
    );
    await user.click(screen.getByRole('button', { name: 'settings.providers.custom.save' }));

    await waitFor(() => expect(customProviderMocks.updateCustomProvider).toHaveBeenCalledOnce());
    expect(customProviderMocks.updateCustomProvider.mock.calls[0]?.[1]).toEqual({});
  });

  it('keeps model-level routes when saving an existing provider', async () => {
    const initial = modelRoutedCodexProvider();
    customProviderMocks.readCustomProviderKey.mockResolvedValue(null);

    const user = userEvent.setup();
    render(<CustomProviderDialog initial={initial} onSaved={vi.fn()} onClose={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'settings.providers.custom.save' }));

    await waitFor(() => expect(customProviderMocks.updateCustomProvider).toHaveBeenCalledOnce());
    expect(customProviderMocks.updateCustomProvider.mock.calls[0]?.[0].runtimes.codex?.models).toEqual([
      {
        id: 'glm-5.3',
        name: 'GLM-5.3',
        route: {
          baseUrl: 'https://open.bigmodel.cn/api/v1',
          wireProtocol: 'openai-responses',
          requestPath: '/responses',
        },
      },
    ]);
  });

  it('tests an unchanged Codex model route through the saved provider probe', async () => {
    const testProviderConnection = vi
      .fn<(request: unknown) => Promise<{ ok: true; latencyMs: number }>>()
      .mockResolvedValue({ ok: true, latencyMs: 1 });
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        maker: {
          listProviderPresets: vi.fn(async () => ({ presets: [] })),
          testProviderConnection,
        },
      },
    });
    const initial = modelRoutedCodexProvider();
    customProviderMocks.readCustomProviderKey.mockResolvedValue('saved-key');

    const user = userEvent.setup();
    render(<CustomProviderDialog initial={initial} onSaved={vi.fn()} onClose={vi.fn()} />);
    await screen.findByText('settings.providers.custom.fields.apiKeySaved');
    await user.click(screen.getByRole('button', { name: 'settings.providers.custom.test.button' }));

    await waitFor(() => expect(testProviderConnection).toHaveBeenCalledOnce());
    expect(testProviderConnection).toHaveBeenCalledWith({
      kind: 'saved',
      providerId: 'glm-coding-plan',
      agent: 'codex',
    });
  });

  it('uses the first Codex model route when an edited runtime requires an ad-hoc probe', async () => {
    const testProviderConnection = vi
      .fn<(request: unknown) => Promise<{ ok: true; latencyMs: number }>>()
      .mockResolvedValue({ ok: true, latencyMs: 1 });
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        maker: {
          listProviderPresets: vi.fn(async () => ({ presets: [] })),
          testProviderConnection,
        },
      },
    });
    const initial = modelRoutedCodexProvider();
    customProviderMocks.readCustomProviderKey.mockResolvedValue('saved-key');

    const user = userEvent.setup();
    render(<CustomProviderDialog initial={initial} onSaved={vi.fn()} onClose={vi.fn()} />);
    await screen.findByText('settings.providers.custom.fields.apiKeySaved');
    await user.click(
      screen.getByRole('button', { name: 'settings.providers.custom.wireProtocol.responses' }),
    );
    await user.click(screen.getByRole('button', { name: 'settings.providers.custom.test.button' }));

    await waitFor(() => expect(testProviderConnection).toHaveBeenCalledOnce());
    expect(testProviderConnection.mock.calls[0]?.[0]).toMatchObject({
      kind: 'adhoc',
      spec: {
        agent: 'codex',
        baseUrl: 'https://open.bigmodel.cn/api/v1',
        modelId: 'glm-5.3',
        authMethod: 'apiKey',
        wireProtocol: 'openai-responses',
        requestPath: '/responses',
        apiKey: 'saved-key',
      },
    });
  });

  it('restores an untouched hydrated key when returning to API-key mode on the saved endpoint', async () => {
    const initial: CustomProviderConfig = {
      id: 'existing-provider',
      name: 'Existing provider',
      auth: { method: 'apiKey' },
      runtimes: {
        codex: {
          baseUrl: 'https://old.example.test/v1',
          models: [{ id: 'test-model', name: 'Test Model' }],
        },
      },
    };
    customProviderMocks.readCustomProviderKey.mockResolvedValue('old-secret');

    const user = userEvent.setup();
    render(<CustomProviderDialog initial={initial} onSaved={vi.fn()} onClose={vi.fn()} />);
    const apiKey = await screen.findByPlaceholderText(
      'settings.providers.custom.fields.apiKeyEditPlaceholder',
    );
    const baseUrl = screen.getByPlaceholderText(
      'settings.providers.custom.fields.baseUrlPlaceholder',
    );

    await waitForInitialDialogFocus();
    await user.clear(baseUrl);
    await user.type(baseUrl, 'https://new.example.test/v1');
    await waitFor(() => expect((apiKey as HTMLInputElement).value).toBe(''));
    await user.click(
      screen.getByRole('button', { name: 'settings.providers.custom.authMode.none' }),
    );
    await user.clear(baseUrl);
    await user.type(baseUrl, 'https://old.example.test/v1');
    await user.click(
      screen.getByRole('button', { name: 'settings.providers.custom.authMode.apiKey' }),
    );

    const restoredApiKey = await screen.findByPlaceholderText(
      'settings.providers.custom.fields.apiKeyEditPlaceholder',
    );
    expect((restoredApiKey as HTMLInputElement).value).toBe('old-secret');
  });

  it('blocks an endpoint save when that runtime key could not be read', async () => {
    const initial: CustomProviderConfig = {
      id: 'existing-provider',
      name: 'Existing provider',
      auth: { method: 'apiKey' },
      runtimes: {
        codex: {
          baseUrl: 'https://old.example.test/v1',
          models: [{ id: 'test-model', name: 'Test Model' }],
        },
      },
    };
    customProviderMocks.readCustomProviderKey.mockRejectedValue(
      new Error('safeStorage unavailable'),
    );

    const user = userEvent.setup();
    render(<CustomProviderDialog initial={initial} onSaved={vi.fn()} onClose={vi.fn()} />);
    await waitFor(() => expect(customProviderMocks.readCustomProviderKey).toHaveBeenCalled());

    const baseUrl = screen.getByPlaceholderText(
      'settings.providers.custom.fields.baseUrlPlaceholder',
    );
    await waitForInitialDialogFocus();
    await user.clear(baseUrl);
    await user.type(baseUrl, 'https://new.example.test/v1');
    await user.click(screen.getByRole('button', { name: 'settings.providers.custom.save' }));

    await waitFor(() => expect(customProviderMocks.updateCustomProvider).not.toHaveBeenCalled());
  });

  it('does not send a hydrated key to a changed endpoint during an ad-hoc test', async () => {
    const testProviderConnection = vi
      .fn<(request: unknown) => Promise<{ ok: true; latencyMs: number }>>()
      .mockResolvedValue({ ok: true, latencyMs: 1 });
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        maker: {
          listProviderPresets: vi.fn(async () => ({ presets: [] })),
          testProviderConnection,
        },
      },
    });
    const initial: CustomProviderConfig = {
      id: 'existing-provider',
      name: 'Existing provider',
      auth: { method: 'apiKey' },
      runtimes: {
        codex: {
          baseUrl: 'https://old.example.test/v1',
          models: [{ id: 'test-model', name: 'Test Model' }],
        },
      },
    };
    customProviderMocks.readCustomProviderKey.mockResolvedValue('old-secret');

    const user = userEvent.setup();
    render(<CustomProviderDialog initial={initial} onSaved={vi.fn()} onClose={vi.fn()} />);
    await screen.findByText('settings.providers.custom.fields.apiKeySaved');
    const baseUrl = screen.getByPlaceholderText(
      'settings.providers.custom.fields.baseUrlPlaceholder',
    );
    await waitForInitialDialogFocus();
    await user.clear(baseUrl);
    await user.type(baseUrl, 'https://new.example.test/v1');
    await user.click(screen.getByRole('button', { name: 'settings.providers.custom.test.button' }));

    await waitFor(() => expect(testProviderConnection).toHaveBeenCalledOnce());
    expect(testProviderConnection.mock.calls[0]?.[0]).toMatchObject({
      kind: 'adhoc',
      spec: expect.objectContaining({
        baseUrl: 'https://new.example.test/v1',
        apiKey: null,
      }),
    });
  });

  it('hides and strips a legacy request path from a Pi runtime', async () => {
    const initial: CustomProviderConfig = {
      id: 'legacy-pi-provider',
      name: 'Legacy Pi provider',
      auth: { method: 'apiKey' },
      runtimes: {
        pi: {
          baseUrl: 'https://pi.example.test/v1',
          requestPath: '/legacy-infer',
          models: [{ id: 'pi-model', name: 'Pi Model' }],
        },
      },
    };
    customProviderMocks.readCustomProviderKey.mockResolvedValue(null);

    const user = userEvent.setup();
    render(<CustomProviderDialog initial={initial} onSaved={vi.fn()} onClose={vi.fn()} />);
    await waitFor(() => expect(customProviderMocks.readCustomProviderKey).toHaveBeenCalled());

    expect(screen.queryByText('settings.providers.custom.fields.requestPath')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'settings.providers.custom.save' }));

    await waitFor(() => expect(customProviderMocks.updateCustomProvider).toHaveBeenCalledOnce());
    expect(
      customProviderMocks.updateCustomProvider.mock.calls[0]?.[0].runtimes.pi?.requestPath,
    ).toBeUndefined();
  });

  it('submits an explicitly edited key as the endpoint replacement', async () => {
    const initial: CustomProviderConfig = {
      id: 'existing-provider',
      name: 'Existing provider',
      auth: { method: 'apiKey' },
      runtimes: {
        codex: {
          baseUrl: 'https://old.example.test/v1',
          models: [{ id: 'test-model', name: 'Test Model' }],
        },
      },
    };
    customProviderMocks.readCustomProviderKey.mockResolvedValue('old-secret');

    const user = userEvent.setup();
    render(<CustomProviderDialog initial={initial} onSaved={vi.fn()} onClose={vi.fn()} />);
    const apiKey = await screen.findByPlaceholderText(
      'settings.providers.custom.fields.apiKeyEditPlaceholder',
    );

    await waitForInitialDialogFocus();
    await user.clear(apiKey);
    await user.type(apiKey, 'replacement-secret');
    await user.click(screen.getByRole('button', { name: 'settings.providers.custom.save' }));

    await waitFor(() => expect(customProviderMocks.updateCustomProvider).toHaveBeenCalledOnce());
    expect(customProviderMocks.updateCustomProvider.mock.calls[0]?.[1]).toEqual({
      codex: 'replacement-secret',
    });
  });

  it('shows a configured-headers badge and never reveals plaintext for the active runtime', async () => {
    const initial: CustomProviderConfig = {
      id: 'configured-headers-provider',
      name: 'Configured headers provider',
      auth: { method: 'apiKey' },
      runtimes: {
        codex: {
          baseUrl: 'https://configured.example.test/v1',
          models: [{ id: 'test-model', name: 'Test Model' }],
          headersState: 'configured',
        },
      },
    };
    customProviderMocks.readCustomProviderKey.mockResolvedValue(null);

    const user = userEvent.setup();
    render(<CustomProviderDialog initial={initial} onSaved={vi.fn()} onClose={vi.fn()} />);
    await waitFor(() => expect(customProviderMocks.readCustomProviderKey).toHaveBeenCalled());

    const configuredBadge = () =>
      screen.queryByText('settings.providers.custom.runtimeFill.values.configured', {
        exact: true,
      });

    // 初始：端点未变，徽标显示。
    expect(configuredBadge()).not.toBeNull();
    // 明文头值绝不允许出现在 renderer。
    expect(document.body.textContent).not.toContain('configured-header-secret');

    const baseUrl = screen.getByPlaceholderText(
      'settings.providers.custom.fields.baseUrlPlaceholder',
    );
    await waitForInitialDialogFocus();
    // 改端点：main 会清掉已存头，徽标必须同步隐藏。
    await user.clear(baseUrl);
    await user.type(baseUrl, 'https://changed.example.test/v1');
    await waitFor(() => expect(configuredBadge()).toBeNull());
    expect(document.body.textContent).not.toContain('configured-header-secret');

    // 改回原端点：徽标可以重新出现。
    await user.clear(baseUrl);
    await user.type(baseUrl, 'https://configured.example.test/v1');
    await waitFor(() => expect(configuredBadge()).not.toBeNull());

    // 切到无鉴权：none 模式剥凭证头，已存头不再有效，徽标隐藏。
    await user.click(screen.getByRole('button', { name: 'settings.providers.custom.authMode.none' }));
    await waitFor(() => expect(configuredBadge()).toBeNull());
    expect(document.body.textContent).not.toContain('configured-header-secret');
  });
});
