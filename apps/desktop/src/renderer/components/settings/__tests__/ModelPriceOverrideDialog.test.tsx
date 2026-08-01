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

function priceView(modelId: string): ModelPriceOverrideView {
  return {
    target: { providerId: 'openrouter', agent: 'codex', modelId },
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
    override: null,
    conflict: false,
    registryUpdatedAt: null,
    allowedCurrencies: ['USD'],
  };
}

describe('ModelPriceOverrideDialog', () => {
  const getModelPriceOverride = vi.fn();
  const setModelPriceOverride = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    getModelPriceOverride.mockReset();
    setModelPriceOverride.mockReset();
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      maker: {
        getModelPriceOverride,
        setModelPriceOverride,
        resetModelPriceOverride: vi.fn(),
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
});
