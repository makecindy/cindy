import type { RemoteResourceProvider } from '../device-link/remoteResourceRegistry.js';
import { RemoteResourceRegistryError } from '../device-link/remoteResourceRegistry.js';
import {
  MAKE_REMOTE_COLLECTION,
  projectMakeRemoteCard,
  type MakeRemoteSnapshot,
} from './remoteProjection.js';

export interface MakeRemoteProviderDeps {
  load(sessionId: string): Promise<{ snapshot: MakeRemoteSnapshot; isCurrent(): boolean }>;
  translate(locale: string | undefined, key: string, values?: Record<string, string>): string;
  act(
    sessionId: string,
    actionId: string,
    isCurrent: () => boolean,
    locale?: string,
  ): Promise<void>;
}

/** Remote controllers use the same business actions; stale descriptors never authorize a mutation. */
export function createMakeRemoteProvider(deps: MakeRemoteProviderDeps): RemoteResourceProvider {
  const pending = new Set<string>();
  return {
    collection: {
      id: MAKE_REMOTE_COLLECTION,
      resourceKind: 'session',
      title: 'Cindy Make',
      placement: 'session:cindy-make',
    },
    async list() {
      return { collectionId: MAKE_REMOTE_COLLECTION, revision: '1', items: [] };
    },
    async get(_context, request) {
      const source = await deps.load(request.ref.id);
      if (!source.isCurrent())
        throw new RemoteResourceRegistryError('NOT_FOUND', 'Task is unavailable');
      return projectMakeRemoteCard(source.snapshot, (key, values) =>
        deps.translate(request.client.locale, key, values),
      );
    },
    async invoke(_context, request) {
      if (!request.resourceRef || (request.input && Object.keys(request.input).length))
        throw new RemoteResourceRegistryError('NOT_FOUND', 'Invalid task action');
      const sessionId = request.resourceRef.id;
      if (pending.has(sessionId))
        throw new RemoteResourceRegistryError('NOT_FOUND', 'Task action is already running');
      pending.add(sessionId);
      try {
        const source = await deps.load(request.resourceRef.id);
        const card = projectMakeRemoteCard(source.snapshot, (key) => key);
        if (
          !source.isCurrent() ||
          !card.actions?.some((action) => action.id === request.actionId && !action.disabled)
        )
          throw new RemoteResourceRegistryError(
            'NOT_FOUND',
            'Task changed; refresh before continuing',
          );
        await deps.act(
          source.snapshot.sessionId,
          request.actionId,
          source.isCurrent,
          request.client.locale,
        );
        if (!source.isCurrent()) return { effects: [] };
        return { effects: [{ kind: 'refresh-resource', ref: card.ref }] };
      } finally {
        pending.delete(sessionId);
      }
    },
  };
}
