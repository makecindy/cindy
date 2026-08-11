import type { Catalog, CatalogModel, Provider } from '@cindy/model-providers';
import { describe, expect, it } from 'vitest';

import type { AgentInputQueuedMessage } from '../../../shared/agentInputQueue.js';
import { CodexImageCapabilityResolver } from '../codex-image-capability.js';

function model(id: string, capability?: boolean): CatalogModel {
  return {
    id,
    name: id,
    contextWindow: 128_000,
    efforts: [],
    defaultEffort: null,
    ...(capability === undefined ? {} : { supportsImageInput: capability }),
  };
}

function provider(id: string, models: CatalogModel[], stripPrefix?: string): Provider {
  return {
    id,
    name: id,
    source: 'builtin',
    agents: ['codex'],
    auth: { method: 'apiKey' },
    models: { codex: models },
    routing: {
      codex: {
        upstream: 'https://example.test/v1',
        authStrategy: 'api-key-header',
        ...(stripPrefix ? { modelIdRewrite: { stripPrefix } } : {}),
      },
    },
  };
}

function item(modelId: string, providerId?: string): AgentInputQueuedMessage {
  return {
    clientId: 'message-1',
    text: 'inspect',
    persistedContent: 'inspect',
    model: modelId,
    effort: 'medium',
    permissionMode: 'default',
    workingDir: '/repo',
    chatMessage: { clientId: 'message-1', role: 'user', content: 'inspect' },
    createOpts: {
      agentKind: 'codex',
      workingDir: '/repo',
      model: modelId,
      ...(providerId ? { providerId } : {}),
    },
  };
}

function harness(catalog: Catalog, sessionProvider: string | null = null) {
  return new CodexImageCapabilityResolver({
    getCatalog: () => catalog,
    getSessionProvider: () => sessionProvider,
  });
}

describe('CodexImageCapabilityResolver', () => {
  it('uses the live session provider and explicit catalog capability', () => {
    const resolver = harness(
      {
        version: 'test',
        providers: [
          provider('vision', [model('same', true)]),
          provider('text', [model('same', false)]),
        ],
      },
      'text',
    );
    expect(resolver.resolve('session-1', item('same', 'vision'))).toBe(false);
  });

  it('matches provider stripPrefix and one-million display suffixes', () => {
    const resolver = harness(
      {
        version: 'test',
        providers: [provider('prefixed', [model('deepseek-chat', false)], 'custom/')],
      },
      'prefixed',
    );
    expect(resolver.resolve('session-1', item('custom/deepseek-chat[1m]'))).toBe(false);
  });

  it('learns only the exact undeclared provider/model route', () => {
    const catalog = {
      version: 'test',
      providers: [provider('one', [model('unknown')]), provider('two', [model('unknown')])],
    };
    const one = harness(catalog, 'one');
    expect(one.resolve('session-1', item('unknown'))).toBeUndefined();
    one.markRejected('session-1', item('unknown'));
    expect(one.resolve('session-1', item('unknown'))).toBe(false);
    expect(one.resolve('session-1', item('another'))).toBeUndefined();
  });

  it('lets an explicit positive catalog refresh override a learned rejection', () => {
    let catalog: Catalog = { version: 'test', providers: [provider('one', [model('unknown')])] };
    const resolver = new CodexImageCapabilityResolver({
      getCatalog: () => catalog,
      getSessionProvider: () => 'one',
    });
    resolver.markRejected('session-1', item('unknown'));
    expect(resolver.resolve('session-1', item('unknown'))).toBe(false);

    catalog = { version: 'test', providers: [provider('one', [model('unknown', true)])] };
    expect(resolver.resolve('session-1', item('unknown'))).toBe(true);
  });

  it('keeps non-Codex routes outside this resolver', () => {
    const resolver = harness({ version: 'test', providers: [] });
    const other = item('model');
    other.createOpts.agentKind = 'claude-code';
    expect(resolver.resolve('session-1', other)).toBe(true);
  });
});
