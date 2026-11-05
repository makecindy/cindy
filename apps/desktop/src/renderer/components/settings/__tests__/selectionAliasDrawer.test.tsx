// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelAdvancedDrawer } from '../ModelAdvancedDrawer';
import type { UnionModelRow } from '../UnifiedModelList';
import type { CatalogModel, ProviderView } from '@cindy/model-providers';
const mocks = vi.hoisted(() => ({ target: vi.fn(), batch: vi.fn(() => true), visibility: vi.fn(async () => true) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { resolvedLanguage: 'en' } }) }));
vi.mock('@/hooks/useModelContextLimit', () => ({ useModelContextLimit: (target: unknown) => {
  mocks.target(target);
  return { loading: false, limit: null, isCustomized: false, error: false, setLimit: vi.fn(), reset: vi.fn() };
} }));
vi.mock('@/state/modelVisibilityPrefs', () => ({ useModelVisibilityVersion: () => 0,
  isModelEnabled: () => true, isModelVisibilityCustomized: () => false,
  setModelVisibility: vi.fn(), setModelVisibilities: mocks.visibility, resetModelVisibilities: vi.fn() }));
vi.mock('@/state/providerModelMemory', () => ({ useProviderModelMemoryVersion: () => 0,
  getProviderModelEffort: (_agent: string, _pid: string, id: string) => id === 'old' ? 'low' : undefined,
  setProviderModelEffort: vi.fn(), clearProviderModelEffort: vi.fn(), editProviderModelMemoryBatch: mocks.batch }));
vi.mock('../ModelPriceOverrideDialog', () => ({ ModelPriceOverrideDialog: () => null }));
const model = (id: string): CatalogModel => ({ id, name: id, contextWindow: 200_000, efforts: ['low', 'high'], defaultEffort: 'high' });
const member = (id: string): UnionModelRow => ({ id, name: id, avail: ['codex'], byAgent: { codex: model(id) } });
const group: UnionModelRow = { ...member('new'), aliasRows: [member('new'), member('old')] };
const provider = { id: 'fixture', name: 'Fixture', source: 'user', agents: ['codex'], routing: {}, models: { codex: [model('new'), model('old')] }, connected: true } as ProviderView;
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const draw = (props: Record<string, unknown> = {}) => render(<ModelAdvancedDrawer provider={provider} row={group} open onOpenChange={vi.fn()} onDisable={vi.fn()} disabled={false} paymentRequired={false} pricePresentationOf={() => null} {...props} />);

describe('alias advanced settings use explicit member targets', () => {
  it('pins context edits to the selected original member', () => {
    draw({ selectedMemberId: 'old' });
    expect(mocks.target).toHaveBeenLastCalledWith(expect.objectContaining({ modelId: 'old' }));
  });
  it('uses the whole group for disable and per-engine visibility', async () => {
    const disable = vi.fn();
    draw({ onDisable: disable });
    fireEvent.click(screen.getByRole('switch', { name: 'new · Codex' }));
    expect(mocks.visibility).toHaveBeenCalledWith('fixture', expect.arrayContaining([
      expect.objectContaining({ agent: 'codex', modelId: 'new' }),
      expect.objectContaining({ agent: 'codex', modelId: 'old' }),
    ]), false);
    fireEvent.click(screen.getByRole('button', { name: 'settings.providers.models.disableModel' }));
    expect(disable).toHaveBeenCalledWith(group);
  });
  it('reads the old preference and resets both actual keys', () => {
    draw();
    fireEvent.click(screen.getByRole('button', { name: 'settings.providers.models.advanced.restoreDefault' }));
    expect(mocks.batch).toHaveBeenCalledWith(expect.arrayContaining([
      { kind: 'clear-effort', agent: 'codex', providerId: 'fixture', model: 'new' },
      { kind: 'clear-effort', agent: 'codex', providerId: 'fixture', model: 'old' },
    ]));
  });
});
