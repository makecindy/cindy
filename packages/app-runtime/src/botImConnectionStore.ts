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

import { createOverrideSettingsFile } from './overrideSettingsFile.js';
import type {Logger} from '@cindy/maker-core';
import {
  BOT_IM_CHANNELS,
  type BotImChannel,
  type BotImConnectionRecord,
  type BotImFeishuService,
  type BotImTaskArchiveActivity,
} from '@cindy/companion-core/botImConnection';

export interface BotImTaskArchiveCleanup {
  connection: BotImConnectionRecord;
  cutoffs: Readonly<Record<string, number>>;
}



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
  const archivedTaskRows = normalizeArchivedTaskRows(r.archivedTaskRows);
  const archivedTaskActivity = normalizeArchivedTaskActivity(r.archivedTaskActivity, archivedTaskRows);
  return {
    botId: r.botId,
    channel: r.channel,
    createdAt,
    ...(service ? { service } : {}),
    botContextId,
    ...(groupActivation ? { groupActivation } : {}),
    ...(archivedTaskRows ? { archivedTaskRows } : {}),
    ...(archivedTaskActivity ? { archivedTaskActivity } : {}),
  };
}

function normalizeArchivedTaskRows(raw: unknown): Record<string, number> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const rows = Object.fromEntries(Object.entries(raw).filter(([id, at]) =>
    /^[A-Za-z0-9_.:-]{1,200}$/.test(id) && typeof at === 'number' && Number.isFinite(at) && at >= 0,
  )) as Record<string, number>;
  return Object.keys(rows).length ? rows : undefined;
}

function normalizeArchivedTaskActivity(raw: unknown, cutoffs: Record<string, number> | undefined): Record<string, BotImTaskArchiveActivity> | undefined {
  if (!cutoffs || !raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const entries: [string, BotImTaskArchiveActivity][] = [];
  for (const [id, value] of Object.entries(raw)) {
    if (!Object.hasOwn(cutoffs, id) || !value || typeof value !== 'object' || Array.isArray(value)) continue;
    const activity = value as Record<string, unknown>;
    if (typeof activity.generation !== 'string' || !/^[a-f0-9]{12}$/.test(activity.generation)) continue;
    if (activity.messageId !== null && (typeof activity.messageId !== 'string' || !activity.messageId.trim() || activity.messageId.length > 256)) continue;
    entries.push([id, { messageId: activity.messageId as string | null, generation: activity.generation }]);
  }
  return entries.length ? Object.fromEntries(entries) : undefined;
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

export function createBotImConnectionStore(host:{filePath():string;scopeKey():string;log:Logger;isAppSessionBoundaryPending?:()=>boolean}) {
const {log}=host;
const file = createOverrideSettingsFile<BotImConnectionDocument>({
  filePath: host.filePath,
  defaults: () => ({ connections: {} }),
  normalize: normalizeDocument,
  log,
  label: 'bot-im-connections',
  scopeKey: host.scopeKey,
  maxBytes: 256 * 1024,
  logLoadedValue: false,
});

function readDocument(): BotImConnectionDocument {
  file.invalidateIfChanged();
  return file.read();
}

function listBotImConnections(): BotImConnectionRecord[] {
  return Object.entries(readDocument().connections)
    .map(([id, record]) => ({ id, ...record }))
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

function readBotImConnection(id: string): BotImConnectionRecord | null {
  if (!isBotImConnectionId(id)) return null;
  const record = readDocument().connections[id];
  return record ? { id, ...record } : null;
}

function listBotImConnectionsForBot(botId: string): BotImConnectionRecord[] {
  return listBotImConnections().filter((record) => record.botId === botId);
}

async function addBotImConnectionRecord(
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

async function updateBotImConnectionRecord(
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

const MAX_ARCHIVED_TASK_ROWS = 512;
const MAX_ARCHIVED_TASK_BYTES = 64 * 1024;

function archivedCutoff(record: Pick<BotImConnectionRecord, 'archivedTaskRows'>, id: string): number | undefined {
  return record.archivedTaskRows && Object.hasOwn(record.archivedTaskRows, id) ? record.archivedTaskRows[id] : undefined;
}

function archivedActivity(record: Pick<BotImConnectionRecord, 'archivedTaskActivity'>, id: string): BotImTaskArchiveActivity | undefined {
  return record.archivedTaskActivity && Object.hasOwn(record.archivedTaskActivity, id) ? record.archivedTaskActivity[id] : undefined;
}

function sameArchiveActivity(left: BotImTaskArchiveActivity | undefined, right: BotImTaskArchiveActivity | undefined): boolean {
  return left?.messageId === right?.messageId && left?.generation === right?.generation;
}

function assertArchiveCapacity(connections: BotImConnectionDocument['connections']): void {
  const count = Object.values(connections).reduce((sum, record) => sum + Object.keys(record.archivedTaskRows ?? {}).length, 0);
  const withoutArchives = Object.fromEntries(Object.entries(connections).map(([id, record]) => [id, {
    ...record, archivedTaskRows: undefined, archivedTaskActivity: undefined,
  }]));
  const archiveBytes = Buffer.byteLength(JSON.stringify({ connections }, null, 2), 'utf8')
    - Buffer.byteLength(JSON.stringify({ connections: withoutArchives }, null, 2), 'utf8');
  if (count > MAX_ARCHIVED_TASK_ROWS || archiveBytes > MAX_ARCHIVED_TASK_BYTES) throw new Error('ARCHIVE_CAPACITY_REACHED');
}

async function archiveBotImTaskRow(
  expected: BotImConnectionRecord,
  sessionId: string,
  reclaimable: readonly BotImTaskArchiveCleanup[] = [],
  activity?: BotImTaskArchiveActivity,
): Promise<BotImConnectionRecord | null> {
  const owner = host.scopeKey();
  let next: BotImConnectionRecord | null = null;
  await file.updateAtomic((current) => {
    if (host.isAppSessionBoundaryPending?.() || host.scopeKey() !== owner) throw new Error('OWNER_CHANGED');
    const existing = current.value.connections[expected.id];
    if (!existing || existing.botId !== expected.botId || existing.channel !== expected.channel || existing.botContextId !== expected.botContextId) return current.value;
    if (activity && (archivedCutoff(existing, sessionId) !== archivedCutoff(expected, sessionId)
      || !sameArchiveActivity(archivedActivity(existing, sessionId), archivedActivity(expected, sessionId)))) {
      next = { id: expected.id, ...existing };
      return current.value;
    }
    const connections = { ...current.value.connections };
    for (const { connection, cutoffs } of reclaimable) {
      const source = connections[connection.id];
      if (!source || source.botId !== connection.botId || source.channel !== connection.channel || source.botContextId !== connection.botContextId) continue;
      const archivedTaskRows = { ...source.archivedTaskRows };
      const archivedTaskActivity = { ...source.archivedTaskActivity };
      for (const [id, observedCutoff] of Object.entries(cutoffs)) {
        if (archivedCutoff(source, id) === observedCutoff && sameArchiveActivity(archivedActivity(source, id), archivedActivity(connection, id))) {
          delete archivedTaskRows[id];
          delete archivedTaskActivity[id];
        }
      }
      connections[connection.id] = { ...source, archivedTaskRows, archivedTaskActivity: Object.keys(archivedTaskActivity).length ? archivedTaskActivity : undefined };
    }
    const target = connections[expected.id];
    const archivedTaskActivity = activity ? { ...target.archivedTaskActivity, [sessionId]: activity } : { ...target.archivedTaskActivity };
    if (!activity) delete archivedTaskActivity[sessionId];
    const merged = {
      ...target,
      archivedTaskRows: { ...target.archivedTaskRows, [sessionId]: Date.now() },
      archivedTaskActivity: Object.keys(archivedTaskActivity).length ? archivedTaskActivity : undefined,
    };
    connections[expected.id] = merged;
    assertArchiveCapacity(connections);
    next = { id: expected.id, ...merged };
    return { connections };
  }, { preserveDefaults: true });
  if (host.isAppSessionBoundaryPending?.() || host.scopeKey() !== owner) throw new Error('OWNER_CHANGED');
  return next;
}

/** 单个群的参与模式(always 写入, mention 回缺省并从表中清除)。 */
async function setBotImConnectionGroupActivation(
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

async function removeBotImConnectionRecord(id: string): Promise<BotImConnectionRecord | null> {
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

return {listBotImConnections,readBotImConnection,listBotImConnectionsForBot,addBotImConnectionRecord,updateBotImConnectionRecord,archiveBotImTaskRow,setBotImConnectionGroupActivation,removeBotImConnectionRecord};
}
