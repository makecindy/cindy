// @vitest-environment jsdom

import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { toast } from '@/lib/toast';

import type { CatalogModel, ProviderView } from '@cindy/model-providers';

import type { ModelPriceOverrideView } from '../../../../shared/modelPriceOverride';
import { ModelPriceOverrideDialog } from '../ModelPriceOverrideDialog';
import type { UnionModelRow } from '../UnifiedModelList';

const translate = (key: string) => key;

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: translate }),
}));

vi.mock('@/lib/toast', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

const provider = {
  id: 'openrouter',
  name: 'OpenRouter',
  connected: true,
} as unknown as ProviderView;

function row(modelId: string): UnionModelRow {
  const model = {
    id: modelId,
    name: modelId,
    contextWindow: 128_000,
    efforts: [],
    defaultEffort: null,
  } as CatalogModel;
  return {
    id: modelId,
    name: modelId,
    byAgent: { codex: model },
    avail: ['codex'],
  };
}

function priceView(
  modelId: string,
  agent: 'claude-code' | 'codex' = 'codex',
  hasOverride = false,
): ModelPriceOverrideView {
  return {
    target: { providerId: 'openrouter', agent, modelId },
    editable: true,
    reference: {
      providerId: 'openrouter',
      modelId,
      currency: 'USD',
      source: 'provider-reference',
      approximate: false,
      inputPerMtok: 1,
      outputPerMtok: 4,
    },
    effective: {
      providerId: 'openrouter',
      modelId,
      currency: 'USD',
      source: 'provider-reference',
      approximate: false,
      inputPerMtok: 1,
      outputPerMtok: 4,
    },
    override: hasOverride ? { currency: 'USD', inputPerMtok: 2, outputPerMtok: 8 } : null,
    conflict: false,
    registryUpdatedAt: null,
    allowedCurrencies: ['USD'],
  };
}

describe('ModelPriceOverrideDialog', () => {
  const getModelPriceOverride = vi.fn();
  const setModelPriceOverride = vi.fn();
  const resetModelPriceOverride = vi.fn();
  const pricingListeners = new Set<() => void>();
  const providerListeners = new Set<() => void>();
  const broadcastProvider = () => act(() => { providerListeners.forEach(listener => listener()); });
  const broadcastPricing = () => act(() => { pricingListeners.forEach(listener => listener()); });

  beforeEach(() => {
    vi.clearAllMocks();
    pricingListeners.clear();
    providerListeners.clear();
    getModelPriceOverride.mockReset();
    setModelPriceOverride.mockReset();
    resetModelPriceOverride.mockReset();
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      maker: {
        onProvidersChanged: (listener: () => void) => { providerListeners.add(listener); return () => { providerListeners.delete(listener); }; },
        getModelPriceOverride,
        setModelPriceOverride,
        resetModelPriceOverride,
        usage: { onReferenceModelPricingChanged: (listener: () => void) => {
          pricingListeners.add(listener);
          return () => { pricingListeners.delete(listener); };
        } },
      },
    };
  });

  it('clears and disables the stale form when loading a new target fails', async () => {
    getModelPriceOverride
      .mockResolvedValueOnce(priceView('model-a'))
      .mockRejectedValueOnce(new Error('catalog unavailable'));

    const { getByRole, rerender } = render(
      <ModelPriceOverrideDialog
        provider={provider}
        row={row('model-a')}
        open
        onOpenChange={vi.fn()}
      />,
    );

    const save = getByRole('button', {
      name: 'settings.providers.models.priceOverride.save',
    });
    await waitFor(() => expect(save.hasAttribute('disabled')).toBe(false));
    expect(document.querySelector<HTMLInputElement>('input[type="number"]')?.value).toBe('1');

    rerender(
      <ModelPriceOverrideDialog
        provider={provider}
        row={row('model-b')}
        open
        onOpenChange={vi.fn()}
      />,
    );

    await waitFor(() => expect(getModelPriceOverride).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(save.hasAttribute('disabled')).toBe(true));
    expect(document.querySelector<HTMLInputElement>('input[type="number"]')?.value).toBe('');

    fireEvent.click(save);
    expect(setModelPriceOverride).not.toHaveBeenCalled();
  });

  it('uses pill geometry for the currency selector and price inputs', async () => {
    getModelPriceOverride.mockResolvedValueOnce(priceView('model-a'));

    render(
      <ModelPriceOverrideDialog
        provider={provider}
        row={row('model-a')}
        open
        onOpenChange={vi.fn()}
      />,
    );

    await waitFor(() => expect(getModelPriceOverride).toHaveBeenCalledOnce());
    const controls = Array.from(document.querySelectorAll('select, input[type="number"]'));
    expect(controls).toHaveLength(5);
    for (const control of controls) {
      expect(control.classList.contains('rounded-full')).toBe(true);
      expect(control.classList.contains('rounded-lg')).toBe(false);
    }
  });

  it('does not add an unregistered shadow to the runtime segmented control', async () => {
    getModelPriceOverride.mockResolvedValueOnce(priceView('model-a'));
    const claudeModel = row('model-a').byAgent.codex!;
    const dualRuntimeRow: UnionModelRow = {
      ...row('model-a'),
      byAgent: { 'claude-code': claudeModel, codex: claudeModel },
      avail: ['claude-code', 'codex'],
    };

    const { getByRole } = render(
      <ModelPriceOverrideDialog
        provider={provider}
        row={dualRuntimeRow}
        open
        onOpenChange={vi.fn()}
      />,
    );

    await waitFor(() => expect(getModelPriceOverride).toHaveBeenCalledOnce());
    expect(getByRole('radio', { name: 'Claude Code' }).classList.contains('shadow-sm')).toBe(false);
    expect(getByRole('radio', { name: 'Codex' }).classList.contains('shadow-sm')).toBe(false);
  });

  it('prevents switching runtime while a reset response is pending', async () => {
    getModelPriceOverride.mockResolvedValueOnce(priceView('model-a', 'claude-code', true));
    let finishReset: ((view: ModelPriceOverrideView) => void) | undefined;
    resetModelPriceOverride.mockReturnValueOnce(
      new Promise<ModelPriceOverrideView>((resolve) => {
        finishReset = resolve;
      }),
    );
    const claudeModel = row('model-a').byAgent.codex!;
    const dualRuntimeRow: UnionModelRow = {
      ...row('model-a'),
      byAgent: { 'claude-code': claudeModel, codex: claudeModel },
      avail: ['claude-code', 'codex'],
    };

    const { getByRole } = render(
      <ModelPriceOverrideDialog
        provider={provider}
        row={dualRuntimeRow}
        open
        onOpenChange={vi.fn()}
      />,
    );

    const reset = await waitFor(() =>
      getByRole('button', { name: 'settings.providers.models.priceOverride.reset' }),
    );
    fireEvent.click(reset);
    await waitFor(() => expect(resetModelPriceOverride).toHaveBeenCalledOnce());

    const codex = getByRole('radio', { name: 'Codex' });
    expect(codex.hasAttribute('disabled')).toBe(true);
    fireEvent.click(codex);
    expect(getModelPriceOverride).toHaveBeenCalledOnce();

    finishReset?.(priceView('model-a', 'claude-code'));
    await waitFor(() => expect(codex.hasAttribute('disabled')).toBe(false));
  });

  it('moves initial focus to the primary price input', async () => {
    getModelPriceOverride.mockResolvedValueOnce(priceView('model-a'));
    const { getByLabelText } = render(
      <ModelPriceOverrideDialog
        provider={provider}
        row={row('model-a')}
        open
        onOpenChange={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(
        getByLabelText('settings.providers.models.priceOverride.input'),
      ),
    );
  });

  it('invalidates a pending save when the dialog instance unmounts', async () => {
    getModelPriceOverride.mockResolvedValueOnce(priceView('model-a'));
    let finishSave: ((view: ModelPriceOverrideView) => void) | undefined;
    setModelPriceOverride.mockReturnValueOnce(
      new Promise<ModelPriceOverrideView>((resolve) => {
        finishSave = resolve;
      }),
    );
    const onOpenChangeA = vi.fn();
    const first = render(
      <ModelPriceOverrideDialog
        provider={provider}
        row={row('model-a')}
        open
        onOpenChange={onOpenChangeA}
      />,
    );
    const save = first.getByRole('button', {
      name: 'settings.providers.models.priceOverride.save',
    });
    await waitFor(() => expect(save.hasAttribute('disabled')).toBe(false));
    fireEvent.click(save);
    await waitFor(() => expect(setModelPriceOverride).toHaveBeenCalledOnce());

    // 生产路径:UnifiedModelList 换行时条件渲染会卸载 A、另挂全新实例 B。
    first.unmount();
    getModelPriceOverride.mockResolvedValueOnce(priceView('model-b'));
    const second = render(
      <ModelPriceOverrideDialog
        provider={provider}
        row={row('model-b')}
        open
        onOpenChange={vi.fn()}
      />,
    );
    await waitFor(() => expect(getModelPriceOverride).toHaveBeenCalledTimes(2));

    // A 的迟到响应落地:不得触发旧实例的 onOpenChange(false),B 的表单不受影响。
    finishSave?.(priceView('model-a', 'codex', true));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onOpenChangeA).not.toHaveBeenCalled();
    expect(
      (second.getByLabelText('settings.providers.models.priceOverride.input') as HTMLInputElement)
        .value,
    ).toBe('1');
  });

  it('discards a late save response after the dialog is closed and reopened', async () => {
    getModelPriceOverride.mockResolvedValueOnce(priceView('model-a'));
    let finishSave: ((view: ModelPriceOverrideView) => void) | undefined;
    setModelPriceOverride.mockReturnValueOnce(
      new Promise<ModelPriceOverrideView>((resolve) => {
        finishSave = resolve;
      }),
    );
    const onOpenChange = vi.fn();
    const { getByRole, getByLabelText, rerender } = render(
      <ModelPriceOverrideDialog
        provider={provider}
        row={row('model-a')}
        open
        onOpenChange={onOpenChange}
      />,
    );
    const save = getByRole('button', {
      name: 'settings.providers.models.priceOverride.save',
    });
    await waitFor(() => expect(save.hasAttribute('disabled')).toBe(false));
    fireEvent.click(save);
    await waitFor(() => expect(setModelPriceOverride).toHaveBeenCalledOnce());

    // 保存尚未返回时关闭弹窗,随即打开模型 B。
    rerender(
      <ModelPriceOverrideDialog
        provider={provider}
        row={row('model-a')}
        open={false}
        onOpenChange={onOpenChange}
      />,
    );
    getModelPriceOverride.mockResolvedValueOnce(priceView('model-b'));
    rerender(
      <ModelPriceOverrideDialog
        provider={provider}
        row={row('model-b')}
        open
        onOpenChange={onOpenChange}
      />,
    );
    await waitFor(() => expect(getModelPriceOverride).toHaveBeenCalledTimes(2));

    // A 的迟到响应(带 override 2/8)落地:不得关闭 B 的弹窗,也不得覆写 B 的表单。
    finishSave?.(priceView('model-a', 'codex', true));
    const saveB = getByRole('button', {
      name: 'settings.providers.models.priceOverride.save',
    });
    await waitFor(() => expect(saveB.hasAttribute('disabled')).toBe(false));
    expect(
      (getByLabelText('settings.providers.models.priceOverride.input') as HTMLInputElement).value,
    ).toBe('1');
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  function inline(modelId = 'model-a', onOpenChange = vi.fn()) {
    return <ModelPriceOverrideDialog provider={provider} row={row(modelId)} open
      onOpenChange={onOpenChange} presentation="inline" />;
  }

  it('keeps Enter inert and saves a changed inline quote only on blur', async () => {
    getModelPriceOverride.mockResolvedValue(priceView('model-a'));
    const next = priceView('model-a', 'codex', true);
    next.effective = { ...next.effective!, inputPerMtok: 0 };
    setModelPriceOverride.mockResolvedValue(next);
    const close = vi.fn();
    const ui = render(inline('model-a', close));
    const input = ui.getByLabelText('settings.providers.models.priceOverride.input');
    await waitFor(() => expect((input as HTMLInputElement).value).toBe('1'));
    fireEvent.blur(input);
    expect(setModelPriceOverride).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '0' } });
    input.focus();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(document.activeElement).toBe(input);
    expect(setModelPriceOverride).not.toHaveBeenCalled();
    act(() => input.blur());
    fireEvent.blur(input);
    await waitFor(() => expect(setModelPriceOverride).toHaveBeenCalledOnce());
    expect(setModelPriceOverride).toHaveBeenCalledWith(
      { providerId: 'openrouter', agent: 'codex', modelId: 'model-a' },
      { currency: 'USD', inputPerMtok: 0, outputPerMtok: 4, cacheReadPerMtok: null, cacheCreatePerMtok: null },
    );
    await waitFor(() => expect(input.hasAttribute('readonly')).toBe(false));
    expect(close).not.toHaveBeenCalled();
  });

  it('blurs and saves on Escape without dismissing the containing surface', async () => {
    getModelPriceOverride.mockResolvedValue(priceView('model-a'));
    setModelPriceOverride.mockResolvedValue({ ...priceView('model-a', 'codex', true),
      effective: { ...priceView('model-a').effective!, inputPerMtok: 7 } });
    const bubble = vi.fn();
    const ui = render(<div onKeyDown={bubble}>{inline()}</div>);
    const input = ui.getByLabelText('settings.providers.models.priceOverride.input') as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('1'));
    input.focus();
    fireEvent.change(input, { target: { value: '7' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(document.activeElement).not.toBe(input);
    expect(input.value).toBe('7');
    expect(bubble).not.toHaveBeenCalled();
    await waitFor(() => expect(setModelPriceOverride).toHaveBeenCalledWith(
      priceView('model-a').target, expect.objectContaining({ inputPerMtok: 7 })));
    expect(ui.queryByText('已撤销当前输入')).toBeNull();
  });

  it('restores invalid inline values and keeps failed valid drafts for retry', async () => {
    getModelPriceOverride.mockResolvedValue(priceView('model-a'));
    setModelPriceOverride.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(priceView('model-a'));
    const ui = render(inline());
    const input = ui.getByLabelText('settings.providers.models.priceOverride.input') as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('1'));
    fireEvent.change(input, { target: { value: '-1' } });
    fireEvent.blur(input);
    expect(setModelPriceOverride).not.toHaveBeenCalled();
    expect(input.value).toBe('1');
    fireEvent.change(input, { target: { value: '2' } });
    fireEvent.blur(input);
    await waitFor(() => expect(input.hasAttribute('readonly')).toBe(false));
    expect(input.value).toBe('2');
    fireEvent.blur(input);
    await waitFor(() => expect(setModelPriceOverride).toHaveBeenCalledTimes(2));
  });

  it('resets the override through the existing API rather than saving the reference as an override', async () => {
    getModelPriceOverride.mockResolvedValue(priceView('model-a', 'codex', true));
    resetModelPriceOverride.mockResolvedValue(priceView('model-a'));
    const ui = render(inline());
    const reset = ui.getByRole('button', { name: 'settings.providers.models.priceOverride.resetShort' });
    await waitFor(() => expect(reset.hasAttribute('disabled')).toBe(false));
    fireEvent.click(reset);
    await waitFor(() => expect(resetModelPriceOverride).toHaveBeenCalledOnce());
    expect(resetModelPriceOverride).toHaveBeenCalledWith({ providerId: 'openrouter', agent: 'codex', modelId: 'model-a' });
    await waitFor(() => expect(reset.hasAttribute('disabled')).toBe(true));
    expect(setModelPriceOverride).not.toHaveBeenCalled();
  });

  it('does not enable inline writes when loading fails or the existing API denies editing', async () => {
    getModelPriceOverride.mockRejectedValueOnce(new Error('offline'));
    const ui = render(inline());
    await waitFor(() => expect(getModelPriceOverride).toHaveBeenCalledOnce());
    const input = ui.getByLabelText('settings.providers.models.priceOverride.input');
    expect(input.hasAttribute('disabled')).toBe(true);
    const denied = { ...priceView('model-b'), editable: false };
    getModelPriceOverride.mockResolvedValueOnce(denied);
    ui.rerender(inline('model-b'));
    await waitFor(() => expect((input as HTMLInputElement).value).toBe('1'));
    expect(input.hasAttribute('disabled')).toBe(true);
    expect(setModelPriceOverride).not.toHaveBeenCalled();
  });

  it('retains engine and allowed currency selection without writing other targets', async () => {
    const modelRow = row('model-a');
    modelRow.byAgent['claude-code'] = { ...modelRow.byAgent.codex!, id: 'claude-alias' };
    modelRow.avail = ['codex', 'claude-code'];
    const view = priceView('claude-alias', 'claude-code');
    view.allowedCurrencies = ['USD', 'CNY'];
    getModelPriceOverride.mockResolvedValue(view);
    setModelPriceOverride.mockResolvedValue(view);
    const ui = render(<ModelPriceOverrideDialog provider={provider} row={modelRow} open
      onOpenChange={vi.fn()} presentation="inline" initialAgent="claude-code" />);
    await waitFor(() => expect(getModelPriceOverride).toHaveBeenCalledWith(
      { providerId: 'openrouter', agent: 'claude-code', modelId: 'claude-alias' },
    ));
    const currency = await ui.findByLabelText('settings.providers.models.priceOverride.currency');
    fireEvent.change(currency, { target: { value: 'CNY' } });
    await waitFor(() => expect(setModelPriceOverride).toHaveBeenCalledOnce());
    expect(setModelPriceOverride.mock.calls[0][1]).toMatchObject({ currency: 'CNY', inputPerMtok: 1 });
    await waitFor(() => expect(currency.hasAttribute('disabled')).toBe(false));
    fireEvent.click(ui.getByRole('radio', { name: 'Codex' }));
    await waitFor(() => expect(getModelPriceOverride).toHaveBeenLastCalledWith(
      { providerId: 'openrouter', agent: 'codex', modelId: 'model-a' },
    ));
    expect(setModelPriceOverride).toHaveBeenCalledOnce();
  });

  it('ignores late inline saves after changing models', async () => {
    getModelPriceOverride.mockResolvedValueOnce(priceView('model-a')).mockResolvedValueOnce(priceView('model-b'));
    let finish!: (value: ModelPriceOverrideView) => void;
    setModelPriceOverride.mockReturnValueOnce(new Promise<ModelPriceOverrideView>(resolve => { finish = resolve; }));
    const ui = render(inline());
    const input = ui.getByLabelText('settings.providers.models.priceOverride.input') as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('1'));
    fireEvent.change(input, { target: { value: '9' } });
    fireEvent.blur(input);
    await waitFor(() => expect(setModelPriceOverride).toHaveBeenCalledOnce());
    ui.rerender(inline('model-b'));
    await waitFor(() => expect(input.value).toBe('1'));
    const old = priceView('model-a'); old.effective!.inputPerMtok = 9;
    await act(async () => { finish(old); });
    await waitFor(() => expect(input.hasAttribute('readonly')).toBe(false));
    expect(input.value).toBe('1');
  });


  it('retains the supplied read-only reference tariff details beside the editable estimate', async () => {
    getModelPriceOverride.mockResolvedValue(priceView('model-a'));
    const ui = render(<ModelPriceOverrideDialog provider={provider} row={row('model-a')} open
      onOpenChange={vi.fn()} presentation="inline"
      referenceDetails={<span>Supplier image pricing and billing conditions</span>} />);
    await waitFor(() => expect((ui.getByLabelText('settings.providers.models.priceOverride.input') as HTMLInputElement).value).toBe('1'));
    expect(ui.getByText('Supplier image pricing and billing conditions').closest('details')).toBeTruthy();
    expect(setModelPriceOverride).not.toHaveBeenCalled();
  });


  it('resets on the first click after editing, without saving the discarded draft', async () => {
    const user = userEvent.setup();
    getModelPriceOverride.mockResolvedValue(priceView('model-a', 'codex', true));
    resetModelPriceOverride.mockResolvedValue(priceView('model-a'));
    const ui = render(inline());
    const input = ui.getByLabelText('settings.providers.models.priceOverride.input') as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('1'));
    await user.clear(input);
    await user.type(input, '7');
    await user.click(ui.getByRole('button', { name: 'settings.providers.models.priceOverride.resetShort' }));
    await waitFor(() => expect(resetModelPriceOverride).toHaveBeenCalledOnce());
    expect(setModelPriceOverride).not.toHaveBeenCalled();
    await waitFor(() => expect(input.value).toBe('1'));
  });

  it.each(['tab', 'click'] as const)('preserves the next price focus during and after a %s-triggered save', async (navigation) => {
    const user = userEvent.setup();
    getModelPriceOverride.mockResolvedValue(priceView('model-a'));
    let finish!: (view: ModelPriceOverrideView) => void;
    const saved = priceView('model-a', 'codex', true);
    saved.effective!.inputPerMtok = 2;
    setModelPriceOverride.mockReturnValueOnce(new Promise<ModelPriceOverrideView>(resolve => { finish = resolve; }))
      .mockResolvedValue(saved);
    const ui = render(inline());
    const input = ui.getByLabelText('settings.providers.models.priceOverride.input') as HTMLInputElement;
    const output = ui.getByLabelText('settings.providers.models.priceOverride.output') as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('1'));
    await user.clear(input);
    await user.type(input, '2');
    if (navigation === 'tab') await user.tab(); else await user.click(output);
    expect(setModelPriceOverride).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(output);
    expect(output.disabled).toBe(false);
    expect(output.readOnly).toBe(true);
    await act(async () => { finish(saved); });
    expect(document.activeElement).toBe(output);
    expect(output.readOnly).toBe(false);
    await user.clear(output);
    await user.type(output, '8');
    await user.tab();
    await waitFor(() => expect(setModelPriceOverride).toHaveBeenCalledTimes(2));
    expect(setModelPriceOverride.mock.calls[1][1].outputPerMtok).toBe(8);
  });

  it('queues the first engine click until the current price save succeeds', async () => {
    const user = userEvent.setup();
    const modelRow = row('model-a');
    modelRow.byAgent['claude-code'] = { ...modelRow.byAgent.codex!, id: 'model-b' };
    modelRow.avail = ['codex', 'claude-code'];
    getModelPriceOverride.mockImplementation(target => Promise.resolve(priceView(target.modelId, target.agent)));
    let finish!: (view: ModelPriceOverrideView) => void;
    setModelPriceOverride.mockReturnValue(new Promise<ModelPriceOverrideView>(resolve => { finish = resolve; }));
    const ui = render(<ModelPriceOverrideDialog provider={provider} row={modelRow} open
      onOpenChange={vi.fn()} presentation="inline" initialAgent="codex" />);
    let input = ui.getByLabelText('settings.providers.models.priceOverride.input') as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('1'));
    await user.clear(input);
    await user.type(input, '7');
    const claude = ui.getByRole('radio', { name: 'Claude Code' });
    await user.click(claude);
    expect(claude.getAttribute('aria-checked')).toBe('false');
    expect(getModelPriceOverride).toHaveBeenLastCalledWith(
      { providerId: 'openrouter', agent: 'codex', modelId: 'model-a' },
    );
    expect(setModelPriceOverride).toHaveBeenCalledExactlyOnceWith(
      { providerId: 'openrouter', agent: 'codex', modelId: 'model-a' },
      expect.objectContaining({ inputPerMtok: 7 }),
    );
    const old = priceView('model-a'); old.effective!.inputPerMtok = 7;
    await act(async () => { finish(old); });
    await waitFor(() => expect(claude.getAttribute('aria-checked')).toBe('true'));
    await waitFor(() => expect(getModelPriceOverride).toHaveBeenLastCalledWith(
      { providerId: 'openrouter', agent: 'claude-code', modelId: 'model-b' },
    ));
    await waitFor(() => expect((ui.getByLabelText('settings.providers.models.priceOverride.input') as HTMLInputElement).value).toBe('1'));
    input = ui.getByLabelText('settings.providers.models.priceOverride.input') as HTMLInputElement;
    expect(input.value).toBe('1');
    expect(input.readOnly).toBe(false);
  });

  it.each(['api', 'subscription'] as const)('shows the unknown %s price and waits for both required fields', async (kind) => {
    const user = userEvent.setup();
    getModelPriceOverride.mockResolvedValue({ ...priceView('model-a'), effective: null, reference: null });
    const saved = priceView('model-a', 'codex', true); saved.effective!.inputPerMtok = 2;
    setModelPriceOverride.mockResolvedValue(saved);
    const source = kind === 'subscription'
      ? { ...provider, access: { kind: 'subscription' } } as ProviderView : provider;
    const ui = render(<ModelPriceOverrideDialog provider={source} row={row('model-a')} open
      onOpenChange={vi.fn()} presentation="inline" />);
    const input = ui.getByLabelText('settings.providers.models.priceOverride.input') as HTMLInputElement;
    const output = ui.getByLabelText('settings.providers.models.priceOverride.output') as HTMLInputElement;
    await waitFor(() => expect(input.disabled).toBe(false));
    expect(ui.getByRole('status').textContent).toBe(kind === 'subscription'
      ? 'settings.providers.models.subscription' : 'settings.providers.models.advanced.noPricing');
    expect(input.placeholder).toBe('—');
    expect(input.value).toBe('');
    await user.type(input, '2');
    await user.tab();
    expect(document.activeElement).toBe(output);
    expect(setModelPriceOverride).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    await user.type(output, '4');
    await user.tab();
    await waitFor(() => expect(setModelPriceOverride).toHaveBeenCalledOnce());
    expect(setModelPriceOverride.mock.calls[0][1]).toMatchObject({ inputPerMtok: 2, outputPerMtok: 4 });
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('displays a known zero price as a value rather than as an unknown price', async () => {
    const view = priceView('model-a'); view.effective!.inputPerMtok = 0;
    getModelPriceOverride.mockResolvedValue(view);
    const ui = render(inline());
    const input = ui.getByLabelText('settings.providers.models.priceOverride.input') as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('0'));
    expect(ui.queryByRole('status')).toBeNull();
    expect(setModelPriceOverride).not.toHaveBeenCalled();
  });

  it.each(['input', 'output'] as const)('restores an empty existing %s price after reporting the error', async (field) => {
    const user = userEvent.setup();
    getModelPriceOverride.mockResolvedValue(priceView('model-a'));
    const ui = render(inline());
    const input = ui.getByLabelText(`settings.providers.models.priceOverride.${field}`) as HTMLInputElement;
    await waitFor(() => expect(input.disabled).toBe(false));
    const previous = input.value;
    await user.clear(input);
    await user.tab();
    expect(toast.error).toHaveBeenCalledWith('settings.providers.models.priceOverride.invalid');
    expect(setModelPriceOverride).not.toHaveBeenCalled();
    expect(input.value).toBe(previous);
  });

  it('reports pending synchronously and keeps the draft after a failed blur save', async () => {
    const user = userEvent.setup();
    const pending = vi.fn();
    getModelPriceOverride.mockResolvedValue(priceView('model-a'));
    let reject!: (error: Error) => void;
    setModelPriceOverride.mockReturnValue(new Promise((_, fail) => { reject = fail; }));
    const ui = render(<ModelPriceOverrideDialog provider={provider} row={row('model-a')} open
      onOpenChange={vi.fn()} presentation="inline" onPendingChange={pending} />);
    const input = ui.getByLabelText('settings.providers.models.priceOverride.input') as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('1'));
    await user.clear(input);
    await user.type(input, '7');
    await user.tab();
    expect(pending).toHaveBeenLastCalledWith(true);
    await act(async () => { reject(new Error('save failed')); });
    expect(pending).toHaveBeenLastCalledWith(false);
    expect(toast.error).toHaveBeenCalledWith('settings.providers.models.priceOverride.saveFailed');
    expect(input.value).toBe('7');
  });

  it('keeps the engine and draft when a save requested before switching fails', async () => {
    const user = userEvent.setup();
    const modelRow = row('model-a');
    modelRow.byAgent['claude-code'] = { ...modelRow.byAgent.codex!, id: 'model-b' };
    modelRow.avail = ['codex', 'claude-code'];
    getModelPriceOverride.mockResolvedValue(priceView('model-a'));
    let reject!: (error: Error) => void;
    setModelPriceOverride.mockReturnValue(new Promise((_, fail) => { reject = fail; }));
    const ui = render(<ModelPriceOverrideDialog provider={provider} row={modelRow} open
      onOpenChange={vi.fn()} presentation="inline" initialAgent="codex" />);
    const input = ui.getByLabelText('settings.providers.models.priceOverride.input') as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('1'));
    await user.clear(input);
    await user.type(input, '7');
    await user.click(ui.getByRole('radio', { name: 'Claude Code' }));
    await act(async () => { reject(new Error('save failed')); });
    expect(toast.error).toHaveBeenCalledWith('settings.providers.models.priceOverride.saveFailed');
    expect(input.value).toBe('7');
    expect(ui.getByRole('radio', { name: 'Codex' }).getAttribute('aria-checked')).toBe('true');
    expect(getModelPriceOverride).toHaveBeenCalledOnce();
  });

  it.each([
    { amount: 1, override: false },
    { amount: 5, override: true },
    { amount: 0, override: true },
  ])('restores the last effective price $amount for invalid input without writing', async ({ amount, override }) => {
    const view = priceView('model-a', 'codex', override);
    view.effective!.inputPerMtok = amount;
    getModelPriceOverride.mockResolvedValue(view);
    const ui = render(inline());
    const input = ui.getByLabelText('settings.providers.models.priceOverride.input') as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe(String(amount)));
    for (const invalid of ['', ' ', '-1', 'not-a-price', 'Infinity', '0x10', '0o10', '0b10']) {
      input.focus();
      fireEvent.change(input, { target: { value: invalid } });
      act(() => input.blur());
      expect(input.value).toBe(String(amount));
    }
    expect(setModelPriceOverride).not.toHaveBeenCalled();
    ui.unmount();
    const reopened = render(inline());
    await waitFor(() => expect((reopened.getByLabelText('settings.providers.models.priceOverride.input') as HTMLInputElement).value).toBe(String(amount)));
  });

  it.each(['input', 'output', 'cacheRead', 'cacheWrite'])('rejects non-decimal %s prices without writing', async (label) => {
    const view = priceView('model-a');
    view.effective!.cacheReadPerMtok = 0.1;
    view.effective!.cacheCreatePerMtok = 0.2;
    getModelPriceOverride.mockResolvedValue(view);
    const ui = render(inline());
    const input = ui.getByLabelText(`settings.providers.models.priceOverride.${label}`) as HTMLInputElement;
    await waitFor(() => expect(input.disabled).toBe(false));
    const previous = input.value;
    fireEvent.change(input, { target: { value: '0x10' } });
    fireEvent.blur(input);
    expect(input.value).toBe(previous);
    expect(toast.error).toHaveBeenCalledWith('settings.providers.models.priceOverride.invalid');
    expect(setModelPriceOverride).not.toHaveBeenCalled();
  });

  it.each([0, 3])('uses the list quote for a cost-only custom model, including %s', async (amount) => {
    const empty = { ...priceView('model-a'), effective: null, reference: null };
    const fallback = { ...priceView('model-a').effective!, inputPerMtok: amount,
      outputPerMtok: 6, cacheReadPerMtok: 0.2, cacheCreatePerMtok: 0.4 };
    getModelPriceOverride.mockResolvedValue(empty);
    resetModelPriceOverride.mockResolvedValue(empty);
    const saved = priceView('model-a', 'codex', true);
    saved.effective = { ...fallback, inputPerMtok: 7, source: 'user-override' };
    setModelPriceOverride.mockResolvedValue(saved);
    const ui = render(<ModelPriceOverrideDialog provider={provider} row={row('model-a')} open
      presentation="inline" onOpenChange={vi.fn()} fallbackQuoteOf={() => fallback} />);
    const input = ui.getByLabelText('settings.providers.models.priceOverride.input') as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe(String(amount)));
    expect(ui.queryByRole('status')).toBeNull();
    expect((ui.getByLabelText('settings.providers.models.priceOverride.output') as HTMLInputElement).value).toBe('6');
    expect(setModelPriceOverride).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    expect(input.value).toBe(String(amount));
    fireEvent.change(input, { target: { value: '7' } });
    fireEvent.blur(input);
    await waitFor(() => expect(input.readOnly).toBe(false));
    expect(setModelPriceOverride).toHaveBeenCalledWith(empty.target, {
      currency: 'USD', inputPerMtok: 7, outputPerMtok: 6,
      cacheReadPerMtok: 0.2, cacheCreatePerMtok: 0.4,
    });
    fireEvent.click(ui.getByRole('button', { name: 'settings.providers.models.priceOverride.resetShort' }));
    await waitFor(() => expect(input.value).toBe(String(amount)));
    expect(resetModelPriceOverride).toHaveBeenCalledWith(empty.target);
  });

  it.each(['success', 'failure'] as const)('preserves pending %s across a same-target provider refresh', async (outcome) => {
    const pending = vi.fn();
    getModelPriceOverride.mockResolvedValue(priceView('model-a'));
    let resolve!: (value: ModelPriceOverrideView) => void;
    let reject!: (error: Error) => void;
    setModelPriceOverride.mockReturnValue(new Promise((ok, fail) => { resolve = ok; reject = fail; }));
    const props = { provider, row: row('model-a'), open: true, presentation: 'inline' as const,
      onOpenChange: vi.fn(), onPendingChange: pending };
    const ui = render(<ModelPriceOverrideDialog {...props} />);
    const input = ui.getByLabelText('settings.providers.models.priceOverride.input') as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('1'));
    fireEvent.change(input, { target: { value: '7' } });
    fireEvent.blur(input);
    expect(pending).toHaveBeenLastCalledWith(true);
    ui.rerender(<ModelPriceOverrideDialog {...props} provider={{ ...provider }} row={row('model-a')} />);
    expect(pending).toHaveBeenLastCalledWith(true);
    expect(input.readOnly).toBe(true);
    expect(input.value).toBe('7');
    expect(getModelPriceOverride).toHaveBeenCalledOnce();
    await act(async () => {
      if (outcome === 'failure') reject(new Error('save failed'));
      else resolve({ ...priceView('model-a', 'codex', true),
        effective: { ...priceView('model-a').effective!, inputPerMtok: 7 } });
    });
    expect(pending).toHaveBeenLastCalledWith(false);
    expect(input.value).toBe('7');
    expect(input.readOnly).toBe(false);
    expect(outcome === 'failure' ? toast.error : toast.success).toHaveBeenCalledWith(
      `settings.providers.models.priceOverride.${outcome === 'failure' ? 'saveFailed' : 'saved'}`);
  });

  function refreshedPrice(input = 1, output = 9): ModelPriceOverrideView {
    const next = priceView('model-a', 'codex', true);
    next.effective = { ...next.effective!, inputPerMtok: input, outputPerMtok: output };
    return next;
  }

  it('refreshes an idle editor after another window changes the same quote', async () => {
    getModelPriceOverride.mockResolvedValueOnce(priceView('model-a')).mockResolvedValue(refreshedPrice());
    setModelPriceOverride.mockResolvedValue(refreshedPrice(7));
    const ui = render(inline());
    const input = ui.getByLabelText('settings.providers.models.priceOverride.input') as HTMLInputElement;
    const output = ui.getByLabelText('settings.providers.models.priceOverride.output') as HTMLInputElement;
    await waitFor(() => expect(output.value).toBe('4'));
    broadcastPricing();
    await waitFor(() => expect(output.value).toBe('9'));
    expect(setModelPriceOverride).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '7' } });
    fireEvent.blur(input);
    await waitFor(() => expect(setModelPriceOverride).toHaveBeenCalledWith(
      priceView('model-a').target, expect.objectContaining({ inputPerMtok: 7, outputPerMtok: 9 })));
  });

  it('preserves the field being edited while refreshing untouched quote fields', async () => {
    getModelPriceOverride.mockResolvedValueOnce(priceView('model-a')).mockResolvedValue(refreshedPrice());
    const ui = render(inline());
    const input = ui.getByLabelText('settings.providers.models.priceOverride.input') as HTMLInputElement;
    const output = ui.getByLabelText('settings.providers.models.priceOverride.output') as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('1'));
    fireEvent.change(input, { target: { value: '7' } });
    broadcastPricing();
    await waitFor(() => expect(output.value).toBe('9'));
    expect(input.value).toBe('7');
    expect(input.disabled).toBe(false);
    expect(setModelPriceOverride).not.toHaveBeenCalled();
  });

  it.each(['success', 'failure'] as const)('drains a queued pricing refresh after save %s without dropping drafts or guards', async (outcome) => {
    const pending = vi.fn();
    getModelPriceOverride.mockResolvedValueOnce(priceView('model-a'))
      .mockResolvedValue(refreshedPrice(outcome === 'success' ? 7 : 1));
    let resolve!: (view: ModelPriceOverrideView) => void;
    let reject!: (error: Error) => void;
    setModelPriceOverride.mockReturnValue(new Promise((ok, fail) => { resolve = ok; reject = fail; }));
    const ui = render(<ModelPriceOverrideDialog provider={provider} row={row('model-a')} open
      onOpenChange={vi.fn()} presentation="inline" onPendingChange={pending} />);
    const input = ui.getByLabelText('settings.providers.models.priceOverride.input') as HTMLInputElement;
    const output = ui.getByLabelText('settings.providers.models.priceOverride.output') as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('1'));
    fireEvent.change(input, { target: { value: '7' } });
    fireEvent.blur(input);
    broadcastPricing();
    expect(pending).toHaveBeenLastCalledWith(true);
    expect(getModelPriceOverride).toHaveBeenCalledOnce();
    expect(input.value).toBe('7');
    await act(async () => {
      if (outcome === 'success') resolve(refreshedPrice(7, 4));
      else reject(new Error('save failed'));
    });
    await waitFor(() => expect(output.value).toBe('9'));
    expect(input.value).toBe('7');
    expect(pending).toHaveBeenLastCalledWith(false);
    expect(input.readOnly).toBe(false);
    expect(setModelPriceOverride).toHaveBeenCalledOnce();
    if (outcome === 'failure') expect(toast.error).toHaveBeenCalledWith('settings.providers.models.priceOverride.saveFailed');
  });

  it('rebases a blur save onto the latest quote when the broadcast reload is still in flight', async () => {
    let server = refreshedPrice();
    let finishReload!: (view: ModelPriceOverrideView) => void;
    getModelPriceOverride.mockResolvedValueOnce(priceView('model-a'))
      .mockImplementationOnce(() => new Promise(resolve => { finishReload = resolve; }))
      .mockImplementation(async () => server);
    setModelPriceOverride.mockImplementation(async (_target, desired) => {
      server = refreshedPrice(desired.inputPerMtok, desired.outputPerMtok);
      return server;
    });
    const ui = render(inline());
    const input = ui.getByLabelText('settings.providers.models.priceOverride.input') as HTMLInputElement;
    const output = ui.getByLabelText('settings.providers.models.priceOverride.output') as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('1'));
    fireEvent.change(input, { target: { value: '7' } });
    broadcastPricing();
    expect(input.disabled).toBe(false);
    fireEvent.blur(input);
    await waitFor(() => expect(setModelPriceOverride).toHaveBeenCalledWith(
      priceView('model-a').target, expect.objectContaining({ inputPerMtok: 7, outputPerMtok: 9 })));
    await waitFor(() => expect(output.value).toBe('9'));
    await act(async () => { finishReload(refreshedPrice()); });
    expect(input.value).toBe('7');
    expect(output.value).toBe('9');
    expect(setModelPriceOverride).toHaveBeenCalledOnce();
  });

  it('queues external quote updates until an in-flight reset settles', async () => {
    getModelPriceOverride.mockResolvedValueOnce(priceView('model-a', 'codex', true)).mockResolvedValue(refreshedPrice());
    let finishReset!: (view: ModelPriceOverrideView) => void;
    resetModelPriceOverride.mockReturnValue(new Promise(resolve => { finishReset = resolve; }));
    const ui = render(inline());
    const output = ui.getByLabelText('settings.providers.models.priceOverride.output') as HTMLInputElement;
    await waitFor(() => expect(output.value).toBe('4'));
    fireEvent.click(ui.getByRole('button', { name: 'settings.providers.models.priceOverride.resetShort' }));
    broadcastPricing();
    expect(getModelPriceOverride).toHaveBeenCalledOnce();
    await act(async () => { finishReset(priceView('model-a')); });
    await waitFor(() => expect(output.value).toBe('9'));
    expect(setModelPriceOverride).not.toHaveBeenCalled();
  });

  it('keeps a dirty draft after reload failure and reads fresh untouched fields before retrying its save', async () => {
    getModelPriceOverride.mockResolvedValueOnce(priceView('model-a')).mockRejectedValueOnce(new Error('read failed'))
      .mockResolvedValue(refreshedPrice());
    setModelPriceOverride.mockResolvedValue(refreshedPrice(7));
    const ui = render(inline());
    const input = ui.getByLabelText('settings.providers.models.priceOverride.input') as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('1'));
    fireEvent.change(input, { target: { value: '7' } });
    broadcastPricing();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('settings.providers.models.priceOverride.loadFailed'));
    expect(input.value).toBe('7');
    fireEvent.blur(input);
    await waitFor(() => expect(setModelPriceOverride).toHaveBeenCalledWith(
      priceView('model-a').target, expect.objectContaining({ inputPerMtok: 7, outputPerMtok: 9 })));
  });

  it('does not reinterpret an unsaved amount when another window changes currency', async () => {
    const latest = refreshedPrice();
    latest.effective!.currency = 'CNY';
    latest.allowedCurrencies = ['USD', 'CNY'];
    getModelPriceOverride.mockResolvedValueOnce(priceView('model-a')).mockResolvedValue(latest);
    const ui = render(inline());
    const input = ui.getByLabelText('settings.providers.models.priceOverride.input') as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('1'));
    fireEvent.change(input, { target: { value: '7' } });
    broadcastPricing();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('settings.providers.models.priceOverride.loadFailed'));
    fireEvent.blur(input);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('settings.providers.models.priceOverride.saveFailed'));
    expect(input.value).toBe('7');
    expect(setModelPriceOverride).not.toHaveBeenCalled();
  });

  it('does not write an obsolete merged quote if another broadcast arrives during its pre-save read', async () => {
    let finishReload!: (view: ModelPriceOverrideView) => void;
    let finishRead!: (view: ModelPriceOverrideView) => void;
    getModelPriceOverride.mockResolvedValueOnce(priceView('model-a'))
      .mockImplementationOnce(() => new Promise(resolve => { finishReload = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve; }))
      .mockResolvedValue(refreshedPrice(1, 12));
    const ui = render(inline());
    const input = ui.getByLabelText('settings.providers.models.priceOverride.input') as HTMLInputElement;
    const output = ui.getByLabelText('settings.providers.models.priceOverride.output') as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('1'));
    fireEvent.change(input, { target: { value: '7' } });
    broadcastPricing();
    fireEvent.blur(input);
    await waitFor(() => expect(getModelPriceOverride).toHaveBeenCalledTimes(3));
    broadcastPricing();
    await act(async () => { finishRead(refreshedPrice()); finishReload(refreshedPrice()); });
    await waitFor(() => expect(output.value).toBe('12'));
    expect(input.value).toBe('7');
    expect(toast.error).toHaveBeenCalledWith('settings.providers.models.priceOverride.saveFailed');
    expect(setModelPriceOverride).not.toHaveBeenCalled();
  });

  it('does not treat an already-blurred equivalent decimal as a draft over a later remote quote', async () => {
    getModelPriceOverride.mockResolvedValueOnce(priceView('model-a')).mockResolvedValue(refreshedPrice(3, 4));
    setModelPriceOverride.mockResolvedValue(refreshedPrice(3, 9));
    const ui = render(inline());
    const input = ui.getByLabelText('settings.providers.models.priceOverride.input') as HTMLInputElement;
    const output = ui.getByLabelText('settings.providers.models.priceOverride.output') as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('1'));
    fireEvent.change(input, { target: { value: '1.00' } });
    fireEvent.blur(input);
    expect(setModelPriceOverride).not.toHaveBeenCalled();
    broadcastPricing();
    await waitFor(() => expect(input.value).toBe('3'));
    fireEvent.change(output, { target: { value: '9' } });
    fireEvent.blur(output);
    await waitFor(() => expect(setModelPriceOverride).toHaveBeenCalledWith(
      priceView('model-a').target, expect.objectContaining({ inputPerMtok: 3, outputPerMtok: 9 })));
  });

  it('saves the refreshed untouched fields even before React commits the reload render', async () => {
    let finishReload!: (view: ModelPriceOverrideView) => void;
    getModelPriceOverride.mockResolvedValueOnce(priceView('model-a'))
      .mockImplementationOnce(() => new Promise(resolve => { finishReload = resolve; }))
      .mockResolvedValue(refreshedPrice());
    setModelPriceOverride.mockImplementation(async (_target, quote) => refreshedPrice(quote.inputPerMtok, quote.outputPerMtok));
    const ui = render(inline());
    const input = ui.getByLabelText('settings.providers.models.priceOverride.input') as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('1'));
    fireEvent.change(input, { target: { value: '7' } });
    broadcastPricing();
    await act(async () => {
      finishReload(refreshedPrice());
      await Promise.resolve();
      fireEvent.blur(input);
    });
    expect(setModelPriceOverride).toHaveBeenCalledWith(priceView('model-a').target,
      expect.objectContaining({ inputPerMtok: 7, outputPerMtok: 9 }));
  });

  it.each([
    ['input', '1.00', '3'], ['input', '1e0', '3'], ['output', '4.00', '9'],
    ['cacheRead', '0.10', '0.3'], ['cacheCreate', '2.50', '5'], ['cacheRead', '  ', '0.3'],
  ])('lets a formatting-only focused %s draft %s yield to a newer quote', async (field, draft, expected) => {
    const before = priceView('model-a');
    before.effective = { ...before.effective!, cacheReadPerMtok: draft.trim() ? 0.1 : undefined, cacheCreatePerMtok: 2.5 };
    const after = refreshedPrice(3, 9);
    after.effective = { ...after.effective!, cacheReadPerMtok: 0.3, cacheCreatePerMtok: 5 };
    getModelPriceOverride.mockResolvedValueOnce(before).mockResolvedValue(after);
    const ui = render(inline());
    const input = ui.getByLabelText(`settings.providers.models.priceOverride.${field === "cacheCreate" ? "cacheWrite" : field}`) as HTMLInputElement;
    await waitFor(() => expect(getModelPriceOverride).toHaveBeenCalledOnce());
    await waitFor(() => expect(input.disabled).toBe(false));
    input.focus();
    fireEvent.change(input, { target: { value: draft } });
    broadcastPricing();
    await waitFor(() => expect(input.value).toBe(expected));
    expect(document.activeElement).toBe(input);
    fireEvent.blur(input);
    expect(setModelPriceOverride).not.toHaveBeenCalled();
  });

  it('rebases a pending refresh by numeric semantics while preserving an actual edit', async () => {
    let finishReload!: (value: ModelPriceOverrideView) => void;
    getModelPriceOverride.mockResolvedValueOnce(priceView('model-a'))
      .mockImplementationOnce(() => new Promise(resolve => { finishReload = resolve; }))
      .mockResolvedValue(refreshedPrice(3));
    setModelPriceOverride.mockResolvedValue(refreshedPrice(3, 7));
    const ui = render(inline());
    const input = ui.getByLabelText('settings.providers.models.priceOverride.input') as HTMLInputElement;
    const output = ui.getByLabelText('settings.providers.models.priceOverride.output') as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('1'));
    fireEvent.change(input, { target: { value: '1.00' } });
    fireEvent.change(output, { target: { value: '7' } });
    broadcastPricing();
    fireEvent.blur(output);
    await waitFor(() => expect(setModelPriceOverride).toHaveBeenCalledWith(
      priceView('model-a').target, expect.objectContaining({ inputPerMtok: 3, outputPerMtok: 7 })));
    await act(async () => { finishReload(refreshedPrice(3)); });
  });

  it.each(['repeat', 'ctrlKey', 'shiftKey', 'altKey', 'metaKey', 'isComposing'])(
    'ignores %s Escape in a focused price field without blur or save', async (flag) => {
      getModelPriceOverride.mockResolvedValue(priceView('model-a'));
      const ui = render(inline());
      const input = ui.getByLabelText('settings.providers.models.priceOverride.input') as HTMLInputElement;
      await waitFor(() => expect(input.value).toBe('1'));
      input.focus();
      fireEvent.change(input, { target: { value: '7' } });
      fireEvent.keyDown(input, { key: 'Escape', [flag]: true });
      expect(document.activeElement).toBe(input);
      expect(input.value).toBe('7');
      expect(setModelPriceOverride).not.toHaveBeenCalled();
    });

  it('refreshes changed fallback values without treating callback identity changes as new edits', async () => {
    const empty = { ...priceView('model-a'), effective: null, reference: null };
    getModelPriceOverride.mockResolvedValue(empty);
    const show = (amount: number) => <ModelPriceOverrideDialog provider={provider} row={row('model-a')} open
      onOpenChange={vi.fn()} presentation="inline" fallbackQuoteOf={() => ({ ...priceView('model-a').reference!, outputPerMtok: amount })} />;
    const ui = render(show(4));
    const input = ui.getByLabelText('settings.providers.models.priceOverride.input') as HTMLInputElement;
    const output = ui.getByLabelText('settings.providers.models.priceOverride.output') as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('1'));
    fireEvent.change(input, { target: { value: '7' } });
    ui.rerender(show(9));
    await waitFor(() => expect(output.value).toBe('9'));
    expect(input.value).toBe('7');
    const reads = getModelPriceOverride.mock.calls.length;
    ui.rerender(show(9));
    await act(async () => {});
    expect(getModelPriceOverride).toHaveBeenCalledTimes(reads);
  });

  it('reads fresh connection-local pricing on provider-only notifications before parent snapshots arrive', async () => {
    const empty = { ...priceView('model-a'), effective: null, reference: null };
    let quote = priceView('model-a').reference!;
    const currentPricing = vi.fn(async () => ({ openrouter: { ['model-a\u0000codex']: quote } }));
    Object.assign(window.electronAPI.maker.usage, { getReferenceModelPricing: currentPricing });
    getModelPriceOverride.mockResolvedValue(empty);
    setModelPriceOverride.mockResolvedValue(refreshedPrice(7));
    const ui = render(<ModelPriceOverrideDialog provider={provider} row={row('model-a')} open
      onOpenChange={vi.fn()} presentation="inline" fallbackQuoteOf={() => priceView('model-a').reference!} />);
    const input = ui.getByLabelText('settings.providers.models.priceOverride.input') as HTMLInputElement;
    const output = ui.getByLabelText('settings.providers.models.priceOverride.output') as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('1'));
    input.focus();
    fireEvent.change(input, { target: { value: '7' } });
    quote = { ...quote, outputPerMtok: 9 };
    broadcastProvider();
    await waitFor(() => expect(output.value).toBe('9'));
    expect(input.value).toBe('7');
    fireEvent.blur(input);
    await waitFor(() => expect(setModelPriceOverride).toHaveBeenCalledWith(empty.target,
      expect.objectContaining({ inputPerMtok: 7, outputPerMtok: 9 })));
  });

  it.each(['save success', 'save failure', 'reset'] as const)('queues provider-only refresh during %s', async (kind) => {
    let finish!: (view: ModelPriceOverrideView) => void;
    let fail!: (error: Error) => void;
    getModelPriceOverride.mockResolvedValueOnce(priceView('model-a', 'codex', true)).mockResolvedValue(refreshedPrice());
    const operation = new Promise<ModelPriceOverrideView>((resolve, reject) => { finish = resolve; fail = reject; });
    if (kind === 'reset') resetModelPriceOverride.mockReturnValue(operation);
    else setModelPriceOverride.mockReturnValue(operation);
    const pending = vi.fn();
    const ui = render(<ModelPriceOverrideDialog provider={provider} row={row('model-a')} open
      onOpenChange={vi.fn()} onPendingChange={pending} presentation="inline" />);
    const input = ui.getByLabelText('settings.providers.models.priceOverride.input') as HTMLInputElement;
    const output = ui.getByLabelText('settings.providers.models.priceOverride.output') as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('1'));
    if (kind === 'reset') fireEvent.click(ui.getByRole('button', { name: 'settings.providers.models.priceOverride.resetShort' }));
    else { fireEvent.change(input, { target: { value: '7' } }); fireEvent.blur(input); }
    broadcastProvider();
    expect(pending).toHaveBeenLastCalledWith(true);
    await act(async () => { if (kind === 'save failure') fail(new Error('offline')); else finish(priceView('model-a')); });
    await waitFor(() => expect(output.value).toBe('9'));
    expect(input.value).toBe(kind === 'save failure' ? '7' : '1');
    expect(pending).toHaveBeenLastCalledWith(false);
    ui.unmount();
    expect(providerListeners.size).toBe(0);
  });

  it.each(['success', 'failure'] as const)('keeps currency focus and rejects repeated changes during save %s', async (kind) => {
    const initial = priceView('model-a'); initial.allowedCurrencies = ['USD', 'CNY'];
    getModelPriceOverride.mockResolvedValue(initial);
    let finish!: (view: ModelPriceOverrideView) => void;
    let fail!: (error: Error) => void;
    setModelPriceOverride.mockReturnValue(new Promise((resolve, reject) => { finish = resolve; fail = reject; }));
    const user = userEvent.setup();
    const ui = render(inline());
    const currency = await ui.findByLabelText('settings.providers.models.priceOverride.currency') as HTMLSelectElement;
    currency.focus();
    fireEvent.change(currency, { target: { value: 'CNY' } });
    expect(currency.disabled).toBe(false);
    expect(document.activeElement).toBe(currency);
    fireEvent.change(currency, { target: { value: 'USD' } });
    expect(currency.value).toBe('CNY');
    expect(setModelPriceOverride).toHaveBeenCalledOnce();
    await user.tab();
    const input = ui.getByLabelText('settings.providers.models.priceOverride.input');
    expect(document.activeElement).toBe(input);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(currency);
    await act(async () => {
      if (kind === 'failure') fail(new Error('offline'));
      else finish({ ...initial, effective: { ...initial.effective!, currency: 'CNY' } });
    });
    expect(document.activeElement).toBe(currency);
  });

  it.each(['success', 'failure', 'left'] as const)('keeps reset focus during pending work and settles it safely: %s', async (kind) => {
    getModelPriceOverride.mockResolvedValue(priceView('model-a', 'codex', true));
    let finish!: (view: ModelPriceOverrideView) => void;
    let fail!: (error: Error) => void;
    resetModelPriceOverride.mockReturnValue(new Promise((resolve, reject) => { finish = resolve; fail = reject; }));
    const ui = render(inline());
    const input = ui.getByLabelText('settings.providers.models.priceOverride.input') as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('1'));
    const button = ui.getByRole('button', { name: 'settings.providers.models.priceOverride.resetShort' }) as HTMLButtonElement;
    button.focus(); fireEvent.click(button);
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(resetModelPriceOverride).toHaveBeenCalledOnce();
    const other = ui.getByLabelText('settings.providers.models.priceOverride.output');
    if (kind === 'left') other.focus();
    await act(async () => { if (kind === 'failure') fail(new Error('offline')); else finish(priceView('model-a')); });
    expect(document.activeElement).toBe(kind === 'left' ? other : kind === 'failure' ? button : input);
  });

  it('retains drafts and refuses stale writes when the fresh connection quote cannot be read', async () => {
    const empty = { ...priceView('model-a'), effective: null, reference: null };
    const pricing = vi.fn().mockResolvedValueOnce({ openrouter: { ['model-a\u0000codex']: priceView('model-a').reference! } })
      .mockRejectedValue(new Error('quote unavailable'));
    Object.assign(window.electronAPI.maker.usage, { getReferenceModelPricing: pricing });
    getModelPriceOverride.mockResolvedValue(empty);
    const ui = render(inline());
    const input = ui.getByLabelText('settings.providers.models.priceOverride.input') as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('1'));
    fireEvent.change(input, { target: { value: '7' } });
    broadcastProvider();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('settings.providers.models.priceOverride.loadFailed'));
    fireEvent.blur(input);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('settings.providers.models.priceOverride.saveFailed'));
    expect(input.value).toBe('7');
    expect(setModelPriceOverride).not.toHaveBeenCalled();
  });

  it('ignores a late connection quote after switching the real target', async () => {
    let finish!: (value: unknown) => void;
    const pricing = vi.fn().mockReturnValueOnce(new Promise(resolve => { finish = resolve; }))
      .mockResolvedValue({ openrouter: { ['model-b\u0000codex']: { ...priceView('model-b').reference!, inputPerMtok: 5 } } });
    Object.assign(window.electronAPI.maker.usage, { getReferenceModelPricing: pricing });
    getModelPriceOverride.mockImplementation(async target => ({ ...priceView(target.modelId), effective: null, reference: null }));
    const ui = render(inline());
    await waitFor(() => expect(pricing).toHaveBeenCalledOnce());
    ui.rerender(inline('model-b'));
    const input = ui.getByLabelText('settings.providers.models.priceOverride.input') as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('5'));
    await act(async () => { finish({ openrouter: { ['model-a\u0000codex']: priceView('model-a').reference! } }); });
    expect(input.value).toBe('5');
    expect(setModelPriceOverride).not.toHaveBeenCalled();
  });

  it.each(['outside', 'engine'] as const)('validates and restores an incomplete new quote when leaving for %s', async (destination) => {
    getModelPriceOverride.mockImplementation(async target => ({ ...priceView(target.modelId, target.agent), effective: null, reference: null }));
    const two = row('model-a'); two.avail = ['codex', 'claude-code']; two.byAgent['claude-code'] = two.byAgent.codex;
    const user = userEvent.setup();
    const leave = vi.fn();
    const ui = render(<><ModelPriceOverrideDialog provider={provider} row={two} open
      onOpenChange={vi.fn()} presentation="inline" /><button onClick={leave}>Leave editor</button></>);
    const input = ui.getByLabelText('settings.providers.models.priceOverride.input') as HTMLInputElement;
    await waitFor(() => expect(input.disabled).toBe(false));
    input.focus(); fireEvent.change(input, { target: { value: '7' } });
    await user.tab();
    expect(input.value).toBe('7');
    expect(toast.error).not.toHaveBeenCalled();
    if (destination === 'outside') await user.click(ui.getByRole('button', { name: 'Leave editor' }));
    else await user.click(ui.getByRole('radio', { name: 'Claude Code' }));
    expect(toast.error).toHaveBeenCalledWith('settings.providers.models.priceOverride.invalid');
    expect((ui.getByLabelText('settings.providers.models.priceOverride.input') as HTMLInputElement).value).toBe('');
    expect(setModelPriceOverride).not.toHaveBeenCalled();
    if (destination === 'outside') expect(leave).toHaveBeenCalledOnce();
  });

  it('does not treat an untouched empty new quote as an invalid edit on blur', async () => {
    getModelPriceOverride.mockResolvedValue({ ...priceView('model-a'), effective: null, reference: null });
    const ui = render(inline());
    const input = ui.getByLabelText('settings.providers.models.priceOverride.input') as HTMLInputElement;
    await waitFor(() => expect(input.disabled).toBe(false));
    fireEvent.blur(input);
    expect(toast.error).not.toHaveBeenCalled();
    expect(setModelPriceOverride).not.toHaveBeenCalled();
  });

  it.each(['7', '-1', ''])('locally resets a %s draft with no persisted override and no save toast', async (draft) => {
    getModelPriceOverride.mockResolvedValue(priceView('model-a'));
    const user = userEvent.setup();
    const ui = render(inline());
    const input = ui.getByLabelText('settings.providers.models.priceOverride.input') as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('1'));
    input.focus(); fireEvent.change(input, { target: { value: draft } });
    const button = ui.getByRole('button', { name: 'settings.providers.models.priceOverride.resetShort' }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    await user.click(button);
    expect(input.value).toBe('1');
    expect(document.activeElement).toBe(input);
    expect(setModelPriceOverride).not.toHaveBeenCalled();
    expect(resetModelPriceOverride).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('lets Reset discard a valid failed-save draft without another write', async () => {
    getModelPriceOverride.mockResolvedValue(priceView('model-a'));
    setModelPriceOverride.mockRejectedValue(new Error('offline'));
    const user = userEvent.setup();
    const ui = render(inline());
    const input = ui.getByLabelText('settings.providers.models.priceOverride.input') as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('1'));
    fireEvent.change(input, { target: { value: '7' } }); fireEvent.blur(input);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('settings.providers.models.priceOverride.saveFailed'));
    await user.click(ui.getByRole('button', { name: 'settings.providers.models.priceOverride.resetShort' }));
    expect(input.value).toBe('1');
    expect(setModelPriceOverride).toHaveBeenCalledOnce();
    expect(resetModelPriceOverride).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('can discard an incomplete unknown-price draft with local Reset', async () => {
    getModelPriceOverride.mockResolvedValue({ ...priceView('model-a'), effective: null, reference: null });
    const user = userEvent.setup();
    const ui = render(inline());
    const input = ui.getByLabelText('settings.providers.models.priceOverride.input') as HTMLInputElement;
    await waitFor(() => expect(input.disabled).toBe(false));
    input.focus(); fireEvent.change(input, { target: { value: '7' } });
    await user.click(ui.getByRole('button', { name: 'settings.providers.models.priceOverride.resetShort' }));
    expect(input.value).toBe('');
    expect(setModelPriceOverride).not.toHaveBeenCalled();
    expect(resetModelPriceOverride).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('keeps a committed reset cleared when only the auxiliary quote read fails', async () => {
    getModelPriceOverride.mockResolvedValue(priceView('model-a', 'codex', true));
    resetModelPriceOverride.mockResolvedValue({ ...priceView('model-a'), effective: null, reference: null });
    Object.assign(window.electronAPI.maker.usage, { getReferenceModelPricing: vi.fn().mockRejectedValue(new Error('pricing unavailable')) });
    const ui = render(inline());
    const input = ui.getByLabelText('settings.providers.models.priceOverride.input') as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('1'));
    const reset = ui.getByRole('button', { name: 'settings.providers.models.priceOverride.resetShort' }) as HTMLButtonElement;
    fireEvent.click(reset);
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('settings.providers.models.priceOverride.resetDone'));
    expect(toast.error).toHaveBeenCalledWith('settings.providers.models.priceOverride.loadFailed');
    expect(toast.error).not.toHaveBeenCalledWith('settings.providers.models.priceOverride.saveFailed');
    await waitFor(() => expect(input.readOnly).toBe(false));
    expect(input.value).toBe('');
    expect(reset.disabled).toBe(true);
  });

  it('ignores auxiliary reset-read failure after switching to a new target', async () => {
    let fail!: (error: Error) => void;
    Object.assign(window.electronAPI.maker.usage, { getReferenceModelPricing: vi.fn(() => new Promise((_resolve, reject) => { fail = reject; })) });
    getModelPriceOverride.mockImplementation(async target => priceView(target.modelId, target.agent, true));
    resetModelPriceOverride.mockResolvedValue({ ...priceView('model-a'), effective: null, reference: null });
    const ui = render(inline());
    await waitFor(() => expect((ui.getByLabelText('settings.providers.models.priceOverride.input') as HTMLInputElement).value).toBe('1'));
    fireEvent.click(ui.getByRole('button', { name: 'settings.providers.models.priceOverride.resetShort' }));
    await waitFor(() => expect(fail).toBeDefined());
    ui.rerender(inline('model-b'));
    await waitFor(() => expect(ui.getByLabelText('settings.providers.models.priceOverride.input').hasAttribute('readonly')).toBe(false));
    await act(async () => { fail(new Error('old quote unavailable')); });
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('keeps an incomplete quote while tabbing through Reset without activating it', async () => {
    getModelPriceOverride.mockResolvedValue({ ...priceView('model-a'), effective: null, reference: null });
    const user = userEvent.setup();
    const ui = render(inline());
    const input = ui.getByLabelText('settings.providers.models.priceOverride.input') as HTMLInputElement;
    await waitFor(() => expect(input.disabled).toBe(false));
    input.focus(); fireEvent.change(input, { target: { value: '7' } });
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(ui.getByRole('button', { name: 'settings.providers.models.priceOverride.resetShort' }));
    await user.tab();
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe('7');
    expect(toast.error).not.toHaveBeenCalled();
    expect(setModelPriceOverride).not.toHaveBeenCalled();
  });

});
