// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatalogModel, ProviderView } from '@cindy/model-providers';

const mocks = vi.hoisted(() => ({
  setLimit: vi.fn(async () => {}),
  reset: vi.fn(async () => {}),
  target: vi.fn(),
  limit: null as number | null,
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values?.tokens ? `${key} ${values.tokens}` : key,
    i18n: { resolvedLanguage: 'en' },
  }),
}));
vi.mock('@/hooks/useModelContextLimit', () => ({
  useModelContextLimit: (target: unknown) => {
    mocks.target(target);
    return {
      limit: mocks.limit,
      isCustomized: mocks.limit !== null,
      loading: false,
      error: false,
      setLimit: mocks.setLimit,
      reset: mocks.reset,
    };
  },
}));
vi.mock('@/state/modelVisibilityPrefs', () => ({
  useModelVisibilityVersion: () => 0,
  isModelEnabled: () => true,
  isModelVisibilityCustomized: () => false,
  setModelVisibility: vi.fn(),
  resetModelVisibilities: vi.fn(),
}));
vi.mock('@/state/providerModelMemory', () => ({
  useProviderModelMemoryVersion: () => 0,
  getProviderModelEffort: () => undefined,
  setProviderModelEffort: vi.fn(),
  clearProviderModelEffort: vi.fn(),
}));
vi.mock('../ModelPriceOverrideDialog', () => ({ ModelPriceOverrideDialog: () => null }));
import { ModelAdvancedDrawer } from '../ModelAdvancedDrawer';
import { setModelVisibility } from '@/state/modelVisibilityPrefs';
import { setProviderModelEffort } from '@/state/providerModelMemory';

const model: CatalogModel = {
  id: 'gpt-6',
  name: 'GPT-6',
  contextWindow: 272_000,
  contextWindowMax: 1_050_000,
  maxOutput: 128_000,
  efforts: ['low', 'high'],
  defaultEffort: 'high',
  modalities: { input: ['text', 'image'], output: ['text'] },
};
const provider = {
  id: 'openai',
  name: 'OpenAI',
  source: 'builtin',
  connected: true,
  agents: ['codex', 'claude-code'],
  models: {},
} as ProviderView;
function drawer(primary = model, bridgeDefault = primary.defaultEffort, bridgeEfforts = primary.efforts) {
  const row = {
    id: primary.id,
    name: primary.name,
    avail: ['codex', 'claude-code'] as ('codex' | 'claude-code')[],
    byAgent: {
      codex: primary,
      'claude-code': { ...primary, id: `chatgpt/${primary.id}`, defaultEffort: bridgeDefault, efforts: bridgeEfforts },
    },
  };
  return (
    <ModelAdvancedDrawer
      provider={provider}
      row={row}
      open
      onOpenChange={vi.fn()}
      pricePresentationOf={() => null}
      onDisable={vi.fn()}
      disabled={false}
      paymentRequired={false}
    />
  );
}
function draw(primary = model, bridgeDefault = primary.defaultEffort) {
  return render(drawer(primary, bridgeDefault));
}
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  mocks.limit = null;
});

describe('model advanced editor', () => {
  it('keeps useful identity fields without exposing internal defaults, normal lifecycle or raw descriptions', () => {
    draw({ ...model, status: 'active', defaultEnabled: false, description: 'GPT for coding tasks' });
    expect(screen.queryByText('active')).toBeNull();
    expect(screen.queryByText('GPT for coding tasks')).toBeNull();
    expect(screen.queryByText('settings.providers.models.advanced.defaultEnabled')).toBeNull();
    expect(screen.getByText('settings.providers.models.advanced.modelId')).toBeTruthy();
  });

  it.each(['alpha', 'deprecated', 'retired'] as const)('localizes the actionable model status %s', (status) => {
    draw({ ...model, status });
    expect(screen.queryByText(status)).toBeNull();
    expect(screen.getByText(`settings.providers.models.advanced.lifecycle.${status}`)).toBeTruthy();
  });

  it('preserves selected harnesses while disconnected, and restores controls after reconnect', () => {
    const view = render(
      <ModelAdvancedDrawer
        provider={{ ...provider, connected: false }}
        row={{ id: model.id, name: model.name, avail: ['codex'], byAgent: { codex: model } }}
        open
        onOpenChange={vi.fn()}
        pricePresentationOf={() => null}
        onDisable={vi.fn()}
        disabled={false}
        paymentRequired={false}
      />,
    );
    const toggle = screen.getByRole('switch', { name: 'GPT-6 · Codex' }) as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(toggle);
    expect(setModelVisibility).not.toHaveBeenCalled();
    expect(screen.getByText('settings.providers.models.manage.connectionRequired')).toBeTruthy();
    view.rerender(drawer());
    expect(
      (screen.getByRole('switch', { name: 'GPT-6 · Codex' }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(screen.queryByText('settings.providers.models.manage.connectionRequired')).toBeNull();
    expect(screen.getByRole('switch', { name: 'GPT-6 · Codex' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    expect(setModelVisibility).not.toHaveBeenCalled();
  });

  it('shows the exact maximum and includes Codex in shared context edits', () => {
    draw();
    expect(screen.getByText('1,050,000')).toBeTruthy();
    const input = screen.getByRole('textbox', {
      name: 'settings.providers.models.advanced.contextLimitAria',
    });
    expect((input as HTMLInputElement).value).toBe('272');
    fireEvent.change(input, { target: { value: '500' } });
    fireEvent.blur(input);
    expect(mocks.setLimit).toHaveBeenCalledWith(500_000);
    fireEvent.change(input, { target: { value: '1.5' } });
    fireEvent.blur(input);
    expect(mocks.setLimit).toHaveBeenCalledTimes(1);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(mocks.target).toHaveBeenLastCalledWith({
      providerId: 'openai',
      agent: 'codex',
      modelId: 'gpt-6',
      relatedTargets: [{ providerId: 'openai', agent: 'claude-code', modelId: 'chatgpt/gpt-6' }],
    });
  });

  it('edits a Codex-only route without removing the model specification', () => {
    render(
      <ModelAdvancedDrawer
        provider={provider}
        row={{ id: model.id, name: model.name, avail: ['codex'], byAgent: { codex: model } }}
        open
        onOpenChange={vi.fn()}
        pricePresentationOf={() => null}
        onDisable={vi.fn()}
        disabled={false}
        paymentRequired={false}
      />,
    );
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: '1000' } });
    fireEvent.blur(input);
    expect(mocks.setLimit).toHaveBeenCalledWith(1_000_000);
    expect(screen.getByText('1,050,000')).toBeTruthy();
    expect(screen.queryByText('settings.providers.models.advanced.codexContextHint')).toBeNull();
  });

  it('uses the same context editor for custom Codex providers', () => {
    render(
      <ModelAdvancedDrawer
        provider={{ ...provider, id: 'custom', source: 'user' }}
        row={{ id: model.id, name: model.name, avail: ['codex'], byAgent: { codex: model } }}
        open
        onOpenChange={vi.fn()}
        pricePresentationOf={() => null}
        onDisable={vi.fn()}
        disabled={false}
        paymentRequired={false}
      />,
    );
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: '1000' } });
    fireEvent.blur(input);
    expect(mocks.setLimit).toHaveBeenCalledWith(1_000_000);
    expect(screen.getAllByText('272K').length).toBeGreaterThan(0);
    expect(screen.queryByText('settings.providers.models.advanced.codexContextHint')).toBeNull();
  });

  it('shows whole K without rewriting the exact catalog value on untouched blur', () => {
    draw({ ...model, contextWindow: 1_048_576, contextWindowMax: 1_048_576 });
    const input = screen.getByRole('textbox') as HTMLInputElement;
    expect(input.value).toBe('1048');
    expect(
      screen.getByText('settings.providers.models.advanced.contextLimitRoute 1,048,576'),
    ).toBeTruthy();
    fireEvent.focus(input);
    fireEvent.blur(input);
    expect(mocks.setLimit).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '1000' } });
    fireEvent.blur(input);
    expect(mocks.setLimit).toHaveBeenCalledWith(1_000_000);
  });

  it('labels both Google compatibility routes and gives Pi the recommendation', async () => {
    const primary = {
      ...model,
      id: 'google/gemini-future',
      name: 'Gemini',
      nativeApi: 'google-generative-ai' as const,
    };
    const byAgent = {
      'claude-code': primary,
      codex: primary,
      pi: { ...primary, piApi: 'google-generative-ai' as const },
    };
    const agents = ['claude-code', 'codex', 'pi'] as const;
    render(
      <ModelAdvancedDrawer
        provider={{
          ...provider,
          id: 'xd',
          agents: [...agents],
          models: Object.fromEntries(agents.map((agent) => [agent, [byAgent[agent]]])),
          routing: {
            'claude-code': { wireProtocol: 'anthropic-messages' },
            codex: { wireProtocol: 'openai-responses' },
          } as ProviderView['routing'],
        }}
        row={{ id: primary.id, name: primary.name, avail: [...agents], byAgent }}
        open
        onOpenChange={vi.fn()}
        pricePresentationOf={() => null}
        onDisable={vi.fn()}
        disabled={false}
        paymentRequired={false}
      />,
    );
    expect(
      screen.getByText('newChat.modelSelector.unified.recommended').parentElement?.textContent,
    ).toContain('Pi');
    for (const agent of ['Claude Code', 'Codex']) {
      const toggle = screen.getByRole('switch', { name: `Gemini · ${agent}` });
      expect(toggle.getAttribute('data-compatibility')).toBe('true');
      expect(
        document.getElementById(toggle.getAttribute('aria-describedby')!)?.textContent,
      ).toContain('protocol.compatibility');
    }
    expect(
      screen.getByRole('switch', { name: 'Gemini · Pi' }).hasAttribute('data-compatibility'),
    ).toBe(false);
    const notices = screen.getAllByRole('button', {
      name: 'settings.providers.models.advanced.protocol.compatibility',
    });
    expect(notices).toHaveLength(2);
    fireEvent.click(notices[0]!);
    expect((await screen.findByRole('tooltip')).textContent).toContain(
      'protocol.compatibilityHint',
    );
    expect(setModelVisibility).not.toHaveBeenCalled();
  });

  it('preserves an existing precise override, warns above the exact maximum, and resets without rounding writes', () => {
    mocks.limit = 1_048_900;
    draw({ ...model, contextWindow: 1_048_576, contextWindowMax: 1_048_576 });
    const input = screen.getByRole('textbox') as HTMLInputElement;
    expect(input.value).toBe('1048');
    expect(
      screen.getByText('settings.providers.models.advanced.contextLimitOverWindow'),
    ).toBeTruthy();
    fireEvent.blur(input);
    expect(mocks.setLimit).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole('button', { name: 'settings.providers.models.advanced.restoreDefault' }),
    );
    expect(mocks.reset).toHaveBeenCalledOnce();
    expect(mocks.setLimit).not.toHaveBeenCalled();
  });

  it('shows facts beside controls without disclosure and keeps related window values together', () => {
    draw();
    const dialog = screen.getByRole('dialog');
    expect(dialog.querySelector('details')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'GPT-6' }));
    const input = screen.getByRole('textbox');
    const controlsColumn = input.closest('section')!.parentElement!;
    expect(controlsColumn.textContent).toContain(
      'settings.providers.models.advanced.contextWindow',
    );
    expect(screen.getByText('settings.providers.models.advanced.imageInput')).toBeTruthy();
    expect(screen.getByText('settings.providers.models.advanced.modelId')).toBeTruthy();
    const scrollArea = input.closest('.overflow-y-auto')!;
    expect(
      scrollArea.contains(
        screen.getByRole('button', { name: 'settings.providers.models.disableModel' }),
      ),
    ).toBe(false);
    const close = screen.getByRole('button', { name: 'settings.providers.models.advanced.close' });
    fireEvent.focus(close);
    expect(close.getAttribute('aria-describedby')).toBeNull();
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it.each([
    ['anthropic-claude/claude-opus-4-8', ['claude-code', 'codex', 'pi'], 'Claude Code'],
    ['new-vendor/gpt-9', ['claude-code', 'codex', 'pi'], 'Codex'],
    ['new-labs/next-model', ['pi'], 'Pi'],
  ] as const)('uses the shared recommendation for %s', (id, agents, expected) => {
    const primary = { ...model, id, name: id };
    const models = Object.fromEntries(agents.map((agent) => [agent, [primary]]));
    render(
      <ModelAdvancedDrawer
        provider={{ ...provider, id: 'xd', agents: [...agents], models }}
        row={{
          id,
          name: id,
          avail: [...agents],
          byAgent: Object.fromEntries(agents.map((agent) => [agent, primary])),
        }}
        open
        onOpenChange={vi.fn()}
        pricePresentationOf={() => null}
        onDisable={vi.fn()}
        disabled={false}
        paymentRequired={false}
      />,
    );
    const marker = screen.getByText('newChat.modelSelector.unified.recommended');
    expect(marker.parentElement?.textContent).toContain(expected);
  });

  it('refreshes defaults and controls in an open drawer when the catalog changes', () => {
    const { rerender } = draw();
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('272');
    rerender(
      drawer({ ...model, contextWindow: 700_000, efforts: ['high', 'max'], defaultEffort: 'max' }),
    );
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('700');
    expect(screen.queryByRole('button', { name: 'effortLevels.low' })).toBeNull();
    expect(
      screen.getByRole('button', { name: 'effortLevels.max' }).getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('allows an intentional override above the maximum and rejects invalid input', () => {
    draw();
    const input = screen.getByRole('textbox', {
      name: 'settings.providers.models.advanced.contextLimitAria',
    });
    fireEvent.change(input, { target: { value: '1200' } });
    expect(
      screen.getByText('settings.providers.models.advanced.contextLimitOverWindow'),
    ).toBeTruthy();
    fireEvent.blur(input);
    expect(mocks.setLimit).toHaveBeenLastCalledWith(1_200_000);
    fireEvent.change(input, { target: { value: '-1' } });
    fireEvent.blur(input);
    expect(mocks.setLimit).toHaveBeenCalledTimes(1);
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });

  it('retains a mixed saved selection without showing per-engine default labels', () => {
    draw(model, 'low');
    expect(screen.getByText('settings.providers.models.advanced.effortMixed')).toBeTruthy();
    expect(
      screen.queryByText(/settings.providers.models.advanced.engineDefaultEffort/),
    ).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'effortLevels.high' }));
    expect(setProviderModelEffort).toHaveBeenCalledWith('codex', 'openai', 'gpt-6', 'high');
    expect(setProviderModelEffort).toHaveBeenCalledWith('claude-code', 'openai', 'chatgpt/gpt-6', 'high');
  });

  it('shows one selected depth when another harness needs a supported-level mapping', () => {
    render(drawer(model, 'low', ['low']));
    expect(screen.queryByText('settings.providers.models.advanced.effortMixed')).toBeNull();
    expect(screen.getByRole('button', { name: 'effortLevels.high' }).getAttribute('aria-pressed'))
      .toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'effortLevels.high' }));
    expect(setProviderModelEffort).toHaveBeenCalledWith('codex', 'openai', 'gpt-6', 'high');
    expect(setProviderModelEffort).toHaveBeenCalledWith('claude-code', 'openai', 'chatgpt/gpt-6', 'low');
  });

  it('uses provider-declared image capability ahead of family-name heuristics', () => {
    draw({ ...model, id: 'deepseek-v4', name: 'DeepSeek', supportsImageInput: true });
    expect(screen.getByText('settings.providers.models.advanced.vision.vision')).toBeTruthy();
    expect(screen.getByText('settings.providers.models.advanced.inputModalities')).toBeTruthy();
  });
});
