// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

vi.mock('@/lib/toast', () => ({ toast }));

vi.mock('@/lib/customProviders', () => ({
  createCustomProvider: vi.fn(async () => {}),
  readCustomProviderKey: vi.fn(async () => null),
  replaceCustomProviderModelId: (model: { name: string }, id: string) => ({ ...model, id }),
  updateCustomProvider: vi.fn(async () => {}),
}));

vi.mock('@/lib/customProviderId', () => ({
  uniqueCustomProviderId: (name: string) => name.toLowerCase().replaceAll(' ', '-'),
}));

import { CustomProviderDialog } from '../CustomProviderDialog';
import { createCustomProvider, updateCustomProvider } from '@/lib/customProviders';

function renderDialog(initial?: React.ComponentProps<typeof CustomProviderDialog>['initial']) {
  return render(
    React.createElement(CustomProviderDialog, {
      initial,
      onClose: vi.fn(),
      onSaved: vi.fn(),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    maker: {
      listProviderPresets: vi.fn(async () => ({ presets: [] })),
      fetchProviderModels: vi.fn(async () => ({ ok: false, code: 'NETWORK' })),
      testProviderConnection: vi.fn(async () => ({ ok: false, code: 'NETWORK' })),
    },
  };
});

afterEach(() => cleanup());

describe('CustomProviderDialog progressive connection settings', () => {
  it('hides advanced connection fields by default and reveals them from an accessible disclosure', async () => {
    renderDialog();
    await waitFor(() =>
      expect(window.electronAPI.maker.listProviderPresets).toHaveBeenCalledOnce(),
    );

    const advanced = screen.getByRole('button', {
      name: 'settings.providers.custom.advanced.label',
    });
    expect(advanced.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByText('settings.providers.custom.fields.models')).not.toBeNull();
    expect(screen.queryByText('settings.providers.custom.fields.requestPath')).toBeNull();
    expect(screen.queryByText('settings.providers.custom.fields.headers')).toBeNull();

    fireEvent.click(advanced);

    expect(advanced.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('settings.providers.custom.fields.requestPath')).not.toBeNull();
    expect(screen.getByText('settings.providers.custom.fields.headers')).not.toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: 'settings.providers.custom.protocol.codex' }));
    expect(screen.getByText('settings.providers.custom.fields.wireProtocol')).not.toBeNull();
  });

  it('saves a new handwritten Codex endpoint as OpenAI Chat without exposing protocol controls', async () => {
    renderDialog();

    fireEvent.change(
      screen.getByPlaceholderText('settings.providers.custom.fields.namePlaceholder'),
      {
        target: { value: 'Chat endpoint' },
      },
    );
    fireEvent.click(screen.getByRole('tab', { name: 'settings.providers.custom.protocol.codex' }));
    expect(screen.queryByText('settings.providers.custom.fields.wireProtocol')).toBeNull();
    fireEvent.change(
      screen.getByPlaceholderText('settings.providers.custom.fields.baseUrlPlaceholder'),
      {
        target: { value: 'https://chat.example/v1' },
      },
    );
    fireEvent.change(
      screen.getByPlaceholderText('settings.providers.custom.fields.modelIdPlaceholder'),
      {
        target: { value: 'chat-model' },
      },
    );
    fireEvent.change(
      screen.getByPlaceholderText('settings.providers.custom.fields.modelNamePlaceholder'),
      {
        target: { value: 'Chat model' },
      },
    );
    fireEvent.click(screen.getByText('settings.providers.custom.save'));

    await waitFor(() => expect(createCustomProvider).toHaveBeenCalledOnce());
    expect(vi.mocked(createCustomProvider).mock.calls[0][0]).toMatchObject({
      name: 'Chat endpoint',
      runtimes: {
        codex: {
          baseUrl: 'https://chat.example/v1',
          wireProtocol: 'openai-chat',
          models: [{ id: 'chat-model', name: 'Chat model' }],
        },
      },
    });
  });

  it('keeps manual model entry and saving available after fetching models fails', async () => {
    renderDialog();

    fireEvent.change(
      screen.getByPlaceholderText('settings.providers.custom.fields.namePlaceholder'),
      {
        target: { value: 'Manual fallback' },
      },
    );
    fireEvent.change(
      screen.getByPlaceholderText('settings.providers.custom.fields.baseUrlPlaceholder'),
      {
        target: { value: 'https://provider.example/v1' },
      },
    );
    fireEvent.click(screen.getByText('settings.providers.custom.fetch.button'));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('providerError.NETWORK'));

    fireEvent.change(
      screen.getByPlaceholderText('settings.providers.custom.fields.modelIdPlaceholder'),
      {
        target: { value: 'manual-model' },
      },
    );
    fireEvent.change(
      screen.getByPlaceholderText('settings.providers.custom.fields.modelNamePlaceholder'),
      {
        target: { value: 'Manual model' },
      },
    );
    fireEvent.click(screen.getByText('settings.providers.custom.save'));

    await waitFor(() => expect(createCustomProvider).toHaveBeenCalledOnce());
    expect(vi.mocked(createCustomProvider).mock.calls[0][0]).toMatchObject({
      name: 'Manual fallback',
      runtimes: {
        'claude-code': {
          baseUrl: 'https://provider.example/v1',
          models: [{ id: 'manual-model', name: 'Manual model' }],
        },
      },
    });
  });

  it('accepts a full Anthropic Messages URL without sending a duplicated request path', async () => {
    renderDialog();
    fireEvent.change(
      screen.getByPlaceholderText('settings.providers.custom.fields.baseUrlPlaceholder'),
      {
        target: { value: 'https://token-plan.example/apps/anthropic/v1/messages' },
      },
    );
    fireEvent.change(
      screen.getByPlaceholderText('settings.providers.custom.fields.modelIdPlaceholder'),
      { target: { value: 'qwen-test' } },
    );

    fireEvent.click(screen.getByText('settings.providers.custom.test.button'));

    await waitFor(() =>
      expect(window.electronAPI.maker.testProviderConnection).toHaveBeenCalledWith({
        kind: 'adhoc',
        spec: expect.objectContaining({
          agent: 'claude-code',
          baseUrl: 'https://token-plan.example/apps/anthropic',
          modelId: 'qwen-test',
        }),
      }),
    );
    const request = vi.mocked(window.electronAPI.maker.testProviderConnection).mock.calls[0][0];
    expect(request.kind).toBe('adhoc');
    if (request.kind !== 'adhoc') throw new Error('expected an adhoc connection test');
    expect(request.spec).not.toHaveProperty('requestPath');
  });

  it('normalizes a full Anthropic Messages URL selected for Pi', async () => {
    renderDialog();
    fireEvent.click(screen.getByRole('tab', { name: 'settings.providers.custom.protocol.pi' }));
    fireEvent.click(screen.getByText('settings.providers.custom.wireProtocol.piAnthropic'));
    fireEvent.change(
      screen.getByPlaceholderText('settings.providers.custom.fields.baseUrlPlaceholder'),
      {
        target: { value: 'https://token-plan.example/apps/anthropic/v1/messages' },
      },
    );
    fireEvent.change(
      screen.getByPlaceholderText('settings.providers.custom.fields.modelIdPlaceholder'),
      { target: { value: 'qwen-test' } },
    );

    fireEvent.click(screen.getByText('settings.providers.custom.test.button'));

    await waitFor(() =>
      expect(window.electronAPI.maker.testProviderConnection).toHaveBeenCalledWith({
        kind: 'adhoc',
        spec: expect.objectContaining({
          agent: 'pi',
          baseUrl: 'https://token-plan.example/apps/anthropic',
          wireProtocol: 'anthropic-messages',
          modelId: 'qwen-test',
        }),
      }),
    );
    const request = vi.mocked(window.electronAPI.maker.testProviderConnection).mock.calls[0][0];
    expect(request.kind).toBe('adhoc');
    if (request.kind !== 'adhoc') throw new Error('expected an adhoc connection test');
    expect(request.spec).not.toHaveProperty('requestPath');
  });

  it('normalizes a full Chat Completions URL before saving', async () => {
    renderDialog();
    fireEvent.change(
      screen.getByPlaceholderText('settings.providers.custom.fields.namePlaceholder'),
      { target: { value: 'DeepSeek full endpoint' } },
    );
    fireEvent.click(screen.getByRole('tab', { name: 'settings.providers.custom.protocol.codex' }));
    fireEvent.change(
      screen.getByPlaceholderText('settings.providers.custom.fields.baseUrlPlaceholder'),
      { target: { value: 'https://api.deepseek.example/v1/chat/completions' } },
    );
    fireEvent.change(
      screen.getByPlaceholderText('settings.providers.custom.fields.modelIdPlaceholder'),
      { target: { value: 'deepseek-chat' } },
    );
    fireEvent.change(
      screen.getByPlaceholderText('settings.providers.custom.fields.modelNamePlaceholder'),
      { target: { value: 'DeepSeek Chat' } },
    );

    fireEvent.click(screen.getByText('settings.providers.custom.save'));

    await waitFor(() => expect(createCustomProvider).toHaveBeenCalledOnce());
    expect(vi.mocked(createCustomProvider).mock.calls[0][0]).toMatchObject({
      runtimes: {
        codex: {
          baseUrl: 'https://api.deepseek.example/v1',
          models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }],
        },
      },
    });
  });

  it('normalizes a full endpoint when a saved request path equals the protocol default', async () => {
    renderDialog({
      id: 'saved-responses',
      name: 'Saved Responses',
      runtimes: {
        codex: {
          baseUrl: 'https://responses.example/v1',
          requestPath: '/responses',
          wireProtocol: 'openai-responses',
          models: [{ id: 'responses-model', name: 'Responses model' }],
        },
      },
    });
    fireEvent.click(screen.getByRole('tab', { name: 'settings.providers.custom.protocol.codex' }));
    fireEvent.change(
      screen.getByPlaceholderText('settings.providers.custom.fields.baseUrlPlaceholder'),
      { target: { value: 'https://responses.example/v1/responses' } },
    );

    fireEvent.click(screen.getByText('settings.providers.custom.save'));

    await waitFor(() => expect(updateCustomProvider).toHaveBeenCalledOnce());
    expect(vi.mocked(updateCustomProvider).mock.calls[0][0]).toMatchObject({
      runtimes: {
        codex: {
          baseUrl: 'https://responses.example/v1',
          models: [{ id: 'responses-model', name: 'Responses model' }],
        },
      },
    });
    const savedCodex = vi.mocked(updateCustomProvider).mock.calls[0][0].runtimes.codex;
    expect(savedCodex).not.toHaveProperty('requestPath');
  });
});
