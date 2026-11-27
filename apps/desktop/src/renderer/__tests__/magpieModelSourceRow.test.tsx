// @vitest-environment jsdom
import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderView, UnifiedAgentCapability, UnifiedModelEntry } from '@cindy/model-providers';
import { UnifiedModelRow } from '@/components/new-chat/UnifiedModelRow';
import { enginePreferenceModelIds, type UnifiedRowConfig } from '@/components/new-chat/unifiedModelSelection';

vi.mock('react-i18next', async importOriginal => ({ ...await importOriginal<typeof import('react-i18next')>(), useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/new-chat/ModelSelector', () => ({ ModelIconMark: () => <span data-model-icon/> }));
afterEach(cleanup);

function props(modelId = 'gpt-5.5', source = 'Supplier A') {
  const capability: UnifiedAgentCapability = {
    agent: 'pi' as const, wireModelId: modelId, efforts: ['low'], defaultEffort: 'low',
    defaultEffortSource: 'catalog' as const, supportsFastMode: false, contextWindow: 128000, contextWindowVerified: true,
    discoveredSource: { kind: 'magpie' as const, providerId: source },
  };
  const entry: UnifiedModelEntry = { providerId: 'magpie-row', modelId, displayName: 'Model',
    candidates: ['pi'], recommended: 'pi', nativeAgent: null, capabilities: { pi: capability } };
  const config: UnifiedRowConfig = { engine: 'pi', agent: 'pi', efforts: ['low'], effort: 'low',
    fast: false, fastCapable: false, customized: false, capability, wireModelId: modelId };
  return { entry, config,
    providers: [{ id: 'magpie-row', name: 'Magpie', models: {}, subscriptionAccount: { identity: 'account-A' } } as unknown as ProviderView],
    anchor: { kind: 'model' as const, providerId: entry.providerId, modelId }, selected: false,
    active: false, isFavoriteRow: false, justFavorited: false, interactionDisabled: false,
    effortLabelOf: (_agent: string, effort: string) => effort, onSelect: vi.fn(), onStar: vi.fn(),
    onReveal: vi.fn(), onRevealForKeyboard: vi.fn(),
  };
}

describe('supplier text occupies only the existing model second line', () => {
  it.each(['all', 'favorites', 'sizer'])('replaces the connection label in %s without removing account identity', () => {
    const common = props();
    const result = render(<UnifiedModelRow {...common} sourceLabel="Magpie"/>);
    const text = result.container.querySelector('[data-model-source-details]')!.textContent;
    expect(text).toBe('Supplier A · account-A');
    expect(text).not.toContain('Magpie');
  });
  it('keeps the first line byte-identical when only supplier provenance changes', () => {
    const common = props();
    const result = render(<UnifiedModelRow {...common}/>);
    const firstLine = result.container.firstElementChild!.firstElementChild!.outerHTML;
    const changed = props('gpt-5.5', 'Supplier B');
    result.rerender(<UnifiedModelRow {...changed}/>);
    expect(result.container.firstElementChild!.firstElementChild!.outerHTML).toBe(firstLine);
    expect(result.container.textContent).toContain('Supplier B');
    expect(result.container.textContent).not.toContain('modelDescriptions.coding');
  });
  it('retains remote computer, group, unavailability and account information', () => {
    const common = props();
    const result = render(<UnifiedModelRow {...common} sourceLabel="Magpie · 3 computers · Studio Mac · unavailable"/>);
    expect(result.container.querySelector('[data-model-source-details]')!.textContent)
      .toBe('Supplier A · 3 computers · Studio Mac · unavailable · account-A');
  });
  it('keeps an unknown single-line model single-line, but still replaces an existing source row', () => {
    const common = props('previously-unknown-vendor-model');
    const result = render(<UnifiedModelRow {...common}/>);
    expect(result.container.firstElementChild!.children).toHaveLength(1);
    expect(result.container.textContent).not.toContain('Supplier A');
    result.rerender(<UnifiedModelRow {...common} sourceLabel="Magpie"/>);
    expect(result.container.firstElementChild!.children).toHaveLength(2);
    expect(result.container.textContent).toContain('Supplier A');
  });
  it('uses the effective engine source rather than the recommended engine source', () => {
    const common = props();
    common.entry.capabilities.codex = { ...common.entry.capabilities.pi!, agent: 'codex',
      discoveredSource: { kind: 'magpie', providerId: 'Wrong engine supplier' } };
    common.entry.recommended = 'codex';
    const result = render(<UnifiedModelRow {...common} sourceLabel="Magpie"/>);
    expect(result.container.textContent).toContain('Supplier A');
    expect(result.container.textContent).not.toContain('Wrong engine supplier');
  });
  it('distinguishes suppliers with the same display name using their source IDs', () => {
    const common = props();
    common.entry.capabilities.pi!.discoveredSource = {
      kind: 'magpie', providerId: 'a', label: 'Model · Shared name', discoveredName: 'Model',
    };
    common.providers[0].models.pi = ['a', 'b'].map(providerId => ({
      ...common.entry.capabilities.pi!, id: providerId + '/gpt-5.5', name: 'Model',
      efforts: [...common.entry.capabilities.pi!.efforts],
      discoveredSource: { kind: 'magpie' as const, providerId, label: 'Model · Shared name', discoveredName: 'Model' },
    }));
    expect(render(<UnifiedModelRow {...common} sourceLabel="Magpie"/>).container.textContent).toContain('Shared name (a)');
  });
  it('preserves ambiguous legacy preferences without applying them to a gateway route', () => {
    const entry = props().entry;
    entry.enginePreferenceId = '["magpie-route","foo"]';
    expect(enginePreferenceModelIds(entry)).toEqual([entry.enginePreferenceId]);
    entry.legacyEnginePreferenceId = 'foo';
    expect(enginePreferenceModelIds(entry)).toEqual([entry.enginePreferenceId, 'foo']);
  });
});
