/**
 * 个人飞书 / Lark 机器人的「按群设置」：给机器人所在的某个群单独指定项目、模型与权限。
 *
 * 每一项缺省（null）都表示跟随：项目跟随机器人共用的对话目录；绑定了项目的群，模型与权限跟随
 * 「项目与模型」里那个项目的一行（官方机器人与 IM 插件共用的那一份），没绑项目的群模型跟随
 * 「新对话配置」、权限跟随「群聊新建任务权限档」。一个群的设置同时作用于群主线和它的所有话题。
 * 只属于设置页那份个人机器人；伙伴连接、官方机器人与其他渠道不读它。
 *
 * 设置页与 Main 之间项目只用不透明标记（`projectToken`）指代，不来回传本机目录；
 * 选择时 Main 按侧栏的本机项目清单找回目录。
 */

import {
  isImDefaultAgentKind,
  isImDefaultEffort,
  isImDefaultPermissionMode,
  type ImDefaultAgentKind,
  type ImDefaultEffort,
  type ImDefaultPermissionMode,
} from './imDefaultSettings.js';

export interface FeishuGroupRoute {
  agentKind: ImDefaultAgentKind;
  model: string;
  providerId: string | null;
  /** Agent 所在电脑；share:<id> 表示分享来的供应商；null 为本机。 */
  agentDeviceId: string | null;
  effort: ImDefaultEffort;
}

/** 渲染端可见的一个群的设置。 */
export interface FeishuGroupSettingsView {
  chatId: string;
  /** 群名；读不到时为 null，界面显示群 ID 尾段。 */
  name: string | null;
  /** 飞书返回的群头像（https）；名单不是从飞书读到的或没有头像时为 null，界面显示占位图标。 */
  avatarUrl: string | null;
  /** 选中的项目；null = 跟随（机器人共用的对话目录）。 */
  project: {
    token: string;
    name: string;
    available: boolean;
    /**
     * 「项目与模型」里这个项目的设置，群没单独设置的项跟随它。null = 对不上那一行（例如官方机器人
     * 的项目表还没建起来），群仍跟随渠道设置。`route` 为 null 表示那一行的模型此刻不可用；
     * `permissionMode` 为 null 表示那一行的档位不可用，回到「群聊新建任务权限档」。
     */
    config: { route: FeishuGroupRoute | null; permissionMode: ImDefaultPermissionMode | null } | null;
  } | null;
  route: FeishuGroupRoute | null;
  permissionMode: ImDefaultPermissionMode | null;
}

export type FeishuGroupListSource = 'feishu' | 'local';

export interface FeishuGroupSettingsList {
  /** 机器人未连接时为 false，只列已保存过设置的群。 */
  connected: boolean;
  /**
   * 群名单来源：'feishu' = 飞书接口返回的机器人所在群；'local' = 接口读不到时，
   * 退回列出机器人用过的群与已保存设置的群。
   */
  source: FeishuGroupListSource;
  /** 接口读不到群名单的原因（只在 source = 'local' 时有）。 */
  listError: 'permission' | 'unavailable' | null;
  groups: FeishuGroupSettingsView[];
  /**
   * 可选的侧栏本机项目。`permissionMode`：「项目与模型」里这个项目的权限档，绑定时据此判断群里新任务
   * 的权限会不会变宽；null = 对不上那一行或档位不可用，绑定后权限仍按「群聊新建任务权限档」。
   */
  projects: Array<{ token: string; name: string; permissionMode: ImDefaultPermissionMode | null }>;
}

/**
 * 一次保存。省略的字段不改；`null` 表示改回跟随。
 * `projectToken` 必须来自同一次列表里的 `projects`。
 */
export interface FeishuGroupSettingsPatch {
  projectToken?: string | null;
  route?: FeishuGroupRoute | null;
  permissionMode?: ImDefaultPermissionMode | null;
}

const CHAT_ID_RE = /^oc_[A-Za-z0-9_-]{1,128}$/;
const TOKEN_RE = /^[0-9a-f]{24}$/;
const MAX_ID_LENGTH = 256;

const MAX_AVATAR_URL_LENGTH = 2048;

/** 权限档从严到宽（与「项目与模型」合并时用的顺序一致）。 */
const PERMISSION_ORDER: readonly string[] = ['ask', 'default', 'plan', 'acceptEdits', 'auto', 'bypassPermissions'];

/** `next` 是否比 `current` 更宽；不认识的档位按更宽算，宁可多确认一次。 */
export function isWiderPermissionMode(next: string, current: string): boolean {
  const nextRank = PERMISSION_ORDER.indexOf(next);
  const currentRank = PERMISSION_ORDER.indexOf(current);
  if (nextRank === -1) return next !== current;
  return currentRank !== -1 && nextRank > currentRank;
}

/** 只收 https 地址，且不带账号密码；其余一律当作没有头像。 */
export function safeFeishuAvatarUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.length > MAX_AVATAR_URL_LENGTH) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** 飞书群 ID（oc_ 开头）。单聊与其他标识一律不收。 */
export function isFeishuGroupChatId(value: unknown): value is string {
  return typeof value === 'string' && CHAT_ID_RE.test(value);
}

function optionalId(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length <= MAX_ID_LENGTH ? trimmed : undefined;
}

/** 校验一条固定的模型路由；不合法返回 null。 */
export function parseFeishuGroupRoute(value: unknown): FeishuGroupRoute | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (!isImDefaultAgentKind(raw.agentKind) || !isImDefaultEffort(raw.effort)) return null;
  if (typeof raw.model !== 'string') return null;
  const model = raw.model.trim();
  if (!model || model.length > MAX_ID_LENGTH) return null;
  const providerId = optionalId(raw.providerId ?? null);
  const agentDeviceId = optionalId(raw.agentDeviceId ?? null);
  if (providerId === undefined || agentDeviceId === undefined) return null;
  return { agentKind: raw.agentKind, model, providerId, agentDeviceId, effort: raw.effort };
}

/** 运行时校验渲染端发来的保存内容；不合法时抛错，不做部分保存。 */
export function parseFeishuGroupSettingsPatch(value: unknown): FeishuGroupSettingsPatch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('FEISHU_GROUP_SETTINGS_INVALID');
  }
  const raw = value as Record<string, unknown>;
  const patch: FeishuGroupSettingsPatch = {};
  if ('projectToken' in raw) {
    if (raw.projectToken === null) patch.projectToken = null;
    else if (typeof raw.projectToken === 'string' && TOKEN_RE.test(raw.projectToken)) {
      patch.projectToken = raw.projectToken;
    } else throw new Error('FEISHU_GROUP_SETTINGS_INVALID');
  }
  if ('route' in raw) {
    if (raw.route === null) patch.route = null;
    else {
      const route = parseFeishuGroupRoute(raw.route);
      if (!route) throw new Error('FEISHU_GROUP_SETTINGS_INVALID');
      patch.route = route;
    }
  }
  if ('permissionMode' in raw) {
    if (raw.permissionMode === null) patch.permissionMode = null;
    else if (isImDefaultPermissionMode(raw.permissionMode)) patch.permissionMode = raw.permissionMode;
    else throw new Error('FEISHU_GROUP_SETTINGS_INVALID');
  }
  return patch;
}
