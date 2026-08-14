// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProviderPreset } from '@cindy/model-providers';

const i18nState = vi.hoisted(() => ({ language: 'zh-TW' }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: i18nState.language },
  }),
}));

vi.mock('@/lib/toast', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock('@/lib/customProviderId', () => ({
  uniqueCustomProviderId: () => 'localized-provider',
}));

vi.mock('@/lib/customProviders', () => ({
  createCustomProvider: vi.fn(async () => undefined),
  readCustomProviderKey: vi.fn(),
  replaceCustomProviderModelId: vi.fn(),
  setCustomProviderModelReasoning: vi.fn(),
  setCustomProviderModelReasoningEffort: vi.fn(),
  setCustomProviderModelSupportsImageInput: vi.fn(),
  updateCustomProvider: vi.fn(),
}));

import { CustomProviderDialog } from '@/components/settings/CustomProviderDialog';
import { createCustomProvider } from '@/lib/customProviders';

const localizedPreset: ProviderPreset = {
  id: 'localized-provider',
  name: '简体供应商',
  nameEn: 'English Provider',
  nameZhTW: '繁體供應商',
  authMethod: 'none',
  runtimes: {
    codex: {
      baseUrl: 'http://127.0.0.1:4000/v1',
      models: [{ id: 'local-model', name: 'Local Model' }],
    },
  },
};

function renderDialog(onClose = vi.fn()) {
  return {
    onClose,
    ...render(<CustomProviderDialog onSaved={vi.fn()} onClose={onClose} existingIds={[]} />),
  };
}

beforeEach(() => {
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    maker: {
      listProviderPresets: vi.fn(async () => ({ presets: [localizedPreset] })),
      fetchProviderModels: vi.fn(async () => ({
        ok: true,
        models: [
          { id: 'local-model', name: 'Local Model' },
          { id: 'new-model', name: 'New Model' },
        ],
      })),
    },
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('CustomProviderDialog preset locale ownership', () => {
  it.each([
    ['zh-TW', '繁體供應商'],
    ['en', 'English Provider'],
  ])(
    'uses presetDisplayName for menu, trigger, prefill, and saved name in %s',
    async (locale, expectedName) => {
      i18nState.language = locale;
      renderDialog();

      const trigger = await screen.findByRole('button', {
        name: 'settings.providers.custom.presets.label',
      });
      expect(trigger.textContent).toContain('settings.providers.custom.presets.placeholder');

      fireEvent.click(trigger);
      const option = await screen.findByRole('option', { name: expectedName });
      fireEvent.click(option);

      expect(trigger.textContent).toContain(expectedName);
      expect(screen.getByDisplayValue(expectedName)).not.toBeNull();

      fireEvent.click(screen.getByRole('button', { name: 'settings.providers.custom.save' }));
      await waitFor(() => expect(createCustomProvider).toHaveBeenCalledTimes(1));
      expect(vi.mocked(createCustomProvider).mock.calls[0][0].name).toBe(expectedName);
    },
  );

  it('dismisses only the topmost preset menu on Escape and preserves unsaved form edits', async () => {
    i18nState.language = 'zh-TW';
    const { onClose } = renderDialog();

    const trigger = await screen.findByRole('button', {
      name: 'settings.providers.custom.presets.label',
    });

    const heading = screen.getByRole('heading', {
      name: 'settings.providers.custom.dialog.createTitle',
    });
    expect(heading.parentElement?.parentElement?.querySelector('button')).toBeNull();

    const nameInput = screen.getByPlaceholderText(
      'settings.providers.custom.fields.namePlaceholder',
    );
    fireEvent.change(nameInput, { target: { value: 'Unsaved provider' } });
    fireEvent.click(trigger);
    expect(await screen.findByRole('option', { name: '繁體供應商' })).not.toBeNull();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('option', { name: '繁體供應商' })).toBeNull();
    expect(screen.getByDisplayValue('Unsaved provider')).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('dismisses only the topmost preset menu on a scrim gesture', async () => {
    i18nState.language = 'zh-TW';
    const { container, onClose } = renderDialog();

    const trigger = await screen.findByRole('button', {
      name: 'settings.providers.custom.presets.label',
    });
    fireEvent.click(trigger);
    const option = await screen.findByRole('option', { name: '繁體供應商' });
    // 等 layout effect 把 childLayer 写进 childLayerRef。只等 option 出现不够:
    // Windows CI 上 rAF 也可能早于 useLayoutEffect, 第一个 pointerDown 会关整表。
    await waitFor(() => {
      expect(option.isConnected).toBe(true);
    });
    await new Promise<void>((resolve) => { requestAnimationFrame(() => resolve()); });
    await new Promise<void>((resolve) => { requestAnimationFrame(() => resolve()); });

    const scrim = container.firstElementChild as Element;
    fireEvent.pointerDown(scrim);
    await waitFor(() => {
      expect(screen.queryByRole('option', { name: '繁體供應商' })).toBeNull();
    });
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.pointerDown(scrim);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps Cancel as a direct form dismissal without a duplicate top-right button', async () => {
    i18nState.language = 'zh-TW';
    const { onClose } = renderDialog();

    await screen.findByRole('button', { name: 'settings.providers.custom.presets.label' });
    fireEvent.click(screen.getByRole('button', { name: 'settings.providers.custom.cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['isComposing', { isComposing: true }],
    ['keyCode 229', { keyCode: 229 }],
  ])('keeps IME Escape inside composition for %s', async (_label, eventInit) => {
    i18nState.language = 'zh-TW';
    const { onClose } = renderDialog();

    const trigger = await screen.findByRole('button', {
      name: 'settings.providers.custom.presets.label',
    });
    fireEvent.click(trigger);
    expect(await screen.findByRole('option', { name: '繁體供應商' })).not.toBeNull();
    await new Promise<void>((resolve) => { requestAnimationFrame(() => resolve()); });

    fireEvent.keyDown(document, { key: 'Escape', ...eventInit });
    expect(screen.getByRole('option', { name: '繁體供應商' })).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('dismisses the model picker before the underlying form on Escape', async () => {
    i18nState.language = 'zh-TW';
    const { onClose } = renderDialog();

    const trigger = await screen.findByRole('button', {
      name: 'settings.providers.custom.presets.label',
    });
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole('option', { name: '繁體供應商' }));

    fireEvent.click(screen.getByRole('tab', { name: 'settings.providers.custom.protocol.codex' }));
    fireEvent.click(screen.getByRole('button', { name: 'settings.providers.custom.fetch.button' }));
    expect(
      await screen.findByRole('heading', {
        name: 'settings.providers.custom.fetch.pickerTitle',
      }),
    ).not.toBeNull();

    // Radix Popover 的退场 DismissableLayer 会短暂保留 document-capture
    // listener。显式模拟它消费 Escape，确保 window-capture 的当前层 owner
    // 先结算 picker，而不是被一个已关闭的菜单吞掉。
    const staleLayerListener = vi.fn((event: KeyboardEvent) => event.preventDefault());
    document.addEventListener('keydown', staleLayerListener, true);
    try {
      fireEvent.keyDown(document, { key: 'Escape' });
      await waitFor(() =>
        expect(
          screen.queryByRole('heading', { name: 'settings.providers.custom.fetch.pickerTitle' }),
        ).toBeNull(),
      );
      expect(staleLayerListener).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();

      fireEvent.keyDown(document, { key: 'Escape' });
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener('keydown', staleLayerListener, true);
    }
  });

  it('dismisses only the model picker on its scrim gesture', async () => {
    i18nState.language = 'zh-TW';
    const { onClose } = renderDialog();

    const trigger = await screen.findByRole('button', {
      name: 'settings.providers.custom.presets.label',
    });
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole('option', { name: '繁體供應商' }));
    fireEvent.click(screen.getByRole('tab', { name: 'settings.providers.custom.protocol.codex' }));
    fireEvent.click(screen.getByRole('button', { name: 'settings.providers.custom.fetch.button' }));

    const pickerHeading = await screen.findByRole('heading', {
      name: 'settings.providers.custom.fetch.pickerTitle',
    });
    const pickerScrim = pickerHeading.closest('[role="dialog"]')?.parentElement;
    expect(pickerScrim).not.toBeNull();
    fireEvent.pointerDown(pickerScrim as Element);

    expect(
      screen.queryByRole('heading', { name: 'settings.providers.custom.fetch.pickerTitle' }),
    ).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });
});
