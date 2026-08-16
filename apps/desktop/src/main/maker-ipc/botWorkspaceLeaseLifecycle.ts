import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { and, eq, inArray, isNull } from 'drizzle-orm';

import { getDbClient } from '../localDb/client/current.js';
import {
  botAutomationRuns,
  botDelegations,
  botLifecycleEvents,
  botWorkspaceAttachments,
  botWorkspaceLeases,
  sessions,
} from '../localDb/schema.js';
import { throwIpcError } from '../utils/ipcValidate.js';

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function assertNoActiveWorkspaceLeaseReferences(leaseId: string): Promise<string[]> {
  const db = getDbClient().drizzle;
  const attachments = await db
    .select()
    .from(botWorkspaceAttachments)
    .where(
      and(
        eq(botWorkspaceAttachments.leaseId, leaseId),
        isNull(botWorkspaceAttachments.detachedAt),
      ),
    );
  const attachedSessionIds = attachments.map((attachment) => attachment.sessionId);
  const attachedSessions = attachedSessionIds.length
    ? await db
        .select({ id: sessions.id, status: sessions.status })
        .from(sessions)
        .where(inArray(sessions.id, attachedSessionIds))
    : [];
  const statusBySession = new Map(attachedSessions.map((session) => [session.id, session.status]));
  if (
    attachedSessionIds.some((sessionId) => {
      const status = statusBySession.get(sessionId);
      return status !== undefined && status !== 'archived' && status !== 'deleted';
    })
  ) {
    throwIpcError('PRECONDITION_FAILED', '仍有 active Bot Session 使用该 workspace lease');
  }

  const activeAutomation = await db
    .select({ id: botAutomationRuns.id })
    .from(botAutomationRuns)
    .where(
      and(
        eq(botAutomationRuns.workspaceLeaseId, leaseId),
        inArray(botAutomationRuns.status, ['claimed', 'running', 'completing']),
      ),
    )
    .limit(1);
  if (activeAutomation.length > 0) {
    throwIpcError('PRECONDITION_FAILED', '仍有 Bot Automation 使用该 workspace lease');
  }
  if (attachedSessionIds.length > 0) {
    const activeDelegations = await db
      .select({
        parentSessionId: botDelegations.parentSessionId,
        childSessionId: botDelegations.childSessionId,
      })
      .from(botDelegations)
      .where(inArray(botDelegations.status, ['queued', 'running', 'waiting']));
    const attached = new Set(attachedSessionIds);
    if (
      activeDelegations.some(
        (delegation) =>
          (delegation.parentSessionId && attached.has(delegation.parentSessionId))
          || (delegation.childSessionId && attached.has(delegation.childSessionId)),
      )
    ) {
      throwIpcError('PRECONDITION_FAILED', '仍有 Bot delegation 使用该 workspace lease');
    }
  }
  return attachedSessionIds;
}

export async function retainBotWorkspaceLeases(botId: string): Promise<number> {
  const db = getDbClient().drizzle;
  const at = Date.now();
  return getDbClient().tx<number>('bots.retainWorkspaceLeases', { botId, at });
}

export async function releaseBotWorkspaceLease(input: {
  botId: string;
  leaseId: string;
  expectedGeneration: number;
}): Promise<void> {
  const db = getDbClient().drizzle;
  const [lease] = await db
    .select()
    .from(botWorkspaceLeases)
    .where(
      and(
        eq(botWorkspaceLeases.id, input.leaseId),
        eq(botWorkspaceLeases.botId, input.botId),
      ),
    )
    .limit(1);
  if (!lease) throwIpcError('NOT_FOUND', 'Bot workspace lease 不存在');
  if (lease.generation !== input.expectedGeneration) {
    throwIpcError('PRECONDITION_FAILED', 'Bot workspace lease 已被另一处操作更新');
  }
  if (lease.status === 'released') return;
  if (lease.status !== 'active' && lease.status !== 'error' && lease.status !== 'retained') {
    throwIpcError('PRECONDITION_FAILED', `Bot workspace lease 当前状态为 ${lease.status}`);
  }

  let attachedSessionIds = await assertNoActiveWorkspaceLeaseReferences(lease.id);

  const at = Date.now();
  const [claimed] = await db
    .update(botWorkspaceLeases)
    .set({ status: 'releasing', updatedAt: at })
    .where(
      and(
        eq(botWorkspaceLeases.id, lease.id),
        eq(botWorkspaceLeases.generation, input.expectedGeneration),
        inArray(botWorkspaceLeases.status, ['active', 'error', 'retained']),
      ),
    )
    .returning();
  if (!claimed) throwIpcError('PRECONDITION_FAILED', 'Bot workspace lease 已被另一处操作更新');

  try {
    // The pre-claim reads are advisory only. A scheduler fire or delegation can
    // acquire a reference between those reads and the CAS. Once `releasing` is
    // owned, workspace acquisition is closed; repeat the complete reference
    // check before the first destructive filesystem operation.
    attachedSessionIds = await assertNoActiveWorkspaceLeaseReferences(claimed.id);
    const [{ getMakerIfReady }, worktree, remoteWorkspace] = await Promise.all([
      import('../maker-host/index.js'),
      import('../worktree/index.js'),
      import('./botRemoteWorkspaceService.js'),
    ]);
    const maker = getMakerIfReady();
    if (attachedSessionIds.some((sessionId) => maker?.isSessionAlive(sessionId) === true)) {
      throwIpcError('PRECONDITION_FAILED', '仍有 Bot Session runtime 使用该 workspace lease');
    }
    if (claimed.worktreePath && !claimed.anchorSessionId) {
      throwIpcError('PRECONDITION_FAILED', 'workspace lease 缺少可恢复的 anchor Session');
    }
    if (claimed.remoteHostId && claimed.worktreePath) {
      if (!claimed.branch) {
        throwIpcError('PRECONDITION_FAILED', '远程 workspace lease 缺少受管分支信息');
      }
      await remoteWorkspace.removeRemoteBotWorktree({
        remoteHostId: claimed.remoteHostId,
        baseRepo: claimed.baseRepo,
        worktreePath: claimed.worktreePath,
        branch: claimed.branch,
      });
    } else if (claimed.anchorSessionId) {
      await worktree.WorktreeManager.removeWorktreeForSession(claimed.anchorSessionId, {
        isSessionRuntimeAlive: (sessionId) => maker?.isSessionAlive(sessionId) ?? false,
        canRemove: async () => {
          const [current] = await db
            .select({
              status: botWorkspaceLeases.status,
              generation: botWorkspaceLeases.generation,
            })
            .from(botWorkspaceLeases)
            .where(eq(botWorkspaceLeases.id, claimed.id))
            .limit(1);
          return current?.status === 'releasing' && current.generation === claimed.generation;
        },
      });
    }
    const registered = !claimed.remoteHostId && claimed.worktreePath
      ? worktree.WorktreeManager.listAll().some(
          (meta) => path.resolve(meta.path) === path.resolve(claimed.worktreePath!),
        )
      : false;
    const remainsOnDisk = claimed.worktreePath
      ? claimed.remoteHostId
        ? (
            await remoteWorkspace.inspectRemoteBotWorktree({
              remoteHostId: claimed.remoteHostId,
              worktreePath: claimed.worktreePath,
              baseRepo: claimed.baseRepo,
              branch: claimed.branch,
            })
          ).exists
        : await pathExists(claimed.worktreePath)
      : false;
    if (registered || remainsOnDisk) {
      throwIpcError(
        'PRECONDITION_FAILED',
        'worktree 被安全保护策略保留；请处理运行中引用、分支状态或 .worktree-keep 后重试',
      );
    }

    const releasedAt = Date.now();
    await getDbClient().tx('bots.finalizeWorkspaceLeaseRelease', {
      leaseId: claimed.id,
      botId: input.botId,
      expectedGeneration: claimed.generation,
      anchorSessionId: claimed.anchorSessionId,
      releasedAt,
      eventId: randomUUID(),
      eventType: 'workspace-lease-released',
    });
  } catch (error) {
    await db
      .update(botWorkspaceLeases)
      .set({ status: 'error', updatedAt: Date.now() })
      .where(
        and(
          eq(botWorkspaceLeases.id, lease.id),
          eq(botWorkspaceLeases.generation, input.expectedGeneration),
          eq(botWorkspaceLeases.status, 'releasing'),
        ),
      );
    throw error;
  }
}

export async function releaseAllBotWorkspaceLeases(botId: string): Promise<number> {
  const db = getDbClient().drizzle;
  const unstable = await db
    .select({ id: botWorkspaceLeases.id, status: botWorkspaceLeases.status })
    .from(botWorkspaceLeases)
    .where(
      and(
        eq(botWorkspaceLeases.botId, botId),
        inArray(botWorkspaceLeases.status, ['acquiring', 'releasing']),
      ),
    );
  if (unstable.length > 0) {
    throwIpcError(
      'PRECONDITION_FAILED',
      'Bot workspace 正在创建或释放，请等待状态稳定后重试',
    );
  }
  const leases = await db
    .select({ id: botWorkspaceLeases.id, generation: botWorkspaceLeases.generation })
    .from(botWorkspaceLeases)
    .where(
      and(
        eq(botWorkspaceLeases.botId, botId),
        inArray(botWorkspaceLeases.status, ['active', 'error', 'retained']),
      ),
    );
  for (const lease of leases) {
    await releaseBotWorkspaceLease({
      botId,
      leaseId: lease.id,
      expectedGeneration: lease.generation,
    });
  }
  return leases.length;
}
