/**
 * Owner-scoped, non-secret settings for the personal WeChat channel.
 *
 * A working directory can only enter this store after the user selected it in
 * a native directory picker. Missing/inaccessible saved directories fall back
 * to the channel-managed directory instead of breaking inbound messages.
 * 校验与原子保存的实现在 shared/channelWorkingDirSettings 工厂里,这里只注入
 * 微信的文件名、错误码前缀与托管目录命名(存量目录依赖命名保持稳定)。
 */

import { createHash } from 'node:crypto';

import {
  createChannelWorkingDirStore,
  type ChannelWorkingDirSettings,
  type ChannelWorkingDirSettingsState,
} from '../shared/channelWorkingDirSettings';

export type WechatChannelSettings = ChannelWorkingDirSettings;
export type WechatChannelSettingsState = ChannelWorkingDirSettingsState;

function managedWorkingDirName(botId: string): string {
  if (/^[A-Za-z0-9_-]{1,128}$/.test(botId)) return `wechat-${botId}`;
  const digest = createHash('sha256').update(botId).digest('hex').slice(0, 24);
  return `wechat-external-${digest}`;
}

const store = createChannelWorkingDirStore({
  logTag: 'im/wechat/channel-settings',
  fileName: 'wechat-channel.json',
  errorCodePrefix: 'WECHAT',
  managedDirNameFor: managedWorkingDirName,
});

export function readWechatChannelSettings(rootPath?: string): WechatChannelSettingsState {
  return store.read(rootPath);
}

export function writeWechatWorkingDir(
  selectedPath: string,
  rootPath?: string,
): WechatChannelSettingsState {
  return store.writeWorkingDir(selectedPath, rootPath);
}

export function resetWechatWorkingDir(rootPath?: string): WechatChannelSettingsState {
  return store.resetWorkingDir(rootPath);
}

export function resolveWechatWorkingDir(botId: string, rootPath?: string): string {
  return store.resolveWorkingDir(botId, rootPath);
}
