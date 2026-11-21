/*
 * 测试价值
 * - 生产入口与可观察结果：projectSubscriptionPoolCatalog 返回的目录里 `openai` 的模型表。桌面的
 *   getDesktopSelectableCatalog 与 Node Host 的 model-context 都经它投影订阅账号池。
 * - 规则依据：只把「属于 OpenAI 账号池、未暂停、已登录」的导入 Codex 账号的模型并进 `openai`，
 *   不覆盖 `openai` 已有的同名模型；池断开或没有别名时保留相同目录内容。
 * - 最小失败输入：并入了暂停或未登录账号的模型；覆盖了 `openai` 自己的同名模型；池断开仍投影。
 * - tier：unit（纯函数，端口全部是假实现）。
 */
import { describe, expect, it } from 'vitest';
import type { Catalog, CatalogModel } from '@cindy/model-providers';

import { projectSubscriptionPoolCatalog, type SubscriptionPoolCatalogPorts } from '../subscriptionPoolCatalog.js';
import { BUNDLED_CATALOG } from '@cindy/model-providers';
import { getActiveCatalogWithClaudeModels, getActiveCatalogWithCodexModels } from '../active-catalog.js';
import { createProviderService } from '../provider-service.js';
import { resolveScheduledModelSelection } from '../../maker-ipc/scheduledModelSelection.js';
import { resolveGuestProviderId } from '../../remote-agent/host/providerAccess.js';
import { isSelectedSourceDisconnected } from '../../../renderer/components/new-chat/sourceSwitch.js';

const model = (id: string, contextWindow = 100_000) => ({ id, name: id, contextWindow, efforts: [], defaultEffort: null });

function catalog(): Catalog {
  return {
    providers: [
      { id: 'openai', agents: ['codex'], auth: { native: 'codex' }, models: { codex: [model('shared', 1)] }, routing: {} },
      { id: 'acct-a', agents: ['codex'], auth: { native: 'codex' }, models: { codex: [model('shared', 2), model('only-a')] }, routing: {} },
      { id: 'acct-b', agents: ['codex'], auth: { native: 'codex' }, models: { codex: [model('only-b')] }, routing: {} },
    ],
  } as unknown as Catalog;
}

const basePorts = {
  readSubscriptionPoolCodexModels: () => null,
  readSubscriptionPoolClaudeModels: () => null,
  getActiveCatalogWithClaudeModels,
  getActiveCatalogWithCodexModels: () => { throw Error('no discovery in this fixture'); },
  readMergedProviderAccount: () => undefined,
  accountProviderId: () => 'openai',
  readProviderBoundAccountIds: () => new Set<string>(),
} satisfies Omit<SubscriptionPoolCatalogPorts, 'readPool' | 'codexAccountState'>;

const pool = (overrides: Record<string, unknown> = {}) => ({
  legacyCodexAccounts: { 'acct-a': 'pool-a', 'acct-b': 'pool-b' },
  accounts: [{ id: 'pool-a' }, { id: 'pool-b', paused: true }],
  ...overrides,
});

describe('projectSubscriptionPoolCatalog', () => {
  // #11865: the public production projection combines connection catalogs, so a
  // retained public marker must not conceal imported account evidence or claim
  // the eventual executor was checked. Existing tests cover members/capabilities,
  // not this metadata boundary. Unit: fake ports, conflicting same-ID Pi entries.
  it.each(['lender', 'legacy'] as const)('keeps combined Pi membership evidence unknown at the %s merge boundary', (boundary) => {
    const targetModels: CatalogModel[] = [
      { ...model('shared', 1), membershipSource: 'public-catalog' },
      { ...model('own-explicit', 2), membershipSource: 'user-configured' },
      { ...model('only-target', 3), membershipSource: 'account-catalog' },
    ];
    const sourceModels: CatalogModel[] = [
      { ...model('shared', 10), membershipSource: 'account-catalog' },
      { ...model('own-explicit', 20), membershipSource: 'account-catalog' },
      { ...model('borrowed', 30), membershipSource: 'account-catalog' },
      { ...model('borrowed-explicit', 40), membershipSource: 'user-configured' },
    ];
    const targetId = boundary === 'lender' ? 'openai' : 'acct-a';
    const target = { ...catalog().providers[0]!, id: targetId, agents: ['pi' as const], models: { pi: targetModels } };
    const source = { ...catalog().providers[1]!, agents: ['pi' as const], models: { pi: sourceModels } };
    const input: Catalog = { ...catalog(), providers: boundary === 'lender' ? [target, source] : [target] };
    const projected = projectSubscriptionPoolCatalog(input, {
      ...basePorts,
      readPool: () => pool() as never,
      codexAccountState: () => ({ authenticated: true }),
      accountProviderId: () => targetId,
      readSubscriptionPoolCodexModels: () => boundary === 'legacy' ? [model('pooled')] : null,
      getActiveCatalogWithCodexModels: () => ({ ...catalog(), providers: [{ ...source, id: 'openai' }] }),
    });
    const models = projected.providers.find(provider => provider.id === targetId)!.models.pi!;
    expect(models.map(entry => entry.id)).toEqual(['shared', 'own-explicit', 'only-target', 'borrowed', 'borrowed-explicit']);
    expect(models.find(entry => entry.id === 'shared')).toMatchObject({ contextWindow: 1 });
    expect(models.find(entry => entry.id === 'shared')!.membershipSource).toBeUndefined();
    expect(models.find(entry => entry.id === 'borrowed')!.membershipSource).toBeUndefined();
    expect(models.find(entry => entry.id === 'borrowed-explicit')!.membershipSource).toBeUndefined();
    expect(models.find(entry => entry.id === 'own-explicit'))
      .toMatchObject({ contextWindow: 2, membershipSource: 'user-configured' });
    expect(models.find(entry => entry.id === 'only-target')!.membershipSource).toBeUndefined();
    // Projection does not rewrite the individual account catalogs.
    expect(targetModels[0]!.membershipSource).toBe('public-catalog');
    expect(sourceModels[0]!.membershipSource).toBe('account-catalog');
  });

  it.each([false, true])('preserves targeted account evidence without borrowing builtin additions on a legacy route (original available: %s)', (keepOriginal) => {
    const target = { ...catalog().providers[1]!, agents: ['pi' as const], models: { pi: keepOriginal ? [] : [model('old')] } };
    const discovered: CatalogModel = { ...model('pooled'), membershipSource: 'account-catalog' };
    const builtinExplicit: CatalogModel = { ...model('builtin-explicit'), membershipSource: 'user-configured' };
    const projected = projectSubscriptionPoolCatalog({ ...catalog(), providers: [target] }, {
      ...basePorts,
      readPool: () => pool() as never,
      codexAccountState: () => ({ authenticated: keepOriginal }),
      accountProviderId: () => 'acct-a',
      readSubscriptionPoolCodexModels: () => [model('pooled')],
      getActiveCatalogWithCodexModels: () => ({ ...catalog(), providers: [
        { ...catalog().providers[0]!, agents: ['pi'], models: { pi: [discovered, builtinExplicit] } },
      ] }),
    });
    expect(projected.providers[0]!.models.pi).toEqual([discovered, model(builtinExplicit.id)]);
  });

  // Unit: local send, remote guest recovery and scheduling all consume provider views.
  // Discovery must retain the native metadata those existing tasks used before the upgrade.
  it.each([{ discovered: null }, { discovered: [] }, { discovered: [model('claude-current')] }])('retains historical Claude routing metadata with discovery $discovered', async ({ discovered }) => {
    const base = BUNDLED_CATALOG.providers.find(provider => provider.id === 'anthropic')!;
    const historical = model('claude-historical', 123_456);
    const input = { ...BUNDLED_CATALOG, providers: [{ ...base, models: { 'claude-code': [historical] } }] };
    const ports: SubscriptionPoolCatalogPorts = { ...basePorts, readPool: () => null,
      codexAccountState: () => ({ authenticated: true }), readSubscriptionPoolClaudeModels: () => discovered };
    const selectable = projectSubscriptionPoolCatalog(input, ports);
    expect(selectable.providers[0]!.models['claude-code']?.map(m => m.id)).toEqual([historical, ...discovered ?? []].map(m => m.id));
    const routing = projectSubscriptionPoolCatalog(input, ports, true);
    expect(routing.providers[0]!.models['claude-code']).toContainEqual(historical);
    let connected = true;
    let disabledModels: Record<string, true> = {};
    const service = createProviderService({ getCatalog: () => input,
      projectCatalog: (source, full) => projectSubscriptionPoolCatalog(source, ports, full),
      connection: { xd: () => false, anthropic: () => connected, openai: () => false, xai: () => false },
      getModelAccess: () => ({ disabledModels, disabledProviders: {} }),
    });
    const selection = { agentKind: 'claude-code' as const, providerId: 'anthropic', model: historical.id, effort: null, fastMode: false };
    const views = () => service.listProviders({ catalog: input, snapshotOnly: true });
    expect(resolveScheduledModelSelection(selection, await views())).toMatchObject({ providerId: 'anthropic', model: historical.id });
    const remote = await service.listProviders({ snapshotOnly: true });
    expect(isSelectedSourceDisconnected({ providers: remote, agent: 'claude-code', modelId: historical.id,
      selectedProviderId: 'anthropic', providersLoading: false })).toBe(false);
    expect(resolveGuestProviderId(remote, 'anthropic', () => true, 'claude-code', historical.id, 'anthropic')).toBe('anthropic');
    expect(resolveGuestProviderId(remote, 'anthropic', () => false, 'claude-code', historical.id, 'anthropic')).toBeNull();
    expect(resolveGuestProviderId(remote, 'anthropic', () => true, 'claude-code', historical.id, 'another-provider')).toBeNull();
    disabledModels = { [`anthropic:${historical.id}`]: true };
    const disabled = await views();
    expect(() => resolveScheduledModelSelection(selection, disabled)).toThrow('MODEL_SELECTION_UNAVAILABLE');
    disabledModels = {};
    connected = false;
    const disconnected = await views();
    expect(() => resolveScheduledModelSelection(selection, disconnected)).toThrow('MODEL_SELECTION_UNAVAILABLE');
    expect(isSelectedSourceDisconnected({ providers: await service.listProviders({ snapshotOnly: true }), agent: 'claude-code',
      modelId: historical.id, selectedProviderId: 'anthropic', providersLoading: false })).toBe(true);
  });
  // Unit: real catalog metadata and shared projection, with renamed/same-name sources.
  // New account discoveries stay with their provider; existing native metadata stays available.
  it.each(['anthropic', 'openai'] as const)('isolates %s membership by id even when display names are swapped', (kind) => {
    const base = BUNDLED_CATALOG.providers.find(provider => provider.id === kind)!;
    const agent = kind === 'anthropic' ? 'claude-code' : 'codex';
    const independent = `${kind}-sub-12345678`;
    const input = { ...BUNDLED_CATALOG, providers: [
      { ...base, name: 'Renamed' },
      { ...base, id: independent, name: kind === 'anthropic' ? 'OpenAI' : 'Claude', subscriptionPool: kind },
    ] };
    const discoveredId = kind === 'anthropic' ? 'claude-opus-99-9' : 'gpt-6';
    const read = (id: string = kind) => id === independent ? [model(discoveredId)] : [];
    const builtinExplicit: CatalogModel = { ...model('chatgpt/builtin-explicit'), membershipSource: 'user-configured' };
    const output = projectSubscriptionPoolCatalog(input, { ...basePorts,
      readPool: () => null, codexAccountState: () => ({ authenticated: true }),
      readSubscriptionPoolCodexModels: kind === 'openai' ? read : () => null,
      readSubscriptionPoolClaudeModels: kind === 'anthropic' ? read : () => null,
      getActiveCatalogWithCodexModels: (models) => {
        const projected = getActiveCatalogWithCodexModels(models);
        return { ...projected, providers: projected.providers.map(provider => provider.id === 'openai'
          ? { ...provider, models: { ...provider.models, pi: [...provider.models.pi ?? [], builtinExplicit] } }
          : provider) };
      },
      getActiveCatalogWithClaudeModels,
    });
    expect(output.providers[0]!.models[agent]).toEqual(kind === 'anthropic' ? input.providers[0]!.models[agent] : []);
    expect(output.providers[0]!.models[agent]?.some(entry => entry.id === discoveredId)).toBe(false);
    expect(output.providers[1]!.models[agent]?.map(entry => entry.id)).toContain(discoveredId);
    expect(output.providers[1]!.name).toBe(input.providers[1]!.name);
    if (kind === 'openai') {
      const inheritedPi: CatalogModel[] = [builtinExplicit,
        { ...model('chatgpt/builtin-account'), membershipSource: 'account-catalog' },
        { ...model('chatgpt/builtin-public'), membershipSource: 'public-catalog' }];
      const pending = projectSubscriptionPoolCatalog({ ...input, providers: [
        { ...input.providers[1]!, models: { pi: inheritedPi } },
      ] }, { ...basePorts, readPool: () => null, codexAccountState: () => ({ authenticated: true }) });
      expect(pending.providers[0]!.models.pi).toEqual([
        model(builtinExplicit.id), model('chatgpt/builtin-account'), model('chatgpt/builtin-public'),
      ]);
      // A created pool mirrors builtin models, not that connection's explicit configuration.
      expect(output.providers[0]!.models.pi?.find(entry => entry.id === builtinExplicit.id)).toEqual(builtinExplicit);
      expect(output.providers[1]!.models.pi?.find(entry => entry.id === builtinExplicit.id))
        .toMatchObject({ id: builtinExplicit.id, contextWindow: builtinExplicit.contextWindow });
      expect(output.providers[1]!.models.pi?.find(entry => entry.id === builtinExplicit.id)?.membershipSource).toBeUndefined();
      expect(output.providers[1]!.models.pi?.find(entry => entry.id === `chatgpt/${discoveredId}`)?.membershipSource).toBe('account-catalog');
    }
  });

  it('adds models of active, signed-in pool accounts to openai without replacing its own', () => {
    const projected = projectSubscriptionPoolCatalog(catalog(), {
      ...basePorts,
      readPool: () => pool() as never,
      codexAccountState: () => ({ authenticated: true }),
    });
    const openai = projected.providers.find((provider) => provider.id === 'openai')!;
    expect(openai.models.codex!.map((entry) => entry.id)).toEqual(['shared', 'only-a']);
    expect(openai.models.codex![0]!.contextWindow).toBe(1);
  });

  it('skips accounts that are not signed in', () => {
    const projected = projectSubscriptionPoolCatalog(catalog(), {
      ...basePorts,
      readPool: () => pool() as never,
      codexAccountState: (id) => ({ authenticated: id !== 'acct-a' }),
    });
    expect(projected.providers.find((provider) => provider.id === 'openai')!.models.codex!.map((entry) => entry.id)).toEqual(['shared']);
  });

  it('preserves catalog content when the pool is disconnected or has no aliases', () => {
    const input = catalog();
    const signedIn = { ...basePorts, codexAccountState: () => ({ authenticated: true }) };
    expect(projectSubscriptionPoolCatalog(input, { ...signedIn, readPool: () => pool({ disconnected: true }) as never })).toEqual(input);
    expect(projectSubscriptionPoolCatalog(input, { ...signedIn, readPool: () => null })).toEqual(input);
  });
});
