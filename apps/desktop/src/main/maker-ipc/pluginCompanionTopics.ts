import { getCurrentDbClientSnapshot } from '../localDb/client/current.js';
import { ensureBotChannelLaneSession, findBotChannelLaneSession } from '../localDb/ipc/bots.js';
import { createPluginTargetStore } from './pluginTargetStore.js';
import { noteSessionHidden } from '../localDb/sessionFlagRegistry.js';

/** Called under the existing plugin receipt write queue, including read-only validation. */
export async function resolvePluginCompanionTopic(
  pluginId: string,
  botId: string,
  topicKey: string,
  options: { create: boolean; title?: string; assertCurrent: () => void },
): Promise<string> {
  const owner = getCurrentDbClientSnapshot();
  if (!owner) throw Object.assign(new Error('HOST_NOT_READY'), { code: 'HOST_NOT_READY' });
  const guard = () => {
    options.assertCurrent();
    if (getCurrentDbClientSnapshot() !== owner)
      throw Object.assign(new Error('PERMISSION_DENIED'), { code: 'PERMISSION_DENIED' });
  };
  guard();
  const routeKey = await createPluginTargetStore(owner.client, guard)
    .topicRoute(pluginId, botId, topicKey, options.create);
  if (!routeKey) throw Object.assign(new Error('TARGET_UNAVAILABLE'), { code: 'TARGET_UNAVAILABLE' });
  if (!options.create) {
    const sessionId = await findBotChannelLaneSession(botId, routeKey);
    guard();
    if (!sessionId) throw Object.assign(new Error('TARGET_UNAVAILABLE'), { code: 'TARGET_UNAVAILABLE' });
    return sessionId;
  }
  guard();
  const result = await ensureBotChannelLaneSession({ botId, routeKey, title: options.title || topicKey });
  guard();
  if (!result.ok) throw Object.assign(new Error(result.message), { code: result.errorCode });
  if (result.created) noteSessionHidden(result.sessionId, true, owner.client);
  return result.sessionId;
}
