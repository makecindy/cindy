import { createHash } from 'node:crypto';
import { ownerScopedImUserDataPath } from '../ownerScopedStorage';
import { createOverrideSettingsFile } from '../../maker-host/override-settings-file';
import { createLogger } from '../../logger';

interface SteeringRoute { connectionId: string; botId: string; chatSha256: string }

const settings = createOverrideSettingsFile<{ routes: SteeringRoute[] }>({
  filePath: () => ownerScopedImUserDataPath('imessage', 'steering.json'),
  defaults: () => ({ routes: [] }),
  normalize: raw => {
    const routes = (raw as { routes?: unknown }).routes;
    return { routes: Array.isArray(routes) ? routes.filter(route =>
      route && typeof route.connectionId === 'string' && typeof route.botId === 'string' &&
      typeof route.chatSha256 === 'string' && /^[0-9a-f]{64}$/.test(route.chatSha256)) : [] };
  },
  log: createLogger('im:imessage'),
  label: 'imessage-steering',
  maxBytes: 64 * 1024,
  preserveUnreadableFile: true,
  logLoadedValue: false,
  logReadErrorDetails: false,
});

export function isIMessageSteeringEnabled(connectionId: string, botId: string, chatId: string): boolean {
  settings.invalidateIfChanged();
  const chatSha256 = createHash('sha256').update(chatId, 'utf8').digest('hex');
  return settings.read().routes.some(route =>
    route.connectionId === connectionId && route.botId === botId && route.chatSha256 === chatSha256);
}
