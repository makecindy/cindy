/**
 * 个人 IM 机器人「群聊」总表在建任务时的解析（飞书、Telegram、Discord、钉钉、企业微信同一份）。
 *
 * 只在设置页那份个人机器人上接线（伙伴连接与交给伙伴回复时不读）。群主线与话题 lane 都按所属的群取
 * 设置；私聊（路由键不是群 lane）一律返回 null，走渠道设置。
 *
 * 一个群新任务的设置按这个顺序取（2026-11-23 用户裁决，2026-11-24 推广到各平台）：
 *   - 项目：群单独选的 > 机器人自己的「项目」> 对话目录。
 *   - 模型（含推理强度、来源、执行位置）：群单独设置的 > 群所在项目在「项目与模型」里的那一行
 *     > 渠道「新对话配置」。
 *   - 权限：群单独设置的 > 所在项目的那一行（没填按完全访问，同插件与官方机器人）> 渠道设置。
 * 「项目与模型」的项目名表与解析经 `imProjectPorts` 取用（装配时由 bootstrap 接上）。
 */

import type { PermissionMode } from '@cindy/maker-core';
import type { ProviderView } from '@cindy/model-providers';

import type { ImChatRoute, ImChatSettingsChannel } from '../../../shared/imChatSettings.js';
import { normalizeWorkingDirForStorage } from '../../../shared/workingDir.js';
import { createLogger } from '../../logger.js';
import { readImDefaultSettings } from '../defaultSettingsStore.js';
import { imChatIdOfLane } from './chatLanes.js';
import { readImChatSettings } from './chatSettingsStore.js';
import {
  getImProjectPorts,
  imProjectDefaultsForDir,
  imProjectRouteOf,
  liveImProjectDir,
} from './imProjectPorts.js';
import type { ImLaneProjectDefaults, ImLaneRouteOverride, ImSessionNamespace } from './types.js';

const log = createLogger('im/chat-overrides');

/** 这个群固定的模型路由；没设置或不是群返回 null。 */
export function imChatRouteOverride(
  channel: ImChatSettingsChannel,
  botId: string,
  userId: string,
): ImLaneRouteOverride | null {
  const chatId = imChatIdOfLane(channel, userId);
  return chatId ? readImChatSettings(channel, botId, chatId)?.route ?? null : null;
}

/**
 * 群里新建任务的权限档：这个群单独设置的 > 所在项目的（`projectPermissionMode`，任务确实落在那个
 * 项目里时由调用方传入）> 渠道的。飞书的渠道档是「群聊新建任务权限档」；其他平台没有单独的群档，
 * 返回 null 交回渠道默认。群 ID 用于 `/ctr` 这类只拿得到 chat_id 的入口。
 */
export function imChatPermissionMode(
  channel: ImChatSettingsChannel,
  botId: string | null,
  chatId: string | null,
  projectPermissionMode: PermissionMode | null = null,
): PermissionMode | null {
  const override = botId && chatId ? readImChatSettings(channel, botId, chatId)?.permissionMode : null;
  return override ?? projectPermissionMode ?? (channel === 'feishu' ? readImDefaultSettings('feishu').groupPermissionMode : null);
}

/** 设置页显示用：这个项目此刻解析出的模型路由；模型不可用时为 null。 */
export async function resolveImProjectRoute(alias: string, providers?: ProviderView[] | null): Promise<ImChatRoute | null> {
  const ports = getImProjectPorts();
  if (!ports) return null;
  try {
    return imProjectRouteOf(await ports.resolveProject(alias, providers ?? undefined, { dryRun: true }));
  } catch (err) {
    log.warn(`chat project route unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export async function listImProjectProviders(): Promise<ProviderView[] | null> {
  try {
    return (await getImProjectPorts()?.listProviders()) ?? null;
  } catch {
    return null;
  }
}

/**
 * 群任务所在目录正是群选的项目时，这个项目在「项目与模型」里的设置。还留在别的目录里的任务返回
 * null（交给机器人自己的「项目」或渠道设置），直到 `/new` 把它挪进项目。
 */
export function imChatProjectDefaults(
  channel: ImChatSettingsChannel,
  botId: string,
  userId: string,
  workingDir: string,
): ImLaneProjectDefaults | null {
  const chatId = imChatIdOfLane(channel, userId);
  if (!chatId) return null;
  const projectDir = readImChatSettings(channel, botId, chatId)?.projectDir;
  if (!projectDir || normalizeWorkingDirForStorage(workingDir) !== projectDir) return null;
  // 群和项目都没给出可用的档位时回到渠道私聊的权限档, 不按更宽的档位跑。
  return imProjectDefaultsForDir(projectDir, `${channel}-group-project`,
    (mode) => readImChatSettings(channel, botId, chatId)?.permissionMode ?? mode
      ?? (channel === 'feishu' ? readImDefaultSettings('feishu').groupPermissionMode : readImDefaultSettings(channel).permissionMode));
}

/**
 * 这个群选的项目目录。项目必须仍在侧栏的本机项目里、目录也还在，否则返回 null（任务落回对话目录），
 * 不按一个已经移除的路径去执行。不是群返回 undefined；群没单独选项目返回 null（机器人自己的「项目」
 * 由 orchestrator 的包装在此之上补上）。
 */
export async function imChatWorkingDir(
  channel: ImChatSettingsChannel,
  botId: string,
  userId: string,
): Promise<string | null | undefined> {
  const chatId = imChatIdOfLane(channel, userId);
  if (!chatId) return undefined;
  const projectDir = readImChatSettings(channel, botId, chatId)?.projectDir;
  if (!projectDir) return null;
  return liveImProjectDir(projectDir, `${channel} group ...${chatId.slice(-6)}`);
}

/**
 * 给没有自己按群钩子的渠道（Telegram、Discord、钉钉、企业微信）接上「群聊」总表。渠道自己实现了的钩子
 * （飞书）不动；`isCompanion()` 为真（交给伙伴回复）时一律不读，任务归伙伴管。
 */
export function withImChatOverrides(
  channel: ImChatSettingsChannel,
  ns: ImSessionNamespace,
  isCompanion: () => boolean,
): ImSessionNamespace {
  if (ns.routeOverrideFor || ns.laneWorkingDirFor || ns.laneProjectDefaultsFor) return ns;
  const ownPermission = ns.permissionModeFor?.bind(ns);
  const wrapped = Object.create(ns) as ImSessionNamespace;
  wrapped.routeOverrideFor = (botId, userId) => (isCompanion() ? null : imChatRouteOverride(channel, botId, userId));
  wrapped.laneWorkingDirFor = async (botId, userId) =>
    (isCompanion() ? undefined : imChatWorkingDir(channel, botId, userId));
  wrapped.laneProjectDefaultsFor = (botId, userId, workingDir) =>
    (isCompanion() ? null : imChatProjectDefaults(channel, botId, userId, workingDir));
  wrapped.permissionModeFor = (userId, projectPermissionMode, botId) => {
    const own = ownPermission?.(userId, projectPermissionMode, botId) ?? null;
    if (isCompanion() || !botId) return own;
    const chatId = imChatIdOfLane(channel, userId);
    if (!chatId) return own;
    // 群单独设置的权限盖过渠道钩子; 没设就照旧(项目档由 sessionRepo 的项目默认套用)。
    return readImChatSettings(channel, botId, chatId)?.permissionMode ?? own;
  };
  return wrapped;
}
