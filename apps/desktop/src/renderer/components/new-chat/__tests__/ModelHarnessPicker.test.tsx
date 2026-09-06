// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { unifiedModelEntries, type ProviderView } from '@cindy/model-providers';
import dictionary from '../../../i18n/locales/zh-CN/common.json';
import { ModelHarnessPicker } from '../ModelHarnessPicker';
import { ModelConfigFlyout } from '../ModelConfigFlyout';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      key
        .split('.')
        .reduce<unknown>((value, part) => (value as Record<string, unknown>)?.[part], dictionary) ??
      key,
  }),
}));
afterEach(cleanup);

function entry() {
  const model = {
    id: 'google/gemini-new',
    name: 'Gemini',
    contextWindow: 1_048_576,
    efforts: [],
    defaultEffort: null,
    nativeApi: 'google-generative-ai',
  } as const;
  const provider = {
    id: 'xd',
    name: 'Cindy AI',
    connected: true,
    source: 'builtin',
    agents: ['claude-code', 'codex', 'pi'],
    auth: { method: 'token' },
    routing: {
      'claude-code': { wireProtocol: 'anthropic-messages' },
      codex: { wireProtocol: 'openai-responses' },
      pi: { wireProtocol: 'openai-responses' },
    },
    models: {
      'claude-code': [{ ...model }],
      codex: [{ ...model }],
      pi: [{ ...model, piApi: 'google-generative-ai' }],
    },
  } as unknown as ProviderView;
  return unifiedModelEntries({ providers: [provider] })[0]!;
}

describe('model harness choices', () => {
  it('shows native/compatibility facts and recommends Pi without changing selection on open', () => {
    const onChange = vi.fn();
    const model = entry();
    const { container, rerender } = render(
      <ModelHarnessPicker entry={model} value="pi" onChange={onChange} />,
    );
    expect(
      container.querySelector('[data-engine-capsule]')?.getAttribute('data-engine-capsule'),
    ).toBe('pi');
    expect(
      screen.getByRole('button', { name: /Pi · Google Gemini · 原生支持 · 推荐/ }),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: /Codex · Responses · 兼容模式/ })).toBeTruthy();
    expect(container.querySelectorAll('[data-engine-capsule]')).toHaveLength(3);
    expect(screen.queryByText('原生支持')).toBeNull();
    expect(screen.getAllByText('兼容模式')).toHaveLength(1);
    expect(screen.queryByText('推荐 Pi')).toBeNull();
    expect(screen.queryByText('兼容')).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.getByRole('button', { name: /Claude Code/ }).title).toContain('Google Gemini');
    expect(screen.queryByText('Messages · 兼容模式')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Codex · Responses · 兼容模式/ }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith('codex');
    rerender(<ModelHarnessPicker entry={model} value="codex" onChange={onChange} />);
    expect(container.querySelectorAll('[aria-pressed="true"]')).toHaveLength(1);
    expect(
      screen
        .getByRole('button', { name: /Codex · Responses · 兼容模式/ })
        .getAttribute('aria-pressed'),
    ).toBe('true');
    expect(
      screen
        .getByRole('button', { name: /Pi · Google Gemini · 原生支持 · 推荐/ })
        .getAttribute('aria-pressed'),
    ).toBe('false');
  });

  it('opens the compatibility explanation without selecting its harness', async () => {
    const onChange = vi.fn();
    render(<ModelHarnessPicker entry={entry()} value="pi" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: '兼容模式' }));
    expect((await screen.findByRole('tooltip')).textContent).toContain('建议有经验的用户使用');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('preserves the same-engine lock used by the unified picker', () => {
    const onChange = vi.fn();
    const model = entry();
    const capability = model.capabilities.codex!;
    render(
      <ModelConfigFlyout
        entry={model}
        config={{
          engine: 'codex',
          agent: 'codex',
          capability,
          efforts: [],
          effort: null,
          fast: false,
          fastCapable: false,
          customized: true,
          wireModelId: capability.wireModelId,
        }}
        state="customized"
        sourceLabel="Cindy AI"
        price={{
          kind: 'priced',
          current: {
            providerId: 'xd',
            modelId: model.modelId,
            source: 'gateway',
            currency: 'USD',
            approximate: false,
            inputPerMtok: 0.75,
            outputPerMtok: 3.75,
            cacheReadPerMtok: 0.075,
          },
        }}
        effortLabelOf={(_, effort) => effort}
        engineLocked
        onEngineChange={onChange}
        onEffortChange={vi.fn()}
        onFastChange={vi.fn()}
        onResetToRecommended={vi.fn()}
        onAddFavorite={vi.fn()}
        onRemoveFavorite={vi.fn()}
      />,
    );
    expect(screen.getByText('$0.75')).toBeTruthy();
    expect(screen.getByText('$3.75')).toBeTruthy();
    expect(screen.getByText('$0.08')).toBeTruthy();
    expect(document.querySelectorAll('[data-engine-capsule]')).toHaveLength(1);
    const current = screen.getByRole('button', {
      name: /Codex · Responses · 兼容模式/,
    }) as HTMLButtonElement;
    expect(current.disabled).toBe(true);
    fireEvent.click(current);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('does not restore compatibility choices filtered out by model settings', () => {
    const model = entry();
    model.candidates = ['pi'];
    const onChange = vi.fn();
    render(<ModelHarnessPicker entry={model} value="pi" onChange={onChange} />);
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('keeps old or unknown protocol metadata unconfirmed and respects saving state', () => {
    const model = entry();
    for (const capability of Object.values(model.capabilities)) {
      delete capability.protocolMode;
      delete capability.nativeApi;
      delete capability.outboundApi;
    }
    const onChange = vi.fn();
    render(<ModelHarnessPicker entry={model} value="pi" disabled onChange={onChange} />);
    expect(screen.getAllByRole('button', { name: /协议待确认/ })).toHaveLength(3);
    for (const button of screen.getAllByRole('button')) {
      fireEvent.click(button);
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
    expect(onChange).not.toHaveBeenCalled();
  });
});
