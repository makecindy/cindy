/**
 * main/im/shared/botImConnectionStore.ts
 * ---------------------------------------------------------------------------
 * 伙伴自有 IM 机器人连接的记录(不含凭证)。
 *
 * 一条记录 = 一位伙伴在某个平台上的一个机器人(渠道 + 连接 id)。凭证(Telegram token /
 * 飞书 app secret 等)不在这里: 传输层按 `secretKeyPrefixFor(id)` 的前缀写进本机安全存储,
 * 多份实例各管各的键。记录是账号级 JSON override 文件(与 im-default-settings 同模式)。
 */

import { randomBytes } from 'node:crypto';

import { activeOwnerScopeKey } from '../../appSessionState.js';
import { desktopMakerLogger } from '../../maker-host/logger-adapter.js';
import { createOverrideSettingsFile } from '../../maker-host/override-settings-file.js';
import { ownerScopedImUserDataPath } from '../ownerScopedStorage.js';
import {
  BOT_IM_CHANNELS,
  type BotImChannel,
  type BotImConnectionRecord,
  type BotImFeishuService,
} from '../../../shared/botImConnection.js';

const log = desktopMakerLogger.child('bot-im-connection-store');

export function isBotImChannel(value: unknown): value is BotImChannel {
  return typeof value === 'string' && (BOT_IM_CHANNELS as readonly string[]).includes(value);
}

interface BotImConnectionDocument {
  connections: Record<string, Omit<BotImConnectionRecord, 'id'>>;
}

const ID_PATTERN = /^[a-f0-9]{12}$/;

export function isBotImConnectionId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

/** 凭证键名前缀: 满足 ownerScopedStorage 的 `[A-Za-z0-9_-]` 约束。 */
export function secretKeyPrefixFor(id: string): string {
  return `bot-im-${id}-`;
}

function normalizeService(value: unknown): BotImFeishuService | undefined {
  return value === 'lark' ? 'lark' : value === 'feishu' ? 'feishu' : undefined;
}

function normalizeRecord(id: string, raw: unknown): Omit<BotImConnectionRecord, 'id'> | null {
  if (!isBotImConnectionId(id)) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.botId !== 'string' || !r.botId.trim() || r.botId.length > 256) return null;
  if (!isBotImChannel(r.channel)) return null;
  const createdAt =
    typeof r.createdAt === 'number' && Number.isFinite(r.createdAt) ? r.createdAt : 0;
  const service = r.channel === 'feishu' ? (normalizeService(r.service) ?? 'feishu') : undefined;
  const botContextId =
    typeof r.botContextId === 'string' && r.botContextId.trim() && r.botContextId.length <= 256
      ? r.botContextId
      : null;
  const groupActivation = normalizeGroupActivation(r.groupActivation);
  return {
    botId: r.botId,
    channel: r.channel,
    createdAt,
    ...(service ? { service } : {}),
    botContextId,
    ...(groupActivation ? { groupActivation } : {}),
  };
}

/** 只认 chatId → 'always'; 'mention' 是缺省, 不落盘。未知值整条丢弃。 */
function normalizeGroupActivation(raw: unknown): Record<string, 'always'> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, 'always'> = {};
  for (const [chatId, mode] of Object.entries(raw as Record<string, unknown>)) {
    if (/^-?\d{1,32}$/.test(chatId) && mode === 'always') out[chatId] = 'always';
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeDocument(raw: unknown): BotImConnectionDocument {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const rawConnections =
    r.connections && typeof r.connections === 'object' && !Array.isArray(r.connections)
      ? (r.connections as Record<string, unknown>)
      : {};
  const connections: BotImConnectionDocument['connections'] = {};
  for (const [id, value] of Object.entries(rawConnections)) {
    const record = normalizeRecord(id, value);
    if (record) connections[id] = record;
  }
  return { connections };
}

const file = createOverrideSettingsFile<BotImConnectionDocument>({
  filePath: () => ownerScopedImUserDataPath('bot-im-connections.json'),
  defaults: () => ({ connections: {} }),
  normalize: normalizeDocument,
  log,
  label: 'bot-im-connections',
  scopeKey: activeOwnerScopeKey,
  maxBytes: 256 * 1024,
  logLoadedValue: false,
});

function readDocument(): BotImConnectionDocument {
  file.invalidateIfChanged();
  return file.read();
}

export function listBotImConnections(): BotImConnectionRecord[] {
  return Object.entries(readDocument().connections)
    .map(([id, record]) => ({ id, ...record }))
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

export function readBotImConnection(id: string): BotImConnectionRecord | null {
  if (!isBotImConnectionId(id)) return null;
  const record = readDocument().connections[id];
  return record ? { id, ...record } : null;
}

export function listBotImConnectionsForBot(botId: string): BotImConnectionRecord[] {
  return listBotImConnections().filter((record) => record.botId === botId);
}

export async function addBotImConnectionRecord(
  input: { botId: string; channel: BotImChannel; service?: BotImFeishuService },
  deps: { now?: () => number; id?: () => string } = {},
): Promise<BotImConnectionRecord> {
  const id = (deps.id ?? (() => randomBytes(6).toString('hex')))();
  if (!isBotImConnectionId(id)) throw new Error(`invalid bot im connection id: ${id}`);
  const record: Omit<BotImConnectionRecord, 'id'> = {
    botId: input.botId,
    channel: input.channel,
    createdAt: (deps.now ?? Date.now)(),
    ...(input.channel === 'feishu' ? { service: input.service ?? 'feishu' } : {}),
    botContextId: null,
  };
  await file.updateAtomic(
    (current) => ({ connections: { ...current.value.connections, [id]: record } }),
    { preserveDefaults: true },
  );
  return { id, ...record };
}

export async function updateBotImConnectionRecord(
  id: string,
  patch: Partial<Pick<BotImConnectionRecord, 'botContextId' | 'groupActivation'>>,
): Promise<BotImConnectionRecord | null> {
  if (!isBotImConnectionId(id)) return null;
  let next: BotImConnectionRecord | null = null;
  await file.updateAtomic(
    (current) => {
      const existing = current.value.connections[id];
      if (!existing) return current.value;
      const merged = { ...existing, ...patch };
      next = { id, ...merged };
      return { connections: { ...current.value.connections, [id]: merged } };
    },
    { preserveDefaults: true },
  );
  return next;
}

/** 单个群的参与模式(always 写入, mention 回缺省并从表中清除)。 */
export async function setBotImConnectionGroupActivation(
  id: string,
  chatId: string,
  mode: 'mention' | 'always',
): Promise<BotImConnectionRecord | null> {
  const current = readBotImConnection(id);
  if (!current) return null;
  const next: Record<string, 'always'> = { ...(current.groupActivation ?? {}) };
  if (mode === 'always') next[chatId] = 'always';
  else delete next[chatId];
  return updateBotImConnectionRecord(id, {
    groupActivation: Object.keys(next).length > 0 ? next : undefined,
  });
}

export async function removeBotImConnectionRecord(id: string): Promise<BotImConnectionRecord | null> {
  if (!isBotImConnectionId(id)) return null;
  let previous: BotImConnectionRecord | null = null;
  await file.updateAtomic(
    (current) => {
      const existing = current.value.connections[id];
      if (!existing) return current.value;
      previous = { id, ...existing };
      const connections = { ...current.value.connections };
      delete connections[id];
      return { connections };
    },
    { preserveDefaults: true },
  );
  return previous;
}
