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

vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => children,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => children,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
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

      const option = await screen.findByRole('option', { name: expectedName });
      fireEvent.click(option);

      expect(trigger.textContent).toContain(expectedName);
      expect(screen.getByDisplayValue(expectedName)).not.toBeNull();

      fireEvent.click(screen.getByRole('button', { name: 'settings.providers.custom.save' }));
      await waitFor(() => expect(createCustomProvider).toHaveBeenCalledTimes(1));
      expect(vi.mocked(createCustomProvider).mock.calls[0][0].name).toBe(expectedName);
    },
  );

  it('uses only Cancel, Escape, and the scrim as form dismissal affordances', async () => {
    i18nState.language = 'zh-TW';
    const { container, onClose } = renderDialog();

    await screen.findByRole('option', { name: '繁體供應商' });

    const heading = screen.getByRole('heading', {
      name: 'settings.providers.custom.dialog.createTitle',
    });
    expect(heading.parentElement?.parentElement?.querySelector('button')).toBeNull();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(container.firstElementChild as Element);
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
