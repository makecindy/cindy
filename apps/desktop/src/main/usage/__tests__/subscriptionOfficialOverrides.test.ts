import { afterEach, expect, it, vi } from 'vitest';
import { BUNDLED_CATALOG, type AgentKind } from '@cindy/model-providers';
import { modelPricingKey, providerReferencePriceQuote } from '../../../shared/modelPriceQuote.js';
import {
  __testing,
  type ModelPriceOverridesSnapshot,
} from '../modelPriceOverrideStore.js';
import {
  getClaudeSubscriptionValuePrice,
  getCodexProviderSubscriptionValuePrice,
  getSubscriptionDirectValuePrice,
} from '../referenceModelPricing.js';

const registry = structuredClone(BUNDLED_CATALOG.modelRegistry!);
vi.mock('../../maker-host/active-catalog.js', () => ({
  getActiveCatalog: () => ({ ...BUNDLED_CATALOG, modelRegistry: registry }),
}));
afterEach(() => vi.useRealTimers());

it.each([
  ['codex', 'openai', 'gpt-5.6-luna', 'codex'],
  ['claude', 'anthropic', 'claude-sonnet-4-6', 'claude-code'],
  ['direct', 'openai', 'chatgpt/gpt-5.6-luna', 'pi'],
  ['direct', 'xai', 'xai/grok-4.6', 'pi'],
] as const)('rebases current and historical sparse overrides on official prices: %s %s', (path, providerId, modelId, agent: AgentKind) => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-11T12:00:00Z'));
  const official = providerReferencePriceQuote(providerId, modelId, registry, { agent, officialOnly: true })!;
  expect(official).toBeDefined();
  // The catalog quote is already merged against a supplier tariff. Only output
  // was explicitly edited; the other supplier fields must not enter subscription value.
  const supplier = { ...official, inputPerMtok: 999, cacheReadPerMtok: 888, cacheCreatePerMtok: 777 };
  const target = { providerId, modelId, agent };
  const baseReference = { ...supplier, cacheReadPerMtok: 888, cacheCreatePerMtok: 777 };
  const values = { outputPerMtok: 123 };
  const entries: ModelPriceOverridesSnapshot = {
    [__testing.overrideKey(target)]: { ...target, values, baseReference, updatedAt: '2026-09-11' },
  };
  const effective = __testing.mergedQuote(target, supplier, values, baseReference)!;
  expect(effective.inputPerMtok).toBe(999);
  const pricing = { [providerId]: { [modelPricingKey(modelId, agent)]: effective } };
  for (const at of [undefined, '2026-09-09']) {
    const reference = providerReferencePriceQuote(providerId, modelId, registry, { agent, officialOnly: true, at })!;
    const expected = __testing.mergedQuote(target, reference, values, baseReference);
    const actual = path === 'claude'
      ? getClaudeSubscriptionValuePrice(modelId, pricing, at, entries)
      : path === 'direct'
        ? getSubscriptionDirectValuePrice(modelId, agent, pricing, at, entries)
        : getCodexProviderSubscriptionValuePrice(providerId, modelId, pricing, at, entries, agent);
    expect(actual).toEqual(expected);
    expect(actual?.outputPerMtok).toBe(123);
    expect(actual?.inputPerMtok).toBe(reference.inputPerMtok);
    expect(actual?.cacheReadPerMtok).toBe(reference.cacheReadPerMtok);
    expect(actual?.cacheCreatePerMtok).toBe(reference.cacheCreatePerMtok);
    expect(actual?.priority).toEqual(reference.priority);
  }
});
