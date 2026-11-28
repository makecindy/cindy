/**
 * 个人 IM 机器人「群聊」总表在本机的存储（项目、模型、权限、群成员也能提问）。
 *
 * 位置：`owners/<账号>/<渠道>-chat-settings.json`；飞书沿用原来的 `feishu-group-settings.json`
 * （同一形状，升级不搬文件）。按机器人 → 群 ID 分组，只记用户单独改过的项与群名（便于机器人不在群里
 * 时仍能认出是哪个群），以及群成员提问是否因连续提问暂停；不含消息、凭证或成员身份。
 * 原子替换写入，权限 0600。读不出（损坏）时按「没有按群设置」处理、保留原文件并拒绝覆写：
 * 群任务回到渠道设置，群成员按平台默认（飞书 / Discord / 企业微信不回答），不会因此放宽。
 *
 * `seeded`：钉钉升级前就会回答群成员。第一次整理时把机器人已经用过的群记为「群成员也能提问」并登记这个
 * 机器人；登记之前钉钉的群默认照旧回答，登记之后新群默认不勾。Telegram 的这一项就是传输层的群准入，不存在这里。
 * 旧版本读到只有 `members` 的条目会当作没有设置（群成员不回答），只会更严。
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  IM_CHAT_LEGACY_MEMBER_CHANNELS,
  IM_CHAT_TRANSPORT_MEMBER_CHANNELS,
  isImChatId,
  parseImChatRoute,
  type ImChatRoute,
  type ImChatSettingsChannel,
} from '../../../shared/imChatSettings.js';
import {
  isImDefaultPermissionMode,
  type ImDefaultPermissionMode,
} from '../../../shared/imDefaultSettings.js';
import { normalizeWorkingDirForStorage } from '../../../shared/workingDir.js';
import { createLogger } from '../../logger.js';
import { atomicWriteFileSync, readAtomicFileSync } from '../../utils/atomicWriteFile.js';
import { ownerScopedImUserDataPath } from '../ownerScopedStorage.js';

const log = createLogger('im/chat-settings');
const VERSION = 1;
const BOT_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const MAX_NAME_LENGTH = 200;
/** 每个机器人最多保存的群数；超出时拒绝新群，已有的照常可改。 */
export const MAX_IM_CHAT_SETTINGS = 500;

export interface StoredImChatSettings {
  name: string | null;
  /** 侧栏项目的目录（存储用归一形态）；null = 跟随机器人自己的「项目」。 */
  projectDir: string | null;
  route: ImChatRoute | null;
  permissionMode: ImDefaultPermissionMode | null;
  /** 群成员也能提问；null = 平台默认。 */
  members: boolean | null;
  /** 群成员连续问满上限、主人还没在群里说话：先不回答他们。 */
  membersPaused: boolean;
}

interface StoredBot {
  groups: Record<string, StoredImChatSettings>;
  seeded?: true;
}

interface StoredDocument {
  version: typeof VERSION;
  bots: Record<string, StoredBot>;
}

export interface ImChatSettingsUpdate {
  projectDir?: string | null;
  route?: ImChatRoute | null;
  permissionMode?: ImDefaultPermissionMode | null;
  members?: boolean | null;
  membersPaused?: boolean;
}

function fileName(channel: ImChatSettingsChannel): string {
  return channel === 'feishu' ? 'feishu-group-settings.json' : `${channel}-chat-settings.json`;
}

function filePath(channel: ImChatSettingsChannel, rootPath?: string): string {
  return rootPath ? path.join(rootPath, fileName(channel)) : ownerScopedImUserDataPath(fileName(channel));
}

function emptyDocument(): StoredDocument {
  return { version: VERSION, bots: {} };
}

function hasContent(entry: StoredImChatSettings): boolean {
  return Boolean(entry.projectDir || entry.route || entry.permissionMode || entry.members !== null || entry.membersPaused);
}

function normalizeEntry(raw: unknown): StoredImChatSettings | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const entry: StoredImChatSettings = {
    name: typeof r.name === 'string' && r.name.trim() ? r.name.trim().slice(0, MAX_NAME_LENGTH) : null,
    projectDir: typeof r.projectDir === 'string' && path.isAbsolute(r.projectDir)
      ? normalizeWorkingDirForStorage(r.projectDir) : null,
    route: r.route === undefined || r.route === null ? null : parseImChatRoute(r.route),
    permissionMode: isImDefaultPermissionMode(r.permissionMode) ? r.permissionMode : null,
    members: typeof r.members === 'boolean' ? r.members : null,
    // 只在群成员能提问时才有暂停可言。
    membersPaused: r.membersPaused === true && r.members !== false,
  };
  return hasContent(entry) ? entry : null;
}

function normalizeDocument(channel: ImChatSettingsChannel, raw: unknown): StoredDocument {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('IM_CHAT_SETTINGS_CORRUPT');
  const bots = (raw as Record<string, unknown>).bots;
  const doc = emptyDocument();
  if (!bots || typeof bots !== 'object' || Array.isArray(bots)) return doc;
  for (const [botId, bot] of Object.entries(bots as Record<string, unknown>)) {
    if (!BOT_ID_RE.test(botId) || !bot || typeof bot !== 'object') continue;
    const groups = (bot as Record<string, unknown>).groups;
    const normalized: Record<string, StoredImChatSettings> = {};
    if (groups && typeof groups === 'object' && !Array.isArray(groups)) {
      for (const [chatId, entry] of Object.entries(groups as Record<string, unknown>)) {
        if (!isImChatId(channel, chatId)) continue;
        const value = normalizeEntry(entry);
        if (value) normalized[chatId] = value;
      }
    }
    const seeded = (bot as Record<string, unknown>).seeded === true;
    if (Object.keys(normalized).length > 0 || seeded) {
      doc.bots[botId] = { groups: normalized, ...(seeded ? { seeded: true as const } : {}) };
    }
  }
  return doc;
}

/** 读文件；缺失 = 空文档，读不出抛错（调用方决定按空处理还是拒绝写入）。 */
function readDocumentStrict(channel: ImChatSettingsChannel, rootPath?: string): StoredDocument {
  const text = readAtomicFileSync(filePath(channel, rootPath));
  if (text === null) return emptyDocument();
  return normalizeDocument(channel, JSON.parse(text));
}

/**
 * 群里每条消息都会问一次（项目、权限、群成员），所以按文件身份缓存解析结果：路径（随账号变化）与
 * dev/ino/大小/修改时间都没变就复用，写入后立即失效。文件不存在时不缓存，每次照常走一遍原子读取。
 */
const cache = new Map<ImChatSettingsChannel, { file: string; identity: string; doc: StoredDocument }>();

function fileIdentity(file: string): string | null {
  try {
    const stat = fs.statSync(file, { bigint: true });
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`;
  } catch {
    return null;
  }
}

function readDocument(channel: ImChatSettingsChannel, rootPath?: string): StoredDocument {
  try {
    const file = filePath(channel, rootPath);
    const identity = fileIdentity(file);
    const cached = cache.get(channel);
    if (identity && cached?.file === file && cached.identity === identity) return cached.doc;
    let doc: StoredDocument;
    try {
      doc = readDocumentStrict(channel, rootPath);
    } catch (err) {
      log.warn(`${channel} chat settings unreadable; chats follow channel settings: ${err instanceof Error ? err.message : String(err)}`);
      doc = emptyDocument();
    }
    if (identity) cache.set(channel, { file, identity, doc });
    else cache.delete(channel);
    return doc;
  } catch (err) {
    // 账号存储还没就绪（登录前）：没有按群设置。
    log.warn(`${channel} chat settings unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return emptyDocument();
  }
}

function copyEntry(entry: StoredImChatSettings): StoredImChatSettings {
  return { ...entry, route: entry.route ? { ...entry.route } : null };
}

/** 某个群的设置；没有单独设置过返回 null。 */
export function readImChatSettings(
  channel: ImChatSettingsChannel,
  botId: string,
  chatId: string,
  rootPath?: string,
): StoredImChatSettings | null {
  if (!BOT_ID_RE.test(botId) || !isImChatId(channel, chatId)) return null;
  const entry = readDocument(channel, rootPath).bots[botId]?.groups[chatId];
  return entry ? copyEntry(entry) : null;
}

/** 这个机器人所有单独设置过的群。 */
export function listImChatSettings(
  channel: ImChatSettingsChannel,
  botId: string,
  rootPath?: string,
): Array<{ chatId: string; settings: StoredImChatSettings }> {
  if (!BOT_ID_RE.test(botId)) return [];
  const groups = readDocument(channel, rootPath).bots[botId]?.groups ?? {};
  return Object.entries(groups).map(([chatId, settings]) => ({ chatId, settings: copyEntry(settings) }));
}

/** Telegram / 钉钉：这个机器人升级前用过的群是否已登记（登记前新群照旧回答群成员）。 */
export function isImChatMembersSeeded(channel: ImChatSettingsChannel, botId: string, rootPath?: string): boolean {
  if (!BOT_ID_RE.test(botId)) return false;
  return readDocument(channel, rootPath).bots[botId]?.seeded === true;
}

/**
 * 群成员能不能提问：单独设置过的照设置；没设置过的按平台默认——Telegram 交给传输层的群准入（批准了的群
 * 成员才进得来），钉钉在登记前照旧回答，其他平台与登记后的新群不回答。
 */
export function imChatMembersAllowed(
  channel: ImChatSettingsChannel,
  botId: string,
  chatId: string,
  rootPath?: string,
): boolean {
  const explicit = readImChatSettings(channel, botId, chatId, rootPath)?.members;
  if (typeof explicit === 'boolean') return explicit;
  if (IM_CHAT_TRANSPORT_MEMBER_CHANNELS.includes(channel)) return true;
  return IM_CHAT_LEGACY_MEMBER_CHANNELS.includes(channel) && !isImChatMembersSeeded(channel, botId, rootPath);
}

function writeDocument(channel: ImChatSettingsChannel, doc: StoredDocument, rootPath?: string): void {
  cache.delete(channel);
  atomicWriteFileSync(filePath(channel, rootPath), `${JSON.stringify(doc, null, 2)}\n`);
}

/**
 * 改一个群的设置：省略的字段不改，null 改回跟随；全部跟随时删除该群的记录。
 * 文件损坏时抛错，不覆盖原文件。
 */
export function writeImChatSettings(
  channel: ImChatSettingsChannel,
  botId: string,
  chatId: string,
  update: ImChatSettingsUpdate,
  name: string | null,
  rootPath?: string,
): StoredImChatSettings | null {
  if (!BOT_ID_RE.test(botId) || !isImChatId(channel, chatId)) throw new Error('IM_CHAT_SETTINGS_INVALID');
  const doc = readDocumentStrict(channel, rootPath);
  const bot = doc.bots[botId];
  const groups = bot?.groups ?? {};
  const previous = groups[chatId] ?? null;
  if (!previous && Object.keys(groups).length >= MAX_IM_CHAT_SETTINGS) throw new Error('IM_CHAT_SETTINGS_LIMIT');
  const members = update.members === undefined ? previous?.members ?? null : update.members;
  const next: StoredImChatSettings = {
    name: (name?.trim() || previous?.name || null)?.slice(0, MAX_NAME_LENGTH) ?? null,
    projectDir: update.projectDir === undefined
      ? previous?.projectDir ?? null
      : normalizeWorkingDirForStorage(update.projectDir),
    route: update.route === undefined ? previous?.route ?? null : update.route,
    permissionMode: update.permissionMode === undefined ? previous?.permissionMode ?? null : update.permissionMode,
    members,
    // 关掉「群成员也能提问」或重新勾选都清零暂停（同微信插件）。
    membersPaused: update.members !== undefined
      ? false
      : members === false ? false : update.membersPaused ?? previous?.membersPaused ?? false,
  };
  const keep = hasContent(next);
  const nextGroups = { ...groups };
  if (keep) nextGroups[chatId] = next;
  else delete nextGroups[chatId];
  const bots = { ...doc.bots };
  if (Object.keys(nextGroups).length > 0 || bot?.seeded) {
    bots[botId] = { groups: nextGroups, ...(bot?.seeded ? { seeded: true as const } : {}) };
  } else delete bots[botId];
  writeDocument(channel, { version: VERSION, bots }, rootPath);
  return keep ? next : null;
}

/**
 * Telegram / 钉钉第一次整理：把这些群记为「群成员也能提问」（已有单独设置的不动）并登记机器人。
 * 已登记过就什么都不做。文件损坏时抛错，不覆盖原文件。
 */
export function seedImChatMembers(
  channel: ImChatSettingsChannel,
  botId: string,
  chats: ReadonlyArray<{ chatId: string; name: string | null }>,
  rootPath?: string,
): void {
  if (!BOT_ID_RE.test(botId)) return;
  const doc = readDocumentStrict(channel, rootPath);
  const bot = doc.bots[botId];
  if (bot?.seeded) return;
  const groups = { ...(bot?.groups ?? {}) };
  for (const chat of chats) {
    if (!isImChatId(channel, chat.chatId) || Object.keys(groups).length >= MAX_IM_CHAT_SETTINGS) continue;
    const previous = groups[chat.chatId];
    if (previous && previous.members !== null) continue;
    groups[chat.chatId] = {
      name: previous?.name ?? (chat.name?.trim().slice(0, MAX_NAME_LENGTH) || null),
      projectDir: previous?.projectDir ?? null,
      route: previous?.route ?? null,
      permissionMode: previous?.permissionMode ?? null,
      members: true,
      membersPaused: false,
    };
  }
  writeDocument(channel, { version: VERSION, bots: { ...doc.bots, [botId]: { groups, seeded: true } } }, rootPath);
}

export const __testing = {
  resetCache(): void {
    cache.clear();
  },
};
