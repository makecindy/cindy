// @vitest-environment jsdom

import { cleanup, createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PiModelApi, ProviderPreset } from '@cindy/model-providers';

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
  setCustomProviderModelPiApi: vi.fn(
    (models: Array<Record<string, unknown>>, index: number, piApi?: string) =>
      models.map((model, modelIndex) => {
        if (modelIndex !== index) return model;
        const next = { ...model };
        if (piApi) next.piApi = piApi;
        else delete next.piApi;
        return next;
      }),
  ),
  createCustomProvider: vi.fn(async () => undefined),
  customProviderWireProtocolForSave: vi.fn(
    (agent: string, wireProtocol: string, defaultWireProtocol: string) =>
      agent === 'pi' || wireProtocol !== defaultWireProtocol ? wireProtocol : undefined,
  ),
  piCatalogProviderIdAfterRouteEdit: (
    _agent: string,
    previous: { baseUrl: string; wireProtocol: string; piCatalogProviderId?: string },
    next: { baseUrl: string; wireProtocol: string; piCatalogProviderId?: string },
  ) =>
    next.piCatalogProviderId === previous.piCatalogProviderId &&
    (next.baseUrl !== previous.baseUrl || next.wireProtocol !== previous.wireProtocol)
      ? undefined
      : next.piCatalogProviderId,
  readCustomProviderKey: vi.fn(),
  replaceCustomProviderModelId: vi.fn(),
  setCustomProviderModelReasoning: vi.fn(),
  setCustomProviderModelReasoningEffort: vi.fn(),
  setCustomProviderModelSupportsImageInput: vi.fn(),
  updateCustomProvider: vi.fn(),
}));

import {
  CustomProviderDialog,
  PiModelProtocolDropdown,
} from '@/components/settings/CustomProviderDialog';
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
      models: [
        {
          id: 'local-model',
          name: 'Local Model',
          route: {
            baseUrl: 'http://127.0.0.1:4000/v1',
            wireProtocol: 'openai-responses',
            requestPath: '/responses',
          },
        },
      ],
    },
  },
};

const piProtocolPreset: ProviderPreset = {
  id: 'pi-protocol-preset',
  name: 'PI Protocol Preset',
  nameEn: 'PI Protocol Preset',
  authMethod: 'none',
  runtimes: {
    pi: {
      baseUrl: 'http://127.0.0.1:4001/v1',
      wireProtocol: 'openai-responses',
      models: [
        {
          id: 'deepseek-v4-pro',
          name: 'DeepSeek V4 Pro',
          piApi: 'openai-responses',
        },
      ],
    },
  },
};

const legacyMissingPiProtocolPreset: ProviderPreset = {
  id: 'legacy-missing-pi-protocol',
  name: 'Legacy Missing Pi Protocol',
  authMethod: 'none',
  runtimes: {
    'claude-code': {
      baseUrl: 'http://127.0.0.1:4010/anthropic',
      models: [{ id: 'model-a', name: 'Model A' }],
    },
    pi: {
      baseUrl: 'http://127.0.0.1:4010/pi',
      models: [{ id: 'model-a', name: 'Model A' }],
    },
  },
};

function renderDialog(onClose = vi.fn()) {
  return {
    onClose,
    ...render(<CustomProviderDialog onSaved={vi.fn()} onClose={onClose} existingIds={[]} />),
  };
}

async function findReadyPresetTrigger() {
  const trigger = await screen.findByRole('button', {
    name: 'settings.providers.custom.presets.label',
  });
  // The dialog moves focus in rAF after mounting. Opening the Radix Popover before
  // that focus settles can immediately dismiss it and leave tests using a stale node.
  await waitFor(() => {
    expect(document.activeElement).toBe(
      screen.getByPlaceholderText('settings.providers.custom.fields.namePlaceholder'),
    );
  });
  return trigger;
}

// jsdom exposes keyCode as read-only. Testing Library's keyDown helper can recreate
// the event and lose 229 on Windows, so dispatch the exact native event we configure.
function dispatchEscape(
  target: Document | Element,
  init: { isComposing?: boolean; keyCode?: number } = {},
) {
  const event = new KeyboardEvent('keydown', {
    key: 'Escape',
    bubbles: true,
    cancelable: true,
    composed: true,
    isComposing: Boolean(init.isComposing),
  });
  if (init.keyCode !== undefined) {
    const keyCode = init.keyCode;
    for (const prop of ['keyCode', 'which'] as const) {
      Object.defineProperty(event, prop, {
        configurable: true,
        get: () => keyCode,
      });
    }
  }
  target.dispatchEvent(event);
}

beforeEach(() => {
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    maker: {
      listProviderPresets: vi.fn(async () => ({
        presets: [localizedPreset, piProtocolPreset, legacyMissingPiProtocolPreset],
      })),
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

      const trigger = await findReadyPresetTrigger();
      expect(trigger.textContent).toContain('settings.providers.custom.presets.placeholder');

      fireEvent.click(trigger);
      const option = await screen.findByRole('option', { name: expectedName });
      fireEvent.click(option);

      await waitFor(() => {
        expect(trigger.textContent).toContain(expectedName);
        expect(screen.getByDisplayValue(expectedName)).not.toBeNull();
      });

      fireEvent.click(screen.getByRole('button', { name: 'settings.providers.custom.save' }));
      await waitFor(() => expect(createCustomProvider).toHaveBeenCalledTimes(1));
      expect(vi.mocked(createCustomProvider).mock.calls[0][0].name).toBe(expectedName);
    },
  );

  it('skips a legacy preset Pi runtime instead of guessing Chat', async () => {
    renderDialog();
    const trigger = await findReadyPresetTrigger();
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole('option', { name: 'Legacy Missing Pi Protocol' }));

    fireEvent.click(screen.getByRole('button', { name: 'settings.providers.custom.save' }));
    await waitFor(() => expect(createCustomProvider).toHaveBeenCalledTimes(1));
    expect(vi.mocked(createCustomProvider).mock.calls[0][0].runtimes.pi).toBeUndefined();
  });

  it('dismisses only the topmost preset menu on Escape and preserves unsaved form edits', async () => {
    i18nState.language = 'zh-TW';
    const { onClose } = renderDialog();

    const trigger = await findReadyPresetTrigger();

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

    const trigger = await findReadyPresetTrigger();
    fireEvent.click(trigger);
    const option = await screen.findByRole('option', { name: '繁體供應商' });
    // 等 layout effect 把 childLayer 写进 childLayerRef。只等 option 出现不够:
    // Windows CI 上 rAF 也可能早于 useLayoutEffect, 第一个 pointerDown 会关整表。
    await waitFor(() => {
      expect(option.isConnected).toBe(true);
    });
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });

    const scrim = container.firstElementChild as Element;
    fireEvent.pointerDown(scrim);
    await waitFor(() => {
      expect(screen.queryByRole('option', { name: '繁體供應商' })).toBeNull();
    });
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.pointerDown(scrim);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not consume runtime tab or input pointerdowns while a child layer is open', async () => {
    i18nState.language = 'zh-TW';
    const { onClose } = renderDialog();

    const trigger = await screen.findByRole('button', {
      name: 'settings.providers.custom.presets.label',
    });
    const openPresetMenu = async () => {
      fireEvent.click(trigger);
      expect(await screen.findByRole('option', { name: '繁體供應商' })).not.toBeNull();
    };

    await openPresetMenu();
    const piTab = screen.getByRole('tab', {
      name: 'settings.providers.custom.protocol.pi',
    });
    const tabPointerDown = createEvent.pointerDown(piTab, { button: 0 });
    fireEvent(piTab, tabPointerDown);
    expect(tabPointerDown.defaultPrevented).toBe(false);
    fireEvent.click(piTab);
    expect(piTab.getAttribute('aria-selected')).toBe('true');

    await openPresetMenu();
    const baseUrl = screen.getByPlaceholderText(
      'settings.providers.custom.fields.baseUrlPlaceholder',
    );
    const inputPointerDown = createEvent.pointerDown(baseUrl, { button: 0 });
    fireEvent(baseUrl, inputPointerDown);
    expect(inputPointerDown.defaultPrevented).toBe(false);
    fireEvent.change(baseUrl, { target: { value: 'https://runtime.example.test/v1' } });
    expect((baseUrl as HTMLInputElement).value).toBe('https://runtime.example.test/v1');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('keeps Cancel as a direct form dismissal without a duplicate top-right button', async () => {
    i18nState.language = 'zh-TW';
    const { onClose } = renderDialog();

    await findReadyPresetTrigger();
    fireEvent.click(screen.getByRole('button', { name: 'settings.providers.custom.cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps an existing model route through fetch picker confirmation and save', async () => {
    i18nState.language = 'zh-TW';
    renderDialog();

    const trigger = await findReadyPresetTrigger();
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole('option', { name: '繁體供應商' }));
    fireEvent.click(screen.getByRole('tab', { name: 'settings.providers.custom.protocol.codex' }));
    fireEvent.click(screen.getByRole('button', { name: 'settings.providers.custom.fetch.button' }));
    await screen.findByRole('heading', {
      name: 'settings.providers.custom.fetch.pickerTitle',
    });
    fireEvent.click(
      screen.getByRole('button', { name: /settings\.providers\.custom\.fetch\.confirm/ }),
    );
    await waitFor(() => {
      expect(
        screen.queryByRole('heading', {
          name: 'settings.providers.custom.fetch.pickerTitle',
        }),
      ).toBeNull();
    });
    fireEvent.click(screen.getByRole('button', { name: 'settings.providers.custom.save' }));

    await waitFor(() => expect(createCustomProvider).toHaveBeenCalledTimes(1));
    expect(vi.mocked(createCustomProvider).mock.calls[0][0].runtimes.codex?.models[0]).toEqual({
      id: 'local-model',
      name: 'Local Model',
      route: {
        baseUrl: 'http://127.0.0.1:4000/v1',
        wireProtocol: 'openai-responses',
        requestPath: '/responses',
      },
    });
  });

  it.each([
    ['settings.providers.custom.wireProtocol.piChat', 'openai-chat'],
    ['settings.providers.custom.wireProtocol.piAnthropic', 'anthropic-messages'],
  ] as const)(
    'saves an explicit %s PI default without deleting the model override',
    async (buttonName, wireProtocol) => {
      i18nState.language = 'en';
      renderDialog();

      fireEvent.click(await findReadyPresetTrigger());
      fireEvent.click(await screen.findByRole('option', { name: 'PI Protocol Preset' }));
      const piTab = screen.getByRole('tab', { name: 'settings.providers.custom.protocol.pi' });
      fireEvent.click(piTab);
      await waitFor(() => expect(piTab.getAttribute('aria-selected')).toBe('true'));
      fireEvent.click(screen.getByRole('button', { name: buttonName }));
      await screen.findByText(
        wireProtocol === 'anthropic-messages'
          ? 'settings.providers.custom.wireProtocol.piAnthropicHelp'
          : 'settings.providers.custom.wireProtocol.piChatHelp',
      );
      fireEvent.click(screen.getByRole('button', { name: 'settings.providers.custom.save' }));

      await waitFor(() => expect(createCustomProvider).toHaveBeenCalledTimes(1));
      expect(vi.mocked(createCustomProvider).mock.calls[0][0].runtimes.pi).toMatchObject({
        wireProtocol,
        models: [
          {
            id: 'deepseek-v4-pro',
            name: 'DeepSeek V4 Pro',
            piApi: 'openai-responses',
          },
        ],
      });
    },
  );

  it('offers all per-model PI protocols and maps Chat to openai-completions', async () => {
    const onChange = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <PiModelProtocolDropdown
        modelName="DeepSeek V4 Pro"
        value="openai-responses"
        open
        onOpenChange={onOpenChange}
        onChange={onChange}
      />,
    );

    for (const optionName of [
      'settings.providers.custom.modelProtocol.inherit',
      'settings.providers.custom.modelProtocol.messages',
      'settings.providers.custom.modelProtocol.chat',
      'settings.providers.custom.modelProtocol.responses',
      'settings.providers.custom.modelProtocol.google',
    ]) {
      expect(await screen.findByRole('menuitemradio', { name: optionName })).not.toBeNull();
    }
    const menu = screen.getByRole('menu');
    expect(menu.className).toContain('--radix-dropdown-menu-trigger-width');
    expect(menu.className).not.toContain('--radix-popover-trigger-width');
    fireEvent.click(
      screen.getByRole('menuitemradio', {
        name: 'settings.providers.custom.modelProtocol.chat',
      }),
    );
    expect(onChange).toHaveBeenCalledWith('openai-completions');
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('supports arrow-key selection, Escape, and focus return for the PI model protocol menu', async () => {
    function Harness() {
      const [open, setOpen] = React.useState(false);
      const [value, setValue] = React.useState<PiModelApi | undefined>();
      return (
        <>
          <PiModelProtocolDropdown
            modelName="DeepSeek V4 Pro"
            value={value}
            open={open}
            onOpenChange={setOpen}
            onChange={setValue}
          />
          <output>{value ?? 'inherit'}</output>
        </>
      );
    }

    render(<Harness />);
    const trigger = screen.getByRole('button', {
      name: 'settings.providers.custom.modelProtocol.ariaLabel',
    });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });

    const inherit = await screen.findByRole('menuitemradio', {
      name: 'settings.providers.custom.modelProtocol.inherit',
    });
    await waitFor(() => expect(document.activeElement).toBe(inherit));
    fireEvent.keyDown(inherit, { key: 'ArrowDown' });
    const messages = screen.getByRole('menuitemradio', {
      name: 'settings.providers.custom.modelProtocol.messages',
    });
    await waitFor(() => expect(document.activeElement).toBe(messages));

    fireEvent.keyDown(messages, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('menuitemradio')).toBeNull();
      expect(document.activeElement).toBe(trigger);
    });

    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    const reopenedMessages = await screen.findByRole('menuitemradio', {
      name: 'settings.providers.custom.modelProtocol.messages',
    });
    fireEvent.keyDown(reopenedMessages, { key: 'Enter' });
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('anthropic-messages'));
  });

  it.each([
    ['isComposing', { isComposing: true }],
    ['keyCode 229', { keyCode: 229 }],
  ])('keeps IME Escape inside composition for %s', async (_label, eventInit) => {
    i18nState.language = 'zh-TW';
    const { onClose } = renderDialog();

    const trigger = await findReadyPresetTrigger();
    fireEvent.click(trigger);
    expect(await screen.findByRole('option', { name: '繁體供應商' })).not.toBeNull();
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });

    dispatchEscape(document, eventInit);
    expect(screen.getByRole('option', { name: '繁體供應商' })).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('dismisses the model picker before the underlying form on Escape', async () => {
    i18nState.language = 'zh-TW';
    const { onClose } = renderDialog();

    const trigger = await findReadyPresetTrigger();
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

    const trigger = await findReadyPresetTrigger();
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
