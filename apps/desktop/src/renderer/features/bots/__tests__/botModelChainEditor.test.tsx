// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { modelSelectorProps, roster } = vi.hoisted(() => ({
  modelSelectorProps: vi.fn(),
  roster: { availableVendors: new Set(['cc', 'codex', 'pi']), loaded: true },
}));

vi.mock('@/hooks/useAvailableAgents', () => ({ useAvailableAgents: () => roster }));

vi.mock('@/components/new-chat/ModelSelector', () => ({
  ModelSelector: (props: {
    modelId: string;
    onEffortChange: (effort: string) => void;
    onFastModeChange: (enabled: boolean) => void;
    onUnifiedSelect: (selection: {
      providerId: string;
      modelId: string;
      effort?: string;
      engine: 'cc' | 'codex' | 'pi';
      fast: boolean;
      favoriteUid: string | null;
    }) => void;
  }) => {
    modelSelectorProps(props);
    return (
      <div data-testid={`model-selector-${props.modelId}`}>
        <button onClick={() => props.onEffortChange("high")}>set-high-effort</button>
        <button onClick={() => props.onFastModeChange(true)}>enable-fast-mode</button>
        <button
          type="button"
          onClick={() =>
            props.onUnifiedSelect({
              providerId: 'openai',
              modelId: 'gpt-5.6-sol',
              effort: 'medium',
              engine: 'codex',
              fast: true,
              favoriteUid: null,
            })
          }
        >
          choose-official-codex-model
        </button>
        <button
          type="button"
          onClick={() =>
            props.onUnifiedSelect({
              providerId: 'anthropic',
              modelId: 'claude-opus-5',
              engine: 'cc',
              fast: false,
              favoriteUid: null,
            })
          }
        >
          choose-official-claude-model
        </button>
      </div>
    );
  },
}));

vi.mock('../botStore', () => ({
  getEffectiveBotModelSettings: () => ({
    model: 'default-model',
    providerId: null,
    effort: '',
    fastMode: false,
  }),
}));

vi.mock('../botPronounContext', () => ({
  useBotTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
  }),
}));

import { BotModelChainEditor } from '../BotModelChainEditor';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  roster.availableVendors = new Set(['cc', 'codex', 'pi']);
  roster.loaded = true;
});

describe('BotModelChainEditor', () => {
  const primary = { harness: 'codex' as const, model: 'primary-model', providerId: 'openai', effort: 'medium', fastMode: false };
  const firstFallback = { ...primary, model: 'first-fallback' };
  const secondFallback = { ...primary, model: 'second-fallback' };

  function expand(container: HTMLElement) {
    const details = container.querySelector('details')!;
    details.open = true;
    fireEvent(details, new Event('toggle'));
    return within(details);
  }

  it('lists and numbers only fallbacks, and edits the second route without replacing the primary', () => {
    const onChange = vi.fn();
    const view = render(<BotModelChainEditor value={[primary, firstFallback]} onChange={onChange} />);
    const fallbacks = expand(view.container);

    expect(screen.getAllByTestId('model-selector-primary-model')).toHaveLength(1);
    expect(fallbacks.queryByTestId('model-selector-primary-model')).toBeNull();
    expect(fallbacks.getByText('bots.modelChain.options:{"count":1}')).toBeTruthy();
    expect(fallbacks.getByText('1')).toBeTruthy();
    expect(fallbacks.queryByText('2')).toBeNull();
    const picker = within(fallbacks.getByTestId('model-selector-first-fallback'));
    fireEvent.click(picker.getByText('choose-official-codex-model'));
    expect(onChange).toHaveBeenLastCalledWith([primary, {
      harness: 'codex', providerId: 'openai', model: 'gpt-5.6-sol', effort: 'medium', fastMode: true,
    }]);
    fireEvent.click(picker.getByText('set-high-effort'));
    expect(onChange).toHaveBeenLastCalledWith([primary, { ...firstFallback, effort: 'high' }]);
    fireEvent.click(picker.getByText('enable-fast-mode'));
    expect(onChange).toHaveBeenLastCalledWith([primary, { ...firstFallback, fastMode: true }]);
  });

  it('reorders and removes fallbacks while keeping the primary in place', () => {
    const onChange = vi.fn();
    const view = render(<BotModelChainEditor value={[primary, firstFallback, secondFallback]} onChange={onChange} />);
    const fallbacks = expand(view.container);
    const up = fallbacks.getAllByLabelText('bots.modelChain.moveUp');
    expect((up[0] as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(up[0]!);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(up[1]!);
    expect(onChange).toHaveBeenLastCalledWith([primary, secondFallback, firstFallback]);
    fireEvent.click(fallbacks.getAllByLabelText('bots.modelChain.moveDown')[0]!);
    expect(onChange).toHaveBeenLastCalledWith([primary, secondFallback, firstFallback]);
    fireEvent.click(fallbacks.getAllByLabelText('bots.modelChain.remove')[0]!);
    expect(onChange).toHaveBeenLastCalledWith([primary, secondFallback]);

    view.rerender(<BotModelChainEditor value={[primary, secondFallback]} onChange={onChange} />);
    expect(fallbacks.getByText('1')).toBeTruthy();
    expect(fallbacks.queryByText('2')).toBeNull();
    fireEvent.click(fallbacks.getByLabelText('bots.modelChain.remove'));
    expect(onChange).toHaveBeenLastCalledWith([primary]);
  });

  it('shows no fallback rows for a primary-only chain and appends the first fallback', () => {
    const onChange = vi.fn();
    const view = render(<BotModelChainEditor value={[primary]} onChange={onChange} />);
    const fallbacks = expand(view.container);
    expect(fallbacks.getByText('bots.modelChain.options:{"count":0}')).toBeTruthy();
    expect(fallbacks.queryByTestId('model-selector-primary-model')).toBeNull();
    expect(fallbacks.queryByLabelText('bots.modelChain.remove')).toBeNull();
    fireEvent.click(fallbacks.getByText('bots.modelChain.add'));
    expect(onChange).toHaveBeenLastCalledWith([primary, expect.objectContaining({ model: 'default-model' })]);
  });

  it('uses the standard configurable picker for the current harness', () => {
    render(
      <BotModelChainEditor
        value={[
          {
            harness: 'pi',
            model: 'z-ai/glm-5.3-flash',
            providerId: 'xd',
            effort: 'high',
            fastMode: false,
          },
        ]}
        onChange={vi.fn()}
        hiddenVendors={['codex']}
      />,
    );

    expect(modelSelectorProps).toHaveBeenCalledTimes(1);
    expect(modelSelectorProps.mock.calls[0]?.[0].unifiedLayout).toBeUndefined();
    expect(modelSelectorProps.mock.calls[0]?.[0].unifiedLayoutControls).toBeUndefined();
    expect(modelSelectorProps.mock.calls[0]?.[0]).toMatchObject({
      configurationEnabled: true,
      vendorKey: 'pi',
      unifiedPanel: true,
      unifiedAgents: ['pi', 'claude-code'],
      triggerVariant: 'toolbar',
    });
  });

  it('blocks picker callbacks and chain controls when disabled', () => {
    const route = { harness: 'codex' as const, model: 'saved-model', providerId: 'openai', effort: '', fastMode: false };
    const onChange = vi.fn();
    const restore = vi.fn();
    const view = render(<BotModelChainEditor value={[route, { ...route, model: 'backup' }]} onChange={onChange} onRestoreDefault={restore} disabled />);
    expect(modelSelectorProps.mock.lastCall?.[0].disabled).toBe(true);
    // Simulate callbacks from content portaled outside the disabled trigger.
    fireEvent.click(screen.getByText('choose-official-codex-model'));
    fireEvent.click(screen.getByText('set-high-effort'));
    fireEvent.click(screen.getByText('enable-fast-mode'));
    const details = view.container.querySelector('details')!;
    details.open = true;
    fireEvent(details, new Event('toggle'));
    for (const label of ['bots.modelChain.moveUp', 'bots.modelChain.moveDown', 'bots.modelChain.remove']) {
      for (const button of screen.getAllByLabelText(label)) {
        expect((button as HTMLButtonElement).disabled).toBe(true);
        fireEvent.click(button);
      }
    }
    fireEvent.click(screen.getByText('bots.modelChain.add'));
    fireEvent.click(screen.getByText('bots.model.restoreDefault'));
    expect(onChange).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
  });

  it('allows selecting the first route when the default chain is empty', () => {
    const onChange = vi.fn();
    render(<BotModelChainEditor value={[]} onChange={onChange} />);
    fireEvent.click(screen.getByText('choose-official-codex-model'));
    expect(onChange).toHaveBeenCalledWith([{ harness: 'codex', providerId: 'openai', model: 'gpt-5.6-sol', effort: 'medium', fastMode: true }]);
  });

  it('filters both first-route selection and added fallbacks with the local runtime roster', () => {
    roster.availableVendors = new Set(['codex']);
    const onChange = vi.fn();
    const view = render(<BotModelChainEditor value={[]} onChange={onChange} />);
    expect(modelSelectorProps.mock.lastCall?.[0].unifiedAgents).toEqual(['codex']);
    // A callback from a now-hidden row must not create an unavailable override.
    fireEvent.click(screen.getByText('choose-official-claude-model'));
    expect(onChange).not.toHaveBeenCalled();
    const details = view.container.querySelector('details')!;
    details.open = true;
    fireEvent(details, new Event('toggle'));
    fireEvent.click(screen.getByText('bots.modelChain.add'));
    expect(onChange).toHaveBeenCalledWith([expect.objectContaining({ harness: 'codex' })]);
  });

  it('does not fabricate a Pi fallback when no runtime is installed', () => {
    roster.availableVendors = new Set();
    const onChange = vi.fn();
    const view = render(<BotModelChainEditor value={[]} onChange={onChange} />);
    expect(modelSelectorProps.mock.lastCall?.[0].unifiedAgents).toEqual([]);
    const details = view.container.querySelector('details')!;
    details.open = true;
    fireEvent(details, new Event('toggle'));
    const add = screen.getByText('bots.modelChain.add') as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    fireEvent.click(add);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('refreshes runtime filtering after installation without rewriting an existing route', () => {
    roster.availableVendors = new Set(['codex']);
    const onChange = vi.fn();
    const route = { harness: 'pi' as const, model: 'saved-pi', providerId: 'custom', effort: '', fastMode: false };
    const view = render(<BotModelChainEditor value={[route]} onChange={onChange} />);
    expect(modelSelectorProps.mock.lastCall?.[0]).toMatchObject({ modelId: 'saved-pi', unifiedAgents: ['codex'] });
    roster.availableVendors = new Set(['pi', 'codex']);
    view.rerender(<BotModelChainEditor value={[route]} onChange={onChange} />);
    expect(modelSelectorProps.mock.lastCall?.[0].unifiedAgents).toEqual(['pi', 'codex']);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('blocks unknown local runtimes until the roster loads and preserves remote filtering', () => {
    roster.availableVendors = new Set();
    roster.loaded = false;
    const onChange = vi.fn();
    const view = render(<BotModelChainEditor value={[]} onChange={onChange} />);
    expect(modelSelectorProps.mock.lastCall?.[0]).toMatchObject({ unifiedAgents: [], disabled: true });
    fireEvent.click(screen.getByText('choose-official-codex-model'));
    fireEvent.click(screen.getByText('set-high-effort'));
    fireEvent.click(screen.getByText('enable-fast-mode'));
    expect(onChange).not.toHaveBeenCalled();
    roster.availableVendors = new Set(['codex']);
    roster.loaded = true;
    view.rerender(<BotModelChainEditor value={[]} onChange={onChange} />);
    fireEvent.click(screen.getByText('choose-official-codex-model'));
    expect(onChange).toHaveBeenCalledWith([expect.objectContaining({ harness: 'codex' })]);
    roster.loaded = true;
    view.rerender(<BotModelChainEditor value={[]} onChange={vi.fn()} remote hiddenVendors={['codex']} />);
    expect(modelSelectorProps.mock.lastCall?.[0].unifiedAgents).toEqual(['pi', 'claude-code']);
  });

  it('writes depth and fast mode to the selected route without changing its model', () => {
    const route = { harness: 'codex' as const, model: 'gpt-5.6-sol',
      providerId: 'openai', effort: 'medium', fastMode: false };
    const fallback = { ...route, model: 'fallback-model' };
    const onChange = vi.fn();
    render(<BotModelChainEditor value={[route, fallback]} onChange={onChange} />);
    fireEvent.click(screen.getByText('set-high-effort'));
    expect(onChange).toHaveBeenLastCalledWith([{ ...route, effort: 'high' }, fallback]);
    fireEvent.click(screen.getByText('enable-fast-mode'));
    expect(onChange).toHaveBeenLastCalledWith([{ ...route, fastMode: true }, fallback]);
    expect(modelSelectorProps.mock.calls[0]?.[0].unifiedSelectionPolicy).toBeUndefined();
  });

  it('atomically stores the official harness, provider, model, effort, and fast mode', () => {
    const onChange = vi.fn();
    render(
      <BotModelChainEditor
        value={[
          {
            harness: 'pi',
            model: 'model-with-effort',
            providerId: 'xd',
            effort: 'high',
            fastMode: false,
          },
        ]}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByText('choose-official-codex-model'));

    expect(onChange).toHaveBeenCalledWith([
      {
        harness: 'codex',
        model: 'gpt-5.6-sol',
        providerId: 'openai',
        effort: 'medium',
        fastMode: true,
      },
    ]);
  });

  it('maps the Claude Code recommendation and clears an unavailable effort', () => {
    const onChange = vi.fn();
    render(
      <BotModelChainEditor
        value={[
          {
            harness: 'pi',
            model: 'model-with-effort',
            providerId: 'xd',
            effort: 'high',
            fastMode: true,
          },
        ]}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByText('choose-official-claude-model'));

    expect(onChange).toHaveBeenCalledWith([
      {
        harness: 'claude',
        model: 'claude-opus-5',
        providerId: 'anthropic',
        effort: '',
        fastMode: false,
      },
    ]);
  });
});
