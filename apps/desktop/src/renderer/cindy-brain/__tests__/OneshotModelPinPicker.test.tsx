// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const OPENROUTER_PIN = 'cat:openrouter:codex:openai/gpt-5-mini';
const ANTHROPIC_PIN = 'cat:anthropic:claude-code:claude-haiku-4-5';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        'settings.providers.anthropic.title': 'Anthropic',
        'settings.providers.openai.title': 'OpenAI',
        'settings.providers.xd.title': 'Cindy AI',
      })[key] ?? key,
  }),
}));

vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => children,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/components/new-chat/ModelSelector', () => ({
  ModelIconMark: () => <span aria-hidden="true" />,
}));

import { OneshotModelPinPicker, type OneshotPinOption } from '../OneshotModelPinPicker';

const options: OneshotPinOption[] = [
  {
    id: OPENROUTER_PIN,
    label: 'GPT-5 mini · OpenRouter',
    group: 'OpenRouter',
    providerId: 'openrouter',
    agentKind: 'codex',
    modelId: 'openai/gpt-5-mini',
    modelName: 'GPT-5 mini',
    budget: false,
    subscription: false,
    available: true,
  },
  {
    id: ANTHROPIC_PIN,
    label: 'Claude Haiku 4.5 · Anthropic',
    group: 'Anthropic',
    providerId: 'anthropic',
    agentKind: 'claude-code',
    modelId: 'claude-haiku-4-5',
    modelName: 'Claude Haiku 4.5',
    budget: false,
    subscription: false,
    available: true,
  },
];

const xdOption: OneshotPinOption = {
  id: 'cat:xd:codex:deepseek/deepseek-v4-flash',
  label: 'DeepSeek V4 Flash · XD Gateway',
  group: 'XD Gateway',
  providerId: 'xd',
  agentKind: 'codex',
  modelId: 'deepseek/deepseek-v4-flash',
  modelName: 'DeepSeek V4 Flash',
  budget: false,
  subscription: false,
  available: true,
};

describe('OneshotModelPinPicker provider-first mode', () => {
  it('groups all suppliers without rendering the Agent rail', () => {
    render(
      <OneshotModelPinPicker
        value={undefined}
        defaultLabel=""
        declaredLabel={null}
        options={options}
        onChange={vi.fn()}
        ariaLabel="Auxiliary model"
        groupByProvider
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Auxiliary model' }));

    expect(screen.getByRole('group', { name: 'OpenRouter' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Anthropic' })).toBeTruthy();
    expect(
      screen.getByPlaceholderText('settings.ghosts.detail.cindyPrefs.searchPlaceholder'),
    ).toBeTruthy();
    expect(screen.queryByText('Claude Code')).toBeNull();
    expect(screen.queryByText('Codex')).toBeNull();
    expect(screen.queryByRole('option', { name: /Claude Code/ })).toBeNull();
  });

  it('uses the standard Cindy AI name for the xd provider', () => {
    render(
      <OneshotModelPinPicker
        value={undefined}
        defaultLabel=""
        declaredLabel={null}
        options={[xdOption]}
        onChange={vi.fn()}
        ariaLabel="Auxiliary model"
        groupByProvider
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Auxiliary model' }));

    expect(screen.getByRole('group', { name: 'Cindy AI' })).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'XD Gateway' })).toBeNull();
  });

  it('returns the exact provider and Agent pin for a selected row', () => {
    const onChange = vi.fn();
    render(
      <OneshotModelPinPicker
        value={undefined}
        defaultLabel=""
        declaredLabel={null}
        options={options}
        onChange={onChange}
        ariaLabel="Auxiliary model"
        groupByProvider
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Auxiliary model' }));
    fireEvent.click(screen.getByRole('option', { name: /Claude Haiku 4\.5/ }));

    expect(onChange).toHaveBeenCalledWith(ANTHROPIC_PIN);
  });

  it('renders an unavailable current route but prevents selecting it', () => {
    const onChange = vi.fn();
    const unavailable = {
      ...xdOption,
      id: 'cat:xd:codex:retired-model',
      modelId: 'retired-model',
      modelName: 'Retired model',
      label: 'Retired model · Cindy AI',
      available: false,
    };
    render(
      <OneshotModelPinPicker
        value={unavailable.id}
        defaultLabel=""
        declaredLabel={null}
        options={[unavailable]}
        onChange={onChange}
        ariaLabel="Auxiliary model"
        groupByProvider
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Auxiliary model' }));
    const option = screen.getByRole('option', { name: /Retired model/ });
    expect(option.getAttribute('disabled')).not.toBeNull();
    fireEvent.click(option);

    expect(onChange).not.toHaveBeenCalled();
  });
});
