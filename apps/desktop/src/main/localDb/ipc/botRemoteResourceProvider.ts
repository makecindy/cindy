import { captureDataOwnerBroadcastScope, isDataOwnerBroadcastScopeCurrent } from '../../device-link/broadcast-tap.js';
import {
  getBotRemoteResourceSource,
  listBotRemoteResourceSources,
} from './bots.js';
import { RemoteResourceRegistryError, remoteResourceRegistry } from '../../device-link/remoteResourceRegistry.js';
import { getBotRemoteMessageService } from '../../maker-ipc/botRemoteMessageReceiver.js';
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
      return { ...botRemoteResourceFromSource(source), teammateMessaging: { version: 1, available: source.status === 'active' } };
    },
    async invoke(context, request) {
      const scope = captureDataOwnerBroadcastScope();
      if (request.actionId !== 'send-message' && request.actionId !== 'verify-message' && request.actionId !== 'message-receipt') {
        throw new RemoteResourceRegistryError('UNSUPPORTED_CAPABILITY', 'Unknown teammate action');
      }
      const input = request.input;
      const validBotId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
      const validMessageId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);
      if (!validBotId(request.resourceRef?.id) || !validBotId(request.actionId === 'verify-message' ? input?.targetBotId : input?.senderBotId) || !validMessageId(input?.messageId)
        || (request.actionId !== 'message-receipt' && (typeof input?.message !== 'string' || !input.message.trim() || input.message.length > 12_000))) {
        throw new RemoteResourceRegistryError('NOT_FOUND', 'Invalid teammate message');
      }
      const [source] = visibleBotRemoteResourceSources([await getBotRemoteResourceSource(request.resourceRef.id)]);
      if (!source) throw new RemoteResourceRegistryError('NOT_FOUND', 'remote resource does not exist');
      if (!isDataOwnerBroadcastScopeCurrent(scope)) throw new RemoteResourceRegistryError('NOT_FOUND', 'Account changed');
      const service = getBotRemoteMessageService();
      if (!service) throw new RemoteResourceRegistryError('UNSUPPORTED_CAPABILITY', 'Teammate messaging is unavailable');
      if (request.actionId === 'message-receipt') {
        const receipt = await service.readRemoteReceipt({ controllerDeviceId: context.controllerDeviceId,
          senderBotId: input.senderBotId as string, targetBotId: request.resourceRef.id,
          messageId: input.messageId });
        return { effects: [], ...receipt };
      }
      if (request.actionId === 'verify-message') {
        const verified = await service.verifyRemoteMessage({ controllerDeviceId: context.controllerDeviceId,
          senderBotId: request.resourceRef.id, targetBotId: input.targetBotId as string,
          messageId: input.messageId, message: input.message as string });
        return { effects: [], verified };
      }
      const teammateMessage = await service.receiveRemote({
        controllerDeviceId: context.controllerDeviceId,
        senderBotId: input.senderBotId as string, targetBotId: request.resourceRef.id,
        messageId: input.messageId, message: input.message as string,
      });
      return { effects: [], teammateMessage };
    },
  });
  registered = true;
}
