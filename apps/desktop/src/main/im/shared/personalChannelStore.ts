/**
 * 设置 → IM 机器人 里每个平台那份个人机器人的两项选择在本机的存储:
 *   - projectDir:  新任务放进哪个侧栏项目(null = 机器人自己的对话目录); 模型与权限随之跟随
 *                  这个项目在「项目与模型」里的统一设置(2026-11-24 用户裁决: 跟项目走);
 *   - companionBotId: 交给哪位伙伴回复(null = Cindy)。凭证留在原处, 只改落点。
 *
 * 位置: `owners/<账号>/im-personal-channels.json`。不含凭证、消息或成员身份。原子替换写入。
 * 读不出(损坏)时按「都没选」处理、保留原文件并拒绝覆写: 新任务回到对话目录与渠道设置,
 * 机器人回到 Cindy, 不会因此放宽权限。
 *
 * 个人微信的伙伴归属仍在它自己的 channelSettings(单实例 + 扫码授权的既有模型), 这里只存它的项目。
 */

import fs from 'node:fs';
import path from 'node:path';

import type { ImDefaultSettingsChannel } from '../../../shared/imDefaultSettings.js';
import { normalizeWorkingDirForStorage } from '../../../shared/workingDir.js';
import { createLogger } from '../../logger.js';
import { atomicWriteFileSync, readAtomicFileSync } from '../../utils/atomicWriteFile.js';
import { ownerScopedImUserDataPath } from '../ownerScopedStorage.js';

const log = createLogger('im/personal-channels');
const VERSION = 1;
const BOT_ID_RE = /^[A-Za-z0-9_-]{1,200}$/;

/** 有个人机器人、能存这两项的平台。 */
export const PERSONAL_CHANNELS = ['telegram', 'feishu', 'wecom', 'dingtalk', 'discord', 'wechat'] as const;
export type PersonalChannel = (typeof PERSONAL_CHANNELS)[number] & ImDefaultSettingsChannel;

export function isPersonalChannel(value: unknown): value is PersonalChannel {
  return typeof value === 'string' && (PERSONAL_CHANNELS as readonly string[]).includes(value);
}

export interface PersonalChannelChoice {
  projectDir: string | null;
  companionBotId: string | null;
}

interface StoredDocument {
  version: typeof VERSION;
  channels: Partial<Record<PersonalChannel, PersonalChannelChoice>>;
}

const EMPTY: PersonalChannelChoice = { projectDir: null, companionBotId: null };

function filePath(rootPath?: string): string {
  return rootPath
    ? path.join(rootPath, 'im-personal-channels.json')
    : ownerScopedImUserDataPath('im-personal-channels.json');
}

function normalizeChoice(raw: unknown): PersonalChannelChoice | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const projectDir = typeof r.projectDir === 'string' && path.isAbsolute(r.projectDir)
    ? normalizeWorkingDirForStorage(r.projectDir) || null : null;
  const companionBotId = typeof r.companionBotId === 'string' && BOT_ID_RE.test(r.companionBotId)
    ? r.companionBotId : null;
  return projectDir || companionBotId ? { projectDir, companionBotId } : null;
}

function normalizeDocument(raw: unknown): StoredDocument {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('IM_PERSONAL_CHANNELS_CORRUPT');
  const channels = (raw as Record<string, unknown>).channels;
  const doc: StoredDocument = { version: VERSION, channels: {} };
  if (!channels || typeof channels !== 'object' || Array.isArray(channels)) return doc;
  for (const [channel, entry] of Object.entries(channels as Record<string, unknown>)) {
    if (!isPersonalChannel(channel)) continue;
    const choice = normalizeChoice(entry);
    if (choice) doc.channels[channel] = choice;
  }
  return doc;
}

function readDocumentStrict(rootPath?: string): StoredDocument {
  const text = readAtomicFileSync(filePath(rootPath));
  if (text === null) return { version: VERSION, channels: {} };
  return normalizeDocument(JSON.parse(text));
}

/** 每条消息建任务 / 路由时都会读: 按文件身份缓存, 写入后立即失效。 */
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
      log.warn(`personal channel choices unreadable; using defaults: ${err instanceof Error ? err.message : String(err)}`);
      doc = { version: VERSION, channels: {} };
    }
    cache = identity ? { file, identity, doc } : null;
    return doc;
  } catch (err) {
    // 账号存储还没就绪(登录前): 都没选。
    log.warn(`personal channel choices unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return { version: VERSION, channels: {} };
  }
}

export function readPersonalChannelChoice(channel: PersonalChannel, rootPath?: string): PersonalChannelChoice {
  return { ...(readDocument(rootPath).channels[channel] ?? EMPTY) };
}

/** 列出当前交给这位伙伴回复的个人机器人渠道(不含微信, 微信走 wechat-channel.json)。 */
export function listPersonalChannelsForCompanion(
  botId: string,
  rootPath?: string,
): Array<Exclude<PersonalChannel, 'wechat'>> {
  if (!botId || !BOT_ID_RE.test(botId)) return [];
  const doc = readDocument(rootPath);
  const channels: Array<Exclude<PersonalChannel, 'wechat'>> = [];
  for (const channel of PERSONAL_CHANNELS) {
    if (channel === 'wechat') continue;
    if (doc.channels[channel]?.companionBotId === botId) channels.push(channel);
  }
  return channels;
}

/** 清空单个渠道的「项目」与「谁来回复」记录(解绑 / 移交伙伴后保持设置干净)。 */
export function clearPersonalChannelChoice(channel: PersonalChannel, rootPath?: string): boolean {
  if (!isPersonalChannel(channel)) return false;
  const current = readPersonalChannelChoice(channel, rootPath);
  if (!current.projectDir && !current.companionBotId) return false;
  writePersonalChannelChoice(channel, { projectDir: null, companionBotId: null }, rootPath);
  return true;
}

/** 省略的字段不改; 文件损坏时抛错, 不覆盖原文件。 */
export function writePersonalChannelChoice(
  channel: PersonalChannel,
  update: Partial<PersonalChannelChoice>,
  rootPath?: string,
): PersonalChannelChoice {
  if (!isPersonalChannel(channel)) throw new Error('IM_PERSONAL_CHANNEL_INVALID');
  if (update.companionBotId && !BOT_ID_RE.test(update.companionBotId)) throw new Error('IM_PERSONAL_CHANNEL_INVALID');
  const doc = readDocumentStrict(rootPath);
  const previous = doc.channels[channel] ?? EMPTY;
  const next: PersonalChannelChoice = {
    projectDir: update.projectDir === undefined ? previous.projectDir
      : update.projectDir ? normalizeWorkingDirForStorage(update.projectDir) || null : null,
    companionBotId: update.companionBotId === undefined ? previous.companionBotId : update.companionBotId || null,
  };
  const channels = { ...doc.channels };
  if (next.projectDir || next.companionBotId) channels[channel] = next;
  else delete channels[channel];
  cache = null;
  atomicWriteFileSync(filePath(rootPath), `${JSON.stringify({ version: VERSION, channels }, null, 2)}\n`);
  return next;
}
