/**
 * 设置页「群聊」：列出个人飞书 / Lark 机器人所在的群并保存按群设置。
 *
 * 群名单向飞书接口「获取用户或机器人所在的群列表」读取：只在设置页打开这块时读，同一机器人
 * 30 秒内复用上一次结果、并发打开共用一次请求，不轮询、不重试。读不到（缺权限或网络）时退回
 * 机器人用过的群（本机任务记录）与已保存设置的群。
 *
 * 项目在两端之间只用不透明标记指代：列表给出侧栏项目的标记与名字，保存时按当前项目清单找回
 * 目录，清单里已经没有的标记按失败处理，不接受渲染端传来的路径。
 */

import { and, eq, like } from 'drizzle-orm';
import type { FeishuIM } from '@cindy/im';

import type { ImDefaultPermissionMode } from '../../../shared/imDefaultSettings.js';
import {
  safeFeishuAvatarUrl,
  type FeishuGroupListSource,
  type FeishuGroupSettingsList,
  type FeishuGroupSettingsPatch,
  type FeishuGroupSettingsView,
} from '../../../shared/feishuGroupSettings.js';
import { normalizeWorkingDirForStorage } from '../../../shared/workingDir.js';
import { getDbClient } from '../../localDb/client/current.js';
import { sessions } from '../../localDb/schema.js';
import { createLogger } from '../../logger.js';
import { listProjectsForControl } from '../shared/controlProjects.js';
import { projectToken } from '../shared/projectToken.js';
import {
  feishuProjectAliasForDir,
  feishuProjectPermissionMode,
  listFeishuProjectProviders,
  resolveFeishuProjectRoute,
  syncFeishuProjectWorkspaces,
} from './groupOverrides.js';
import {
  listFeishuGroupSettings,
  writeFeishuGroupSettings,
  type FeishuGroupSettingsUpdate,
  type StoredFeishuGroupSettings,
} from './groupSettingsStore.js';

const log = createLogger('im/feishu/group-settings-service');

const GROUP_LIST_CACHE_MS = 30_000;
const GROUP_LIST_MAX_PAGES = 10;
const GROUP_LIST_PAGE_SIZE = 100;
/** 应用缺少读取群信息的权限（tenant token 未开对应 scope）。 */
const PERMISSION_ERROR_CODES = new Set([99991672, 99991679]);

type GroupListPorts = Pick<FeishuIM, 'getBotAppId' | 'getStatus' | 'callApi'>;

interface RemoteGroup {
  chatId: string;
  name: string | null;
  avatarUrl: string | null;
}

let cache: { botAppId: string; at: number; groups: RemoteGroup[] } | null = null;
let inflight: { botAppId: string; promise: Promise<RemoteGroup[]> } | null = null;

function isPermissionError(err: unknown): boolean {
  const e = err as { code?: unknown; httpStatus?: unknown };
  return (typeof e?.code === 'number' && PERMISSION_ERROR_CODES.has(e.code)) || e?.httpStatus === 403;
}

async function fetchBotGroups(im: GroupListPorts): Promise<RemoteGroup[]> {
  const groups: RemoteGroup[] = [];
  let pageToken: string | null = null;
  for (let page = 0; page < GROUP_LIST_MAX_PAGES; page += 1) {
    const res = await im.callApi({
      method: 'GET',
      path: '/open-apis/im/v1/chats',
      params: {
        page_size: String(GROUP_LIST_PAGE_SIZE),
        ...(pageToken ? { page_token: pageToken } : {}),
      },
    });
    const data = (res.data ?? {}) as {
      items?: Array<{ chat_id?: unknown; name?: unknown; avatar?: unknown }>;
      has_more?: unknown;
      page_token?: unknown;
    };
    for (const item of data.items ?? []) {
      if (typeof item.chat_id !== 'string' || !item.chat_id.startsWith('oc_')) continue;
      const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim() : null;
      groups.push({ chatId: item.chat_id, name, avatarUrl: safeFeishuAvatarUrl(item.avatar) });
    }
    if (data.has_more !== true || typeof data.page_token !== 'string' || !data.page_token) break;
    pageToken = data.page_token;
  }
  return groups;
}

/** `refresh` = 用户点了「刷新」：不复用 30 秒内的结果，但仍与正在进行的读取合并。 */
async function botGroups(im: GroupListPorts, botAppId: string, refresh = false): Promise<RemoteGroup[]> {
  if (!refresh && cache && cache.botAppId === botAppId && Date.now() - cache.at < GROUP_LIST_CACHE_MS) {
    return cache.groups;
  }
  if (inflight && inflight.botAppId === botAppId) return inflight.promise;
  const promise = fetchBotGroups(im).then((groups) => {
    cache = { botAppId, at: Date.now(), groups };
    return groups;
  });
  inflight = { botAppId, promise };
  try {
    return await promise;
  } finally {
    if (inflight?.promise === promise) inflight = null;
  }
}

/** 机器人在本机用过的群（群主线 / 话题任务的路由键里带群 ID），用任务标题当群名。 */
async function locallyUsedGroups(botAppId: string): Promise<RemoteGroup[]> {
  const rows = await getDbClient()
    .drizzle.select({ openId: sessions.feishuOpenId, title: sessions.title })
    .from(sessions)
    .where(and(eq(sessions.source, 'feishu'), eq(sessions.feishuBotAppId, botAppId), like(sessions.feishuOpenId, 'g/%')));
  const byChat = new Map<string, string | null>();
  for (const row of rows) {
    const chatId = row.openId?.split('/')[1];
    if (!chatId?.startsWith('oc_')) continue;
    const isMainLane = row.openId === `g/${chatId}`;
    if (!byChat.has(chatId) || (isMainLane && row.title)) byChat.set(chatId, isMainLane ? row.title ?? null : null);
  }
  return [...byChat].map(([chatId, name]) => ({ chatId, name, avatarUrl: null }));
}

interface ProjectOption {
  token: string;
  name: string;
  dir: string;
  /** 「项目与模型」里这个项目的名字；对不上为 null。 */
  alias: string | null;
  permissionMode: ImDefaultPermissionMode | null;
}

type ProjectConfig = NonNullable<NonNullable<FeishuGroupSettingsView['project']>['config']>;

async function projectOptions(): Promise<ProjectOption[]> {
  // 先按侧栏整理一次「项目与模型」的项目名表，名字才对得上。
  await syncFeishuProjectWorkspaces();
  const projects = await listProjectsForControl({ projectsOnly: true, all: true });
  return projects.flatMap((project) => {
    const dir = normalizeWorkingDirForStorage(project.workingDir);
    if (!dir) return [];
    const alias = feishuProjectAliasForDir(dir);
    return [{
      token: projectToken(project.workingDir),
      name: project.displayName,
      dir,
      alias,
      permissionMode: alias ? feishuProjectPermissionMode(alias) : null,
    }];
  });
}

/**
 * 群绑定了的那些项目在「项目与模型」里此刻解析出的模型（供群跟随时显示）。只解析被绑定的项目，
 * 共用一次供应商目录：解析可能要问另一台电脑，不为没人用的项目发请求。
 */
async function projectConfigs(
  projects: readonly ProjectOption[],
  boundDirs: ReadonlySet<string>,
): Promise<Map<string, ProjectConfig>> {
  const bound = projects.filter((project) => project.alias && boundDirs.has(project.dir));
  if (bound.length === 0) return new Map();
  const providers = await listFeishuProjectProviders();
  const entries = await Promise.all(
    bound.map(async (project): Promise<[string, ProjectConfig]> => [
      project.dir,
      { route: await resolveFeishuProjectRoute(project.alias!, providers), permissionMode: project.permissionMode },
    ]),
  );
  return new Map(entries);
}

function viewOf(
  group: RemoteGroup,
  stored: StoredFeishuGroupSettings | null,
  projects: ProjectOption[],
  configs: ReadonlyMap<string, ProjectConfig>,
): FeishuGroupSettingsView {
  let project: FeishuGroupSettingsView['project'] = null;
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
  return {
    chatId: group.chatId,
    name: group.name ?? stored?.name ?? null,
    avatarUrl: group.avatarUrl,
    project,
    route: stored?.route ?? null,
    permissionMode: stored?.permissionMode ?? null,
  };
}

export async function listFeishuGroupSettingsForUi(
  im: GroupListPorts,
  options: { refresh?: boolean } = {},
): Promise<FeishuGroupSettingsList> {
  const projects = await projectOptions();
  const publicProjects = projects.map(({ token, name, permissionMode }) => ({ token, name, permissionMode }));
  const botAppId = im.getBotAppId();
  if (!botAppId) {
    return { connected: false, source: 'local', listError: null, groups: [], projects: publicProjects };
  }
  const connected = im.getStatus().kind === 'connected';
  let source: FeishuGroupListSource = 'local';
  let listError: FeishuGroupSettingsList['listError'] = null;
  let listed: RemoteGroup[] = [];
  if (connected) {
    try {
      listed = await botGroups(im, botAppId, options.refresh === true);
      source = 'feishu';
    } catch (err) {
      listError = isPermissionError(err) ? 'permission' : 'unavailable';
      log.warn(`feishu group list unavailable (${listError}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (source === 'local') {
    try {
      listed = await locallyUsedGroups(botAppId);
    } catch (err) {
      log.warn(`local feishu group lookup failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const stored = new Map(listFeishuGroupSettings(botAppId).map((entry) => [entry.chatId, entry.settings]));
  const boundDirs = new Set([...stored.values()].flatMap((settings) => (settings.projectDir ? [settings.projectDir] : [])));
  const configs = await projectConfigs(projects, boundDirs);
  const groups: FeishuGroupSettingsView[] = [];
  const seen = new Set<string>();
  for (const group of listed) {
    if (seen.has(group.chatId)) continue;
    seen.add(group.chatId);
    groups.push(viewOf(group, stored.get(group.chatId) ?? null, projects, configs));
  }
  // 已保存设置、但这次名单里没有的群（机器人被移出或接口没列出）也列出来，便于改回跟随。
  for (const [chatId, settings] of stored) {
    if (!seen.has(chatId)) groups.push(viewOf({ chatId, name: null, avatarUrl: null }, settings, projects, configs));
  }
  return { connected, source, listError, groups, projects: publicProjects };
}

export class FeishuGroupSettingsError extends Error {
  constructor(readonly reason: 'not-configured' | 'project-unavailable') {
    super(reason === 'not-configured' ? 'feishu bot is not configured' : 'project is no longer available');
  }
}

/** 保存一个群的设置并返回它的新视图。`write` 在真正写文件前由调用方插入账号边界复核。 */
export async function saveFeishuGroupSettings(
  im: GroupListPorts,
  chatId: string,
  patch: FeishuGroupSettingsPatch,
  name: string | null,
  beforeWrite: () => void = () => {},
): Promise<FeishuGroupSettingsView> {
  const botAppId = im.getBotAppId();
  if (!botAppId) throw new FeishuGroupSettingsError('not-configured');
  const projects = await projectOptions();
  const update: FeishuGroupSettingsUpdate = {};
  if (patch.projectToken !== undefined) {
    if (patch.projectToken === null) update.projectDir = null;
    else {
      const project = projects.find((option) => option.token === patch.projectToken);
      if (!project) throw new FeishuGroupSettingsError('project-unavailable');
      update.projectDir = project.dir;
    }
  }
  if (patch.route !== undefined) update.route = patch.route;
  if (patch.permissionMode !== undefined) update.permissionMode = patch.permissionMode;
  beforeWrite();
  const saved = writeFeishuGroupSettings(botAppId, chatId, update, name);
  // 头像沿用上一次从飞书读到的名单（保存不重新拉名单）。
  const avatarUrl =
    cache?.botAppId === botAppId ? cache.groups.find((group) => group.chatId === chatId)?.avatarUrl ?? null : null;
  const configs = await projectConfigs(projects, new Set(saved?.projectDir ? [saved.projectDir] : []));
  return viewOf({ chatId, name, avatarUrl }, saved ?? null, projects, configs);
}

export const __testing = {
  resetCache(): void {
    cache = null;
    inflight = null;
  },
};
