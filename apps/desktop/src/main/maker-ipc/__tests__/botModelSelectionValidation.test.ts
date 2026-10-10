import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatalogModel, ProviderView } from '@cindy/model-providers';
import type { BotModelRoute } from '../../../shared/botModelChain';
import { setMainLocale } from '../../i18n';
import { assertBotModelSelections } from '../botModelSelectionValidation';
import { createBotModelRouteReconciler } from '../botModelRouteReconciler';
import { resolveSessionRuntimeAxes, type SessionRuntimeProfile } from '../sessionRuntimeControl';

vi.mock('../../maker-host/createDesktopProviderService.js', () => ({
  getDesktopProviderService: () => { throw new Error('This test supplies its directory explicitly'); },
}));

const route: BotModelRoute = {
  harness: 'claude', providerId: 'custom', model: 'deepseek/deepseek-v4.1-flash', effort: '', fastMode: false,
};
function catalog(efforts: CatalogModel['efforts'] = ['medium']): ProviderView[] {
  return [{ id: 'custom', name: 'Custom', source: 'user', connected: true,
    agents: ['claude-code'], auth: { method: 'none' },
    models: { 'claude-code': [{ id: route.model, name: route.model, contextWindow: 100_000,
      efforts, defaultEffort: efforts[0] ?? null }] },
  } as ProviderView];
}
beforeEach(() => setMainLocale('en'));

describe('explicit teammate model settings', () => {
  it.each(([['medium'], ['low', 'medium', 'high']] as CatalogModel['efforts'][]).map(efforts => ({ efforts })))(
    'uses the send validator to reject missing effort with capabilities $efforts', ({ efforts }) => {
      const providers = catalog(efforts);
      expect(resolveSessionRuntimeAxes({ model: providers[0]!.models['claude-code']![0]!,
        effort: null, fastMode: false, effortExplicit: true, fastExplicit: true, requireEffort: true,
      })).toEqual({ ok: false, reason: 'effort-unavailable' });
      expect(() => assertBotModelSelections([route], providers)).toThrow('Teammate Settings → Models');
    },
  );

  it('accepts empty effort for fixed or unknown capabilities without inventing an effort', () => {
    const original = structuredClone(route);
    expect(() => assertBotModelSelections([route], catalog([]))).not.toThrow();
    expect(() => assertBotModelSelections([route], [])).not.toThrow();
    expect(route).toEqual(original);
  });

  it.each(['medium', 'high'])('keeps the explicit supported %s effort even when it is not the default', effort => {
    const selected = { ...route, effort };
    assertBotModelSelections([selected], catalog(['medium', 'high']));
    expect(selected.effort).toBe(effort);
  });

  it.each(['ultra', 'null', ' '])('rejects unsupported %j without choosing a default', effort => {
    expect(() => assertBotModelSelections([{ ...route, effort }], catalog())).toThrow('[INVALID_PARAMS]');
  });

  it('does not borrow capabilities from another provider or harness with the same model ID', () => {
    const providers = catalog([]);
    providers[0]!.models.codex = catalog()[0]!.models['claude-code'];
    providers.unshift({ ...catalog()[0]!, id: 'other' });
    expect(() => assertBotModelSelections([route], providers)).not.toThrow();
    expect(() => assertBotModelSelections([{ ...route, providerId: 'other' }], providers)).toThrow('[INVALID_PARAMS]');
    expect(() => assertBotModelSelections([{ ...route, harness: 'codex' }], providers)).toThrow('[INVALID_PARAMS]');
  });

  it('rejects obsolete Fast without modifying the saved selection', () => {
    expect(() => assertBotModelSelections([{ ...route, effort: 'medium', fastMode: true }], catalog()))
      .toThrow('turn off Fast');
  });

  it.each(['en', 'zh-CN', 'zh-TW', 'ja', 'ko'] as const)('returns localized repair guidance in %s', locale => {
    setMainLocale(locale);
    expect(() => assertBotModelSelections([route], catalog())).toThrow(route.model);
    try { assertBotModelSelections([route], catalog()); }
    catch (error) {
      expect(String(error)).not.toContain('bots.modelConfiguration');
      expect(String(error)).not.toContain('{{model}}');
    }
  });
});

describe('saved teammate selection before dispatch', () => {
  function harness() {
    const providers = catalog();
    let owner = 'owner-a';
    const state = {
      chain: [{ ...route }],
      current: { agentKind: 'claude-code', model: route.model, providerId: route.providerId,
        effort: 'medium', fastMode: false } as SessionRuntimeProfile,
      hasRuntimeOverride: false,
    };
    const validate = vi.fn<NonNullable<Parameters<typeof createBotModelRouteReconciler>[0]['validate']>>(async selected => assertBotModelSelections([{
      harness: selected.agentKind === 'claude-code' ? 'claude' : selected.agentKind,
      model: selected.model, providerId: selected.providerId, effort: selected.effort ?? '', fastMode: selected.fastMode,
    }], providers));
    const apply = vi.fn(async () => {});
    const reconcile = createBotModelRouteReconciler({ ownerEpoch: () => owner, read: async () => state, validate, apply });
    return { providers, state, validate, apply, reconcile, changeOwner: () => { owner = 'owner-b'; } };
  }

  it('rejects the legacy empty profile before applying it, keeps previews readable, and accepts an explicit repair', async () => {
    const h = harness();
    await expect(h.reconcile.preview('canonical')).resolves.toMatchObject({ effort: null });
    await expect(h.reconcile('canonical')).rejects.toThrow('Teammate Settings → Models');
    expect(h.apply).not.toHaveBeenCalled();
    expect(h.state.current.effort).toBe('medium');
    expect(h.state.chain[0]!.effort).toBe('');
    h.state.chain[0]!.effort = 'medium';
    await expect(h.reconcile.profileChanged('canonical')).resolves.toBeUndefined();
  });

  it('revalidates unchanged selections when directory capabilities change', async () => {
    const h = harness();
    h.state.chain[0]!.effort = 'medium';
    await h.reconcile('canonical');
    h.providers[0]!.models['claude-code']![0]!.efforts = ['high'];
    await expect(h.reconcile('canonical')).rejects.toThrow('[INVALID_PARAMS]');
    expect(h.apply).not.toHaveBeenCalled();
  });

  it('does not apply after the owner changes while validating', async () => {
    const h = harness();
    h.state.chain[0]!.effort = 'high';
    h.validate.mockImplementationOnce(async () => { h.changeOwner(); });
    await expect(h.reconcile('canonical')).rejects.toThrow('owner changed');
    expect(h.apply).not.toHaveBeenCalled();
  });

  it('does not let a late validation failure override a newer explicit save', async () => {
    const h = harness();
    let reject!: (error: Error) => void;
    h.validate.mockImplementationOnce(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
    const first = h.reconcile('canonical');
    await vi.waitFor(() => expect(reject).toBeTypeOf('function'));
    h.state.chain[0]!.effort = 'medium';
    const save = h.reconcile.profileChanged('canonical');
    reject(new Error('obsolete configuration'));
    await expect(Promise.all([first, save])).resolves.toEqual([undefined, undefined]);
    expect(h.apply).not.toHaveBeenCalled();
  });
});
