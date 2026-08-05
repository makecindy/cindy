// @vitest-environment jsdom

import { fireEvent, render, waitFor } from '@testing-library/react';
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
    expect(getByRole('button', { name: 'Claude Code' }).classList.contains('shadow-sm')).toBe(false);
    expect(getByRole('button', { name: 'Codex' }).classList.contains('shadow-sm')).toBe(false);
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

    const codex = getByRole('button', { name: 'Codex' });
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
    const save = await waitFor(() =>
      first.getByRole('button', { name: 'settings.providers.models.priceOverride.save' }),
    );
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
    const save = await waitFor(() =>
      getByRole('button', { name: 'settings.providers.models.priceOverride.save' }),
    );
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
});
