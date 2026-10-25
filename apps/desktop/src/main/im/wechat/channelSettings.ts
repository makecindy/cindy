import { createWechatChannelSettings } from '@cindy/app-runtime/wechatChannelSettings';
import { createLogger, maskPath } from '../../logger';
import { ownerScopedImUserDataPath } from '../ownerScopedStorage';
export type { WechatChannelSettings, WechatChannelSettingsState } from '@cindy/app-runtime/wechatChannelSettings';
export const { readWechatChannelSettings, writeWechatWorkingDir, resetWechatWorkingDir, writeWechatCompanionBinding, resolveWechatWorkingDir, __testing }=createWechatChannelSettings({ownerScopedImUserDataPath,maskPath:file=>maskPath(file),log:createLogger('im/wechat/channel-settings')});
