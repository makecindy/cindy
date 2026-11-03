import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { BUNDLED_CATALOG, buildRegistry, type Catalog } from '@cindy/model-providers';
import { describe, expect, it, vi } from 'vitest';

import { deviceAvailableModels, localAvailableModels, readOrcaWorkerProviderRoutingContext } from '../orcaProviderRoutingContext.js';

const registerSource = readFileSync(resolve(__dirname, '..', 'register.ts'), 'utf8').replace(
  /\r\n?/g,
  '\n',
);
const routingSource = readFileSync(
  resolve(__dirname, '..', 'orcaProviderRoutingContext.ts'),
  'utf8',
).replace(/\r\n?/g, '\n');

describe('Orca provider routing snapshot wiring', () => {
  it('delegates routing snapshot construction to the post-claim full-catalog reader', () => {
    const start = registerSource.indexOf('const getProviderRoutingContext = () =>');
    const end = registerSource.indexOf('const orcaWorkerCreationService', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const wiring = registerSource.slice(start, end);

    expect(wiring).toContain('readOrcaWorkerProviderRoutingContext');
    expect(wiring).toContain('providerService: getDesktopProviderService()');
    expect(wiring).toContain('getCatalog: getActiveCatalog');
    expect(routingSource).toContain('waitForDiscovery: true');
    expect(registerSource).toContain('getProviderRoutingContext: async (agent, remoteHostId, agentDeviceId) => agentDeviceId && !remoteHostId');
    // lead 的 Agent 在另一台电脑运行时按那台的目录；其余与原来一致。
    expect(registerSource).toContain("deviceWorkerRoutingContext(await readDeviceProviderViews(remoteBackgroundInvoke, agentDeviceId), agent ?? 'claude-code')");
    expect(registerSource).toContain('sshCodexWorkerRoutingContext(await readSshCodexModelList({ id: remoteHostId }, listSshCodexProviders))');
  });

  it('resumes an idle parent with the stored provider so Bot completions can wake it', () => {
    const start = registerSource.indexOf('async function sendToSessionInternal(params: {');
    const resume = registerSource.indexOf('const createOpts = buildCreateOptsWithStderr({',
      registerSource.indexOf('const persistUserMessage = async (): Promise<void> => {', start),
    );
    const end = registerSource.indexOf('await synthesizeOrcaVendorOptionsFromDb(targetSessionId, createOpts);', resume);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(resume).toBeGreaterThan(start);
    expect(end).toBeGreaterThan(resume);
    const lazyResume = registerSource.slice(resume, end);
    expect(lazyResume).toContain('resumeSessionId: meta.sdkSessionId');
    expect(lazyResume).toContain('...(dbRow.providerId ? { providerId: dbRow.providerId } : {})');
  });

  it('validates explicit execution config before allocating a handoff worktree', () => {
    const start = registerSource.indexOf('async function sendToSessionInternal(params: {');
    const end = registerSource.indexOf('const newTitle =', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const createSetup = registerSource.slice(start, end);
    const validation = createSetup.indexOf(
      'const resolvedExecution = resolveSendToSessionExecutionConfig({',
    );
    const worktreeAllocation = createSetup.indexOf(
      'const prep = await prepareHandoffWorktree(',
    );
    expect(validation).toBeGreaterThanOrEqual(0);
    expect(worktreeAllocation).toBeGreaterThan(validation);
  });

  it.each([['openai', 'codex']] as const)('marks %s accounts local-only for Pi before SSH worker creation', async (brand, native) => {
    const builtin = BUNDLED_CATALOG.providers.find((provider) => provider.id === brand)!;
    const account = { ...builtin, id: 'user-account', auth: { method: 'oauth' as const, native } };
    const catalog = { ...BUNDLED_CATALOG, providers: [account, builtin] };
    const routing = await readOrcaWorkerProviderRoutingContext({
      providerService: {
        listProviders: vi.fn(async () => buildRegistry(catalog, { [account.id]: true, [brand]: true })),
      },
      getCatalog: () => catalog,
    });
    expect(routing.availability.pi.find((provider) => provider.id === account.id)?.localOnlyForSsh).toBe(true);
    const nativeAgent = brand === 'openai' ? 'codex' : 'claude-code';
    expect(routing.availability[nativeAgent].find((provider) => provider.id === brand)?.localOnlyForSsh).toBe(false);
  });

  it('never offers the Claude subscription (builtin or retired account) to Pi Orca workers', async () => {
    const builtin = BUNDLED_CATALOG.providers.find((provider) => provider.id === 'anthropic')!;
    const account = { ...builtin, id: 'user-account', agents: [], auth: { method: 'oauth' as const, native: 'claude' as const } };
    const catalog = { ...BUNDLED_CATALOG, providers: [account, builtin] };
    const routing = await readOrcaWorkerProviderRoutingContext({
      providerService: {
        listProviders: vi.fn(async () => buildRegistry(catalog, { [account.id]: true, anthropic: true })),
      },
      getCatalog: () => catalog,
    });
    for (const agent of ['pi', 'codex'] as const) {
      expect(routing.availability[agent].some((provider) => provider.id === 'anthropic' || provider.id === account.id)).toBe(false);
    }
    // 远端任务不能用 Claude 订阅(它只在本机 Claude Code 的登录里),SSH worker 不选它。
    expect(routing.availability['claude-code'].find((provider) => provider.id === 'anthropic')?.localOnlyForSsh).toBe(true);
  });

  it('rejects SSH account switching before deferring or replacing the running route', () => {
    const guard = registerSource.indexOf("throwIpcError('INVALID_PARAMS', 'This provider requires local execution')");
    expect(guard).toBeGreaterThan(-1);
    expect(registerSource.slice(guard - 450, guard)).toContain('runtimeStatus.remoteHostId');
    expect(registerSource.slice(guard - 300, guard)).toContain('isLocalOnlyProviderForAgent');
    expect(registerSource.indexOf('const deferLockedSelection =', guard)).toBeGreaterThan(guard);
    expect(registerSource.indexOf('const previousRuntime =', guard)).toBeGreaterThan(guard);
  });

  it('waits for the first Anthropic claim and routes the discovered model from the same full snapshot', async () => {
    const anthropic = BUNDLED_CATALOG.providers.find((provider) => provider.id === 'anthropic')!;
    const seed = BUNDLED_CATALOG.providers.find((provider) => provider.id === 'xd')!.models[
      'claude-code'
    ]![0]!;
    const discoveredModel = { ...seed, id: 'claude-first-fire', name: 'Claude First Fire' };
    const freshCatalog: Catalog = {
      ...BUNDLED_CATALOG,
      providers: BUNDLED_CATALOG.providers.map((provider) =>
        provider.id === anthropic.id
          ? {
              ...provider,
              models: { ...provider.models, 'claude-code': [discoveredModel] },
            }
          : provider,
      ),
    };
    let catalog: Catalog = BUNDLED_CATALOG;
    let releaseDiscovery!: () => void;
    const discoveryGate = new Promise<void>((resolveGate) => {
      releaseDiscovery = resolveGate;
    });
    let getterCalled = false;
    const providerService = {
      listProviders: vi.fn(
        async (opts: {
          allowSideEffects?: boolean;
          waitForDiscovery?: boolean;
          getCatalog?: () => Catalog;
        }) => {
          expect(opts.allowSideEffects).toBe(true);
          expect(opts.waitForDiscovery).toBe(true);
          await discoveryGate;
          catalog = freshCatalog;
          const postClaimCatalog = opts.getCatalog?.();
          getterCalled = true;
          expect(postClaimCatalog).toBe(freshCatalog);
          return buildRegistry(postClaimCatalog!, {
            xd: false,
            anthropic: true,
            openai: false,
            xai: false,
          });
        },
      ),
    };

    const routingPromise = readOrcaWorkerProviderRoutingContext({
      providerService,
      getCatalog: () => catalog,
    });
    await Promise.resolve();
    expect(getterCalled).toBe(false);
    releaseDiscovery();

    const routing = await routingPromise;
    const anthropicSnapshot = routing.availability['claude-code'].find(
      (provider) => provider.id === 'anthropic',
    );
    expect(anthropicSnapshot?.models).toContain('claude-first-fire');
    expect(routing.resolveDefaultProviderIdForModel('claude-code', 'claude-first-fire')).toBe(
      'anthropic',
    );
  });
});

describe('localAvailableModels (#6970)', () => {
  // Automation model discovery previously discarded pricing/effort data before it
  // reached tools. Same-id routes must retain their own rates; no credentials cross.
  it.each(['claude-code', 'codex', 'pi'] as const)('preserves source-specific prices and known/unknown efforts for %s automation discovery', async (agent) => {
    const base = BUNDLED_CATALOG.providers.find(p => p.id === 'xd')!;
    const seed = base.models.pi![0]!;
    const catalog: Catalog = { ...BUNDLED_CATALOG, providers: [
      { ...base, id: 'first', access: { kind: 'api' }, models: { [agent]: [{ ...seed, id: 'same',
        cost: { input: 0, output: 0.5 }, currency: 'USD', efforts: ['low'], defaultEffort: 'low',
        route: { baseUrl: 'https://private.invalid', wireProtocol: 'openai-chat' },
      }] } },
      { ...base, id: 'second', access: { kind: 'subscription', product: 'test' }, models: { [agent]: [{ ...seed, id: 'same',
        cost: undefined, currency: undefined, efforts: [], defaultEffort: null, effortsUnknown: true,
      }] } },
    ] };
    const views = buildRegistry(catalog, { first: true, second: true });
    const routing = await readOrcaWorkerProviderRoutingContext({
      providerService: { listProviders: vi.fn(async () => views) }, getCatalog: () => catalog,
    });
    const local = localAvailableModels([{ id: 'same', displayName: 'Same' }], routing.availability[agent],
      routing.resolveDefaultProviderIdForModel, agent);
    for (const models of [local, deviceAvailableModels(views, agent)]) {
      expect(models[0]?.providers).toMatchObject([
        { id: 'first', access: { kind: 'api' }, modelDetails: { cost: { input: 0, output: 0.5 }, currency: 'USD', efforts: ['low'] } },
        { id: 'second', access: { kind: 'subscription' }, modelDetails: { cost: undefined, efforts: [], defaultEffort: null, effortsUnknown: true } },
      ]);
      expect(JSON.stringify(models)).not.toContain('private.invalid');
    }
  });

  it('drops catalog models that no enabled provider offers', () => {
    const models = localAvailableModels(
      [
        { id: 'codex/gpt-6.1-sol', displayName: 'GPT 6.1 Sol' },
        { id: 'anthropic/claude-opus-5-5', displayName: 'Opus 5.5' },
      ],
      [{ id: 'chatgpt', name: 'ChatGPT', models: ['codex/gpt-6.1-sol'] }],
      (_agent, model) => (model === 'codex/gpt-6.1-sol' ? 'chatgpt' : null),
      'claude-code',
    );
    // 提供商被关后只剩目录骨架的模型(providers 会是空)不能再暴露给 Lead。
    expect(models).toEqual([
      {
        id: 'codex/gpt-6.1-sol',
        label: 'GPT 6.1 Sol',
        providers: [{ id: 'chatgpt', name: 'ChatGPT' }],
        defaultProviderId: 'chatgpt',
      },
    ]);
  });
});
