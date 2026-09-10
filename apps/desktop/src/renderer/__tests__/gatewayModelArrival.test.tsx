// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { BUNDLED_CATALOG, unifiedModelEntries, modelProtocolComparison, pickRecommendedAgent, type ProviderView } from '@cindy/model-providers';
import { parseModelsSyncPayload } from '../../main/model-access/modelsSyncRefresh';
import {
  getActiveCatalog,
  setActiveCatalog,
  setActiveCatalogChangedListener,
  setXdGatewayModels,
} from '../../main/maker-host/active-catalog';
import { UnifiedModelList } from '../components/settings/UnifiedModelList';
import { __resetForTest, isModelEnabled, migrateModelVisibilityDefaults, setModelVisibilityOwner } from '../state/modelVisibilityPrefs';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn() }),
}));
vi.mock('../hooks/useModelPricing', () => ({
  useGatewayModelPricing: () => null,
  useReferenceModelPricing: () => null,
}));
vi.mock('../components/settings/ModelAdvancedDrawer', () => ({ ModelAdvancedDrawer: () => null }));

afterEach(() => {
  setActiveCatalogChangedListener(null);
  cleanup();
  setXdGatewayModels([]);
  setActiveCatalog(BUNDLED_CATALOG);
  __resetForTest();
});

it.each(['google/gemini-3.8-flash', 'google/gemini-99-pro-preview'])(
  'projects the actual Responses-hinted Gateway payload for %s as Google on Pi',
  (id) => {
    setActiveCatalog(BUNDLED_CATALOG);
    const parsed = parseModelsSyncPayload({ schemaVersion: 5, accountTier: 'paid', models: [{
      id, name: id, currency: 'USD', availability: 'available', mode: 'chat',
      agents: ['claude-code', 'codex', 'pi'], contextWindow: 1_048_576,
      perAgent: {
        'claude-code': { wireProtocol: 'anthropic-messages' },
        codex: { wireProtocol: 'openai-responses' },
        pi: { wireProtocol: 'openai-responses' },
      },
    }] });
    if (!parsed.ok) throw new Error(parsed.error);
    setXdGatewayModels(parsed.models, { authoritative: true });
    const provider = getActiveCatalog().providers.find((p) => p.id === 'xd')!;
    const models = Object.fromEntries(provider.agents.map((agent) => [agent, provider.models[agent]?.find((m) => m.id === id)]));
    const comparison = modelProtocolComparison(provider, models);
    expect(models.pi).toMatchObject({ id, piApi: 'google-generative-ai', contextWindow: 1_048_576 });
    expect(comparison.reference).toBe('google-generative-ai');
    expect(comparison.forAgent('pi')).toMatchObject({ outbound: 'google-generative-ai', mode: 'matching' });
    expect(comparison.forAgent('codex')?.mode).toBe('compatibility');
    expect(comparison.forAgent('claude-code')?.mode).toBe('compatibility');
    expect(pickRecommendedAgent(provider, id, provider.agents)).toBe('pi');
  },
);

it('lists downloaded Gateway models in settings without enabling them until the user chooses them', async () => {
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { maker: {
    claimLegacyModelVisibilityOwner: () => ({ dataOwnerId: 'arrival-test', ownerGeneration: 1,
      canWriteOwnerScoped: true, claimed: true, canInitialize: true, profileOrigin: 'new' }),
    syncModelVisibility: vi.fn(async () => undefined),
  } } });
  __resetForTest();
  await setModelVisibilityOwner('arrival-test', 1, 'cloud');
  setActiveCatalog(BUNDLED_CATALOG);
  const raw = (id: string, name: string) => ({
    id,
    name,
    currency: 'USD',
    availability: 'available',
    mode: 'chat',
    agents: ['claude-code', 'codex', 'pi'],
    contextWindow: 500_000,
    modalities: { input: ['text', 'image'], output: ['text'] },
    efforts: ['low', 'high'],
    defaultEffort: 'high',
    perAgent: {
      'claude-code': { wireProtocol: 'anthropic-messages' },
      codex: { wireProtocol: 'openai-responses' },
      pi: { wireProtocol: 'openai-responses' },
    },
  });
  const download = (models: ReturnType<typeof raw>[]) => {
    const result = parseModelsSyncPayload({ schemaVersion: 5, accountTier: 'paid', models });
    if (!result.ok) throw new Error(result.error);
    setXdGatewayModels(result.models, { authoritative: true });
  };
  const snapshot = () =>
    ({
      ...getActiveCatalog().providers.find((p) => p.id === 'xd')!,
      connected: true,
      source: 'builtin',
    }) as ProviderView;
  const existing = raw('deepseek/deepseek-current', 'Existing Model');
  download([existing]);
  await migrateModelVisibilityDefaults('arrival-test', 1, [snapshot()]);
  // A known native family uses Pi by default while compatibility stays opt-in.
  expect(snapshot().models.pi?.find((m) => m.id === existing.id)).toMatchObject({
    nativeApi: 'openai-completions', piApi: 'openai-completions',
  });
  expect(snapshot().models['claude-code']?.find((m) => m.id === existing.id)?.defaultEnabled).toBe(false);
  const view = render(<UnifiedModelList provider={snapshot()} />);
  expect(screen.getByText('Existing Model')).toBeTruthy();
  expect(screen.queryByText('Future Model 9')).toBeNull();
  const changed = vi.fn(async () => {
    await migrateModelVisibilityDefaults('arrival-test', 1, [snapshot()]);
    view.rerender(<UnifiedModelList provider={snapshot()} />);
  });
  setActiveCatalogChangedListener(changed);
  await act(async () => download([existing, raw('new-labs/future-9', 'Future Model 9')]));
  expect(changed).toHaveBeenCalledTimes(1);
  // Settings now keeps disabled visibility rows expanded, while picker filtering stays off.
  expect(screen.getByText('Future Model 9')).toBeTruthy();
  expect(screen.getByRole('switch', { name: /Future Model 9/ }).getAttribute('aria-checked')).toBe(
    'false',
  );
  const pickerEntries = () => unifiedModelEntries({ providers: [snapshot()],
    isVisible: (providerId, model, agent) => isModelEnabled(agent, providerId, model) });
  expect(pickerEntries().some((entry) => entry.modelId === 'new-labs/future-9')).toBe(false);
  await act(async () => fireEvent.click(screen.getByRole('switch', { name: /Future Model 9/ })));
  expect(screen.getByRole('switch', { name: /Future Model 9/ }).getAttribute('aria-checked')).toBe('true');
  expect(pickerEntries().some((entry) => entry.modelId === 'new-labs/future-9')).toBe(true);
  expect(screen.getByText('new-labs')).toBeTruthy();
  expect(snapshot().models['claude-code']?.find((m) => m.id === 'new-labs/future-9')).toMatchObject(
    {
      contextWindow: 500_000,
      modalities: { input: ['text', 'image'], output: ['text'] },
    },
  );
});
