/**
 * 个人 IM 机器人的「群聊」总表：给机器人所在的某个群（Discord 是频道）单独指定项目、模型与权限，
 * 以及要不要回答群里其他成员（2026-11-24 主人裁决，蒸馏自微信插件的会话设置）。
 *
 * 每一项缺省（null）都表示跟随：项目跟随机器人自己的「项目」设置（没选就是对话目录）；绑定了项目的群，
 * 模型与权限跟随「项目与模型」里那个项目的一行，没绑项目的群模型跟随渠道「新对话配置」。一个群的设置
 * 同时作用于群主线和它的所有话题。只属于设置页那份个人机器人；伙伴连接、官方机器人不读它。
 *
 * 设置页与 Main 之间项目只用不透明标记（`projectToken`）指代，不来回传本机目录；
 * 选择时 Main 按侧栏的本机项目清单找回目录。
 */

import {
  isImDefaultAgentKind,
  isImDefaultEffort,
  isImDefaultPermissionMode,
  isImDefaultPluginEngineEffort,
  type ImDefaultAgentKind,
  type ImDefaultEffort,
  type ImDefaultPermissionMode,
} from './imDefaultSettings.js';
import { pluginEngineKeyFromProviderId } from './pluginEngines.js';

/** 有「群聊」总表的个人机器人。个人微信的连接收不到群消息，不在其中。 */
export const IM_CHAT_SETTINGS_CHANNELS = ['feishu', 'telegram', 'discord', 'dingtalk', 'wecom'] as const;
export type ImChatSettingsChannel = (typeof IM_CHAT_SETTINGS_CHANNELS)[number];

export function isImChatSettingsChannel(value: unknown): value is ImChatSettingsChannel {
  return typeof value === 'string' && (IM_CHAT_SETTINGS_CHANNELS as readonly string[]).includes(value);
}

/**
 * 升级前已经会回答群成员、又没有自己的准入开关的平台（钉钉的群）。第一次整理时把已用过的群记为
 * 「群成员也能提问」，之后新加进的群默认不勾（2026-11-24 主人裁决：保持现状）。
 */
export const IM_CHAT_LEGACY_MEMBER_CHANNELS: readonly ImChatSettingsChannel[] = ['dingtalk'];

/**
 * 平台自己有群准入、且准入的含义就是「群成员能召唤」的平台（Telegram：你邀请的群自动批准，别人拉的群
 * 在私聊卡里批准）。「群成员也能提问」读写的就是这份准入，不另存一份，免得批准后成员仍被挡住。
 */
export const IM_CHAT_TRANSPORT_MEMBER_CHANNELS: readonly ImChatSettingsChannel[] = ['telegram'];

/** 群成员连续提问多少次（你不在群里说话时）就先暂停回答他们；第这么多次仍会回答。 */
export const IM_CHAT_MEMBER_BREAKER_LIMIT = 10;
/** 同一个群最多排队几条群成员的提问，再多的不回答。 */
export const IM_CHAT_MEMBER_QUEUE_LIMIT = 5;

export interface ImChatRoute {
  agentKind: ImDefaultAgentKind;
  model: string;
  providerId: string | null;
  /** Agent 所在电脑；share:<id> 表示分享来的供应商；null 为本机。 */
  agentDeviceId: string | null;
  /** 插件引擎(acp)允许 '' 表示引擎默认思考强度。 */
  effort: ImDefaultEffort | '';
  /** 可选智能路由 id；命中时建任务按该路由选源并持续托管，失效时回落到上面的具体模型。 */
  modelGroup?: string | null;
}

/** 渲染端可见的一个群（或频道）的设置。 */
export interface ImChatSettingsView {
  chatId: string;
  /** 群聊；Discord 服务器里的文字频道为 channel。 */
  kind: 'group' | 'channel';
  /** 群名；读不到时为 null，界面显示 ID 尾段。 */
  name: string | null;
  /** 群头像（https）；平台不给或没读到时为 null，界面显示首字母。 */
  avatarUrl: string | null;
  /** 选中的项目；null = 跟随机器人自己的「项目」。 */
  project: {
    token: string;
    name: string;
    available: boolean;
    /**
     * 「项目与模型」里这个项目的设置，群没单独设置的项跟随它。null = 对不上那一行，群仍跟随渠道设置。
     * `route` 为 null 表示那一行的模型此刻不可用；`permissionMode` 为 null 表示那一行的档位不可用。
     */
    config: { route: ImChatRoute | null; permissionMode: ImDefaultPermissionMode | null } | null;
  } | null;
  route: ImChatRoute | null;
  permissionMode: ImDefaultPermissionMode | null;
  /** 群成员也能提问。 */
  members: boolean;
  /** 群成员连续问满上限、你还没在群里说话，已暂停回答他们。 */
  membersPaused: boolean;
}

export type ImChatListSource = 'remote' | 'local';

export interface ImChatSettingsList {
  channel: ImChatSettingsChannel;
  /** 机器人未配置时为 false，只列已保存过设置的群。 */
  connected: boolean;
  /**
   * 名单来源：'remote' = 平台接口返回的机器人所在群（飞书、Discord）；'local' = 本机记录里机器人用过、
   * 收到过消息的群与已保存设置的群（Telegram、钉钉、企业微信没有列群接口，接口读不到时也退回这里）。
   */
  source: ImChatListSource;
  /** 接口读不到群名单的原因（只在本该从接口读却退回本机记录时有）。 */
  listError: 'permission' | 'unavailable' | null;
  chats: ImChatSettingsView[];
  /**
   * 可选的侧栏本机项目。`permissionMode`：「项目与模型」里这个项目的权限档，绑定时据此判断群里新任务
   * 的权限会不会变宽；null = 对不上那一行或档位不可用。
   */
  projects: Array<{ token: string; name: string; permissionMode: ImDefaultPermissionMode | null }>;
  /**
   * 机器人自己的「项目」设置（群跟随时显示继承值）；null = 对话目录。`config` 同 `project.config`
   * （概要读取时为 null）。
   */
  channelProject: {
    name: string;
    available: boolean;
    config: { route: ImChatRoute | null; permissionMode: ImDefaultPermissionMode | null } | null;
  } | null;
}

/**
 * 一次保存。省略的字段不改；`null` 表示改回跟随。
 * `projectToken` 必须来自同一次列表里的 `projects`。
 */
export interface ImChatSettingsPatch {
  projectToken?: string | null;
  route?: ImChatRoute | null;
  permissionMode?: ImDefaultPermissionMode | null;
  members?: boolean;
}

const TOKEN_RE = /^[0-9a-f]{24}$/;
const MAX_ID_LENGTH = 256;
const MAX_AVATAR_URL_LENGTH = 2048;
const SNOWFLAKE = '\\d{1,25}';
const CHAT_ID_RES: Record<ImChatSettingsChannel, RegExp> = {
  feishu: /^oc_[A-Za-z0-9_-]{1,128}$/,
  // 群 / 超级群的 chat_id 是负数。
  telegram: /^-\d{1,20}$/,
  // 服务器 / 文字频道。thread 跟随父频道，不单独设置。
  discord: new RegExp(`^${SNOWFLAKE}/${SNOWFLAKE}$`),
  // 钉钉 openConversationId、企业微信 chatid：不透明字符串，只拒绝空白与控制字符。
  dingtalk: /^[^\s\u0000-\u001f\u007f]{1,256}$/,
  wecom: /^[^\s\u0000-\u001f\u007f]{1,256}$/,
};

/** 这个平台的群 / 频道标识。私聊与其他标识一律不收。 */
export function isImChatId(channel: ImChatSettingsChannel, value: unknown): value is string {
  return typeof value === 'string' && CHAT_ID_RES[channel].test(value);
}

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
export function safeImAvatarUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.length > MAX_AVATAR_URL_LENGTH) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function optionalId(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length <= MAX_ID_LENGTH ? trimmed : undefined;
}

/** 校验一条固定的模型路由；不合法返回 null。 */
export function parseImChatRoute(value: unknown): ImChatRoute | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (!isImDefaultAgentKind(raw.agentKind)) return null;
  const effortValid = raw.agentKind === 'acp'
    ? isImDefaultPluginEngineEffort(raw.effort)
    : isImDefaultEffort(raw.effort);
  if (!effortValid) return null;
  if (typeof raw.model !== 'string') return null;
  const model = raw.model.trim();
  if (!model || model.length > MAX_ID_LENGTH) return null;
  const providerId = optionalId(raw.providerId ?? null);
  const agentDeviceId = optionalId(raw.agentDeviceId ?? null);
  const modelGroup = optionalId(raw.modelGroup ?? null);
  if (providerId === undefined || agentDeviceId === undefined || modelGroup === undefined) return null;
  if (raw.agentKind === 'acp' && !pluginEngineKeyFromProviderId(providerId)) return null;
  return {
    agentKind: raw.agentKind,
    model,
    providerId,
    agentDeviceId,
    effort: raw.effort as ImDefaultEffort | '',
    ...(modelGroup ? { modelGroup } : {}),
  };
}

/** 运行时校验渲染端发来的保存内容；不合法时抛错，不做部分保存。 */
export function parseImChatSettingsPatch(value: unknown): ImChatSettingsPatch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('IM_CHAT_SETTINGS_INVALID');
  }
  const raw = value as Record<string, unknown>;
  const patch: ImChatSettingsPatch = {};
  if ('projectToken' in raw) {
    if (raw.projectToken === null) patch.projectToken = null;
    else if (typeof raw.projectToken === 'string' && TOKEN_RE.test(raw.projectToken)) {
      patch.projectToken = raw.projectToken;
    } else throw new Error('IM_CHAT_SETTINGS_INVALID');
  }
  if ('route' in raw) {
    if (raw.route === null) patch.route = null;
    else {
      const route = parseImChatRoute(raw.route);
      if (!route) throw new Error('IM_CHAT_SETTINGS_INVALID');
      patch.route = route;
    }
  }
  if ('permissionMode' in raw) {
    if (raw.permissionMode === null) patch.permissionMode = null;
    else if (isImDefaultPermissionMode(raw.permissionMode)) patch.permissionMode = raw.permissionMode;
    else throw new Error('IM_CHAT_SETTINGS_INVALID');
  }
  if ('members' in raw) {
    if (typeof raw.members !== 'boolean') throw new Error('IM_CHAT_SETTINGS_INVALID');
    patch.members = raw.members;
  }
  return patch;
}
