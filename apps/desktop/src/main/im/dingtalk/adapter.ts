import fs from 'node:fs';
import { ownerScopedImUserDataPath } from '../ownerScopedStorage';
import { DINGTALK_PERSONAL_GROUP_WINDOW } from '../shared/channelGroupWindow';
import { createLogger } from '../../logger';
import { buildDingTalkAdapter as buildSharedAdapter, dingtalkManagedWorkingDirName } from '@cindy/im-runtime/channels/dingtalk/adapter';
export { dingtalkManagedWorkingDirName, dingtalkSessionIdFor } from '@cindy/im-runtime/channels/dingtalk/adapter';
export type { DingTalkAdapterOptions } from '@cindy/im-runtime/channels/dingtalk/adapter';
function ensureWorkingDir(appKey: string): string {
  const dir = ownerScopedImUserDataPath('im-working-dir', dingtalkManagedWorkingDirName(appKey));
  fs.mkdirSync(dir, { recursive: true }); return dir;
}
export const buildDingTalkAdapter = (
  im: Parameters<typeof buildSharedAdapter>[0],
  config: Parameters<typeof buildSharedAdapter>[1],
  options: Parameters<typeof buildSharedAdapter>[3] = {},
) => buildSharedAdapter(im, config, { ensureWorkingDir, window: DINGTALK_PERSONAL_GROUP_WINDOW, log: createLogger('im:dingtalk-adapter') }, options);
