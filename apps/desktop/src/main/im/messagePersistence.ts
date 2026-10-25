import { createImMessagePersistence } from '@cindy/app-runtime/imMessagePersistence';
import { createMessage, patchMessageAgentMeta, broadcastMessageAgentMetaUpdate } from '../localDb/ipc/messages';
import { enqueueDurableWrite } from '../messagePersistBroadcaster';
import { createLogger } from '../logger';
export { buildPersistedUserContent } from '@cindy/app-runtime/imMessagePersistence';
export const { persistUserMessage } = createImMessagePersistence({
  createMessage: (...args) => createMessage(...args),
  patchMessageAgentMeta: (...args) => patchMessageAgentMeta(...args),
  broadcastMessageAgentMetaUpdate: (...args) => broadcastMessageAgentMetaUpdate(...args),
  enqueueDurableWrite: (...args) => enqueueDurableWrite(...args),
  logger: createLogger('im:msg-persist'),
});
