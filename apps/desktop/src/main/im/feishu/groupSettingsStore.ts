/**
 * 个人飞书 / Lark 机器人的按群设置（项目、模型、权限）在本机的存储。
 *
 * 位置：`owners/<账号>/feishu-group-settings.json`，按机器人 App ID → 群 ID 分组，只记用户
 * 单独改过的项与群名（便于机器人不在群里时仍能认出是哪个群）；不含消息、凭证或成员身份。
 * 原子替换写入，权限 0600。读不出（损坏）时按「没有按群设置」处理、保留原文件并拒绝覆写，
 * 群任务回到渠道设置，不会因此放宽到比渠道设置更宽的权限。
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  parseFeishuGroupRoute,
  isFeishuGroupChatId,
  type FeishuGroupRoute,
} from '../../../shared/feishuGroupSettings.js';
import {
  isImDefaultPermissionMode,
  type ImDefaultPermissionMode,
} from '../../../shared/imDefaultSettings.js';
import { normalizeWorkingDirForStorage } from '../../../shared/workingDir.js';
import { createLogger } from '../../logger.js';
import { atomicWriteFileSync, readAtomicFileSync } from '../../utils/atomicWriteFile.js';
import { ownerScopedImUserDataPath } from '../ownerScopedStorage.js';

const log = createLogger('im/feishu/group-settings');
const VERSION = 1;
const BOT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_NAME_LENGTH = 200;
/** 每个机器人最多保存的群数；超出时拒绝新群，已有的照常可改。 */
export const MAX_FEISHU_GROUP_SETTINGS = 500;

export interface StoredFeishuGroupSettings {
  name: string | null;
  /** 侧栏项目的目录（存储用归一形态）；null = 跟随机器人的对话目录。 */
  projectDir: string | null;
  route: FeishuGroupRoute | null;
  permissionMode: ImDefaultPermissionMode | null;
}

interface StoredDocument {
  version: typeof VERSION;
  bots: Record<string, { groups: Record<string, StoredFeishuGroupSettings> }>;
}

export interface FeishuGroupSettingsUpdate {
  projectDir?: string | null;
  route?: FeishuGroupRoute | null;
  permissionMode?: ImDefaultPermissionMode | null;
}

function filePath(rootPath?: string): string {
  return rootPath
    ? path.join(rootPath, 'feishu-group-settings.json')
    : ownerScopedImUserDataPath('feishu-group-settings.json');
}

function emptyDocument(): StoredDocument {
  return { version: VERSION, bots: {} };
}

function normalizeEntry(raw: unknown): StoredFeishuGroupSettings | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === 'string' && r.name.trim()
    ? r.name.trim().slice(0, MAX_NAME_LENGTH) : null;
  const projectDir = typeof r.projectDir === 'string' && path.isAbsolute(r.projectDir)
    ? normalizeWorkingDirForStorage(r.projectDir) : null;
  const route = r.route === undefined || r.route === null ? null : parseFeishuGroupRoute(r.route);
  const permissionMode = isImDefaultPermissionMode(r.permissionMode) ? r.permissionMode : null;
  if (!projectDir && !route && !permissionMode) return null;
  return { name, projectDir, route, permissionMode };
}

function normalizeDocument(raw: unknown): StoredDocument {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('FEISHU_GROUP_SETTINGS_CORRUPT');
  const bots = (raw as Record<string, unknown>).bots;
  const doc = emptyDocument();
  if (!bots || typeof bots !== 'object' || Array.isArray(bots)) return doc;
  for (const [botAppId, bot] of Object.entries(bots as Record<string, unknown>)) {
    if (!BOT_ID_RE.test(botAppId) || !bot || typeof bot !== 'object') continue;
    const groups = (bot as Record<string, unknown>).groups;
    if (!groups || typeof groups !== 'object' || Array.isArray(groups)) continue;
    const normalized: Record<string, StoredFeishuGroupSettings> = {};
    for (const [chatId, entry] of Object.entries(groups as Record<string, unknown>)) {
      if (!isFeishuGroupChatId(chatId)) continue;
      const value = normalizeEntry(entry);
      if (value) normalized[chatId] = value;
    }
    if (Object.keys(normalized).length > 0) doc.bots[botAppId] = { groups: normalized };
  }
  return doc;
}

/** 读文件；缺失 = 空文档，读不出抛错（调用方决定按空处理还是拒绝写入）。 */
function readDocumentStrict(rootPath?: string): StoredDocument {
  const text = readAtomicFileSync(filePath(rootPath));
  if (text === null) return emptyDocument();
  return normalizeDocument(JSON.parse(text));
}

/**
 * 群里每条消息都会问一次（跟随默认的指纹、权限档），所以按文件身份缓存解析结果：路径（随账号
 * 变化）与 dev/ino/大小/修改时间都没变就复用，写入后立即失效。文件不存在时不缓存，
 * 每次照常走一遍原子读取（含备份恢复）。
 */
let cache: { file: string; identity: string; doc: StoredDocument } | null = null;

function fileIdentity(file: string): string | null {
  try {
    const stat = fs.statSync(file, { bigint: true });
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`;
  } catch {
    return null;
  }
}

function readDocument(rootPath?: string): StoredDocument {
  try {
    const file = filePath(rootPath);
    const identity = fileIdentity(file);
    if (identity && cache?.file === file && cache.identity === identity) return cache.doc;
    let doc: StoredDocument;
    try {
      doc = readDocumentStrict(rootPath);
    } catch (err) {
      log.warn(
        `feishu group settings unreadable; groups follow channel settings: ${err instanceof Error ? err.message : String(err)}`,
      );
      doc = emptyDocument();
    }
    cache = identity ? { file, identity, doc } : null;
    return doc;
  } catch (err) {
    // 账号存储还没就绪（登录前）：没有按群设置。
    log.warn(`feishu group settings unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return emptyDocument();
  }
}

function copyEntry(entry: StoredFeishuGroupSettings): StoredFeishuGroupSettings {
  return { ...entry, route: entry.route ? { ...entry.route } : null };
}

/** 某个群的设置；没有单独设置过返回 null。 */
export function readFeishuGroupSettings(
  botAppId: string,
  chatId: string,
  rootPath?: string,
): StoredFeishuGroupSettings | null {
  if (!BOT_ID_RE.test(botAppId) || !isFeishuGroupChatId(chatId)) return null;
  const entry = readDocument(rootPath).bots[botAppId]?.groups[chatId];
  return entry ? copyEntry(entry) : null;
}

/** 这个机器人所有单独设置过的群。 */
export function listFeishuGroupSettings(
  botAppId: string,
  rootPath?: string,
): Array<{ chatId: string; settings: StoredFeishuGroupSettings }> {
  if (!BOT_ID_RE.test(botAppId)) return [];
  const groups = readDocument(rootPath).bots[botAppId]?.groups ?? {};
  return Object.entries(groups).map(([chatId, settings]) => ({ chatId, settings: copyEntry(settings) }));
}

/**
 * 改一个群的设置：省略的字段不改，null 改回跟随；全部跟随时删除该群的记录。
 * 文件损坏时抛错，不覆盖原文件。
 */
export function writeFeishuGroupSettings(
  botAppId: string,
  chatId: string,
  update: FeishuGroupSettingsUpdate,
  name: string | null,
  rootPath?: string,
): StoredFeishuGroupSettings | null {
  if (!BOT_ID_RE.test(botAppId) || !isFeishuGroupChatId(chatId)) {
    throw new Error('FEISHU_GROUP_SETTINGS_INVALID');
  }
  const doc = readDocumentStrict(rootPath);
  const groups = doc.bots[botAppId]?.groups ?? {};
  const previous = groups[chatId] ?? null;
  if (!previous && Object.keys(groups).length >= MAX_FEISHU_GROUP_SETTINGS) {
    throw new Error('FEISHU_GROUP_SETTINGS_LIMIT');
  }
  const next: StoredFeishuGroupSettings = {
    name: (name?.trim() || previous?.name || null)?.slice(0, MAX_NAME_LENGTH) ?? null,
    projectDir: update.projectDir === undefined
      ? previous?.projectDir ?? null
      : normalizeWorkingDirForStorage(update.projectDir),
    route: update.route === undefined ? previous?.route ?? null : update.route,
    permissionMode: update.permissionMode === undefined
      ? previous?.permissionMode ?? null
      : update.permissionMode,
  };
  const keep = Boolean(next.projectDir || next.route || next.permissionMode);
  const nextGroups = { ...groups };
  if (keep) nextGroups[chatId] = next;
  else delete nextGroups[chatId];
  const bots = { ...doc.bots };
  if (Object.keys(nextGroups).length > 0) bots[botAppId] = { groups: nextGroups };
  else delete bots[botAppId];
  cache = null;
  atomicWriteFileSync(filePath(rootPath), `${JSON.stringify({ version: VERSION, bots }, null, 2)}\n`);
  return keep ? next : null;
}
