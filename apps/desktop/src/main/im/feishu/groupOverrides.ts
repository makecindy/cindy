/**
 * 个人飞书 / Lark 机器人按群设置在建任务时的解析。
 *
 * 只在设置页那份个人机器人的 adapter 上接线（伙伴连接不接）。群主线与话题 lane 都按所属的群取设置；
 * 私聊（路由键不是群 lane）一律返回 null，走渠道设置。
 *
 * 一个群新任务的设置按这个顺序取（2026-11-23 用户裁决）：
 *   - 模型（含推理强度、来源、执行位置）：群单独设置的 > 群绑定项目在「项目与模型」里的那一行
 *     > 渠道「新对话配置」。只有没绑项目、留在对话目录里的群才用「新对话配置」。
 *   - 权限：群单独设置的 > 绑定项目的那一行（没填按完全访问，同插件与官方机器人）
 *     > 渠道「群聊新建任务权限档」。设置页在绑定项目会让权限变宽时先确认。
 * 「项目与模型」是官方机器人与 IM 插件共用的那一份，项目名表与解析都在 hook-control；这里经
 * 端口取用（装配时由 bootstrap 接上），不直接引用那边的模块，免得形成循环依赖。端口没接上时
 * 绑定项目的群只换目录，模型与权限仍按渠道设置。
 */

import fs from 'node:fs';

import { decodeFeishuLaneUserId } from '@cindy/im';
import type { PermissionMode } from '@cindy/maker-core';
import type { ProviderView } from '@cindy/model-providers';

import type { FeishuGroupRoute } from '../../../shared/feishuGroupSettings.js';
import { HOOK_CHAT_WORKSPACE_ALIAS } from '../../../shared/hookControlIpc.js';
import {
  isImDefaultAgentKind,
  isImDefaultEffort,
  isImDefaultPermissionMode,
  type ImDefaultEffort,
  type ImDefaultPermissionMode,
} from '../../../shared/imDefaultSettings.js';
import { normalizeWorkingDirForStorage } from '../../../shared/workingDir.js';
import { createLogger, maskPath } from '../../logger.js';
import { getImDefaultEffortFor, type ResolvedImSessionDefaults } from '../defaultSessionSettings.js';
import { readImDefaultSettings } from '../defaultSettingsStore.js';
import { listProjectsForControl } from '../shared/controlProjects.js';
import type { ImLaneProjectDefaults, ImLaneRouteOverride } from '../shared/types.js';
import { readFeishuGroupSettings } from './groupSettingsStore.js';

const log = createLogger('im/feishu/group-overrides');

/** 「项目与模型」那一行的解析结果（hook-control 的 resolveSharedImProjectConfig）。 */
export interface FeishuSharedProjectResolution {
  agentKind: string;
  model: string;
  effort?: string | null;
  providerId: string | null;
  agentDeviceId?: string | null;
  fingerprint: string;
}

export interface FeishuGroupProjectPorts {
  /** 项目名 → 目录，与官方机器人、插件用的是同一张表；表还没建起来时为空。 */
  projectWorkspaces(): Readonly<Record<string, string>>;
  /** 按侧栏整理一次项目名表（建任务、打开设置页前调用）。 */
  syncProjectWorkspaces(): Promise<void>;
  /** 这一行设置的权限档；没填返回 null。 */
  projectPermissionMode(alias: string): string | null;
  /** 这一行的默认设置指纹，与 resolveProject 结果的 fingerprint 同一口径。 */
  projectFingerprint(alias: string): string;
  /** 按这一行解析新任务的路由；模型不可用时抛错。 */
  resolveProject(alias: string, providers?: ProviderView[]): Promise<FeishuSharedProjectResolution>;
  /** 一次读取供应商目录，供一次解析多个项目时共用。 */
  listProviders(): Promise<ProviderView[] | null>;
}

let ports: FeishuGroupProjectPorts | null = null;

/** 装配时由 bootstrap 接上；测试可传 null 复位。 */
export function setFeishuGroupProjectPorts(next: FeishuGroupProjectPorts | null): void {
  ports = next;
}

/** 群 / 话题 lane 所属的群 ID；私聊返回 null。 */
export function feishuGroupChatIdOf(userId: string): string | null {
  return decodeFeishuLaneUserId(userId)?.chatId ?? null;
}

/** 这个群固定的模型路由；没设置或不是群返回 null。 */
export function feishuGroupRouteOverride(botAppId: string, userId: string): ImLaneRouteOverride | null {
  const chatId = feishuGroupChatIdOf(userId);
  return chatId ? readFeishuGroupSettings(botAppId, chatId)?.route ?? null : null;
}

/**
 * 群里新建任务的权限档：这个群单独设置的 > 绑定项目的（`projectPermissionMode`，任务确实落在那个
 * 项目里时由调用方传入）> 渠道的「群聊新建任务权限档」。群 ID 用于 `/ctr` 这类只拿得到 chat_id 的入口。
 */
export function feishuGroupPermissionMode(
  botAppId: string | null,
  chatId: string | null,
  projectPermissionMode: PermissionMode | null = null,
): PermissionMode {
  const override = botAppId && chatId ? readFeishuGroupSettings(botAppId, chatId)?.permissionMode : null;
  return override ?? projectPermissionMode ?? readImDefaultSettings('feishu').groupPermissionMode;
}

/** 侧栏项目目录在「项目与模型」里的名字；对不上（表还没建、端口没接）返回 null。 */
export function feishuProjectAliasForDir(dir: string): string | null {
  if (!ports) return null;
  const normalized = normalizeWorkingDirForStorage(dir);
  if (!normalized) return null;
  for (const [alias, directory] of Object.entries(ports.projectWorkspaces())) {
    if (alias === HOOK_CHAT_WORKSPACE_ALIAS) continue;
    if (normalizeWorkingDirForStorage(directory) === normalized) return alias;
  }
  return null;
}

/** 这一行的权限档：没填按完全访问（同插件与官方机器人）；不认识的档位返回 null，回到渠道设置。 */
export function feishuProjectPermissionMode(alias: string): ImDefaultPermissionMode | null {
  if (!ports) return null;
  const mode = ports.projectPermissionMode(alias) ?? 'bypassPermissions';
  return isImDefaultPermissionMode(mode) ? mode : null;
}

/** 把「项目与模型」的解析结果换成群设置用的路由；Agent 不认识时返回 null。 */
function routeOf(resolved: FeishuSharedProjectResolution): FeishuGroupRoute | null {
  if (!isImDefaultAgentKind(resolved.agentKind) || !resolved.model) return null;
  // 那一行没给推理强度时才按模型的默认强度补上。
  let effort: ImDefaultEffort = 'high';
  if (isImDefaultEffort(resolved.effort)) effort = resolved.effort;
  else {
    const fallback = getImDefaultEffortFor(resolved.agentKind, resolved.model);
    if (isImDefaultEffort(fallback)) effort = fallback;
  }
  return {
    agentKind: resolved.agentKind,
    model: resolved.model,
    providerId: resolved.providerId,
    agentDeviceId: resolved.agentDeviceId ?? null,
    effort,
  };
}

/** 设置页显示用：这个项目此刻解析出的模型路由；模型不可用时为 null。 */
export async function resolveFeishuProjectRoute(
  alias: string,
  providers?: ProviderView[] | null,
): Promise<FeishuGroupRoute | null> {
  if (!ports) return null;
  try {
    return routeOf(await ports.resolveProject(alias, providers ?? undefined));
  } catch (err) {
    log.warn(`group project route unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** 设置页显示前整理一次项目名表；失败只记日志，按已有的表显示。 */
export async function syncFeishuProjectWorkspaces(): Promise<void> {
  try {
    await ports?.syncProjectWorkspaces();
  } catch (err) {
    log.warn(`IM project names not refreshed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function listFeishuProjectProviders(): Promise<ProviderView[] | null> {
  try {
    return (await ports?.listProviders()) ?? null;
  } catch {
    return null;
  }
}

/**
 * 群任务所在目录正是群绑定的项目时，这个项目在「项目与模型」里的设置。还留在对话目录（或别的
 * 目录）里的任务返回 null，仍跟随渠道设置，直到 `/new` 把它挪进项目。
 */
export function feishuGroupProjectDefaults(
  botAppId: string,
  userId: string,
  workingDir: string,
): ImLaneProjectDefaults | null {
  const bound = ports;
  if (!bound) return null;
  const chatId = feishuGroupChatIdOf(userId);
  if (!chatId) return null;
  const projectDir = readFeishuGroupSettings(botAppId, chatId)?.projectDir;
  if (!projectDir || normalizeWorkingDirForStorage(workingDir) !== projectDir) return null;
  const alias = feishuProjectAliasForDir(projectDir);
  if (!alias) return null;
  const permissionMode = feishuProjectPermissionMode(alias);
  return {
    fingerprint: `feishu-group-project:${bound.projectFingerprint(alias)}`,
    permissionMode,
    async resolve(providerSnapshot): Promise<ResolvedImSessionDefaults> {
      const resolved = await bound.resolveProject(alias, providerSnapshot ?? undefined);
      const route = routeOf(resolved);
      if (!route) throw new Error('The selected project model is unavailable');
      return {
        ...route,
        permissionMode: feishuGroupPermissionMode(botAppId, chatId, permissionMode),
        fastMode: false,
        fingerprint: `feishu-group-project:${resolved.fingerprint}`,
      };
    },
  };
}

/**
 * 这个群设置的项目目录。项目必须仍在侧栏的本机项目里、目录也还在，否则返回 null
 * （任务落回机器人的对话目录），不按一个已经移除的路径去执行。顺带整理一次项目名表，
 * 让随后按项目取设置时用的是最新的名字。
 */
export async function feishuGroupWorkingDir(botAppId: string, userId: string): Promise<string | null> {
  const chatId = feishuGroupChatIdOf(userId);
  if (!chatId) return null;
  const projectDir = readFeishuGroupSettings(botAppId, chatId)?.projectDir;
  if (!projectDir) return null;
  const projects = await listProjectsForControl({ projectsOnly: true, all: true });
  const project = projects.find((p) => normalizeWorkingDirForStorage(p.workingDir) === projectDir);
  if (!project) {
    log.warn(`group project is no longer a sidebar project; using the bot dialogue dir chat=...${chatId.slice(-6)}`);
    return null;
  }
  try {
    if (!fs.statSync(project.workingDir).isDirectory()) throw new Error('not a directory');
  } catch {
    log.warn(`group project folder missing; using the bot dialogue dir dir=${maskPath(project.workingDir)}`);
    return null;
  }
  await syncFeishuProjectWorkspaces();
  return project.workingDir;
}
