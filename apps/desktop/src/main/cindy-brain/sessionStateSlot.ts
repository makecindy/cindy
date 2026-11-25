import { inArray } from 'drizzle-orm';

import {
  ghostInstallApprovalToken,
  type GhostPipeSessionStateResult,
  type GhostSessionState,
  type InstalledGhost,
} from '../../shared/ghost.js';
import type { DbClient } from '../localDb/client/DbClient.js';
import { sessions } from '../localDb/schema.js';
import { isGhostEligibleSessionRow } from './subscriptionGateway.js';

const SESSION_ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const MAX_SESSION_IDS = 100;

export async function readGhostSessionStateRows(db: Pick<DbClient, 'drizzle'>, sessionIds: string[]) {
  return await db.drizzle.select({
    sessionId: sessions.id,
    status: sessions.status,
    source: sessions.source,
    orcaRole: sessions.orcaRole,
  }).from(sessions).where(inArray(sessions.id, sessionIds));
}

interface SessionStateSlotDeps {
  getGhost(id: string): InstalledGhost | null;
  readSessions(sessionIds: string[]): ReturnType<typeof readGhostSessionStateRows>;
}

function approvedSubscriber(ghost: InstalledGhost | null): ghost is InstalledGhost {
  return ghost?.enabled === true && ghost.approval?.state === 'approved' &&
    ghost.manifest.subscribe?.topics?.includes('session') === true;
}

function fail(
  errorCode: Extract<GhostPipeSessionStateResult, { ok: false }>['errorCode'],
  message: string,
): GhostPipeSessionStateResult {
  return { ok: false, errorCode, message };
}

export class GhostSessionStateSlot {
  constructor(private readonly deps: SessionStateSlotDeps) {}

  async handleRequest(id: string, payload: unknown, isCurrent: () => boolean): Promise<GhostPipeSessionStateResult> {
    const denied = () => fail('PERMISSION_DENIED', '插件未启用、整体安装批准无效或未声明 session 主题');
    const unavailable = () => fail('HOST_NOT_READY', '当前账号的会话数据库不可用');
    if (!isCurrent()) return unavailable();
    const ghost = this.deps.getGhost(id);
    if (!approvedSubscriber(ghost)) return denied();
    const approval = ghostInstallApprovalToken(ghost.approval);
    const rawIds = (payload as { sessionIds?: unknown } | null)?.sessionIds;
    const invalid = () => fail('INVALID_REQUEST', 'sessionIds 必须包含 1–100 个合法会话 id');
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
      !Array.isArray(rawIds) || rawIds.length < 1 || rawIds.length > MAX_SESSION_IDS) return invalid();
    const sessionIds: unknown[] = Array.from(rawIds);
    if (!sessionIds.every((sessionId): sessionId is string =>
      typeof sessionId === 'string' && SESSION_ID_RE.test(sessionId))) {
      return invalid();
    }

    try {
      const rows = await this.deps.readSessions([...new Set(sessionIds)]);
      if (!isCurrent()) return unavailable();
      const current = this.deps.getGhost(id);
      if (!approvedSubscriber(current) || ghostInstallApprovalToken(current.approval) !== approval) return denied();
      const states = new Map<string, GhostSessionState>();
      for (const row of rows) {
        if (!isGhostEligibleSessionRow(row)) continue;
        if (row.status !== 'active' && row.status !== 'archived' && row.status !== 'deleted') {
          return fail('INTERNAL', '无法读取会话状态');
        }
        states.set(row.sessionId, row.status);
      }
      return { ok: true, sessions: sessionIds.map(sessionId => ({
        sessionId,
        status: states.get(sessionId) ?? 'out_of_scope',
      })) };
    } catch {
      return fail('INTERNAL', '无法读取会话状态');
    }
  }
}
