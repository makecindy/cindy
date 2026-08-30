// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AuxiliaryModelOption,
  AuxiliaryModelSettingsState,
} from '../../../../shared/auxiliaryModelSettings';

const PREFERRED_PIN = 'cat:openrouter:codex:openai/gpt-5-mini';
const FALLBACK_PIN = 'cat:anthropic:claude-code:claude-haiku-4-5';

const h = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  toastError: vi.fn(),
  authMode: 'cloud' as 'signed-out' | 'local' | 'cloud',
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ warn: vi.fn() }),
}));

vi.mock('@/lib/toast', () => ({
  toast: { error: h.toastError },
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ mode: h.authMode }),
}));

vi.mock('@/components/ui/tooltip', () => ({
  Tip: ({ children }: { children: React.ReactElement }) => children,
}));

vi.mock('@/cindy-brain/OneshotModelPinPicker', () => ({
  OneshotModelPinPicker: ({
    value,
    disabled,
    defaultOptionLabel,
    groupByProvider,
    options,
    onChange,
    ariaLabel,
  }: {
    value?: string;
    ariaLabel: string;
    disabled?: boolean;
    defaultOptionLabel?: string;
    groupByProvider?: boolean;
    options: readonly AuxiliaryModelOption[];
    onChange: (pin: string | null) => void;
  }) => {
    return (
      <div>
        <span>{`${ariaLabel}:${value ?? defaultOptionLabel ?? 'empty'}`}</span>
        <span data-testid={`${ariaLabel}:value`}>{value ?? 'empty'}</span>
        <span data-testid={`${ariaLabel}:panel`}>
          {`${Boolean(groupByProvider)}:${options.map((option) => option.group).join(',')}`}
        </span>
        <button
          type="button"
          aria-label={`${ariaLabel}:select`}
          disabled={disabled}
          onClick={() => onChange(PREFERRED_PIN)}
        >
          select
        </button>
        <button
          type="button"
          aria-label={`${ariaLabel}:select-fallback`}
          disabled={disabled}
          onClick={() => onChange(FALLBACK_PIN)}
        >
          select fallback
        </button>
        <button
          type="button"
          aria-label={`${ariaLabel}:automatic`}
          disabled={disabled}
          onClick={() => onChange(null)}
        >
          automatic
        </button>
      </div>
    );
  },
}));

import { AuxiliaryModelSection } from '../AuxiliaryModelSection';

function state(partial: Partial<AuxiliaryModelSettingsState> = {}): AuxiliaryModelSettingsState {
  return {
    models: [],
    isCustomized: false,
    customizedKeys: [],
    defaults: { models: [] },
    options: [],
    ...partial,
  };
}

const OPTIONS: AuxiliaryModelOption[] = [
  {
    id: PREFERRED_PIN,
    label: 'GPT-5 mini · OpenRouter',
    group: 'OpenRouter',
    providerId: 'openrouter',
    agentKind: 'codex',
    modelId: 'openai/gpt-5-mini',
    modelName: 'GPT-5 mini',
    budget: false,
    subscription: false,
    agentSuffix: 'Codex',
    available: true,
  },
  {
    id: FALLBACK_PIN,
    label: 'Claude Haiku 4.5 · Anthropic',
    group: 'Anthropic',
    providerId: 'anthropic',
    agentKind: 'claude-code',
    modelId: 'claude-haiku-4-5',
    modelName: 'Claude Haiku 4.5',
    budget: false,
    subscription: false,
    agentSuffix: 'Claude Code',
    available: true,
  },
];

function installApi(): void {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      maker: {
        auxiliaryModelSettingsGet: h.get,
        auxiliaryModelSettingsSet: h.set,
      },
    },
  });
}

async function selectMode(modeKey: string): Promise<void> {
  fireEvent.click(
    await screen.findByRole('combobox', { name: 'settings.auxiliaryModels.title' }),
  );
  const option = await screen.findByRole('option', { name: modeKey });
  await act(async () => {
    fireEvent.click(option);
  });
}

describe('AuxiliaryModelSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.authMode = 'cloud';
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
    installApi();
    h.get.mockResolvedValue(state({ options: OPTIONS }));
    h.set.mockImplementation(async (patch: { models?: string[] }) => {
      const models = patch.models ?? [];
      return state({
        models,
        isCustomized: models.length > 0,
        customizedKeys: models.length > 0 ? ['models'] : [],
        options: OPTIONS,
      });
    });
  });

  it('renders a persistent automatic/custom mode selector above the automatic chain', async () => {
    render(<AuxiliaryModelSection />);

    expect(
      (await screen.findByRole('combobox', { name: 'settings.auxiliaryModels.title' })).textContent,
    ).toContain('settings.auxiliaryModels.automatic');
    expect(screen.getByText(/settings.auxiliaryModels.chain.cindyDeepseekV4Flash/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'settings.auxiliaryModels.customize' })).toBeNull();
    expect(screen.queryByText('settings.auxiliaryModels.preferred.label')).toBeNull();
  });

  it('treats a GET payload without models as automatic instead of crashing', async () => {
    h.get.mockResolvedValue({
      models: [],
      isCustomized: false,
      customizedKeys: [],
      defaults: { models: [] },
      options: [],
    } as AuxiliaryModelSettingsState);

    render(<AuxiliaryModelSection />);

    expect(
      (await screen.findByRole('combobox', { name: 'settings.auxiliaryModels.title' })).textContent,
    ).toContain('settings.auxiliaryModels.automatic');
  });

  it('opens the three custom slots without persisting and keeps the mode selector', async () => {
    render(<AuxiliaryModelSection />);

    await selectMode('settings.auxiliaryModels.customize');

    expect(await screen.findByText('settings.auxiliaryModels.preferred.label')).toBeTruthy();
    expect(screen.getByText('settings.auxiliaryModels.fallback1.label')).toBeTruthy();
    expect(screen.getByText('settings.auxiliaryModels.fallback2.label')).toBeTruthy();
    expect(
      screen.getByRole('combobox', { name: 'settings.auxiliaryModels.title' }).textContent,
    ).toContain('settings.auxiliaryModels.customize');
    expect(screen.getByTestId('settings.auxiliaryModels.preferred.ariaLabel:value').textContent).toBe(
      'cat:xd:codex:deepseek/deepseek-v4-flash',
    );
    expect(screen.getByTestId('settings.auxiliaryModels.fallback1.ariaLabel:value').textContent).toBe(
      'cat:xd:codex:tencent/hy3',
    );
    expect(screen.getByTestId('settings.auxiliaryModels.fallback2.ariaLabel:value').textContent).toBe(
      'cat:xd:codex:qwen/qwen3.8-flash',
    );
    expect(screen.queryByText('settings.defaults.customizedBadge')).toBeNull();
    const modeTrigger = screen.getByRole('combobox', { name: 'settings.auxiliaryModels.title' });
    const restoreButton = screen.getByRole('button', { name: 'settings.defaults.restore' });
    expect(restoreButton).toBeTruthy();
    expect(
      modeTrigger.compareDocumentPosition(restoreButton) & Node.DOCUMENT_POSITION_PRECEDING,
    ).toBeTruthy();
    expect(screen.getAllByText('settings.auxiliaryModels.customize')).toHaveLength(1);
    expect(
      screen.getByTestId('settings.auxiliaryModels.preferred.ariaLabel:panel').textContent,
    ).toBe('true:OpenRouter,Anthropic');
    expect(h.set).not.toHaveBeenCalled();
  });

  it('does not seed Cindy AI defaults while signed out', async () => {
    h.authMode = 'signed-out';
    render(<AuxiliaryModelSection />);

    await selectMode('settings.auxiliaryModels.customize');

    expect(screen.getByTestId('settings.auxiliaryModels.preferred.ariaLabel:value').textContent).toBe(
      'empty',
    );
    expect(screen.getByText('settings.auxiliaryModels.signInHint')).toBeTruthy();
    expect(h.set).not.toHaveBeenCalled();
  });

  it('returns to automatic without persisting when restore is used while drafting', async () => {
    render(<AuxiliaryModelSection />);

    await selectMode('settings.auxiliaryModels.customize');
    fireEvent.click(await screen.findByRole('button', { name: 'settings.defaults.restore' }));

    expect(
      (await screen.findByRole('combobox', { name: 'settings.auxiliaryModels.title' })).textContent,
    ).toContain('settings.auxiliaryModels.automatic');
    expect(screen.queryByText('settings.auxiliaryModels.preferred.label')).toBeNull();
    expect(h.set).not.toHaveBeenCalled();
  });

  it('persists the changed preferred pin while keeping the other automatic defaults', async () => {
    render(<AuxiliaryModelSection />);

    await selectMode('settings.auxiliaryModels.customize');
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'settings.auxiliaryModels.preferred.ariaLabel:select',
      }),
    );

    await waitFor(() =>
      expect(h.set).toHaveBeenLastCalledWith({
        models: [PREFERRED_PIN, 'cat:xd:codex:tencent/hy3', 'cat:xd:codex:qwen/qwen3.8-flash'],
      }),
    );
  });

  it('shows all supplier groups while keeping the exact selected catalog pin', async () => {
    h.get.mockResolvedValue(
      state({
        models: [PREFERRED_PIN],
        isCustomized: true,
        customizedKeys: ['models'],
        options: OPTIONS,
      }),
    );
    render(<AuxiliaryModelSection />);

    expect(
      (await screen.findByTestId('settings.auxiliaryModels.preferred.ariaLabel:panel')).textContent,
    ).toBe('true:OpenRouter,Anthropic');
    expect(
      screen.getByRole('combobox', { name: 'settings.auxiliaryModels.title' }).textContent,
    ).toContain('settings.auxiliaryModels.customize');

    expect(h.set).not.toHaveBeenCalled();
  });

  it('clears a saved custom chain when automatic is selected', async () => {
    h.get.mockResolvedValue(
      state({
        models: [PREFERRED_PIN, FALLBACK_PIN],
        isCustomized: true,
        customizedKeys: ['models'],
        options: OPTIONS,
      }),
    );
    render(<AuxiliaryModelSection />);

    await selectMode('settings.auxiliaryModels.automatic');

    await waitFor(() => {
      expect(h.set).toHaveBeenCalledWith({ models: [] });
      expect(
        screen.getByRole('combobox', { name: 'settings.auxiliaryModels.title' }).textContent,
      ).toContain('settings.auxiliaryModels.automatic');
    });
  });

  it('restores automatic routing when the preferred slot is cleared', async () => {
    h.get.mockResolvedValue(
      state({
        models: [PREFERRED_PIN, FALLBACK_PIN],
        isCustomized: true,
        customizedKeys: ['models'],
      }),
    );
    render(<AuxiliaryModelSection />);

    fireEvent.click(
      await screen.findByRole('button', {
        name: 'settings.auxiliaryModels.preferred.ariaLabel:automatic',
      }),
    );
    await waitFor(() => expect(h.set).toHaveBeenCalledWith({ models: [] }));
  });

  it('persists an empty list when restore is used on a saved custom chain', async () => {
    h.get.mockResolvedValue(
      state({
        models: [PREFERRED_PIN],
        isCustomized: true,
        customizedKeys: ['models'],
      }),
    );
    render(<AuxiliaryModelSection />);

    fireEvent.click(await screen.findByRole('button', { name: 'settings.defaults.restore' }));
    await waitFor(() => expect(h.set).toHaveBeenCalledWith({ models: [] }));
  });
});
