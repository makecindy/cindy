// @vitest-environment jsdom
import { useRef, useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CustomProviderConfig } from '@cindy/model-providers';

import { CustomProviderDialog } from '../CustomProviderDialog';

const customProviderMocks = vi.hoisted(() => ({
  readCustomProviderKey: vi.fn(),
  createCustomProvider: vi.fn(),
  updateCustomProvider: vi.fn(),
}));

vi.mock('@/lib/customProviders', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/customProviders')>()),
  readCustomProviderKey: customProviderMocks.readCustomProviderKey,
  createCustomProvider: customProviderMocks.createCustomProvider,
  updateCustomProvider: customProviderMocks.updateCustomProvider,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      if (key === 'settings.providers.custom.imageGenerationReload.interrupt') {
        return '保存并停止';
      }
      if (key === 'settings.providers.custom.imageGenerationReload.cancel') return '取消';
      return key;
    },
    i18n: { language: 'en' },
  }),
}));

beforeEach(() => {
  customProviderMocks.readCustomProviderKey.mockReset();
  customProviderMocks.createCustomProvider.mockReset().mockResolvedValue({ ok: true });
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
  const nameInput = screen.getByPlaceholderText('settings.providers.custom.fields.namePlaceholder');
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

function imageGenerationFromModelRouteProvider(): CustomProviderConfig {
  return {
    id: 'model-route-images',
    name: 'Model route images',
    auth: { method: 'apiKey' },
    runtimes: {
      codex: {
        baseUrl: 'https://chat.example.test/v1',
        wireProtocol: 'openai-chat',
        requestPath: '/chat/completions',
        supportsImageGeneration: true,
        models: [
          {
            id: 'routed-model',
            name: 'Routed Model',
            route: {
              baseUrl: 'https://responses.example.test/v1',
              wireProtocol: 'openai-responses',
              requestPath: '/responses',
            },
          },
        ],
      },
    },
  };
}

async function renderImageGenerationHelp() {
  const initial: CustomProviderConfig = {
    id: 'image-help-provider',
    name: 'Image help provider',
    auth: { method: 'apiKey' },
    runtimes: {
      codex: {
        baseUrl: 'https://images.example.test/v1',
        models: [{ id: 'responses-model', name: 'Responses Model' }],
        supportsImageGeneration: true,
      },
    },
  };
  customProviderMocks.readCustomProviderKey.mockResolvedValue(null);
  const user = userEvent.setup();
  render(<CustomProviderDialog initial={initial} onSaved={vi.fn()} onClose={vi.fn()} />);
  await waitFor(() => expect(customProviderMocks.readCustomProviderKey).toHaveBeenCalled());
  const advanced = screen.getByRole('button', {
    name: 'settings.providers.custom.fields.runtimeAdvanced',
  });
  await user.click(advanced);
  const help = screen.getByRole('button', {
    name: 'settings.providers.custom.fields.runtimeSupportsImageGenerationHelpLabel',
  });
  return { advanced, help, user };
}

async function renderImageGenerationReloadConfirmation(onSaved = vi.fn(), onClose = vi.fn()) {
  const initial: CustomProviderConfig = {
    id: 'reload-image-provider',
    name: 'Reload image provider',
    auth: { method: 'apiKey' },
    runtimes: {
      codex: {
        baseUrl: 'https://images.example.test/v1',
        models: [{ id: 'responses-model', name: 'Responses model' }],
      },
    },
  };
  customProviderMocks.readCustomProviderKey.mockResolvedValue(null);
  customProviderMocks.updateCustomProvider.mockResolvedValueOnce({
    ok: false,
    confirmationRequired: 'codex-image-generation-reload',
    busyCount: 3,
  });
  const user = userEvent.setup();
  render(<CustomProviderDialog initial={initial} onSaved={onSaved} onClose={onClose} />);
  await waitFor(() => expect(customProviderMocks.readCustomProviderKey).toHaveBeenCalled());
  await user.click(
    screen.getByRole('button', { name: 'settings.providers.custom.fields.runtimeAdvanced' }),
  );
  await user.click(
    screen.getByRole('checkbox', {
      name: 'settings.providers.custom.fields.runtimeSupportsImageGeneration',
    }),
  );
  await user.click(screen.getByRole('button', { name: 'settings.providers.custom.save' }));
  const confirmation = await screen.findByRole('dialog', {
    name: 'settings.providers.custom.imageGenerationReload.title',
  });
  return { confirmation, onClose, onSaved, user };
}

async function renderNewImageGenerationReloadConfirmation(onSaved = vi.fn(), onClose = vi.fn()) {
  customProviderMocks.createCustomProvider.mockResolvedValueOnce({
    ok: false,
    confirmationRequired: 'codex-image-generation-reload',
    busyCount: 3,
  });
  const user = userEvent.setup();
  render(<CustomProviderDialog onSaved={onSaved} onClose={onClose} />);
  await user.type(
    screen.getByPlaceholderText('settings.providers.custom.fields.namePlaceholder'),
    'New image provider',
  );
  await user.click(screen.getByRole('tab', { name: 'settings.providers.custom.protocol.codex' }));
  await user.type(
    screen.getByPlaceholderText('settings.providers.custom.fields.baseUrlPlaceholder'),
    'https://images.example.test/v1',
  );
  await user.type(
    screen.getByPlaceholderText('settings.providers.custom.fields.modelIdPlaceholder'),
    'responses-model',
  );
  await user.type(
    screen.getByPlaceholderText('settings.providers.custom.fields.modelNamePlaceholder'),
    'Responses model',
  );
  await user.click(
    screen.getByRole('button', { name: 'settings.providers.custom.fields.runtimeAdvanced' }),
  );
  await user.click(
    screen.getByRole('checkbox', {
      name: 'settings.providers.custom.fields.runtimeSupportsImageGeneration',
    }),
  );
  await user.click(screen.getByRole('button', { name: 'settings.providers.custom.save' }));
  const confirmation = await screen.findByRole('dialog', {
    name: 'settings.providers.custom.imageGenerationReload.title',
  });
  return { confirmation, onClose, onSaved, user };
}

describe('CustomProviderDialog accessibility', () => {
  it('opens the requested runtime and focuses the model context-window field', async () => {
    const initial: CustomProviderConfig = {
      id: 'deep-link-provider',
      name: 'Deep Link Provider',
      auth: { method: 'apiKey' },
      runtimes: {
        'claude-code': {
          baseUrl: 'https://claude.example.test',
          models: [{ id: 'claude-model', name: 'Claude Model' }],
        },
        codex: {
          baseUrl: 'https://codex.example.test',
          models: [{ id: 'target-model', name: 'Target Model' }],
        },
      },
    };
    customProviderMocks.readCustomProviderKey.mockResolvedValue(null);

    render(
      <CustomProviderDialog
        initial={initial}
        focusAgent="codex"
        focusModelId="target-model"
        onSaved={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    await waitFor(() => expect(customProviderMocks.readCustomProviderKey).toHaveBeenCalled());
    expect(
      screen
        .getByRole('tab', { name: 'settings.providers.custom.protocol.codex' })
        .getAttribute('aria-selected'),
    ).toBe('true');
    const contextWindow = screen.getByRole('textbox', {
      name: 'settings.providers.custom.fields.modelContextWindowTitle',
    });
    await waitFor(() => expect(document.activeElement).toBe(contextWindow));
  });

  it('cancels a pending manual create without discarding the Provider draft', async () => {
    const { confirmation, onClose, onSaved, user } =
      await renderNewImageGenerationReloadConfirmation();

    expect(within(confirmation).getByRole('button', { name: '保存并停止' })).toBeTruthy();
    await user.click(within(confirmation).getByRole('button', { name: '取消' }));

    expect(
      screen.queryByRole('dialog', {
        name: 'settings.providers.custom.imageGenerationReload.title',
      }),
    ).toBeNull();
    expect(
      screen.getByRole('dialog', { name: 'settings.providers.custom.dialog.createTitle' }),
    ).toBeTruthy();
    expect(customProviderMocks.createCustomProvider).toHaveBeenCalledOnce();
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('asks before manually creating an image Provider and X, Escape, or outside do not create it', async () => {
    const { confirmation, onClose, onSaved, user } =
      await renderNewImageGenerationReloadConfirmation();
    const pendingId = customProviderMocks.createCustomProvider.mock.calls[0]?.[0].id;
    expect(pendingId).toBeTruthy();
    expect(customProviderMocks.createCustomProvider).toHaveBeenCalledWith(
      expect.objectContaining({ id: pendingId }),
      {},
      { source: 'manual-settings' },
    );

    await user.click(
      within(confirmation).getByRole('button', {
        name: 'settings.providers.custom.imageGenerationReload.close',
      }),
    );
    expect(customProviderMocks.createCustomProvider).toHaveBeenCalledOnce();

    customProviderMocks.createCustomProvider.mockResolvedValueOnce({
      ok: false,
      confirmationRequired: 'codex-image-generation-reload',
      busyCount: 2,
    });
    await user.click(screen.getByRole('button', { name: 'settings.providers.custom.save' }));
    await screen.findByRole('dialog', {
      name: 'settings.providers.custom.imageGenerationReload.title',
    });
    await user.keyboard('{Escape}');
    expect(customProviderMocks.createCustomProvider).toHaveBeenCalledTimes(2);

    customProviderMocks.createCustomProvider.mockResolvedValueOnce({
      ok: false,
      confirmationRequired: 'codex-image-generation-reload',
      busyCount: 1,
    });
    await user.click(screen.getByRole('button', { name: 'settings.providers.custom.save' }));
    const outsideConfirmation = await screen.findByRole('dialog', {
      name: 'settings.providers.custom.imageGenerationReload.title',
    });
    const overlay = outsideConfirmation.previousElementSibling;
    expect(overlay).not.toBeNull();
    fireEvent.pointerDown(overlay!);
    fireEvent.click(overlay!);
    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', {
          name: 'settings.providers.custom.imageGenerationReload.title',
        }),
      ).toBeNull(),
    );
    expect(customProviderMocks.createCustomProvider).toHaveBeenCalledTimes(3);
    expect(customProviderMocks.createCustomProvider.mock.calls.map((call) => call[0].id)).toEqual([
      pendingId,
      pendingId,
      pendingId,
    ]);
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('creates once after interruption is confirmed', async () => {
    const onSaved = vi.fn();
    const { confirmation, user } = await renderNewImageGenerationReloadConfirmation(onSaved);
    const pendingConfig = customProviderMocks.createCustomProvider.mock.calls[0]?.[0];
    customProviderMocks.createCustomProvider.mockResolvedValueOnce({ ok: true });

    await user.click(
      within(confirmation).getByRole('button', {
        name: '保存并停止',
      }),
    );

    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(customProviderMocks.createCustomProvider).toHaveBeenCalledTimes(2);
    expect(customProviderMocks.createCustomProvider).toHaveBeenLastCalledWith(
      pendingConfig,
      {},
      {
        source: 'manual-settings',
        codexImageGenerationRestartPolicy: 'interrupt',
      },
    );
  });

  it('asks before a manual image-generation save and closes via X, Escape, or outside without saving', async () => {
    const { confirmation, onClose, onSaved, user } =
      await renderImageGenerationReloadConfirmation();
    expect(customProviderMocks.updateCustomProvider).toHaveBeenCalledWith(
      expect.any(Object),
      {},
      { source: 'manual-settings' },
    );
    expect(screen.getAllByRole('dialog', { hidden: true })).toHaveLength(2);

    await user.click(
      within(confirmation).getByRole('button', {
        name: 'settings.providers.custom.imageGenerationReload.close',
      }),
    );
    expect(
      screen.queryByRole('dialog', {
        name: 'settings.providers.custom.imageGenerationReload.title',
      }),
    ).toBeNull();
    expect(
      screen.getByRole('dialog', { name: 'settings.providers.custom.dialog.editTitle' }),
    ).toBeTruthy();
    expect(customProviderMocks.updateCustomProvider).toHaveBeenCalledTimes(1);

    customProviderMocks.updateCustomProvider.mockResolvedValueOnce({
      ok: false,
      confirmationRequired: 'codex-image-generation-reload',
      busyCount: 3,
    });
    await user.click(screen.getByRole('button', { name: 'settings.providers.custom.save' }));
    await screen.findByRole('dialog', {
      name: 'settings.providers.custom.imageGenerationReload.title',
    });
    await user.keyboard('{Escape}');
    expect(
      screen.queryByRole('dialog', {
        name: 'settings.providers.custom.imageGenerationReload.title',
      }),
    ).toBeNull();

    customProviderMocks.updateCustomProvider.mockResolvedValueOnce({
      ok: false,
      confirmationRequired: 'codex-image-generation-reload',
      busyCount: 3,
    });
    await user.click(screen.getByRole('button', { name: 'settings.providers.custom.save' }));
    const outsideConfirmation = await screen.findByRole('dialog', {
      name: 'settings.providers.custom.imageGenerationReload.title',
    });
    const overlay = outsideConfirmation.previousElementSibling;
    expect(overlay).not.toBeNull();
    fireEvent.pointerDown(overlay!);
    fireEvent.click(overlay!);
    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', {
          name: 'settings.providers.custom.imageGenerationReload.title',
        }),
      ).toBeNull(),
    );
    expect(customProviderMocks.updateCustomProvider).toHaveBeenCalledTimes(3);
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('cancels a pending manual update without discarding the Provider edits', async () => {
    const { confirmation, onClose, onSaved, user } =
      await renderImageGenerationReloadConfirmation();

    expect(within(confirmation).getByRole('button', { name: '保存并停止' })).toBeTruthy();
    await user.click(within(confirmation).getByRole('button', { name: '取消' }));

    expect(
      screen.queryByRole('dialog', {
        name: 'settings.providers.custom.imageGenerationReload.title',
      }),
    ).toBeNull();
    expect(
      screen.getByRole('dialog', { name: 'settings.providers.custom.dialog.editTitle' }),
    ).toBeTruthy();
    expect(customProviderMocks.updateCustomProvider).toHaveBeenCalledOnce();
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('saves with the interrupt policy only after explicit confirmation', async () => {
    const onSaved = vi.fn();
    const { confirmation, user } = await renderImageGenerationReloadConfirmation(onSaved);
    customProviderMocks.updateCustomProvider.mockResolvedValueOnce({ ok: true });

    await user.click(
      within(confirmation).getByRole('button', {
        name: '保存并停止',
      }),
    );
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(customProviderMocks.updateCustomProvider).toHaveBeenLastCalledWith(
      expect.any(Object),
      {},
      {
        source: 'manual-settings',
        codexImageGenerationRestartPolicy: 'interrupt',
      },
    );
  });

  it('keeps the confirmation open when saving after interruption fails', async () => {
    const onSaved = vi.fn();
    const { confirmation, user } = await renderImageGenerationReloadConfirmation(onSaved);
    customProviderMocks.updateCustomProvider.mockRejectedValueOnce(new Error('save failed'));

    await user.click(within(confirmation).getByRole('button', { name: '保存并停止' }));

    await waitFor(() =>
      expect(
        (within(confirmation).getByRole('button', { name: '保存并停止' }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    expect(
      screen.getByRole('dialog', {
        name: 'settings.providers.custom.imageGenerationReload.title',
      }),
    ).toBeTruthy();
    expect(onSaved).not.toHaveBeenCalled();
    expect(customProviderMocks.updateCustomProvider).toHaveBeenCalledTimes(2);
  });

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
    expect(
      customProviderMocks.updateCustomProvider.mock.calls[0]?.[0].runtimes.codex?.models,
    ).toEqual([
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
    await user.click(
      screen.getByRole('button', { name: 'settings.providers.custom.authMode.none' }),
    );
    await waitFor(() => expect(configuredBadge()).toBeNull());
    expect(document.body.textContent).not.toContain('configured-header-secret');
  });

  it('places the provider image capability below headers in a collapsed accessible disclosure', async () => {
    const initial: CustomProviderConfig = {
      id: 'image-provider',
      name: 'Image provider',
      auth: { method: 'apiKey' },
      runtimes: {
        codex: {
          baseUrl: 'https://images.example.test/v1',
          models: [{ id: 'responses-model', name: 'Responses Model' }],
          supportsImageGeneration: true,
        },
      },
    };
    customProviderMocks.readCustomProviderKey.mockResolvedValue(null);
    const consoleError = vi.spyOn(console, 'error');
    const onClose = vi.fn();

    const user = userEvent.setup();
    render(<CustomProviderDialog initial={initial} onSaved={vi.fn()} onClose={onClose} />);
    await waitFor(() => expect(customProviderMocks.readCustomProviderKey).toHaveBeenCalled());

    const headersLabel = screen.getByText('settings.providers.custom.fields.headers');
    const advanced = screen.getByRole('button', {
      name: 'settings.providers.custom.fields.runtimeAdvanced',
    });
    expect(
      headersLabel.compareDocumentPosition(advanced) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(advanced.getAttribute('aria-expanded')).toBe('false');
    expect(
      screen.queryByRole('checkbox', {
        name: 'settings.providers.custom.fields.runtimeSupportsImageGeneration',
      }),
    ).toBeNull();

    await user.click(advanced);
    const capability = screen.getByRole('checkbox', {
      name: 'settings.providers.custom.fields.runtimeSupportsImageGeneration',
    });
    expect((capability as HTMLInputElement).checked).toBe(true);
    expect(advanced.getAttribute('aria-expanded')).toBe('true');

    const help = screen.getByRole('button', {
      name: 'settings.providers.custom.fields.runtimeSupportsImageGenerationHelpLabel',
    });
    expect(help.getAttribute('aria-label')).toBe(
      'settings.providers.custom.fields.runtimeSupportsImageGenerationHelpLabel',
    );
    expect(help.querySelector('button')).toBeNull();
    const capabilityLabel = capability.closest('label');
    const capabilityRow = capabilityLabel?.parentElement;
    expect(capabilityLabel?.className).toContain('items-center');
    expect(capability.className).not.toContain('mt-0.5');
    expect(capabilityRow?.className).toContain('min-h-11');
    expect(capabilityRow?.className).toContain('items-center');

    const expectCompleteImageGenerationHelp = (content: HTMLElement) => {
      const helpContent = within(content);
      expect(
        helpContent.getByText(
          'settings.providers.custom.fields.runtimeSupportsImageGenerationConditionTitle',
        ),
      ).toBeTruthy();
      expect(
        helpContent.getByText(
          'settings.providers.custom.fields.runtimeSupportsImageGenerationCondition',
        ),
      ).toBeTruthy();
      expect(
        helpContent.getByText(
          'settings.providers.custom.fields.runtimeSupportsImageGenerationEndpointsTitle',
        ),
      ).toBeTruthy();
      expect(helpContent.getByText('/images/generations').tagName).toBe('CODE');
      expect(helpContent.getByText('/images/edits').tagName).toBe('CODE');
      expect(
        helpContent.getByText(
          'settings.providers.custom.fields.runtimeSupportsImageGenerationPermissionsTitle',
        ),
      ).toBeTruthy();
      expect(
        helpContent.getByText(
          'settings.providers.custom.fields.runtimeSupportsImageGenerationPermissions',
        ),
      ).toBeTruthy();
    };

    await user.hover(help);
    expectCompleteImageGenerationHelp(await screen.findByRole('tooltip'));
    expect(document.querySelectorAll('#custom-provider-image-generation-help-card')).toHaveLength(
      1,
    );
    await user.unhover(help);
    await user.hover(screen.getByRole('tooltip'));
    await act(() => new Promise((resolve) => window.setTimeout(resolve, 150)));
    expectCompleteImageGenerationHelp(screen.getByRole('tooltip'));
    await user.unhover(screen.getByRole('tooltip'));
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());

    await user.hover(help);
    expectCompleteImageGenerationHelp(await screen.findByRole('tooltip'));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
    expect(
      screen.getByRole('dialog', { name: 'settings.providers.custom.dialog.editTitle' }),
    ).toBeTruthy();
    expect(document.activeElement).toBe(help);
    expect(onClose).not.toHaveBeenCalled();
    await act(() => new Promise((resolve) => window.setTimeout(resolve, 0)));
    expect(screen.queryByRole('tooltip')).toBeNull();
    await user.unhover(help);

    await act(async () => help.focus());
    expect(screen.queryByRole('tooltip')).toBeNull();
    await act(async () => capability.focus());
    await act(async () => help.focus());
    expectCompleteImageGenerationHelp(await screen.findByRole('tooltip'));
    await act(async () => help.blur());
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());

    await user.hover(help);
    expectCompleteImageGenerationHelp(await screen.findByRole('tooltip'));
    await user.click(help);
    let helpPopover = await screen.findByRole('dialog', {
      name: 'settings.providers.custom.fields.runtimeSupportsImageGenerationHelpLabel',
    });
    expect(screen.queryByRole('tooltip')).toBeNull();
    expectCompleteImageGenerationHelp(helpPopover);
    await user.keyboard('{Escape}');
    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', {
          name: 'settings.providers.custom.fields.runtimeSupportsImageGenerationHelpLabel',
        }),
      ).toBeNull(),
    );
    expect(
      screen.getByRole('dialog', { name: 'settings.providers.custom.dialog.editTitle' }),
    ).toBeTruthy();
    expect(document.activeElement).toBe(help);
    expect(onClose).not.toHaveBeenCalled();
    await act(() => new Promise((resolve) => window.setTimeout(resolve, 0)));
    expect(screen.queryByRole('tooltip')).toBeNull();
    await user.unhover(help);

    await user.click(help);
    helpPopover = await screen.findByRole('dialog', {
      name: 'settings.providers.custom.fields.runtimeSupportsImageGenerationHelpLabel',
    });
    expectCompleteImageGenerationHelp(helpPopover);
    await user.unhover(help);
    await act(() => new Promise((resolve) => window.setTimeout(resolve, 150)));
    expect(
      screen.getByRole('dialog', {
        name: 'settings.providers.custom.fields.runtimeSupportsImageGenerationHelpLabel',
      }),
    ).toBeTruthy();

    await user.click(help);
    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', {
          name: 'settings.providers.custom.fields.runtimeSupportsImageGenerationHelpLabel',
        }),
      ).toBeNull(),
    );

    await user.click(help);
    helpPopover = await screen.findByRole('dialog', {
      name: 'settings.providers.custom.fields.runtimeSupportsImageGenerationHelpLabel',
    });
    expectCompleteImageGenerationHelp(helpPopover);
    await user.click(capability);
    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', {
          name: 'settings.providers.custom.fields.runtimeSupportsImageGenerationHelpLabel',
        }),
      ).toBeNull(),
    );

    await act(async () => help.focus());
    expectCompleteImageGenerationHelp(await screen.findByRole('tooltip'));
    await user.keyboard('{Enter}');
    await screen.findByRole('dialog', {
      name: 'settings.providers.custom.fields.runtimeSupportsImageGenerationHelpLabel',
    });
    await act(async () => capability.focus());
    expect(
      screen.getByRole('dialog', {
        name: 'settings.providers.custom.fields.runtimeSupportsImageGenerationHelpLabel',
      }),
    ).toBeTruthy();
    await user.keyboard('{Escape}');
    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', {
          name: 'settings.providers.custom.fields.runtimeSupportsImageGenerationHelpLabel',
        }),
      ).toBeNull(),
    );
    expect(
      screen.getByRole('dialog', { name: 'settings.providers.custom.dialog.editTitle' }),
    ).toBeTruthy();
    expect(document.activeElement).toBe(help);
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => capability.focus());
    await act(async () => help.focus());
    expectCompleteImageGenerationHelp(await screen.findByRole('tooltip'));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
    expect(document.activeElement).toBe(help);
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => capability.focus());
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();

    await act(async () => help.focus());
    expectCompleteImageGenerationHelp(await screen.findByRole('tooltip'));
    await user.keyboard(' ');
    await screen.findByRole('dialog', {
      name: 'settings.providers.custom.fields.runtimeSupportsImageGenerationHelpLabel',
    });
    await user.keyboard('{Escape}');
    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', {
          name: 'settings.providers.custom.fields.runtimeSupportsImageGenerationHelpLabel',
        }),
      ).toBeNull(),
    );

    expect(consoleError.mock.calls.flat().join('\n')).not.toMatch(
      /changing an (uncontrolled|controlled).*component/i,
    );
    consoleError.mockRestore();
  });

  it('lets the first real hover open after dismissing a focus-only preview', async () => {
    const { help, user } = await renderImageGenerationHelp();

    await act(async () => help.focus());
    await screen.findByRole('tooltip');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
    expect(document.activeElement).toBe(help);

    await act(async () => help.blur());
    await user.hover(help);
    expect(await screen.findByRole('tooltip')).toBeTruthy();
  });

  it('resets help interaction state when Advanced is collapsed and remounted', async () => {
    const { advanced, help, user } = await renderImageGenerationHelp();

    await act(async () => help.focus());
    await screen.findByRole('tooltip');
    await user.keyboard('{Escape}');
    await act(async () => help.blur());
    await user.click(advanced);
    expect(
      screen.queryByRole('button', {
        name: 'settings.providers.custom.fields.runtimeSupportsImageGenerationHelpLabel',
      }),
    ).toBeNull();

    await user.click(advanced);
    const remountedHelp = screen.getByRole('button', {
      name: 'settings.providers.custom.fields.runtimeSupportsImageGenerationHelpLabel',
    });
    await user.hover(remountedHelp);
    expect(await screen.findByRole('tooltip')).toBeTruthy();
  });

  it('suppresses only same-exit-frame pointer re-entry after Escape', async () => {
    const { help, user } = await renderImageGenerationHelp();

    await user.hover(help);
    await screen.findByRole('tooltip');
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.pointerEnter(help);
    expect(help.getAttribute('aria-expanded')).toBe('false');

    await act(() => new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve())));
    expect(help.getAttribute('aria-expanded')).toBe('false');
    fireEvent.pointerLeave(help);
    fireEvent.pointerEnter(help);
    await waitFor(() => expect(help.getAttribute('aria-expanded')).toBe('true'));
    expect(await screen.findByRole('tooltip')).toBeTruthy();
  });

  it('clears and omits the provider image capability when Codex loses a Responses route', async () => {
    const initial: CustomProviderConfig = {
      id: 'image-provider',
      name: 'Image provider',
      auth: { method: 'apiKey' },
      runtimes: {
        codex: {
          baseUrl: 'https://images.example.test/v1',
          models: [{ id: 'responses-model', name: 'Responses Model' }],
          supportsImageGeneration: true,
        },
      },
    };
    customProviderMocks.readCustomProviderKey.mockResolvedValue(null);

    const user = userEvent.setup();
    render(<CustomProviderDialog initial={initial} onSaved={vi.fn()} onClose={vi.fn()} />);
    await waitFor(() => expect(customProviderMocks.readCustomProviderKey).toHaveBeenCalled());
    await user.click(
      screen.getByRole('button', { name: 'settings.providers.custom.fields.runtimeAdvanced' }),
    );
    expect(
      (
        screen.getByRole('checkbox', {
          name: 'settings.providers.custom.fields.runtimeSupportsImageGeneration',
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);

    await user.click(
      screen.getByRole('button', { name: 'settings.providers.custom.wireProtocol.chat' }),
    );
    expect(
      screen.queryByRole('button', {
        name: 'settings.providers.custom.fields.runtimeAdvanced',
      }),
    ).toBeNull();

    await user.click(screen.getByRole('button', { name: 'settings.providers.custom.save' }));
    await waitFor(() => expect(customProviderMocks.updateCustomProvider).toHaveBeenCalledOnce());
    expect(
      customProviderMocks.updateCustomProvider.mock.calls[0]?.[0].runtimes.codex
        ?.supportsImageGeneration,
    ).toBeUndefined();
  });

  it('immediately clears image generation when the picker replaces the last Responses override', async () => {
    const fetchProviderModels = vi.fn(async () => ({
      ok: true as const,
      models: [
        { id: 'routed-model', name: 'Routed Model' },
        { id: 'replacement-model', name: 'Replacement Model' },
      ],
    }));
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        maker: {
          listProviderPresets: vi.fn(async () => ({ presets: [] })),
          testProviderConnection: vi.fn(async () => ({ ok: true, latencyMs: 1 })),
          fetchProviderModels,
        },
      },
    });
    customProviderMocks.readCustomProviderKey.mockResolvedValue(null);

    const user = userEvent.setup();
    render(
      <CustomProviderDialog
        initial={imageGenerationFromModelRouteProvider()}
        onSaved={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() => expect(customProviderMocks.readCustomProviderKey).toHaveBeenCalled());
    await user.click(
      screen.getByRole('button', { name: 'settings.providers.custom.fields.runtimeAdvanced' }),
    );
    expect(
      (
        screen.getByRole('checkbox', {
          name: 'settings.providers.custom.fields.runtimeSupportsImageGeneration',
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);

    await user.click(
      screen.getByRole('button', { name: 'settings.providers.custom.fetch.button' }),
    );
    await screen.findByRole('heading', {
      name: 'settings.providers.custom.fetch.pickerTitle',
    });
    await user.click(screen.getByRole('checkbox', { name: /Routed Model/ }));
    await user.click(screen.getByRole('checkbox', { name: /Replacement Model/ }));
    await user.click(
      screen.getByRole('button', { name: 'settings.providers.custom.fetch.confirm' }),
    );

    expect(
      screen.queryByRole('button', {
        name: 'settings.providers.custom.fields.runtimeAdvanced',
      }),
    ).toBeNull();

    // 重新形成 Responses 前门不会恢复旧 true；必须由用户再次显式开启。
    await user.click(
      screen.getByRole('button', { name: 'settings.providers.custom.wireProtocol.responses' }),
    );
    const capability = screen.getByRole('checkbox', {
      name: 'settings.providers.custom.fields.runtimeSupportsImageGeneration',
    }) as HTMLInputElement;
    expect(capability.checked).toBe(false);
    await user.click(capability);
    expect(capability.checked).toBe(true);
  });

  it('immediately clears image generation when deleting the last Responses override row', async () => {
    customProviderMocks.readCustomProviderKey.mockResolvedValue(null);

    const user = userEvent.setup();
    render(
      <CustomProviderDialog
        initial={imageGenerationFromModelRouteProvider()}
        onSaved={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() => expect(customProviderMocks.readCustomProviderKey).toHaveBeenCalled());
    await user.click(
      screen.getByRole('button', { name: 'settings.providers.custom.fields.runtimeAdvanced' }),
    );
    expect(
      (
        screen.getByRole('checkbox', {
          name: 'settings.providers.custom.fields.runtimeSupportsImageGeneration',
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);

    const removeButtons = screen.getAllByRole('button', {
      name: 'settings.providers.custom.fields.removeRow',
    });
    await user.click(removeButtons[0]!);
    expect(
      screen.queryByRole('button', {
        name: 'settings.providers.custom.fields.runtimeAdvanced',
      }),
    ).toBeNull();

    await user.click(
      screen.getByRole('button', { name: 'settings.providers.custom.wireProtocol.responses' }),
    );
    const capability = screen.getByRole('checkbox', {
      name: 'settings.providers.custom.fields.runtimeSupportsImageGeneration',
    }) as HTMLInputElement;
    expect(capability.checked).toBe(false);
    await user.click(capability);
    expect(capability.checked).toBe(true);
  });
});
