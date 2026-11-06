// @vitest-environment jsdom

import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

  beforeEach(() => {
    vi.clearAllMocks();
    getModelPriceOverride.mockReset();
    setModelPriceOverride.mockReset();
    resetModelPriceOverride.mockReset();
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      maker: {
        getModelPriceOverride,
        setModelPriceOverride,
        resetModelPriceOverride,
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
  // Production behavior (unit): inline editing reuses the dialog's original API/payload.
  // Existing coverage exercises only explicit Save; these cases protect the new trigger,
  // reset precedence, invalid-input restoration, and existing late-response isolation.
  const priceInput = (result: ReturnType<typeof render>, label = 'input') =>
    result.getByLabelText('settings.providers.models.priceOverride.' + label) as HTMLInputElement;
  const renderInline = async (view = priceView('model-a'), onPendingChange = vi.fn()) => {
    getModelPriceOverride.mockResolvedValue(view);
    const result = render(<ModelPriceOverrideDialog provider={provider} row={row(view.target.modelId)}
      open onOpenChange={vi.fn()} presentation="inline" onPendingChange={onPendingChange} />);
    await waitFor(() => expect(priceInput(result).disabled).toBe(false));
    return result;
  };

  it.each(['dialog', 'inline'] as const)('uses the same target and payload in %s presentation', async (presentation) => {
    getModelPriceOverride.mockResolvedValue(priceView('model-a'));
    setModelPriceOverride.mockResolvedValue(priceView('model-a'));
    const onOpenChange = vi.fn();
    const result = render(<ModelPriceOverrideDialog provider={provider} row={row('model-a')}
      open onOpenChange={onOpenChange} presentation={presentation} />);
    await waitFor(() => expect(priceInput(result).value).toBe('1'));
    fireEvent.change(priceInput(result), { target: { value: '0' } });
    fireEvent.change(priceInput(result, 'cacheRead'), { target: { value: '0.25' } });
    if (presentation === 'inline') fireEvent.blur(priceInput(result));
    else fireEvent.click(result.getByRole('button', { name: 'settings.providers.models.priceOverride.save' }));
    await waitFor(() => expect(setModelPriceOverride).toHaveBeenCalledExactlyOnceWith(
      { providerId: 'openrouter', agent: 'codex', modelId: 'model-a' },
      { currency: 'USD', inputPerMtok: 0, outputPerMtok: 4, cacheReadPerMtok: 0.25, cacheCreatePerMtok: null },
    ));
    await waitFor(() => expect(onOpenChange.mock.calls.length).toBe(presentation === 'inline' ? 0 : 1));
  });

  it('does not write on load, unchanged blur or equivalent numeric formatting', async () => {
    const result = await renderInline();
    fireEvent.blur(priceInput(result));
    fireEvent.change(priceInput(result), { target: { value: '1.00' } });
    fireEvent.blur(priceInput(result));
    expect(setModelPriceOverride).not.toHaveBeenCalled();
    expect(priceInput(result).value).toBe('1');
  });

  it('reloads a refreshed catalog snapshot with the same IDs before editing its quote', async () => {
    const initialRow = row('model-a');
    const current = priceView('model-a');
    getModelPriceOverride.mockResolvedValueOnce(current);
    const props = { provider, row: initialRow, open: true, onOpenChange: vi.fn(), presentation: 'inline' as const };
    const result = render(<ModelPriceOverrideDialog {...props} />);
    await waitFor(() => expect(priceInput(result).value).toBe('1'));
    fireEvent.change(priceInput(result), { target: { value: '7' } });
    result.rerender(<ModelPriceOverrideDialog {...props} row={{ ...initialRow }} />);
    expect(getModelPriceOverride).toHaveBeenCalledOnce();
    expect(priceInput(result).value).toBe('7');
    const refreshed = { ...current, effective: { ...current.effective!, outputPerMtok: 8 },
      reference: { ...current.reference!, outputPerMtok: 8 } };
    getModelPriceOverride.mockResolvedValueOnce(refreshed);
    result.rerender(<ModelPriceOverrideDialog {...props} row={{ ...initialRow, byAgent: {
      codex: { ...initialRow.byAgent.codex!, name: 'refreshed catalog model' },
    } }} />);
    await waitFor(() => expect(priceInput(result, 'output').value).toBe('8'));
    expect(getModelPriceOverride).toHaveBeenCalledTimes(2);
    expect(setModelPriceOverride).not.toHaveBeenCalled();
    setModelPriceOverride.mockResolvedValue(refreshed);
    fireEvent.change(priceInput(result), { target: { value: '7' } });
    fireEvent.blur(priceInput(result));
    await waitFor(() => expect(setModelPriceOverride).toHaveBeenCalledExactlyOnceWith(current.target, {
      currency: 'USD', inputPerMtok: 7, outputPerMtok: 8, cacheReadPerMtok: null, cacheCreatePerMtok: null,
    }));
  });

  it.each(['', '-1', 'Infinity'])('restores invalid inline input %j without saving', async (value) => {
    const result = await renderInline();
    fireEvent.change(priceInput(result), { target: { value } });
    fireEvent.blur(priceInput(result));
    expect(priceInput(result).value).toBe('1');
    expect(setModelPriceOverride).not.toHaveBeenCalled();
  });

  it('keeps a complete quote draft while moving between fields and saves once on exit', async () => {
    const empty = { ...priceView('model-a'), effective: null, reference: null };
    const result = await renderInline(empty);
    setModelPriceOverride.mockResolvedValue(priceView('model-a'));
    const input = priceInput(result), output = priceInput(result, 'output');
    fireEvent.change(input, { target: { value: '2' } });
    fireEvent.blur(input, { relatedTarget: output });
    expect(input.value).toBe('2');
    expect(setModelPriceOverride).not.toHaveBeenCalled();
    fireEvent.change(output, { target: { value: '5' } });
    fireEvent.blur(output);
    await waitFor(() => expect(setModelPriceOverride).toHaveBeenCalledOnce());
    expect(setModelPriceOverride.mock.calls[0][1]).toMatchObject({ inputPerMtok: 2, outputPerMtok: 5 });
  });

  it.each([false, true])('resets a dirty quote without first saving it; stored override: %s', async (stored) => {
    const result = await renderInline(priceView('model-a', 'codex', stored));
    resetModelPriceOverride.mockResolvedValue(priceView('model-a'));
    const reset = result.getByRole('button', { name: 'settings.providers.models.priceOverride.resetShort' });
    fireEvent.change(priceInput(result), { target: { value: '7' } });
    fireEvent.blur(priceInput(result), { relatedTarget: reset });
    reset.focus();
    fireEvent.click(reset);
    await waitFor(() => expect(priceInput(result).value).toBe('1'));
    expect(setModelPriceOverride).not.toHaveBeenCalled();
    expect(resetModelPriceOverride.mock.calls.length).toBe(stored ? 1 : 0);
    if (stored) expect(resetModelPriceOverride).toHaveBeenCalledWith({ providerId: 'openrouter', agent: 'codex', modelId: 'model-a' });
    expect(document.activeElement).toBe(priceInput(result));
  });

  it('preserves a failed draft for the next ordinary blur retry', async () => {
    const result = await renderInline();
    setModelPriceOverride.mockRejectedValueOnce(new Error('write failed')).mockResolvedValueOnce(priceView('model-a'));
    fireEvent.change(priceInput(result), { target: { value: '7' } });
    fireEvent.blur(priceInput(result));
    await waitFor(() => expect(priceInput(result).readOnly).toBe(false));
    expect(priceInput(result).value).toBe('7');
    fireEvent.blur(priceInput(result));
    await waitFor(() => expect(setModelPriceOverride).toHaveBeenCalledTimes(2));
  });

  it('notifies the owner while saving and ignores duplicate save/reset activation', async () => {
    const pending = vi.fn();
    const result = await renderInline(priceView('model-a'), pending);
    let finish!: (view: ModelPriceOverrideView) => void;
    setModelPriceOverride.mockReturnValue(new Promise<ModelPriceOverrideView>(resolve => { finish = resolve; }));
    fireEvent.change(priceInput(result), { target: { value: '7' } });
    fireEvent.blur(priceInput(result));
    expect(priceInput(result).readOnly).toBe(true);
    expect(pending).toHaveBeenLastCalledWith(true);
    fireEvent.blur(priceInput(result));
    fireEvent.click(result.getByRole('button', { name: 'settings.providers.models.priceOverride.resetShort' }));
    expect(setModelPriceOverride).toHaveBeenCalledOnce();
    expect(resetModelPriceOverride).not.toHaveBeenCalled();
    await act(async () => finish(priceView('model-a')));
    expect(pending).toHaveBeenLastCalledWith(false);
  });

  it('saves the previous engine draft before switching to the next engine', async () => {
    const a = priceView('model-a', 'claude-code');
    getModelPriceOverride.mockResolvedValueOnce(a).mockResolvedValueOnce(priceView('model-a'));
    setModelPriceOverride.mockResolvedValue(a);
    const model = row('model-a').byAgent.codex!;
    const result = render(<ModelPriceOverrideDialog provider={provider}
      row={{ ...row('model-a'), avail: ['claude-code', 'codex'], byAgent: { 'claude-code': model, codex: model } }}
      open onOpenChange={vi.fn()} presentation="inline" />);
    await waitFor(() => expect(priceInput(result).value).toBe('1'));
    fireEvent.change(priceInput(result), { target: { value: '7' } });
    fireEvent.click(result.getByRole('radio', { name: 'Codex' }));
    await waitFor(() => expect(getModelPriceOverride).toHaveBeenLastCalledWith({ providerId: 'openrouter', agent: 'codex', modelId: 'model-a' }));
    expect(setModelPriceOverride.mock.calls[0][0].agent).toBe('claude-code');
  });

});
