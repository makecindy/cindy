/**
 * custom/personalStore.ts — 设置页「自定义渠道」的连接记录(个人 bot 那份)。
 *
 * 与伙伴页的连接分开存: 伙伴页的记录带 botId, 归伙伴; 这里的记录没有伙伴,
 * 消息进「IM 机器人」自己的会话。凭证(token)同样按连接 id 存安全存储。
 */

import { randomBytes } from 'node:crypto';

import { activeOwnerScopeKey } from '../../appSessionState.js';
import { desktopMakerLogger } from '../../maker-host/logger-adapter.js';
import { createOverrideSettingsFile } from '../../maker-host/override-settings-file.js';
import { ownerScopedImUserDataPath } from '../ownerScopedStorage.js';

const log = desktopMakerLogger.child('custom-channel-store');

export interface PersonalCustomConnection {
  id: string;
  displayName: string;
  callbackUrl: string | null;
  agentKind: 'claude-code' | 'codex' | 'pi';
  model: string | null;
  createdAt: number;
}

interface Document {
  connections: Record<string, Omit<PersonalCustomConnection, 'id'>>;
}

const ID_PATTERN = /^[a-f0-9]{12}$/;

export function isPersonalCustomId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function normalize(raw: unknown): Document {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const source =
    r.connections && typeof r.connections === 'object' && !Array.isArray(r.connections)
      ? (r.connections as Record<string, unknown>)
      : {};
  const connections: Document['connections'] = {};
  for (const [id, value] of Object.entries(source)) {
    if (!isPersonalCustomId(id) || !value || typeof value !== 'object') continue;
    const v = value as Record<string, unknown>;
    const displayName = typeof v.displayName === 'string' ? v.displayName.trim() : '';
    if (!displayName || displayName.length > 80) continue;
    const agentKind =
      v.agentKind === 'codex' || v.agentKind === 'pi' ? v.agentKind : 'claude-code';
    connections[id] = {
      displayName,
      callbackUrl: typeof v.callbackUrl === 'string' && v.callbackUrl ? v.callbackUrl : null,
      agentKind,
      model: typeof v.model === 'string' && v.model ? v.model : null,
      createdAt: typeof v.createdAt === 'number' ? v.createdAt : 0,
    };
  }
  return { connections };
}

const file = createOverrideSettingsFile<Document>({
  filePath: () => ownerScopedImUserDataPath('custom-im-connections.json'),
  defaults: () => ({ connections: {} }),
  normalize,
  log,
  label: 'custom-im-connections',
  scopeKey: activeOwnerScopeKey,
  maxBytes: 128 * 1024,
  logLoadedValue: false,
});

export function listPersonalCustomConnections(): PersonalCustomConnection[] {
  file.invalidateIfChanged();
  return Object.entries(file.read().connections).map(([id, record]) => ({ id, ...record }));
}

export function readPersonalCustomConnection(id: string): PersonalCustomConnection | null {
  file.invalidateIfChanged();
  const record = file.read().connections[id];
  return record ? { id, ...record } : null;
}

export async function addPersonalCustomConnection(input: {
  displayName: string;
  callbackUrl: string | null;
  agentKind: 'claude-code' | 'codex' | 'pi';
  model: string | null;
}): Promise<PersonalCustomConnection> {
  const id = randomBytes(6).toString('hex');
  const record = { ...input, createdAt: Date.now() };
  await file.updateAtomic(
    (current) => ({ connections: { ...current.value.connections, [id]: record } }),
    { preserveDefaults: true },
  );
  return { id, ...record };
}

export async function removePersonalCustomConnection(id: string): Promise<void> {
  await file.updateAtomic(
    (current) => {
      const connections = { ...current.value.connections };
      delete connections[id];
      return { connections };
    },
    { preserveDefaults: true },
  );
}
