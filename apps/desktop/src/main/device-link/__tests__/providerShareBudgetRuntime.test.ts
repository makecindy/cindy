import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ProviderView } from '@cindy/model-providers';
import type { ProviderShareMemberBudget } from '../../../shared/providerShareBudget.js';
// Unit: real admission/status entry. The old account estimator cannot verify personal token
// shares, draft bypass, exact-boundary admission or recovery after other-model usage.
const state = vi.hoisted(() => ({
  read: vi.fn(), ledger: vi.fn(), broken: false, available: true, modelTokens: 60, otherTokens: 40,
  policy: null as ProviderShareMemberBudget | null,
}));
vi.mock('../../maker-host/active-catalog.js', () => ({ getActiveCatalog: () => ({ providers: [{ id: 'p', models: { codex: [{ id: 'future-model' }, { id: 'other-model' }] } }] }) }));
vi.mock('../../provider-group/store.js', () => ({ readProviderGroup: () => null }));
vi.mock('../providerShareHost.js', () => ({ getProviderShareHostSnapshot: () => [{ shareId: 'share', providerId: 'p', members: [{ memberId: 'alice' }] }] }));
vi.mock('../providerShareUsageStore.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../providerShareUsageStore.js')>();
  return { ...actual, getProviderShareUsageStore: () => ({ memberTokenSnapshot: state.ledger }) };
});
vi.mock('../remoteModelAccess.js', () => ({ remoteModelAccess: { read: state.read, allows: () => true } }));
import { memberBudgetAllows, memberBudgetAllowsCached, readMemberBudgetStatus, supportsMemberBudget } from '../providerShareBudgetRuntime.js';
import { isProviderShareMemberBudget } from '../../../shared/providerShareBudget.js';

beforeEach(() => {
  state.broken = false; state.available = true; state.modelTokens = 60; state.otherTokens = 40;
  state.policy = { basis: 'member-input-output-7d', enabled: true, rules: [{ id: 'one', models: ['future-model'], maxPercent: 50 }], recommendedModel: 'other-model' };
  state.read.mockReset().mockImplementation(() => {
    if (state.broken) throw new Error('unreadable settings');
    return { memberBudget: state.policy };
  });
  state.ledger.mockReset().mockImplementation(() => ({ available: state.available, windowStart: '2026-10-22', windowEnd: '2026-10-28', nextWindowAt: 1,
    models: [{ model: 'future-model', tokens: state.modelTokens }, { model: 'other-model', tokens: state.otherTokens }] }));
});
afterEach(() => vi.restoreAllMocks());

it('never reads member rules or usage for owner and same-account admission even with broken storage', async () => {
  state.broken = true;
  expect(memberBudgetAllowsCached('p', 'future-model')).toBe(true);
  expect(await memberBudgetAllows('p', 'future-model')).toBe(true);
  expect(state.read).not.toHaveBeenCalled();
  expect(state.ledger).not.toHaveBeenCalled();
});
it('keeps a draft non-enforcing, while its status shows the actual threshold comparison', () => {
  state.policy!.enabled = false;
  expect(memberBudgetAllowsCached('p', 'future-model', 'alice')).toBe(true);
  expect(state.ledger).not.toHaveBeenCalled();
  expect(readMemberBudgetStatus('p', 'alice')?.rules[0]).toMatchObject({ usedPercent: 60, wouldBlock: true, blocked: false });
  state.available = false;
  expect(memberBudgetAllowsCached('p', 'future-model', 'alice')).toBe(true);
});
it('previews recorded usage before any rule exists without creating or enabling one', () => {
  state.policy = null;
  expect(readMemberBudgetStatus('p', 'alice')).toBeNull();
  expect(readMemberBudgetStatus('p', 'alice', true)).toMatchObject({ enabled: false, totalTokens: 100, rules: [],
    modelUsage: [{ model: 'future-model', tokens: 60 }, { model: 'other-model', tokens: 40 }] });
  expect(state.policy).toBeNull();
  expect(memberBudgetAllowsCached('p', 'future-model', 'alice')).toBe(true);
});
it('limits only the configured member model, then recovers as that member uses another model', () => {
  expect(supportsMemberBudget({ id: 'p' } as ProviderView)).toBe(true);
  expect(memberBudgetAllowsCached('p', 'future-model', 'alice')).toBe(false);
  expect(memberBudgetAllowsCached('p', 'other-model', 'alice')).toBe(true);
  state.otherTokens = 60;
  expect(readMemberBudgetStatus('p', 'alice')?.rules[0].usedPercent).toBe(50);
  expect(memberBudgetAllowsCached('p', 'future-model', 'alice')).toBe(false);
  state.otherTokens = 61;
  expect(memberBudgetAllowsCached('p', 'future-model', 'alice')).toBe(true);
});
// Unit: bridge-qualified model IDs must not split the numerator or bypass admission.
it('combines canonical and bridge usage and applies the same rule to either request ID', () => {
  state.ledger.mockReturnValue({ available: true, windowStart: '2026-10-22', windowEnd: '2026-10-28', nextWindowAt: 1,
    models: [{ model: 'future-model', tokens: 30 }, { model: 'chatgpt/future-model', tokens: 30 }, { model: 'other-model', tokens: 40 }] });
  expect(readMemberBudgetStatus('p', 'alice')?.rules[0]).toMatchObject({ usedPercent: 60, tokens: 60 });
  expect(memberBudgetAllowsCached('p', 'chatgpt/future-model', 'alice')).toBe(false);
});
it('does not fabricate 0% for empty or unreadable records; empty allows bootstrap and 100% is unrestricted', () => {
  state.modelTokens = state.otherTokens = 0;
  expect(readMemberBudgetStatus('p', 'alice')).toMatchObject({ state: 'empty', totalTokens: 0, rules: [{ usedPercent: null, blocked: false }] });
  state.available = false;
  expect(readMemberBudgetStatus('p', 'alice')).toMatchObject({ state: 'unavailable', totalTokens: null, rules: [{ usedPercent: null, blocked: true }] });
  state.available = true; state.modelTokens = 100;
  state.policy!.rules[0]!.maxPercent = 100;
  expect(memberBudgetAllowsCached('p', 'future-model', 'alice')).toBe(true);
});
it('rejects the former quota schema and duplicate or combined models instead of reinterpreting them', () => {
  expect(isProviderShareMemberBudget(state.policy)).toBe(true);
  const { basis: _basis, ...old } = state.policy!;
  expect(isProviderShareMemberBudget(old)).toBe(false);
  expect(isProviderShareMemberBudget({ ...state.policy, rules: [{ id: 'one', models: ['a', 'b'], maxPercent: 50 }] })).toBe(false);
  expect(isProviderShareMemberBudget({ ...state.policy, rules: [...state.policy!.rules, { ...state.policy!.rules[0], id: 'two' }] })).toBe(false);
  for (const maxPercent of [0, 0.5, 30.5, 101, NaN, '50']) expect(isProviderShareMemberBudget({ ...state.policy, rules: [{ ...state.policy!.rules[0], maxPercent }] })).toBe(false);
  expect(isProviderShareMemberBudget({ ...state.policy, rules: [...state.policy!.rules, { id: 'alias', models: ['chatgpt/future-model'], maxPercent: 50 }] })).toBe(false);
});
