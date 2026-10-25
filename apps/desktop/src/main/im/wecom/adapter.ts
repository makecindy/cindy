import fs from 'node:fs';
import { ownerScopedImUserDataPath } from '../ownerScopedStorage';
import { WECOM_PERSONAL_GROUP_WINDOW } from '../shared/channelGroupWindow';
import { createLogger } from '../../logger';
import { buildWecomAdapter as buildSharedAdapter } from '@cindy/im-runtime/channels/wecom/adapter';
export type { WecomAdapterOptions } from '@cindy/im-runtime/channels/wecom/adapter';
function ensureWorkingDir(botId: string): string {
  const safeBotId = Buffer.from(botId, 'utf8').toString('base64url').slice(0, 96);
  const dir = ownerScopedImUserDataPath('im-working-dir', `wecom-${safeBotId}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
export const buildWecomAdapter = (
  im: Parameters<typeof buildSharedAdapter>[0],
  interactions: Parameters<typeof buildSharedAdapter>[1],
  config: Parameters<typeof buildSharedAdapter>[2],
  options: Parameters<typeof buildSharedAdapter>[4] = {},
) => buildSharedAdapter(im, interactions, config, { ensureWorkingDir, window: WECOM_PERSONAL_GROUP_WINDOW, log: createLogger('im:wecom-adapter') }, options);
