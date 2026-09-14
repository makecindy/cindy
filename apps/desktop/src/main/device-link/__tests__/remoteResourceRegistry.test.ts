import { describe, expect, it, vi } from 'vitest';
import type {
  RemoteActionInvokeResponse,
  RemoteCollectionListResponse,
} from '@cindy/device-link';

import {
  RemoteResourceRegistry,
  RemoteResourceRegistryError,
  type RemoteResourceProvider,
} from '../remoteResourceRegistry.js';

const client = { protocolVersion: 1, primitives: ['markdown'] };
const context = { controllerDeviceId: 'mobile-1' };

function provider(overrides: Partial<RemoteResourceProvider> = {}): RemoteResourceProvider {
  return {
    collection: {
      id: 'teammates',
      resourceKind: 'bot',
      title: 'Teammates',
    },
    list: vi.fn(async (): Promise<RemoteCollectionListResponse> => ({
      collectionId: 'teammates',
      revision: 'r1',
      items: [{
        ref: { collectionId: 'teammates', kind: 'bot', id: 'bot-1' },
        display: { title: 'Sora' },
        links: [{ rel: 'conversation', target: { kind: 'session', sessionId: 'session-1' } }],
        revision: 'bot-r1',
      }],
    })),
    get: vi.fn(async (_context, request) => ({
      ref: request.ref,
      display: { title: 'Sora' },
      links: [],
      revision: 'bot-r1',
      blocks: [{ id: 'about', primitive: 'markdown', fallbackMarkdown: 'Designer' }],
    })),
    invoke: vi.fn(async (): Promise<RemoteActionInvokeResponse> => ({
      effects: [{ kind: 'toast', message: 'Done' }],
    })),
    ...overrides,
  };
}

describe('RemoteResourceRegistry', () => {
  it('discovers providers and routes generic list/get/action calls', async () => {
    const registry = new RemoteResourceRegistry();
    const registered = provider();
    registry.register(registered);

    expect(registry.manifest(context, { client })).toEqual({
      protocolVersion: 1,
      collections: [registered.collection],
    });
    await expect(registry.list(context, {
      client,
      collectionId: 'teammates',
    })).resolves.toMatchObject({ collectionId: 'teammates', revision: 'r1' });
    await expect(registry.get(context, {
      client,
      ref: { collectionId: 'teammates', kind: 'bot', id: 'bot-1' },
    })).resolves.toMatchObject({ revision: 'bot-r1' });
    await expect(registry.invoke(context, {
      client,
      collectionId: 'teammates',
      actionId: 'future-action',
    })).resolves.toEqual({ effects: [{ kind: 'toast', message: 'Done' }] });
  });

  it('rejects duplicate providers and cross-collection output', async () => {
    const registry = new RemoteResourceRegistry();
    registry.register(provider());
    expect(() => registry.register(provider())).toThrow(RemoteResourceRegistryError);

    const broken = new RemoteResourceRegistry();
    broken.register(provider({
      list: async () => ({
        collectionId: 'teammates',
        revision: 'r1',
        items: [{
          ref: { collectionId: 'other', kind: 'bot', id: 'bot-1' },
          display: { title: 'Sora' },
          links: [],
          revision: 'r1',
        }],
      }),
    }));
    await expect(broken.list(context, { client, collectionId: 'teammates' }))
      .rejects.toMatchObject({ code: 'INTERNAL' });
  });

  it('treats action descriptors as hints and rejects unregistered execution', async () => {
    const registry = new RemoteResourceRegistry();
    registry.register(provider({ invoke: undefined }));
    await expect(registry.invoke(context, {
      client,
      collectionId: 'teammates',
      actionId: 'forged-action',
    })).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
  });
});
