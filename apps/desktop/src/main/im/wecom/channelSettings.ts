/**
 * Owner-scoped, non-secret settings for the WeCom channel.
 *
 * 与个人微信同构(见 wechat/channelSettings.ts):只持久化用户在 Main 原生
 * 目录选择器里选中的 override;目录缺失/不可访问时回退渠道托管目录。
 * 托管目录命名沿用 adapter 既定的 base64url 方案,存量目录保持稳定。
 */

import {
  createChannelWorkingDirStore,
  type ChannelWorkingDirSettings,
  type ChannelWorkingDirSettingsState,
} from '../shared/channelWorkingDirSettings';

export type WecomChannelSettings = ChannelWorkingDirSettings;
export type WecomChannelSettingsState = ChannelWorkingDirSettingsState;

function managedWorkingDirName(botId: string): string {
  // 与旧 ensureWorkingDir 相同的编码:任意 botId 都映射进安全文件名字符集。
  const safeBotId = Buffer.from(botId, 'utf8').toString('base64url').slice(0, 96);
  return `wecom-${safeBotId}`;
}

const store = createChannelWorkingDirStore({
  logTag: 'im/wecom/channel-settings',
  fileName: 'wecom-channel.json',
  errorCodePrefix: 'WECOM',
  managedDirNameFor: managedWorkingDirName,
});

export function readWecomChannelSettings(rootPath?: string): WecomChannelSettingsState {
  return store.read(rootPath);
}

export function writeWecomWorkingDir(
  selectedPath: string,
  rootPath?: string,
): WecomChannelSettingsState {
  return store.writeWorkingDir(selectedPath, rootPath);
}

export function resetWecomWorkingDir(rootPath?: string): WecomChannelSettingsState {
  return store.resetWorkingDir(rootPath);
}

export function resolveWecomWorkingDir(botId: string, rootPath?: string): string {
  return store.resolveWorkingDir(botId, rootPath);
}
