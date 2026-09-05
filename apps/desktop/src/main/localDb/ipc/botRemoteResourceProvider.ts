import {
  getBotRemoteResourceSource,
  listBotRemoteResourceSources,
} from './bots.js';
import { RemoteResourceRegistryError, remoteResourceRegistry } from '../../device-link/remoteResourceRegistry.js';
import {
  BOT_REMOTE_RESOURCE_KIND,
  TEAMMATES_REMOTE_COLLECTION_ID,
  TEAMMATES_TITLE,
  botRemoteCollectionItemFromSource,
  botRemoteResourceFromSource,
  visibleBotRemoteResourceSources,
} from './botRemoteResourceProjection.js';

let registered = false;

/** Register the Bot module through the same API future host modules use. */
export function registerBotRemoteResourceProvider(): void {
  if (registered) return;
  remoteResourceRegistry.register({
    collection: {
      id: TEAMMATES_REMOTE_COLLECTION_ID,
      resourceKind: BOT_REMOTE_RESOURCE_KIND,
      title: TEAMMATES_TITLE,
      placement: 'home-scope',
      icon: { name: 'users', fallbackText: '••' },
    },
    async list(_context, request) {
      const rawQuery = request.query?.trim().toLocaleLowerCase() ?? '';
      const sources = visibleBotRemoteResourceSources(await listBotRemoteResourceSources());
      const filtered = rawQuery
        ? sources.filter((source) =>
            [source.name, source.description]
              .some((value) => value.toLocaleLowerCase().includes(rawQuery)))
        : sources;
      const items = filtered
        .slice(0, request.limit ?? 200)
        .map(botRemoteCollectionItemFromSource);
      return {
        collectionId: TEAMMATES_REMOTE_COLLECTION_ID,
        revision: items.map((item) => item.revision).join('|'),
        items,
      };
    },
    async get(_context, request) {
      const [source] = visibleBotRemoteResourceSources([
        await getBotRemoteResourceSource(request.ref.id),
      ]);
      if (!source) {
        throw new RemoteResourceRegistryError('NOT_FOUND', 'remote resource does not exist');
      }
      return botRemoteResourceFromSource(source);
    },
  });
  registered = true;
}
