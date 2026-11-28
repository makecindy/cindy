/**
 * 设置页「群聊」总表：列出个人 IM 机器人所在的群并保存按群设置（飞书、Telegram、Discord、钉钉、企业微信）。
 *
 * 名单 = 平台接口返回的机器人所在群（飞书 / Discord；读不到时退回本机）+ 本机群消息窗口记得的群
 * （Telegram / 钉钉 / 企业微信）+ 本机任务记录里机器人用过的群 + 已保存设置的群。`summary` 只给收起
 * 时的群数与头像用：不解析项目模型（那一步要列供应商、可能问另一台电脑）。
 *
 * 项目在两端之间只用不透明标记指代：列表给出侧栏项目的标记与名字，保存时按当前项目清单找回目录，
 * 清单里已经没有的标记按失败处理，不接受渲染端传来的路径。
 */

import {
  type ImChatListSource,
  type ImChatSettingsChannel,
  type ImChatSettingsList,
  type ImChatSettingsPatch,
  type ImChatSettingsView,
} from '../../../shared/imChatSettings.js';
import type { ImDefaultPermissionMode } from '../../../shared/imDefaultSettings.js';
import { normalizeWorkingDirForStorage } from '../../../shared/workingDir.js';
import { createLogger } from '../../logger.js';
import { listImProjectProviders, resolveImProjectRoute } from './chatOverrides.js';
import { imChatSource, locallyUsedImChats, type ImChatEntry } from './chatSources.js';
import {
  imChatMembersAllowed,
  listImChatSettings,
  writeImChatSettings,
  type ImChatSettingsUpdate,
  type StoredImChatSettings,
} from './chatSettingsStore.js';
import { listProjectsForControl } from './controlProjects.js';
import { ensureImChatMembersSeeded, resetImChatMemberStreak } from './guestGate.js';
import { imProjectAliasForDir, imProjectPermissionMode, syncImProjectWorkspaces } from './imProjectPorts.js';
import { readPersonalChannelChoice } from './personalChannelStore.js';
import { projectToken } from './projectToken.js';

const log = createLogger('im/chat-settings-service');

/** 应用缺少读取群信息的权限（飞书 tenant token 未开对应 scope）。 */
const PERMISSION_ERROR_CODES = new Set([99991672, 99991679]);

function isPermissionError(err: unknown): boolean {
  const e = err as { code?: unknown; httpStatus?: unknown };
  return (typeof e?.code === 'number' && PERMISSION_ERROR_CODES.has(e.code)) || e?.httpStatus === 403;
}

interface ProjectOption {
  token: string;
  name: string;
  dir: string;
  /** 「项目与模型」里这个项目的名字；对不上为 null。 */
  alias: string | null;
  permissionMode: ImDefaultPermissionMode | null;
}

type ProjectConfig = NonNullable<NonNullable<ImChatSettingsView['project']>['config']>;

async function projectOptions(): Promise<ProjectOption[]> {
  // 先按侧栏整理一次「项目与模型」的项目名表，名字才对得上。
  await syncImProjectWorkspaces();
  const projects = await listProjectsForControl({ projectsOnly: true, all: true });
  return projects.flatMap((project) => {
    const dir = normalizeWorkingDirForStorage(project.workingDir);
    if (!dir) return [];
    const alias = imProjectAliasForDir(dir);
    return [{
      token: projectToken(project.workingDir),
      name: project.displayName,
      dir,
      alias,
      permissionMode: alias ? imProjectPermissionMode(alias) : null,
    }];
  });
}

/**
 * 群选了的那些项目在「项目与模型」里此刻解析出的模型（供群跟随时显示）。只解析被选的项目，
 * 共用一次供应商目录：解析可能要问另一台电脑，不为没人用的项目发请求。
 */
async function projectConfigs(
  projects: readonly ProjectOption[],
  boundDirs: ReadonlySet<string>,
): Promise<Map<string, ProjectConfig>> {
  const bound = projects.filter((project) => project.alias && boundDirs.has(project.dir));
  if (bound.length === 0) return new Map();
  const providers = await listImProjectProviders();
  const entries = await Promise.all(
    bound.map(async (project): Promise<[string, ProjectConfig]> => [
      project.dir,
      { route: await resolveImProjectRoute(project.alias!, providers), permissionMode: project.permissionMode },
    ]),
  );
  return new Map(entries);
}

function viewOf(
  channel: ImChatSettingsChannel,
  botId: string,
  chat: ImChatEntry,
  stored: StoredImChatSettings | null,
  projects: ProjectOption[],
  configs: ReadonlyMap<string, ProjectConfig>,
): ImChatSettingsView {
  let project: ImChatSettingsView['project'] = null;
  if (stored?.projectDir) {
    const match = projects.find((option) => option.dir === stored.projectDir);
    // 已经不在侧栏的项目仍如实显示为「不可用」，不报出它的本机路径。
    project = match
      ? { token: match.token, name: match.name, available: true, config: configs.get(match.dir) ?? null }
      : {
          token: '',
          name: stored.projectDir.split('/').filter(Boolean).pop() ?? '',
          available: false,
          config: null,
        };
  }
  const members = imChatSource(channel)?.members?.get(chat.chatId) ?? imChatMembersAllowed(channel, botId, chat.chatId);
  return {
    chatId: chat.chatId,
    kind: chat.kind,
    name: chat.name ?? stored?.name ?? null,
    avatarUrl: chat.avatarUrl,
    project,
    route: stored?.route ?? null,
    permissionMode: stored?.permissionMode ?? null,
    members,
    membersPaused: members && stored?.membersPaused === true,
  };
}

function channelProjectOf(
  channel: ImChatSettingsChannel,
  projects: readonly ProjectOption[],
  configs: ReadonlyMap<string, ProjectConfig>,
): ImChatSettingsList['channelProject'] {
  const dir = readPersonalChannelChoice(channel).projectDir;
  if (!dir) return null;
  const match = projects.find((option) => option.dir === dir);
  return match
    ? { name: match.name, available: true, config: configs.get(match.dir) ?? null }
    : { name: dir.split('/').filter(Boolean).pop() ?? '', available: false, config: null };
}

/** 设置页列一个平台的群。 */
export async function listImChatSettingsForUi(
  channel: ImChatSettingsChannel,
  options: { refresh?: boolean; summary?: boolean } = {},
): Promise<ImChatSettingsList> {
  const projects = await projectOptions();
  const publicProjects = projects.map(({ token, name, permissionMode }) => ({ token, name, permissionMode }));
  const source = imChatSource(channel);
  const botId = source?.botId() ?? null;
  if (!source || !botId) {
    return {
      channel, connected: false, source: 'local', listError: null, chats: [], projects: publicProjects,
      channelProject: channelProjectOf(channel, projects, new Map()),
    };
  }
  // Telegram / 钉钉: 打开列表时顺带整理一次升级前用过的群(已整理过不再做)。
  await ensureImChatMembersSeeded(channel, botId);
  const connected = source.connected();
  let listSource: ImChatListSource = 'local';
  let listError: ImChatSettingsList['listError'] = null;
  const listed: ImChatEntry[] = [];
  if (connected && source.remote) {
    try {
      listed.push(...await source.remote(options.refresh === true));
      listSource = 'remote';
    } catch (err) {
      listError = isPermissionError(err) ? 'permission' : 'unavailable';
      log.warn(`${channel} chat list unavailable (${listError}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (listSource === 'local') {
    try {
      if (source.known) listed.push(...await source.known(botId));
    } catch (err) {
      log.warn(`${channel} known chats unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  try {
    listed.push(...await locallyUsedImChats(channel, botId));
  } catch (err) {
    log.warn(`${channel} local chat lookup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const stored = new Map(listImChatSettings(channel, botId).map((entry) => [entry.chatId, entry.settings]));
  const channelDir = readPersonalChannelChoice(channel).projectDir;
  const boundDirs = new Set([
    ...[...stored.values()].flatMap((settings) => (settings.projectDir ? [settings.projectDir] : [])),
    ...(channelDir ? [channelDir] : []),
  ]);
  const configs = options.summary ? new Map<string, ProjectConfig>() : await projectConfigs(projects, boundDirs);
  const chats: ImChatSettingsView[] = [];
  const seen = new Map<string, number>();
  const defaultKind = channel === 'discord' ? 'channel' as const : 'group' as const;
  for (const chat of listed) {
    const index = seen.get(chat.chatId);
    if (index !== undefined) {
      // 先来的(接口 / 窗口)优先; 后来的本机记录只补名字。
      if (!chats[index].name && chat.name) chats[index] = { ...chats[index], name: chat.name };
      continue;
    }
    seen.set(chat.chatId, chats.length);
    chats.push(viewOf(channel, botId, chat, stored.get(chat.chatId) ?? null, projects, configs));
  }
  // 已保存设置、但这次名单里没有的群（机器人被移出或接口没列出）也列出来，便于改回跟随。
  for (const [chatId, settings] of stored) {
    if (seen.has(chatId)) continue;
    chats.push(viewOf(channel, botId, { chatId, name: null, avatarUrl: null, kind: defaultKind }, settings, projects, configs));
  }
  return {
    channel, connected, source: listSource, listError, chats, projects: publicProjects,
    channelProject: channelProjectOf(channel, projects, configs),
  };
}

export class ImChatSettingsError extends Error {
  constructor(readonly reason: 'not-configured' | 'project-unavailable') {
    super(reason === 'not-configured' ? 'bot is not configured' : 'project is no longer available');
  }
}

/** 保存一个群的设置并返回它的新视图。`beforeWrite` 在真正写文件前由调用方插入账号边界复核。 */
export async function saveImChatSettings(
  channel: ImChatSettingsChannel,
  chatId: string,
  patch: ImChatSettingsPatch,
  name: string | null,
  beforeWrite: () => void = () => {},
): Promise<ImChatSettingsView> {
  const source = imChatSource(channel);
  const botId = source?.botId() ?? null;
  if (!botId) throw new ImChatSettingsError('not-configured');
  const projects = await projectOptions();
  const update: ImChatSettingsUpdate = {};
  if (patch.projectToken !== undefined) {
    if (patch.projectToken === null) update.projectDir = null;
    else {
      const project = projects.find((option) => option.token === patch.projectToken);
      if (!project) throw new ImChatSettingsError('project-unavailable');
      update.projectDir = project.dir;
    }
  }
  if (patch.route !== undefined) update.route = patch.route;
  if (patch.permissionMode !== undefined) update.permissionMode = patch.permissionMode;
  const platformMembers = patch.members !== undefined ? source?.members : undefined;
  if (patch.members !== undefined) {
    // 平台自己管准入的(Telegram)写平台那份; 设置文件里只清掉暂停。
    if (platformMembers) update.membersPaused = false;
    else update.members = patch.members;
  }
  beforeWrite();
  if (platformMembers && !platformMembers.set(chatId, patch.members!, name)) {
    throw new Error('IM_CHAT_MEMBERS_NOT_SAVED');
  }
  const saved = writeImChatSettings(channel, botId, chatId, update, name);
  if (patch.members !== undefined) resetImChatMemberStreak(channel, botId, chatId);
  const configs = await projectConfigs(projects, new Set(saved?.projectDir ? [saved.projectDir] : []));
  const kind = channel === 'discord' ? 'channel' as const : 'group' as const;
  return viewOf(channel, botId, { chatId, name, avatarUrl: source?.cachedAvatar?.(botId, chatId) ?? null, kind },
    saved ?? null, projects, configs);
}

/** 设置里点「恢复」：清零群成员的连续提问计数并解除暂停。 */
export async function resumeImChatMembers(
  channel: ImChatSettingsChannel,
  chatId: string,
  name: string | null,
  beforeWrite: () => void = () => {},
): Promise<ImChatSettingsView> {
  const source = imChatSource(channel);
  const botId = source?.botId() ?? null;
  if (!botId) throw new ImChatSettingsError('not-configured');
  beforeWrite();
  const saved = writeImChatSettings(channel, botId, chatId, { membersPaused: false }, name);
  resetImChatMemberStreak(channel, botId, chatId);
  const projects = await projectOptions();
  const configs = await projectConfigs(projects, new Set(saved?.projectDir ? [saved.projectDir] : []));
  const kind = channel === 'discord' ? 'channel' as const : 'group' as const;
  return viewOf(channel, botId, { chatId, name, avatarUrl: source?.cachedAvatar?.(botId, chatId) ?? null, kind },
    saved ?? null, projects, configs);
}
