/**
 * Owner-scoped, non-secret settings for the personal WeChat channel.
 *
 * A working directory can only enter this store after the user selected it in
 * a native directory picker. Missing/inaccessible saved directories fall back
 * to the channel-managed directory instead of breaking inbound messages.
 * 校验与原子保存的实现在 shared/channelWorkingDirSettings 工厂里,这里只注入
 * 微信的文件名、错误码前缀与托管目录命名(存量目录依赖命名保持稳定)。
 * 用户目录上的 IO 全异步(shared/channelWorkingDirSettings 的 Main 线程纪律)。
 */

import { createHash } from 'node:crypto';

import {
  createChannelWorkingDirStore,
  type ChannelUserDirProbeExecutor,
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

export function readWechatChannelSettings(rootPath?: string): Promise<WechatChannelSettingsState> {
  return store.read(rootPath);
}

/** 生产装配(im/index.ts): 用户目录探测切到 utility-process 执行边界。 */
export function configureWechatChannelProbeExecutor(executor: ChannelUserDirProbeExecutor): void {
  store.setProbeExecutor(executor);
}

export function writeWechatWorkingDir(
  selectedPath: string,
  rootPath?: string,
): Promise<WechatChannelSettingsState> {
  return store.writeWorkingDir(selectedPath, rootPath);
}

/** 只校验/规整用户所选目录(异步探测用户盘), 不落盘 — 供 IPC 两段式提交。 */
export function normalizeWechatSelectedDirectory(selectedPath: string): Promise<string> {
  return store.normalizeSelectedDirectory(selectedPath);
}

/** 落盘已规整目录(只碰本地 userData)— 在 IM account generation 二次校验之后调用。 */
export function commitWechatWorkingDir(
  normalizedDir: string,
  rootPath?: string,
): Promise<WechatChannelSettingsState> {
  return store.commitWorkingDir(normalizedDir, rootPath);
}

export function resetWechatWorkingDir(rootPath?: string): Promise<WechatChannelSettingsState> {
  return store.resetWorkingDir(rootPath);
}

/** 稳定托管目录(同步, 本机盘)— 会话行兜底与归属比较用, 不读配置不探测。 */
export function ensureWechatManagedWorkingDir(botId: string, rootPath?: string): string {
  return store.ensureManagedWorkingDir(botId, rootPath);
}

/** 新对话实际目录(异步): 读配置 + 探测用户所选目录, 不可用回退托管目录。 */
export function resolveWechatWorkingDirForNewConversation(
  botId: string,
  rootPath?: string,
): Promise<string> {
  return store.resolveWorkingDirForNewConversation(botId, rootPath);
}
