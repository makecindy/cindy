/**
 * Owner-scoped, non-secret settings for the WeCom channel.
 *
 * 与个人微信同构(见 wechat/channelSettings.ts):只持久化用户在 Main 原生
 * 目录选择器里选中的 override;目录缺失/不可访问时回退渠道托管目录。
 * 托管目录命名沿用 adapter 既定的 base64url 方案,存量目录保持稳定。
 * 用户目录上的 IO 全异步(shared/channelWorkingDirSettings 的 Main 线程纪律)。
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

export function readWecomChannelSettings(rootPath?: string): Promise<WecomChannelSettingsState> {
  return store.read(rootPath);
}

export function writeWecomWorkingDir(
  selectedPath: string,
  rootPath?: string,
): Promise<WecomChannelSettingsState> {
  return store.writeWorkingDir(selectedPath, rootPath);
}

/** 只校验/规整用户所选目录(异步探测用户盘), 不落盘 — 供 IPC 两段式提交。 */
export function normalizeWecomSelectedDirectory(selectedPath: string): Promise<string> {
  return store.normalizeSelectedDirectory(selectedPath);
}

/** 落盘已规整目录(只碰本地 userData)— 在 IM account generation 二次校验之后调用。 */
export function commitWecomWorkingDir(
  normalizedDir: string,
  rootPath?: string,
): Promise<WecomChannelSettingsState> {
  return store.commitWorkingDir(normalizedDir, rootPath);
}

export function resetWecomWorkingDir(rootPath?: string): Promise<WecomChannelSettingsState> {
  return store.resetWorkingDir(rootPath);
}

/** 稳定托管目录(同步, 本机盘)— 会话行兜底与归属比较用, 不读配置不探测。 */
export function ensureWecomManagedWorkingDir(botId: string, rootPath?: string): string {
  return store.ensureManagedWorkingDir(botId, rootPath);
}

/** 新对话实际目录(异步): 读配置 + 探测用户所选目录, 不可用回退托管目录。 */
export function resolveWecomWorkingDirForNewConversation(
  botId: string,
  rootPath?: string,
): Promise<string> {
  return store.resolveWorkingDirForNewConversation(botId, rootPath);
}
