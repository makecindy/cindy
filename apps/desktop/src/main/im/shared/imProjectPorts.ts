/**
 * 个人 IM 机器人用「项目与模型」(官方机器人与 IM 插件共用的按项目设置, hook-control)的端口。
 *
 * 两处消费:
 *   - 个人飞书的按群设置(feishu/groupOverrides.ts): 群绑定了项目 → 那个项目的一行;
 *   - 每个个人平台的默认项目(personalChannelStore 的 projectDir, 设置 → IM 机器人 → 某平台 →「项目」):
 *     新任务放进这个项目, 模型与权限跟随它在「项目与模型」里的那一行(2026-11-24 用户裁决: 跟项目走)。
 * 项目名表与解析都在 hook-control; 这里经端口取用(bootstrap 装配时接上), 不直接引用那边的模块,
 * 免得形成循环依赖。端口没接上时只换目录, 模型与权限仍按渠道设置。
 */

import fs from 'node:fs';

import type { ProviderView } from '@cindy/model-providers';

import { HOOK_CHAT_WORKSPACE_ALIAS } from '../../../shared/hookControlIpc.js';
import {
  isImDefaultAgentKind,
  isImDefaultEffort,
  isImDefaultPermissionMode,
  type ImDefaultAgentKind,
  type ImDefaultEffort,
  type ImDefaultPermissionMode,
} from '../../../shared/imDefaultSettings.js';
import { normalizeWorkingDirForStorage } from '../../../shared/workingDir.js';
import { createLogger, maskPath } from '../../logger.js';
import { getImDefaultEffortFor, type ResolvedImSessionDefaults } from '../defaultSessionSettings.js';
import { readImDefaultSettings } from '../defaultSettingsStore.js';
import { listProjectsForControl } from './controlProjects.js';
import { readPersonalChannelChoice, type PersonalChannel } from './personalChannelStore.js';
import type { ImLaneProjectDefaults } from './types.js';

const log = createLogger('im/project-ports');

/** 「项目与模型」那一行的解析结果(hook-control 的 resolveSharedImProjectConfig)。 */
export interface ImSharedProjectResolution {
  agentKind: string;
  model: string;
  effort?: string | null;
  providerId: string | null;
  agentDeviceId?: string | null;
  fingerprint: string;
}

export interface ImProjectPorts {
  /** 项目名 → 目录, 与官方机器人、插件用的是同一张表; 表还没建起来时为空。 */
  projectWorkspaces(): Readonly<Record<string, string>>;
  /** 按侧栏整理一次项目名表(建任务、打开设置页前调用)。 */
  syncProjectWorkspaces(): Promise<void>;
  /** 这一行设置的权限档; 没填返回 null。 */
  projectPermissionMode(alias: string): string | null;
  /** 这一行的默认设置指纹, 与 resolveProject 结果的 fingerprint 同一口径。 */
  projectFingerprint(alias: string): string;
  /** 按这一行解析新任务的路由; 模型不可用时抛错。 */
  resolveProject(alias: string, providers?: ProviderView[]): Promise<ImSharedProjectResolution>;
  /** 一次读取供应商目录, 供一次解析多个项目时共用。 */
  listProviders(): Promise<ProviderView[] | null>;
}

let ports: ImProjectPorts | null = null;

/** 装配时由 bootstrap 接上; 测试可传 null 复位。 */
export function setImProjectPorts(next: ImProjectPorts | null): void {
  ports = next;
}

export function getImProjectPorts(): ImProjectPorts | null {
  return ports;
}

/** 侧栏项目目录在「项目与模型」里的名字; 对不上(表还没建、端口没接)返回 null。 */
export function imProjectAliasForDir(dir: string): string | null {
  if (!ports) return null;
  const normalized = normalizeWorkingDirForStorage(dir);
  if (!normalized) return null;
  for (const [alias, directory] of Object.entries(ports.projectWorkspaces())) {
    if (alias === HOOK_CHAT_WORKSPACE_ALIAS) continue;
    if (normalizeWorkingDirForStorage(directory) === normalized) return alias;
  }
  return null;
}

/** 这一行的权限档: 没填按完全访问(同插件与官方机器人); 不认识的档位返回 null, 回到渠道设置。 */
export function imProjectPermissionMode(alias: string): ImDefaultPermissionMode | null {
  if (!ports) return null;
  const mode = ports.projectPermissionMode(alias) ?? 'bypassPermissions';
  return isImDefaultPermissionMode(mode) ? mode : null;
}

export interface ImProjectRoute {
  agentKind: ImDefaultAgentKind;
  model: string;
  providerId: string | null;
  agentDeviceId: string | null;
  effort: ImDefaultEffort;
}

/** 把「项目与模型」的解析结果换成新任务的路由; Agent 不认识时返回 null。 */
export function imProjectRouteOf(resolved: ImSharedProjectResolution): ImProjectRoute | null {
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

/** 设置页显示前整理一次项目名表; 失败只记日志, 按已有的表显示。 */
export async function syncImProjectWorkspaces(): Promise<void> {
  try {
    await ports?.syncProjectWorkspaces();
  } catch (err) {
    log.warn(`IM project names not refreshed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * 项目目录 → 这个项目在「项目与模型」里的设置(指纹、权限档、按需解析路由)。
 * `label` 进指纹前缀, 区分来源(按群 / 平台默认), 换来源时跟随记录会重新对齐。
 * `permission` 让调用方叠加自己的权限优先级(如飞书群单独设置的权限档)。
 */
export function imProjectDefaultsForDir(
  projectDir: string,
  label: string,
  permission: (projectPermissionMode: ImDefaultPermissionMode | null) => ImDefaultPermissionMode,
): ImLaneProjectDefaults | null {
  const bound = ports;
  if (!bound) return null;
  const alias = imProjectAliasForDir(projectDir);
  if (!alias) return null;
  const permissionMode = imProjectPermissionMode(alias);
  return {
    fingerprint: `${label}:${bound.projectFingerprint(alias)}`,
    permissionMode,
    async resolve(providerSnapshot): Promise<ResolvedImSessionDefaults> {
      const resolved = await bound.resolveProject(alias, providerSnapshot ?? undefined);
      const route = imProjectRouteOf(resolved);
      if (!route) throw new Error('The selected project model is unavailable');
      return {
        ...route,
        permissionMode: permission(permissionMode),
        fastMode: false,
        fingerprint: `${label}:${resolved.fingerprint}`,
      };
    },
  };
}

/**
 * 一个项目目录是否仍是侧栏里的本机项目、目录也还在; 是则返回规范目录, 否则 null(任务落回
 * 机器人的对话目录, 不按一个已经移除的路径去执行)。顺带整理一次项目名表。
 */
export async function liveImProjectDir(projectDir: string, context: string): Promise<string | null> {
  const projects = await listProjectsForControl({ projectsOnly: true, all: true });
  const project = projects.find((p) => normalizeWorkingDirForStorage(p.workingDir) === projectDir);
  if (!project) {
    log.warn(`${context}: project is no longer a sidebar project; using the bot dialogue dir`);
    return null;
  }
  try {
    if (!fs.statSync(project.workingDir).isDirectory()) throw new Error('not a directory');
  } catch {
    log.warn(`${context}: project folder missing; using the bot dialogue dir dir=${maskPath(project.workingDir)}`);
    return null;
  }
  await syncImProjectWorkspaces();
  return project.workingDir;
}

/** 平台默认项目的目录(新任务与 `/new` 时取); 没选返回 undefined, 选了但已不可用返回 null。 */
export async function personalChannelProjectDir(channel: PersonalChannel): Promise<string | null | undefined> {
  const projectDir = readPersonalChannelChoice(channel).projectDir;
  if (!projectDir) return undefined;
  return liveImProjectDir(projectDir, `${channel} default project`);
}

/**
 * 任务所在目录正是平台默认项目时, 这个项目在「项目与模型」里的设置; 其它目录(对话目录、
 * 用 `/project` 切进的别的项目)返回 null, 仍按渠道设置。
 */
export function personalChannelProjectDefaults(channel: PersonalChannel, workingDir: string): ImLaneProjectDefaults | null {
  const projectDir = readPersonalChannelChoice(channel).projectDir;
  if (!projectDir || normalizeWorkingDirForStorage(workingDir) !== projectDir) return null;
  // 项目那一行没给出可用的权限档时回到渠道私聊的权限档, 不按更宽的档位跑。
  return imProjectDefaultsForDir(projectDir, `${channel}-channel-project`,
    (mode) => mode ?? readImDefaultSettings(channel).permissionMode);
}
