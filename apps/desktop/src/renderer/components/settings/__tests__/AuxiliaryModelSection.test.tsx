// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuxiliaryModelSettingsState } from '../../../../shared/auxiliaryModelSettings';

const TITLE_PIN = 'cat:openrouter:codex:openai/gpt-5-mini';
const RECOMMENDATION_PIN = 'cat:anthropic:claude-code:claude-haiku-4-5';

const h = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  toastError: vi.fn(),
  isModelEnabled: vi.fn(),
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

vi.mock('@/state/modelVisibilityPrefs', () => ({
  isModelEnabled: h.isModelEnabled,
  useModelVisibilityVersion: () => 0,
}));

vi.mock('@/cindy-brain/OneshotModelPinPicker', () => ({
  OneshotModelPinPicker: ({
    value,
    onChange,
    ariaLabel,
    disabled,
    options,
  }: {
    value?: string;
    onChange: (pin: string | null) => void;
    ariaLabel: string;
    disabled?: boolean;
    options: Array<{ id: string; available?: boolean }>;
  }) => {
    const titleRow = ariaLabel.includes('sessionTitle');
    const pin = titleRow ? TITLE_PIN : RECOMMENDATION_PIN;
    const displayedOptions = options.filter(
      (option) => option.available !== false || option.id === value,
    );
    return (
      <div>
        <span>{`${ariaLabel}:${value ?? 'automatic'}`}</span>
        <span data-testid={`${ariaLabel}:options`}>
          {displayedOptions.map((option) => `${option.id}:${option.available !== false}`).join('|')}
        </span>
        <button
          type="button"
          aria-label={`${ariaLabel}:select`}
          disabled={disabled}
          onClick={() => onChange(pin)}
        >
          select
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
    sessionTitleModel: null,
    promptRecommendationModel: null,
    isCustomized: false,
    customizedKeys: [],
    defaults: {
      sessionTitleModel: null,
      promptRecommendationModel: null,
    },
    options: [],
    ...partial,
  };
}

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

describe('AuxiliaryModelSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installApi();
    h.isModelEnabled.mockReturnValue(true);
    h.get.mockResolvedValue(state());
    h.set.mockImplementation(async (patch: Partial<AuxiliaryModelSettingsState>) => state(patch));
  });

  it('renders separate controls for task naming and prompt recommendations', async () => {
    render(<AuxiliaryModelSection />);

    expect(await screen.findByText('settings.auxiliaryModels.sessionTitle.label')).toBeTruthy();
    expect(screen.getByText('settings.auxiliaryModels.promptRecommendation.label')).toBeTruthy();
  });

  it('writes each model choice to its own independent key', async () => {
    render(<AuxiliaryModelSection />);

    fireEvent.click(
      await screen.findByRole('button', {
        name: 'settings.auxiliaryModels.sessionTitle.ariaLabel:select',
      }),
    );
    await waitFor(() => expect(h.set).toHaveBeenLastCalledWith({ sessionTitleModel: TITLE_PIN }));

    fireEvent.click(
      screen.getByRole('button', {
        name: 'settings.auxiliaryModels.promptRecommendation.ariaLabel:select',
      }),
    );
    await waitFor(() =>
      expect(h.set).toHaveBeenLastCalledWith({
        promptRecommendationModel: RECOMMENDATION_PIN,
      }),
    );
  });

  it('restores automatic routing with a null override', async () => {
    h.get.mockResolvedValue(
      state({
        sessionTitleModel: TITLE_PIN,
        promptRecommendationModel: RECOMMENDATION_PIN,
      }),
    );
    render(<AuxiliaryModelSection />);

    fireEvent.click(
      await screen.findByRole('button', {
        name: 'settings.auxiliaryModels.sessionTitle.ariaLabel:automatic',
      }),
    );
    await waitFor(() => expect(h.set).toHaveBeenCalledWith({ sessionTitleModel: null }));
  });

  it('does not offer models hidden from the regular model selector', async () => {
    const hiddenPin = 'cat:xd:codex:claude-opus-5';
    const visiblePin = 'cat:xd:codex:deepseek/deepseek-v4-flash';
    h.isModelEnabled.mockImplementation(
      (_agent: string, _providerId: string, model: { id: string }) =>
        model.id !== 'claude-opus-5',
    );
    h.get.mockResolvedValue(
      state({
        options: [
          {
            id: hiddenPin,
            label: 'Claude Opus 5 · XD Gateway',
            group: 'XD Gateway',
            providerId: 'xd',
            agentKind: 'codex',
            modelId: 'claude-opus-5',
            modelName: 'Claude Opus 5',
            agentSuffix: 'Codex',
            budget: false,
            subscription: false,
            available: true,
          },
          {
            id: visiblePin,
            label: 'DeepSeek V4 Flash · XD Gateway',
            group: 'XD Gateway',
            providerId: 'xd',
            agentKind: 'codex',
            modelId: 'deepseek/deepseek-v4-flash',
            modelName: 'DeepSeek V4 Flash',
            agentSuffix: 'Codex',
            budget: false,
            subscription: false,
            available: true,
          },
        ],
      }),
    );

    render(<AuxiliaryModelSection />);

    const titleOptions = await screen.findByTestId(
      'settings.auxiliaryModels.sessionTitle.ariaLabel:options',
    );
    const recommendationOptions = screen.getByTestId(
      'settings.auxiliaryModels.promptRecommendation.ariaLabel:options',
    );
    expect(titleOptions.textContent).toBe(`${visiblePin}:true`);
    expect(recommendationOptions.textContent).toBe(`${visiblePin}:true`);
  });

  it('keeps a selected hidden model visible only as an unavailable value', async () => {
    const hiddenPin = 'cat:xd:codex:claude-opus-5';
    h.isModelEnabled.mockReturnValue(false);
    h.get.mockResolvedValue(
      state({
        sessionTitleModel: hiddenPin,
        options: [
          {
            id: hiddenPin,
            label: 'Claude Opus 5 · XD Gateway',
            group: 'XD Gateway',
            providerId: 'xd',
            agentKind: 'codex',
            modelId: 'claude-opus-5',
            modelName: 'Claude Opus 5',
            agentSuffix: 'Codex',
            defaultEnabled: false,
            budget: false,
            subscription: false,
            available: true,
          },
        ],
      }),
    );

    render(<AuxiliaryModelSection />);

    expect(
      (await screen.findByTestId('settings.auxiliaryModels.sessionTitle.ariaLabel:options'))
        .textContent,
    ).toBe(`${hiddenPin}:false`);
    expect(
      screen.getByTestId('settings.auxiliaryModels.promptRecommendation.ariaLabel:options')
        .textContent,
    ).toBe('');
  });
});
