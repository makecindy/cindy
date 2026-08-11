import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { BUNDLED_CATALOG, buildRegistry, type Catalog } from '@cindy/model-providers';
import { describe, expect, it, vi } from 'vitest';

import { readOrcaWorkerProviderRoutingContext } from '../orcaProviderRoutingContext.js';

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
    expect(registerSource).toContain('getProviderRoutingContext,');
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
