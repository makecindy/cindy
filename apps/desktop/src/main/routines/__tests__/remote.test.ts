import { expect, it, vi } from 'vitest';
import type { RemoteResourceProvider } from '../../device-link/remoteResourceRegistry.js';
const mocks = vi.hoisted(() => ({
  register: vi.fn(),
  save: vi.fn(async () => ({ id: 'created' })),
  scope: 'account',
}));
vi.mock('../../device-link/remoteResourceRegistry.js', () => ({
  remoteResourceRegistry: { register: mocks.register },
  RemoteResourceRegistryError: Error,
}));
vi.mock('../../localDb/ipc/bots.js', () => ({
  listBotRemoteResourceSources: async () => [
    { id: 'bot', name: 'Partner', status: 'active', currentVersion: 1 },
  ],
}));
vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => mocks.scope,
  isAppSessionBoundaryPending: () => false,
}));
vi.mock('../service.js', () => ({
  getRoutineEngine: async () => ({ list: () => [] }),
  routineTools: { list: async () => [], save: mocks.save },
}));
import { registerRoutineRemoteResources } from '../remote.js';
it('offers a per-teammate creation action and returns navigation to the saved resource', async () => {
  registerRoutineRemoteResources();
  const provider = mocks.register.mock.calls[0][0] as RemoteResourceProvider;
  const context = { controllerDeviceId: 'phone' };
  const client = { protocolVersion: 1, primitives: ['markdown'] };
  const list = await provider.list(context, { collectionId: 'routines', client });
  expect(list.items[0].ref.id).toBe('bot:bot');
  const resource = await provider.get!(context, { ref: list.items[0].ref, client });
  expect(resource.actions?.[0].id).toBe('create');
  const response = await provider.invoke!(context, {
    client,
    collectionId: 'routines',
    resourceRef: list.items[0].ref,
    actionId: 'create',
    input: { name: 'Review', prompt: 'Check PRs', cron: '0 9 * * *', timezone: 'Asia/Singapore' },
  });
  expect(mocks.save).toHaveBeenCalledWith(
    'bot',
    expect.objectContaining({
      name: 'Review',
      triggers: [expect.objectContaining({ kind: 'cron', timezone: 'Asia/Singapore' })],
    }),
  );
  expect(response.effects).toContainEqual({
    kind: 'navigate',
    target: { kind: 'resource', ref: { collectionId: 'routines', kind: 'routine', id: 'created' } },
  });
});
