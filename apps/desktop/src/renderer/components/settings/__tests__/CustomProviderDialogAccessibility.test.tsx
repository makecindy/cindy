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
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock('@/lib/customProviders', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/customProviders')>()),
  readCustomProviderKey: customProviderMocks.readCustomProviderKey,
  updateCustomProvider: customProviderMocks.updateCustomProvider,
}));

vi.mock('@/lib/toast', () => ({
  toast: {
    error: customProviderMocks.toastError,
    success: customProviderMocks.toastSuccess,
  },
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
  customProviderMocks.toastError.mockReset();
  customProviderMocks.toastSuccess.mockReset();
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
    expect(
      screen.queryByText('settings.providers.custom.fields.apiKeySaved'),
    ).toBeNull();
    expect(apiKey.getAttribute('placeholder')).toBe(
      'settings.providers.custom.fields.apiKeyPlaceholder',
    );
    await user.click(screen.getByRole('button', { name: 'settings.providers.custom.save' }));

    await waitFor(() => expect(customProviderMocks.updateCustomProvider).toHaveBeenCalledOnce());
    expect(customProviderMocks.updateCustomProvider.mock.calls[0]?.[1]).toEqual({});
  });

  it('keeps model-level routes when saving an existing provider', async () => {
    const initial: CustomProviderConfig = {
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
    await user.click(screen.getByRole('button', { name: 'settings.providers.custom.authMode.none' }));
    await user.clear(baseUrl);
    await user.type(baseUrl, 'https://old.example.test/v1');
    await user.click(screen.getByRole('button', { name: 'settings.providers.custom.authMode.apiKey' }));

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
    customProviderMocks.readCustomProviderKey.mockRejectedValue(new Error('safeStorage unavailable'));

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

    expect(
      screen.queryByText('settings.providers.custom.fields.requestPath'),
    ).toBeNull();
    await user.click(screen.getByRole('button', { name: 'settings.providers.custom.save' }));

    await waitFor(() => expect(customProviderMocks.updateCustomProvider).toHaveBeenCalledOnce());
    expect(
      customProviderMocks.updateCustomProvider.mock.calls[0]?.[0].runtimes.pi?.requestPath,
    ).toBeUndefined();
  });

  it('shows a dedicated DSH page with model context and reasoning strength, then saves them', async () => {
    const initial: CustomProviderConfig = {
      id: 'dsh-gateway',
      name: 'DSH Gateway',
      auth: { method: 'apiKey' },
      runtimes: {
        dsh: {
          baseUrl: 'https://gateway.example.test/deepseek',
          models: [
            {
              id: 'gateway-pro',
              name: 'Gateway Pro',
              contextWindow: 640_000,
              dshReasoningEffort: 'low',
            },
          ],
        },
      },
    };
    customProviderMocks.readCustomProviderKey.mockResolvedValue('stored-dsh-key');

    const user = userEvent.setup();
    render(<CustomProviderDialog initial={initial} onSaved={vi.fn()} onClose={vi.fn()} />);

    expect(
      screen
        .getByRole('tab', { name: 'settings.providers.custom.protocol.dsh' })
        .getAttribute('aria-selected'),
    ).toBe('true');
    expect(
      screen.getByText('settings.providers.custom.fields.dshReasoningEffort'),
    ).not.toBeNull();
    expect(screen.getByDisplayValue('640000')).not.toBeNull();
    expect(screen.queryByText('settings.providers.custom.fields.requestPath')).toBeNull();
    expect(screen.queryByText('settings.providers.custom.fields.headers')).toBeNull();

    await user.click(
      screen.getByRole('button', {
        name: 'settings.providers.custom.dshReasoningEffort.max',
      }),
    );
    await user.click(screen.getByRole('button', { name: 'settings.providers.custom.save' }));

    await waitFor(() => expect(customProviderMocks.updateCustomProvider).toHaveBeenCalledOnce());
    expect(customProviderMocks.updateCustomProvider.mock.calls[0]?.[0].runtimes.dsh).toEqual({
      baseUrl: 'https://gateway.example.test/deepseek',
      models: [
        {
          id: 'gateway-pro',
          name: 'Gateway Pro',
          contextWindow: 640_000,
          maxOutput: 32_768,
          dshReasoningEffort: 'max',
        },
      ],
    });
  });

  it('runs DSH connection and model-list requests from its settings page', async () => {
    const testProviderConnection = vi.fn(async () => ({ ok: true, latencyMs: 3 }));
    const fetchProviderModels = vi.fn(async () => ({
      ok: true,
      models: [{
        id: 'k3',
        name: 'Kimi K3',
        contextWindow: 262_144,
        dshReasoningEfforts: ['low', 'high', 'max'],
        dshReasoningEffort: 'high',
      }],
    }));
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        maker: {
          listProviderPresets: vi.fn(async () => ({ presets: [] })),
          testProviderConnection,
          fetchProviderModels,
        },
      },
    });
    customProviderMocks.readCustomProviderKey.mockResolvedValue('stored-kimi-key');
    const initial: CustomProviderConfig = {
      id: 'kimi-code',
      name: 'Kimi Code',
      auth: { method: 'apiKey' },
      runtimes: {
        dsh: {
          baseUrl: 'https://api.kimi.com/coding/v1',
          models: [{
            id: 'k3',
            name: 'Kimi K3',
            contextWindow: 1_048_576,
            dshReasoningEfforts: ['low', 'high', 'max'],
            dshReasoningEffort: 'high',
          }],
        },
      },
    };

    const user = userEvent.setup();
    render(<CustomProviderDialog initial={initial} onSaved={vi.fn()} onClose={vi.fn()} />);
    await screen.findByText('settings.providers.custom.fields.apiKeySaved');

    await user.click(screen.getByRole('button', { name: 'settings.providers.custom.test.button' }));
    await waitFor(() => expect(testProviderConnection).toHaveBeenCalledWith({
      kind: 'saved',
      providerId: 'kimi-code',
      agent: 'dsh',
    }));

    await user.click(screen.getByRole('button', { name: 'settings.providers.custom.fetch.button' }));
    await waitFor(() => expect(fetchProviderModels).toHaveBeenCalledWith(expect.objectContaining({
      agent: 'dsh',
      baseUrl: 'https://api.kimi.com/coding/v1',
      wireProtocol: 'openai-chat',
      modelsUrl: null,
      savedProviderId: 'kimi-code',
    })));
    expect(await screen.findByText('settings.providers.custom.fetch.pickerTitle')).not.toBeNull();
    await user.click(screen.getByRole('button', {
      name: 'settings.providers.custom.fetch.confirm',
    }));
    await user.click(screen.getByRole('button', { name: 'settings.providers.custom.save' }));

    await waitFor(() => expect(customProviderMocks.updateCustomProvider).toHaveBeenCalledOnce());
    expect(customProviderMocks.updateCustomProvider.mock.calls[0]?.[0].runtimes.dsh.models[0])
      .toMatchObject({
        id: 'k3',
        contextWindow: 262_144,
        maxOutput: 32_768,
        dshReasoningEfforts: ['low', 'high', 'max'],
        dshReasoningEffort: 'high',
      });
  });

  it('renders fixed DSH thinking as a policy instead of a fake effort tier', async () => {
    const user = userEvent.setup();
    const testProviderConnection = vi.fn(async (_input: unknown) => ({ ok: true, latencyMs: 1 }));
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        maker: {
          listProviderPresets: vi.fn(async () => ({ presets: [] })),
          testProviderConnection,
        },
      },
    });
    customProviderMocks.readCustomProviderKey.mockResolvedValue(null);
    render(<CustomProviderDialog
      initial={{
        id: 'kimi-k27',
        name: 'Kimi K2.7',
        auth: { method: 'apiKey' },
        runtimes: {
          dsh: {
            baseUrl: 'https://api.kimi.com/coding/v1',
            models: [{
              id: 'kimi-for-coding',
              name: 'Kimi K2.7 Code',
              dshReasoningEffort: 'high',
              dshThinkingPolicy: 'always-on',
            }],
          },
        },
      }}
      onSaved={vi.fn()}
      onClose={vi.fn()}
    />);

    expect(await screen.findByText('settings.providers.custom.fields.dshThinkingPolicy'))
      .not.toBeNull();
    expect(screen.getByText('settings.providers.custom.dshThinkingPolicy.always-on'))
      .not.toBeNull();
    expect(screen.queryByRole('button', {
      name: 'settings.providers.custom.dshReasoningEffort.high',
    })).toBeNull();

    fireEvent.change(screen.getByDisplayValue('https://api.kimi.com/coding/v1'), {
      target: { value: 'https://api.kimi.com/coding/v1-test' },
    });
    await user.click(screen.getByRole('button', {
      name: 'settings.providers.custom.test.button',
    }));
    await waitFor(() => expect(testProviderConnection).toHaveBeenCalledWith({
      kind: 'adhoc',
      spec: expect.objectContaining({
        agent: 'dsh',
        modelId: 'kimi-for-coding',
        dshThinkingPolicy: 'always-on',
      }),
    }));
    const call = testProviderConnection.mock.calls[0]?.[0] as {
      spec: Record<string, unknown>;
    };
    expect(call.spec).not.toHaveProperty('dshReasoningEffort');
  });

  it.each(['?', '#'])('rejects a DSH Base URL ending in bare %s before save', async (suffix) => {
    const initial: CustomProviderConfig = {
      id: 'dsh-bare-separator',
      name: 'DSH bare separator',
      auth: { method: 'apiKey' },
      runtimes: {
        dsh: {
          baseUrl: 'https://gateway.example.test/deepseek',
          models: [{ id: 'gateway-pro', name: 'Gateway Pro' }],
        },
      },
    };
    customProviderMocks.readCustomProviderKey.mockResolvedValue(null);
    const user = userEvent.setup();
    render(<CustomProviderDialog initial={initial} onSaved={vi.fn()} onClose={vi.fn()} />);

    fireEvent.change(await screen.findByDisplayValue('https://gateway.example.test/deepseek'), {
      target: { value: `https://gateway.example.test/deepseek${suffix}` },
    });
    await user.click(screen.getByRole('button', { name: 'settings.providers.custom.save' }));

    expect(customProviderMocks.toastError)
      .toHaveBeenCalledWith('settings.providers.custom.errors.baseUrlInvalid');
    expect(customProviderMocks.updateCustomProvider).not.toHaveBeenCalled();
  });

  it('saves DSH non-secret settings before its dedicated key is configured', async () => {
    const initial: CustomProviderConfig = {
      id: 'dsh-without-key',
      name: 'DSH without key',
      auth: { method: 'apiKey' },
      runtimes: {
        dsh: {
          baseUrl: 'https://gateway.example.test/deepseek',
          models: [
            {
              id: 'gateway-pro',
              name: 'Gateway Pro',
              contextWindow: 640_000,
              dshReasoningEffort: 'max',
            },
          ],
        },
      },
    };
    customProviderMocks.readCustomProviderKey.mockResolvedValue(null);

    const user = userEvent.setup();
    render(<CustomProviderDialog initial={initial} onSaved={vi.fn()} onClose={vi.fn()} />);
    await waitFor(() =>
      expect(customProviderMocks.readCustomProviderKey).toHaveBeenCalledWith('dsh-without-key', 'dsh'),
    );
    expect(screen.getByText('settings.providers.custom.errors.dshApiKeyRequired')).not.toBeNull();

    await user.click(screen.getByRole('button', { name: 'settings.providers.custom.save' }));

    await waitFor(() => expect(customProviderMocks.updateCustomProvider).toHaveBeenCalledOnce());
    expect(customProviderMocks.updateCustomProvider).toHaveBeenCalledWith(
      {
        id: 'dsh-without-key',
        name: 'DSH without key',
        runtimes: {
          dsh: {
            baseUrl: 'https://gateway.example.test/deepseek',
            models: [
              {
                id: 'gateway-pro',
                name: 'Gateway Pro',
                contextWindow: 640_000,
                maxOutput: 32_768,
                dshReasoningEffort: 'max',
              },
            ],
          },
        },
      },
      {},
    );
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
});
