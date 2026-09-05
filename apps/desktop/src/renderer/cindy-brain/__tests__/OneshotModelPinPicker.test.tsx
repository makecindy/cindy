// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
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

let picker: React.ComponentProps<typeof import('@/components/new-chat/ModelSelector').ModelSelector>;
vi.mock('@/components/new-chat/ModelSelector', () => ({
  ModelSelector: (props: typeof picker) => { picker = props; return <div data-testid="shared-picker" />; },
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

describe('OneshotModelPinPicker shared A adapter', () => {
  const mount = (extra = {}) => render(<OneshotModelPinPicker defaultLabel="Automatic"
    declaredLabel={null} options={options} onChange={vi.fn()} ariaLabel="Auxiliary model" {...extra} />);

  it('uses the shared picker with all host-approved routes, without a separate Agent step', () => {
    mount();
    expect(screen.getByTestId('shared-picker')).toBeTruthy();
    expect(picker.unifiedPanel).toBeUndefined(); // shared default, no opt-in needed
    expect(picker.configurationEnabled).toBe(true);
    expect(picker.providersOverride?.every(p => Object.values(p.models).every(models => models?.every(m => m.efforts.length === 0 && !m.supportsFastMode)))).toBe(true);
    expect(picker.providersOverride?.map(p => p.id)).toEqual(['openrouter', 'anthropic']);
  });

  it('keeps provider labels and returns the exact selected provider/Harness pin', async () => {
    const onChange = vi.fn();
    mount({ options: [...options, xdOption], onChange, groupByProvider: true });
    expect(picker.providersOverride?.find(p => p.id === 'xd')?.name).toBe('Cindy AI');
    expect(await picker.onUnifiedSelect!({ providerId: 'anthropic', modelId: 'claude-haiku-4-5',
      engine: 'cc', fast: false, favoriteUid: null })).toBe(true);
    expect(onChange).toHaveBeenCalledWith(ANTHROPIC_PIN);
  });

  it('rejects forged, unavailable, and wrong-Harness routes without saving', async () => {
    const onChange = vi.fn();
    mount({ options: [{ ...xdOption, available: false }, ...options], value: xdOption.id, onChange });
    expect(picker.sourceDisconnected).toBe(true);
    expect(picker.providersOverride?.some(p => p.id === 'xd')).toBe(false);
    for (const route of [
      { providerId: 'xd', modelId: xdOption.modelId, engine: 'codex' as const },
      { providerId: 'anthropic', modelId: 'claude-haiku-4-5', engine: 'codex' as const },
      { providerId: 'unlisted', modelId: 'gpt', engine: 'codex' as const },
    ]) expect(await picker.onUnifiedSelect!({ ...route, fast: false, favoriteUid: null })).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('keeps an available same-model route when the saved Harness route is unavailable', async () => {
    const unavailable = { ...xdOption, id: 'old', agentKind: 'claude-code', available: false };
    const onChange = vi.fn();
    mount({ value: unavailable.id, options: [unavailable, xdOption], onChange });
    expect(picker.providersOverride![0]!.agents).toEqual(['codex']);
    await picker.onUnifiedSelect!({ providerId: 'xd', modelId: xdOption.modelId,
      engine: 'codex', fast: false, favoriteUid: null });
    expect(onChange).toHaveBeenCalledWith(xdOption.id);
  });

  it('preserves failure results, same-pin no-op, automatic clearing, and legacy labels', async () => {
    const onChange = vi.fn(async () => false);
    const view = mount({ value: OPENROUTER_PIN, onChange });
    expect(await picker.onUnifiedSelect!({ providerId: 'openrouter', modelId: 'openai/gpt-5-mini',
      engine: 'codex', fast: false, favoriteUid: null })).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
    expect(await picker.onUnifiedSelect!({ providerId: 'anthropic', modelId: 'claude-haiku-4-5',
      engine: 'cc', fast: false, favoriteUid: null })).toBe(false);
    expect(await picker.fallbackOption!.onSelect()).toBe(false);
    expect(onChange).toHaveBeenLastCalledWith(null);
    view.unmount();
    mount({ value: 'legacy', legacyPinLabel: 'Budget tier' });
    expect(picker.sourceDisconnected).toBe(false);
    expect(picker.unknownModelLabel!('legacy')).toBe('Budget tier');
  });
});
