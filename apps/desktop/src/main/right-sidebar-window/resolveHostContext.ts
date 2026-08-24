/**
 * Detached 侧栏 pin 到非焦点 session 时，从主进程权威来源补齐宿主上下文。
 *
 * 查找顺序：
 * 1. 本地 sessions 表：命中即本机或 SSH 会话。device-link 任务不落这张表，
 *    所以这里显式写成 deviceLinkDeviceId:null（已确认非设备互联）。
 * 2. device-link 镜像列表：控制端远程任务的 Main 注册表，只读补 deviceId / workdir。
 */
import { eq } from 'drizzle-orm';

import {
  getMirrorCache,
  MAX_CACHED_TEXT_CHARS,
} from '../device-link/mirrorCacheStore.js';
import { getDbClient } from '../localDb/client/current.js';
import { sessions } from '../localDb/schema.js';
import type { RsbWindowContext } from '../../shared/rightSidebarWindow.js';

export function contextFromLocalSessionRow(row: {
  id: string;
  workingDir: string | null;
  remoteHostId: string | null;
  agentKind: string;
}): RsbWindowContext {
  return {
    sessionId: row.id,
    workdir: row.workingDir ?? null,
    remoteHostId: row.remoteHostId ?? null,
    deviceLinkDeviceId: null,
    available: true,
    subagentsAvailable: row.agentKind === 'pi' && !row.remoteHostId,
  };
}

function workdirFromDeviceLinkMirror(session: Record<string, unknown>): string | null {
  const raw =
    typeof session.workingDir === 'string'
      ? session.workingDir
      : typeof session.worktreePath === 'string'
        ? session.worktreePath
        : null;
  // 冷镜像把路径截到 240 字给列表显示。截断值不能当操作目录。
  if (!raw || raw.length >= MAX_CACHED_TEXT_CHARS) return null;
  return raw;
}

export function contextFromDeviceLinkMirror(
  deviceId: string,
  session: Record<string, unknown>,
): RsbWindowContext | null {
  const sessionId = typeof session.id === 'string' ? session.id : '';
  if (!deviceId || !sessionId) return null;
  const workdir = workdirFromDeviceLinkMirror(session);
  return {
    sessionId,
    workdir,
    remoteHostId: null,
    deviceLinkDeviceId: deviceId,
    available: true,
    // 冷镜像没有 remoteHostId，不能把 SSH Pi 当成有 Subagents。
    subagentsAvailable: false,
  };
}

export async function resolveRsbHostContextFromSession(
  sessionId: string,
): Promise<RsbWindowContext | null> {
  if (!sessionId) return null;
  const local = await readLocalSessionContext(sessionId);
  if (local) return local;
  return readDeviceLinkMirrorContext(sessionId);
}

async function readLocalSessionContext(sessionId: string): Promise<RsbWindowContext | null> {
  try {
    const rows = await getDbClient()
      .drizzle.select({
        id: sessions.id,
        workingDir: sessions.workingDir,
        remoteHostId: sessions.remoteHostId,
        agentKind: sessions.agentKind,
        status: sessions.status,
      })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    const row = rows[0];
    if (!row || row.status === 'deleted') return null;
    return contextFromLocalSessionRow(row);
  } catch {
    return null;
  }
}

async function readDeviceLinkMirrorContext(sessionId: string): Promise<RsbWindowContext | null> {
  try {
    const devices = await getMirrorCache().readSessionList();
    for (const device of devices) {
      const session = device.sessions.find((item) => item.id === sessionId);
      if (!session) continue;
      return contextFromDeviceLinkMirror(device.deviceId, session);
    }
  } catch {
    return null;
  }
  return null;
}
