import type { RemoteResourceAvatar } from '@cindy/device-link';
import type { HostedRemoteCollectionItem } from '@/device-link/remoteResources';
import { resolveRemoteText } from '@cindy/device-link';
import type { RemoteSession } from './types';

/** Display attribution only; never used as authorization for a task. */
export interface TaskTeammate {
  id: string;
  name: string;
  avatar?: RemoteResourceAvatar;
}
export type TaskCompanion = { id: string; role: string; channel?: string };

export function taskTeammateKey(id: string, deviceId: string, cloudIds: ReadonlySet<string>, cindyIds: ReadonlySet<string> = new Set()): string {
  if (id === 'cindy-default' || cindyIds.has(id)) return JSON.stringify(['teammate', 'cindy']);
  return cloudIds.has(id) ? JSON.stringify(['companion', id]) : JSON.stringify([deviceId, id]);
}

export function taskTeammateOptions(rows: readonly HostedRemoteCollectionItem[], cloudIds: ReadonlySet<string>, locale: string, cindyIds: ReadonlySet<string> = new Set()) {
  const options = new Map<string, { key: string; title: string; subtitle?: string }>();
  for (const row of rows) {
    if (row.item.ref.kind !== 'bot') continue;
    const id = row.item.ref.id;
    const key = taskTeammateKey(id, row.host.deviceId, cloudIds, cindyIds);
    if (!options.has(key)) options.set(key, { key, title: resolveRemoteText(row.item.display.title, locale),
      ...(cloudIds.has(id) || cindyIds.has(id) || id === 'cindy-default' ? {} : { subtitle: row.host.deviceName }) });
  }
  return [...options.values()];
}

export function isTeammateTask(session: Pick<RemoteSession, 'source' | 'companion'>): boolean {
  return session.source === 'bot' && !!session.companion?.id
    && (session.companion.role === 'routine' || session.companion.role === 'channel');
}

export function parseTaskCompanion(value: unknown): TaskCompanion | undefined {
  if (!value || typeof value !== 'object') return;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== 'string' || !row.id || typeof row.role !== 'string') return;
  return { id: row.id, role: row.role, ...(typeof row.channel === 'string' ? { channel: row.channel } : {}) };
}

export function parseTaskTeammate(value: unknown): TaskTeammate | undefined {
  if (!value || typeof value !== 'object') return;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== 'string' || !row.id || typeof row.name !== 'string') return;
  const avatar = row.avatar as Record<string, unknown> | undefined;
  return { id: row.id, name: row.name, ...(avatar && typeof avatar.kind === 'string'
    && typeof avatar.value === 'string' && typeof avatar.fallbackText === 'string'
    ? { avatar: { kind: avatar.kind, value: avatar.value, fallbackText: avatar.fallbackText } } : {}) };
}

/** Cached device-specific selections keep matching when cloud/preset identity arrives later. */
export function normalizeTaskTeammateSelection(selection: 'all' | readonly string[], cloudIds: ReadonlySet<string>, cindyIds: ReadonlySet<string> = new Set()): 'all' | string[] {
  if (selection === 'all') return selection;
  return [...new Set(selection.map(key => {
    try {
      const parts: unknown = JSON.parse(key);
      if (!Array.isArray(parts) || parts.length !== 2 || !parts.every(part => typeof part === 'string')) return key;
      if (parts[0] === 'teammate') return key;
      return taskTeammateKey(parts[1], parts[0], cloudIds, cindyIds);
    } catch { return key; }
  }))];
}
