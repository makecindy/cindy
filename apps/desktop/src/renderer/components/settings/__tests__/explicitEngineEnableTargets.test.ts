// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildUnionRows,
  explicitEngineEnableTargets,
  modelVisibilityTargets,
} from '@/components/settings/UnifiedModelList';
import {
  __resetForTest,
  isModelEnabled,
  setModelVisibilities,
  setModelVisibility,
  setModelVisibilityOwner,
} from '@/state/modelVisibilityPrefs';

import type { CatalogModel, ProviderView } from '@cindy/model-providers';

function model(id: string, extra: Partial<CatalogModel> = {}): CatalogModel {
  return { id, name: id, contextWindow: 100_000, efforts: [], defaultEffort: null, ...extra } as CatalogModel;
}

const provider = {
  id: 'gateway',
  name: 'Gateway',
  source: 'user',
  connected: true,
  agents: ['claude-code', 'codex', 'pi'],
  auth: { method: 'api-key' },
  routing: {},
  models: {
    'claude-code': [model('already'), model('closed'), model('retired-chat')],
    codex: [model('already'), model('closed'), model('retired-chat', { status: 'retired' })],
    pi: [model('already'), model('closed'), model('pi-only')],
  },
} as ProviderView;

beforeEach(() => {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      maker: {
        claimLegacyModelVisibilityOwner: () => ({
          dataOwnerId: 'test-owner',
          ownerGeneration: 1,
          canWriteOwnerScoped: true,
          claimed: true,
          claimedByOtherOwner: false,
          canInitialize: true,
          profileOrigin: 'new',
        }),
        syncModelVisibility: async () => undefined,
      },
    },
  });
  setModelVisibilityOwner('test-owner', 1, 'cloud');
});

afterEach(() => {
  __resetForTest();
});

describe('explicit engine enable for models that already exist', () => {
  it('fills only the selected engines, including models already enabled on another engine', async () => {
    const rows = buildUnionRows(provider);
    const already = rows.find((row) => row.id === 'already')!;
    expect(await setModelVisibility('claude-code', provider.id, already.byAgent['claude-code']!.id, true)).toBe(true);

    const targets = explicitEngineEnableTargets(provider, rows, ['codex', 'pi']);
    expect(targets).toEqual([
      { agent: 'codex', modelId: 'already' },
      { agent: 'pi', modelId: 'already' },
      { agent: 'codex', modelId: 'closed' },
      { agent: 'pi', modelId: 'closed' },
      { agent: 'pi', modelId: 'pi-only' },
    ]);

    expect(await setModelVisibilities(provider.id, targets, true)).toBe(true);
    expect(await setModelVisibilities(provider.id, targets, true)).toBe(true);
    expect(isModelEnabled('claude-code', provider.id, { id: 'already' })).toBe(true);
    expect(isModelEnabled('codex', provider.id, { id: 'already' })).toBe(true);
    expect(isModelEnabled('pi', provider.id, { id: 'already' })).toBe(true);
    expect(isModelEnabled('codex', provider.id, { id: 'closed' })).toBe(true);
    expect(isModelEnabled('claude-code', provider.id, { id: 'closed', defaultEnabled: false })).toBe(false);
  });

  it('leaves the existing native-only show target unchanged', () => {
    const rows = buildUnionRows(provider);
    const already = rows.find((row) => row.id === 'already')!;
    const enabled = modelVisibilityTargets(provider, already, true).map((target) => target.agent);
    expect(enabled).not.toEqual(['claude-code', 'codex', 'pi']);
  });
});
