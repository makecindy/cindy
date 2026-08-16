import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { and, desc, eq, inArray, isNull } from 'drizzle-orm';

import type { MakerSessionCreateOpts } from './sessionRequest.js';
import {
  createRemoteBotWorktree,
  inspectRemoteBotWorktree,
  removeRemoteBotWorktree,
} from './botRemoteWorkspaceService.js';
import { getDbClient } from '../localDb/client/current.js';
import {
  botAutomationLinks,
  botAutomationRuns,
  botDelegations,
  botLifecycleEvents,
  botProjectBindings,
  botSessionLinks,
  botWorkspaceAttachments,
  botWorkspaceLeases,
  sessions,
} from '../localDb/schema.js';
import {
  WorktreeManager,
  restoreWorktreeForSession,
  worktreeStore,
} from '../worktree/index.js';
import type { CreateWorktreeResp, WorktreeMeta } from '../worktree/types.js';
import { parseBotDelegationPlanSnapshot } from '../../shared/botDelegation.js';

const ACQUIRING_STALE_MS = 5 * 60_000;
const leaseQueues = new Map<string, Promise<void>>();

export interface BotWorkspaceRuntimeResult {
  botId: string;
  projectBindingId: string;
  workspacePolicy: 'none' | 'reuse' | 'per-task' | 'read-only';
  leaseId?: string;
  leaseKey?: string;
  generation?: number;
  workingDir: string;
  worktreePath?: string;
}

export interface BotWorkspaceRuntimeDeps {
  now?: () => number;
  createId?: () => string;
  createWorktree?: (input: {
    sessionId: string;
    baseRepo: string;
    name: string;
    sourceBranch: string;
  }) => Promise<CreateWorktreeResp>;
  getWorktreeForSession?: (sessionId: string) => WorktreeMeta | null;
  setWorktreeForSession?: (sessionId: string, meta: WorktreeMeta) => Promise<void>;
  deleteWorktreeForSession?: (sessionId: string) => void;
  restoreWorktree?: (sessionId: string) => Promise<{ ok: boolean; message?: string }>;
  createRemoteWorktree?: typeof createRemoteBotWorktree;
  inspectRemoteWorktree?: typeof inspectRemoteBotWorktree;
}

export interface BotWorkspaceReconcileDeps {
  now?: () => number;
  listWorktrees?: () => WorktreeMeta[];
  setWorktreeForSession?: (sessionId: string, meta: WorktreeMeta) => Promise<void>;
  deleteWorktreeForSession?: (sessionId: string) => void;
  pathExists?: (candidate: string) => Promise<boolean>;
  inspectRemoteWorktree?: typeof inspectRemoteBotWorktree;
  createRemoteWorktree?: typeof createRemoteBotWorktree;
  removeRemoteWorktree?: typeof removeRemoteBotWorktree;
  removeLocalWorktree?: (
    sessionId: string,
    options: {
      isSessionRuntimeAlive: (sessionId: string) => boolean;
      canRemove: () => Promise<boolean>;
    },
  ) => Promise<void>;
  isSessionRuntimeAlive?: (sessionId: string) => boolean;
}

async function defaultPathExists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function perTaskLeaseHasActiveReferences(input: {
  leaseId: string;
  isSessionRuntimeAlive: (sessionId: string) => boolean;
}): Promise<{ active: boolean; sessionIds: string[] }> {
  const db = getDbClient().drizzle;
  const attachments = await db
    .select({ sessionId: botWorkspaceAttachments.sessionId })
    .from(botWorkspaceAttachments)
    .where(
      and(
        eq(botWorkspaceAttachments.leaseId, input.leaseId),
        isNull(botWorkspaceAttachments.detachedAt),
      ),
    );
  const sessionIds = attachments.map((attachment) => attachment.sessionId);
  if (sessionIds.length === 0) return { active: true, sessionIds };
  const sessionRows = await db
    .select({ id: sessions.id, status: sessions.status })
    .from(sessions)
    .where(inArray(sessions.id, sessionIds));
  const statusById = new Map(sessionRows.map((row) => [row.id, row.status]));
  if (
    sessionIds.some((sessionId) => {
      const status = statusById.get(sessionId);
      return status !== undefined && status !== 'archived' && status !== 'deleted';
    })
  ) return { active: true, sessionIds };
  if (sessionIds.some(input.isSessionRuntimeAlive)) return { active: true, sessionIds };

  const activeAutomation = await db
    .select({ id: botAutomationRuns.id })
    .from(botAutomationRuns)
    .where(
      and(
        eq(botAutomationRuns.workspaceLeaseId, input.leaseId),
        inArray(botAutomationRuns.status, ['claimed', 'running', 'completing']),
      ),
    )
    .limit(1);
  if (activeAutomation.length > 0) return { active: true, sessionIds };

  const activeDelegations = await db
    .select({
      parentSessionId: botDelegations.parentSessionId,
      childSessionId: botDelegations.childSessionId,
    })
    .from(botDelegations)
    .where(inArray(botDelegations.status, ['queued', 'running', 'waiting']));
  const attached = new Set(sessionIds);
  if (
    activeDelegations.some(
      (delegation) =>
        (delegation.parentSessionId && attached.has(delegation.parentSessionId))
        || (delegation.childSessionId && attached.has(delegation.childSessionId)),
    )
  ) return { active: true, sessionIds };
  return { active: false, sessionIds };
}

/**
 * Release a per-task Bot worktree after its attached task reaches a terminal
 * state. The lease is the durable owner; cleanup is CAS-claimed and every
 * active reference is checked again after the claim. Dirty/locked/kept
 * worktrees are never forced away: the remover throws and the lease remains
 * visible as error for a later retry.
 */
export async function reclaimPerTaskBotWorkspaceForSession(
  sessionId: string,
  deps: BotWorkspaceReconcileDeps = {},
): Promise<boolean> {
  const db = getDbClient().drizzle;
  const [attachment] = await db
    .select({ leaseId: botWorkspaceAttachments.leaseId })
    .from(botWorkspaceAttachments)
    .where(
      and(
        eq(botWorkspaceAttachments.sessionId, sessionId),
        isNull(botWorkspaceAttachments.detachedAt),
      ),
    )
    .limit(1);
  if (!attachment) return false;
  const [initialLease] = await db
    .select()
    .from(botWorkspaceLeases)
    .where(eq(botWorkspaceLeases.id, attachment.leaseId))
    .limit(1);
  if (!initialLease) return false;
  const [binding] = await db
    .select({ workspacePolicy: botProjectBindings.workspacePolicy })
    .from(botProjectBindings)
    .where(eq(botProjectBindings.id, initialLease.projectBindingId))
    .limit(1);
  if (binding?.workspacePolicy !== 'per-task') return false;

  return withLeaseQueue(`${initialLease.projectBindingId}\0${initialLease.leaseKey}`, async () => {
    const [lease] = await db
      .select()
      .from(botWorkspaceLeases)
      .where(eq(botWorkspaceLeases.id, initialLease.id))
      .limit(1);
    if (!lease || (lease.status !== 'active' && lease.status !== 'error')) return false;

    const maker = deps.isSessionRuntimeAlive
      ? null
      : (await import('../maker-host/index.js')).getMakerIfReady();
    const isSessionRuntimeAlive = deps.isSessionRuntimeAlive
      ?? ((id: string) => maker?.isSessionAlive(id) ?? false);
    const beforeClaim = await perTaskLeaseHasActiveReferences({
      leaseId: lease.id,
      isSessionRuntimeAlive,
    });
    if (beforeClaim.active) return false;

    const now = (deps.now ?? Date.now)();
    const [claimed] = await db
      .update(botWorkspaceLeases)
      .set({ status: 'releasing', updatedAt: now })
      .where(
        and(
          eq(botWorkspaceLeases.id, lease.id),
          eq(botWorkspaceLeases.generation, lease.generation),
          inArray(botWorkspaceLeases.status, ['active', 'error']),
        ),
      )
      .returning();
    if (!claimed) return false;

    try {
      const afterClaim = await perTaskLeaseHasActiveReferences({
        leaseId: claimed.id,
        isSessionRuntimeAlive,
      });
      if (afterClaim.active) {
        await db
          .update(botWorkspaceLeases)
          .set({ status: 'active', updatedAt: (deps.now ?? Date.now)() })
          .where(
            and(
              eq(botWorkspaceLeases.id, claimed.id),
              eq(botWorkspaceLeases.generation, claimed.generation),
              eq(botWorkspaceLeases.status, 'releasing'),
            ),
          );
        return false;
      }
      if (claimed.worktreePath && !claimed.anchorSessionId) {
        throw new Error('Per-task Bot workspace lease is missing its anchor Session.');
      }
      if (claimed.remoteHostId && claimed.worktreePath) {
        if (!claimed.branch) {
          throw new Error('Per-task remote Bot workspace lease is missing its managed branch.');
        }
        await (deps.removeRemoteWorktree ?? removeRemoteBotWorktree)({
          remoteHostId: claimed.remoteHostId,
          baseRepo: claimed.baseRepo,
          worktreePath: claimed.worktreePath,
          branch: claimed.branch,
        });
      } else if (claimed.anchorSessionId) {
        await (deps.removeLocalWorktree ?? WorktreeManager.removeWorktreeForSession)(
          claimed.anchorSessionId,
          {
            isSessionRuntimeAlive,
            canRemove: async () => {
              const [current] = await db
                .select({ status: botWorkspaceLeases.status, generation: botWorkspaceLeases.generation })
                .from(botWorkspaceLeases)
                .where(eq(botWorkspaceLeases.id, claimed.id))
                .limit(1);
              return current?.status === 'releasing' && current.generation === claimed.generation;
            },
          },
        );
      }

      const listWorktrees = deps.listWorktrees ?? WorktreeManager.listAll;
      const registered = !claimed.remoteHostId && claimed.worktreePath
        ? listWorktrees().some((meta) => path.resolve(meta.path) === path.resolve(claimed.worktreePath!))
        : false;
      const remainsOnDisk = claimed.worktreePath
        ? claimed.remoteHostId
          ? (await (deps.inspectRemoteWorktree ?? inspectRemoteBotWorktree)({
              remoteHostId: claimed.remoteHostId,
              worktreePath: claimed.worktreePath,
              baseRepo: claimed.baseRepo,
              branch: claimed.branch,
            })).exists
          : await (deps.pathExists ?? defaultPathExists)(claimed.worktreePath)
        : false;
      if (registered || remainsOnDisk) {
        throw new Error('Per-task Bot worktree was retained by its safety policy.');
      }

      const releasedAt = (deps.now ?? Date.now)();
      await getDbClient().tx('bots.finalizeWorkspaceLeaseRelease', {
        leaseId: claimed.id,
        botId: claimed.botId,
        expectedGeneration: claimed.generation,
        anchorSessionId: claimed.anchorSessionId,
        releasedAt,
        eventId: `${claimed.botId}:workspace-auto-released:${claimed.id}:${releasedAt}`,
        eventType: 'workspace-lease-auto-released',
      });
      return true;
    } catch (error) {
      await db
        .update(botWorkspaceLeases)
        .set({ status: 'error', updatedAt: (deps.now ?? Date.now)() })
        .where(
          and(
            eq(botWorkspaceLeases.id, claimed.id),
            eq(botWorkspaceLeases.generation, claimed.generation),
            eq(botWorkspaceLeases.status, 'releasing'),
          ),
        );
      throw error;
    }
  });
}

export function schedulePerTaskBotWorkspaceReclaim(sessionId: string): void {
  void reclaimPerTaskBotWorkspaceForSession(sessionId).catch(() => undefined);
}

async function withLeaseQueue<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = leaseQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(
    () => current,
    () => current,
  );
  leaseQueues.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    release();
    if (leaseQueues.get(key) === tail) leaseQueues.delete(key);
  }
}

function isTransientRemoteWorkspaceError(error: unknown): boolean {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: unknown }).code ?? '')
      : '';
  const message = error instanceof Error ? error.message : String(error);
  return code.startsWith('SSH_') || /ssh host|not connected|connection|unavailable/i.test(message);
}

/**
 * Repair interrupted Bot workspace ownership without guessing from process memory.
 * Destructive cleanup is intentionally excluded: uncertain paths become error and
 * remain user-retryable; only a release whose store entry and directory are both
 * already gone is finalized as released.
 */
export async function reconcileBotWorkspaceLeases(
  deps: BotWorkspaceReconcileDeps = {},
): Promise<void> {
  const db = getDbClient().drizzle;
  const now = (deps.now ?? Date.now)();
  const listWorktrees = deps.listWorktrees ?? WorktreeManager.listAll;
  const setWorktreeForSession = deps.setWorktreeForSession ?? worktreeStore.set;
  const deleteWorktreeForSession = deps.deleteWorktreeForSession ?? worktreeStore.del;
  const pathExists = deps.pathExists ?? defaultPathExists;
  const inspectRemote = deps.inspectRemoteWorktree ?? inspectRemoteBotWorktree;
  const createRemote = deps.createRemoteWorktree ?? createRemoteBotWorktree;
  const leases = await db
    .select()
    .from(botWorkspaceLeases)
    .where(inArray(botWorkspaceLeases.status, ['acquiring', 'active', 'releasing', 'error']));

  for (const snapshot of leases) {
    await withLeaseQueue(`${snapshot.projectBindingId}\0${snapshot.leaseKey}`, async () => {
      const [lease] = await db
        .select()
        .from(botWorkspaceLeases)
        .where(eq(botWorkspaceLeases.id, snapshot.id))
        .limit(1);
      if (!lease) return;
      let remoteState: Awaited<ReturnType<typeof inspectRemoteBotWorktree>> | undefined;
      if (lease.remoteHostId && lease.worktreePath) {
        try {
          remoteState = await inspectRemote({
            remoteHostId: lease.remoteHostId,
            worktreePath: lease.worktreePath,
            baseRepo: lease.baseRepo,
            branch: lease.branch,
          });
        } catch (error) {
          if (isTransientRemoteWorkspaceError(error)) return;
          if (lease.status !== 'acquiring') {
            await db
              .update(botWorkspaceLeases)
              .set({ status: 'error', updatedAt: now })
              .where(
                and(
                  eq(botWorkspaceLeases.id, lease.id),
                  eq(botWorkspaceLeases.generation, lease.generation),
                ),
              );
            return;
          }
        }
      }
      const registered = lease.worktreePath
        && !lease.remoteHostId
        ? listWorktrees().find(
            (meta) => path.resolve(meta.path) === path.resolve(lease.worktreePath!),
          )
        : undefined;
      const existsOnDisk = lease.worktreePath
        ? lease.remoteHostId
          ? remoteState?.exists === true
          : await pathExists(lease.worktreePath)
        : false;

      if (lease.status === 'releasing') {
        if (registered || existsOnDisk) {
          await db
            .update(botWorkspaceLeases)
            .set({ status: 'error', updatedAt: now })
            .where(
              and(
                eq(botWorkspaceLeases.id, lease.id),
                eq(botWorkspaceLeases.generation, lease.generation),
                eq(botWorkspaceLeases.status, 'releasing'),
              ),
            );
          return;
        }
        await getDbClient().tx('bots.finalizeWorkspaceLeaseRelease', {
          leaseId: lease.id,
          botId: lease.botId,
          expectedGeneration: lease.generation,
          anchorSessionId: lease.anchorSessionId,
          releasedAt: now,
        });
        return;
      }

      if (lease.status === 'acquiring') {
        if (lease.remoteHostId) {
          try {
            const meta = existsOnDisk && lease.worktreePath
              ? {
                  path: lease.worktreePath,
                  baseRepo: lease.baseRepo,
                  branch: remoteState?.branch || lease.branch || '',
                  sourceBranch: lease.sourceBranch || 'HEAD',
                }
              : await createRemote({
                  remoteHostId: lease.remoteHostId,
                  baseRepo: lease.baseRepo,
                  sourceBranch: lease.sourceBranch,
                  leaseId: lease.id,
                  generation: lease.generation,
                });
            await db
              .update(botWorkspaceLeases)
              .set({
                worktreePath: meta.path,
                baseRepo: meta.baseRepo,
                branch: meta.branch,
                sourceBranch: meta.sourceBranch,
                status: 'active',
                lastHeartbeatAt: now,
                updatedAt: now,
              })
              .where(
                and(
                  eq(botWorkspaceLeases.id, lease.id),
                  eq(botWorkspaceLeases.generation, lease.generation),
                  eq(botWorkspaceLeases.status, 'acquiring'),
                ),
              );
          } catch (error) {
            if (
              !isTransientRemoteWorkspaceError(error)
              && now - lease.updatedAt >= ACQUIRING_STALE_MS
            ) {
              await db
                .update(botWorkspaceLeases)
                .set({ status: 'error', updatedAt: now })
                .where(
                  and(
                    eq(botWorkspaceLeases.id, lease.id),
                    eq(botWorkspaceLeases.generation, lease.generation),
                    eq(botWorkspaceLeases.status, 'acquiring'),
                  ),
                );
            }
          }
          return;
        }
        if (registered && lease.anchorSessionId) {
          await db
            .update(botWorkspaceLeases)
            .set({
              worktreePath: registered.path,
              baseRepo: registered.baseRepo,
              branch: registered.branch,
              sourceBranch: registered.sourceBranch,
              status: 'active',
              lastHeartbeatAt: now,
              updatedAt: now,
            })
            .where(
              and(
                eq(botWorkspaceLeases.id, lease.id),
                eq(botWorkspaceLeases.generation, lease.generation),
                eq(botWorkspaceLeases.status, 'acquiring'),
              ),
            );
        } else if (now - lease.updatedAt >= ACQUIRING_STALE_MS) {
          await db
            .update(botWorkspaceLeases)
            .set({ status: 'error', updatedAt: now })
            .where(
              and(
                eq(botWorkspaceLeases.id, lease.id),
                eq(botWorkspaceLeases.generation, lease.generation),
                eq(botWorkspaceLeases.status, 'acquiring'),
              ),
            );
        }
        return;
      }

      if (!lease.anchorSessionId && registered) {
        const attachments = await db
          .select()
          .from(botWorkspaceAttachments)
          .where(
            and(
              eq(botWorkspaceAttachments.leaseId, lease.id),
              isNull(botWorkspaceAttachments.detachedAt),
            ),
          )
          .orderBy(desc(botWorkspaceAttachments.createdAt));
        if (attachments.length > 0) {
          const candidateIds = attachments.map((attachment) => attachment.sessionId);
          const rows = await db
            .select({ id: sessions.id, status: sessions.status })
            .from(sessions)
            .where(inArray(sessions.id, candidateIds));
          const statusById = new Map(rows.map((row) => [row.id, row.status]));
          const candidate =
            attachments.find((attachment) => statusById.get(attachment.sessionId) === 'active') ??
            attachments.find((attachment) => statusById.has(attachment.sessionId));
          if (candidate) {
            const nextMeta = { ...registered, sessionId: candidate.sessionId };
            await setWorktreeForSession(candidate.sessionId, nextMeta);
            const [updated] = await db
              .update(botWorkspaceLeases)
              .set({ anchorSessionId: candidate.sessionId, updatedAt: now })
              .where(
                and(
                  eq(botWorkspaceLeases.id, lease.id),
                  eq(botWorkspaceLeases.generation, lease.generation),
                ),
              )
              .returning();
            if (updated && registered.sessionId !== candidate.sessionId) {
              deleteWorktreeForSession(registered.sessionId);
            }
            return;
          }
        }
      }

      if (
        lease.status === 'active'
        && (!lease.worktreePath || (!registered && !existsOnDisk))
      ) {
        await db
          .update(botWorkspaceLeases)
          .set({ status: 'error', updatedAt: now })
          .where(
            and(
              eq(botWorkspaceLeases.id, lease.id),
              eq(botWorkspaceLeases.generation, lease.generation),
              eq(botWorkspaceLeases.status, 'active'),
            ),
          );
      }
    });
  }

  // Startup recovery also retries per-task leases whose owning tasks already
  // reached a terminal state. A prior crash, transient SSH outage, or dirty
  // safety refusal therefore never turns automatic cleanup into a lost event.
  const reclaimCandidates = await db
    .select({ sessionId: botWorkspaceAttachments.sessionId })
    .from(botWorkspaceAttachments)
    .innerJoin(botWorkspaceLeases, eq(botWorkspaceLeases.id, botWorkspaceAttachments.leaseId))
    .innerJoin(botProjectBindings, eq(botProjectBindings.id, botWorkspaceLeases.projectBindingId))
    .where(
      and(
        isNull(botWorkspaceAttachments.detachedAt),
        eq(botProjectBindings.workspacePolicy, 'per-task'),
        inArray(botWorkspaceLeases.status, ['active', 'error']),
      ),
    );
  for (const sessionId of new Set(reclaimCandidates.map((row) => row.sessionId))) {
    await reclaimPerTaskBotWorkspaceForSession(sessionId, deps).catch(() => undefined);
  }
}

function applyWorkspaceToCreateOpts(
  opts: MakerSessionCreateOpts,
  input: {
    workingDir: string;
    remoteHostId: string | null;
    workspaceAccess?: 'read-write' | 'read-only';
    workspaceWritePaths?: string[];
  },
): void {
  opts.workingDir = input.workingDir;
  opts.workspaceKind = 'project';
  opts.remoteHostId = input.remoteHostId ?? undefined;
  opts.workspaceAccess = input.workspaceAccess;
  opts.workspaceWritePaths = input.workspaceWritePaths;
}

function bindingWorkspaceWritePaths(input: {
  bindingRoot: string;
  runtimeRoot: string;
  allowedPathsJson: string;
  remoteHostId: string | null;
}): string[] | undefined {
  let configured: string[] = [];
  try {
    const parsed = JSON.parse(input.allowedPathsJson) as unknown;
    if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== 'string')) {
      throw new Error('Bot workspace allowedPaths snapshot is invalid.');
    }
    configured = parsed.filter((value) => value.length > 0);
  } catch {
    throw new Error('Bot workspace allowedPaths snapshot is invalid.');
  }
  if (configured.length === 0) return undefined;
  const pathApi = input.remoteHostId ? path.posix : path;
  const root = pathApi.resolve(input.bindingRoot);
  const runtimeRoot = pathApi.resolve(input.runtimeRoot);
  const mapped = configured.flatMap((candidate) => {
    const relative = pathApi.relative(root, pathApi.resolve(candidate));
    if (relative === '..' || relative.startsWith(`..${pathApi.sep}`) || pathApi.isAbsolute(relative)) {
      return [];
    }
    return [pathApi.resolve(runtimeRoot, relative)];
  });
  if (mapped.length !== configured.length) {
    throw new Error('Bot workspace allowedPaths escaped the bound project.');
  }
  return [...new Set(mapped)];
}

/**
 * Resolve a Bot Session's durable project/worktree before the Agent starts.
 * The Session is an attachment; the lease owns the workspace lifetime.
 */
export async function prepareBotWorkspaceRuntime(
  opts: MakerSessionCreateOpts,
  deps: BotWorkspaceRuntimeDeps = {},
): Promise<BotWorkspaceRuntimeResult | null> {
  const sessionId = opts.id;
  if (!sessionId) return null;
  const db = getDbClient().drizzle;
  const [link] = await db
    .select({ botId: botSessionLinks.botId, role: botSessionLinks.role })
    .from(botSessionLinks)
    .where(eq(botSessionLinks.sessionId, sessionId))
    .limit(1);
  if (!link) return null;
  const [delegation] = await db
    .select({
      targetBotId: botDelegations.targetBotId,
      permissionSnapshotJson: botDelegations.permissionSnapshotJson,
    })
    .from(botDelegations)
    .where(eq(botDelegations.childSessionId, sessionId))
    .limit(1);
  const delegationPlan = delegation
    ? parseBotDelegationPlanSnapshot(delegation.permissionSnapshotJson)
    : null;
  if (delegation && (!delegationPlan || delegation.targetBotId !== link.botId)) {
    throw new Error('Bot delegation workspace plan is missing or no longer owns this task.');
  }
  const [automationBinding] = await db
    .select({ projectBindingId: botAutomationLinks.projectBindingId })
    .from(botAutomationRuns)
    .innerJoin(
      botAutomationLinks,
      eq(botAutomationLinks.id, botAutomationRuns.automationLinkId),
    )
    .where(eq(botAutomationRuns.sessionId, sessionId))
    .limit(1);
  const [currentBinding] = delegationPlan
    ? []
    : await db
        .select()
        .from(botProjectBindings)
        .where(
          and(
            eq(botProjectBindings.botId, link.botId),
            eq(botProjectBindings.status, 'active'),
            automationBinding?.projectBindingId
              ? eq(botProjectBindings.id, automationBinding.projectBindingId)
              : eq(botProjectBindings.isDefault, true),
          ),
        )
        .limit(1);
  const binding: typeof botProjectBindings.$inferSelect | undefined = delegationPlan?.workspace
    ? {
        id: delegationPlan.workspace.bindingId,
        botId: link.botId,
        projectKey: delegationPlan.workspace.projectKey,
        workingDir: delegationPlan.workspace.workingDir,
        remoteHostId: delegationPlan.workspace.remoteHostId,
        defaultBranch: delegationPlan.workspace.defaultBranch,
        workspacePolicy: delegationPlan.workspace.workspacePolicy,
        isDefault: false,
        allowedPathsJson: JSON.stringify(delegationPlan.workspace.allowedPaths),
        status: 'active',
        createdAt: delegationPlan.createdAt,
        updatedAt: delegationPlan.workspace.bindingUpdatedAt,
      }
    : currentBinding;
  if (!binding) return null;

  if (binding.workspacePolicy === 'read-only') {
    applyWorkspaceToCreateOpts(opts, {
      ...binding,
      workspaceAccess: 'read-only',
    });
    await db
      .update(sessions)
      .set({
        workingDir: binding.workingDir,
        workspaceKind: 'project',
        remoteHostId: binding.remoteHostId,
        updatedAt: (deps.now ?? Date.now)(),
      })
      .where(eq(sessions.id, sessionId));
    return {
      botId: link.botId,
      projectBindingId: binding.id,
      workspacePolicy: binding.workspacePolicy,
      workingDir: binding.workingDir,
    };
  }
  if (binding.workspacePolicy === 'none') {
    applyWorkspaceToCreateOpts(opts, {
      ...binding,
      workspaceWritePaths: bindingWorkspaceWritePaths({
        bindingRoot: binding.workingDir,
        runtimeRoot: binding.workingDir,
        allowedPathsJson: binding.allowedPathsJson,
        remoteHostId: binding.remoteHostId,
      }),
    });
    await db
      .update(sessions)
      .set({
        workingDir: binding.workingDir,
        workspaceKind: 'project',
        remoteHostId: binding.remoteHostId,
        updatedAt: (deps.now ?? Date.now)(),
      })
      .where(eq(sessions.id, sessionId));
    return {
      botId: link.botId,
      projectBindingId: binding.id,
      workspacePolicy: binding.workspacePolicy,
      workingDir: binding.workingDir,
    };
  }
  const leaseKey = binding.workspacePolicy === 'reuse' ? 'shared' : sessionId;
  return withLeaseQueue(`${binding.id}\0${leaseKey}`, async () => {
    const now = (deps.now ?? Date.now)();
    const createId = deps.createId ?? randomUUID;
    const createWorktree = deps.createWorktree ?? WorktreeManager.createWorktree;
    const getWorktreeForSession = deps.getWorktreeForSession ?? WorktreeManager.getForSession;
    const setWorktreeForSession = deps.setWorktreeForSession ?? worktreeStore.set;
    const deleteWorktreeForSession =
      deps.deleteWorktreeForSession ?? worktreeStore.del;
    const restoreWorktree = deps.restoreWorktree ?? restoreWorktreeForSession;
    const createRemote = deps.createRemoteWorktree ?? createRemoteBotWorktree;
    const inspectRemote = deps.inspectRemoteWorktree ?? inspectRemoteBotWorktree;

    const leaseRows = await db
      .select()
      .from(botWorkspaceLeases)
      .where(
        and(
          eq(botWorkspaceLeases.projectBindingId, binding.id),
          eq(botWorkspaceLeases.leaseKey, leaseKey),
          inArray(botWorkspaceLeases.status, ['acquiring', 'active', 'releasing']),
        ),
      )
      .orderBy(desc(botWorkspaceLeases.generation))
      .limit(1);
    let lease: typeof botWorkspaceLeases.$inferSelect | undefined = leaseRows[0];

    if (lease?.status === 'releasing') {
      throw new Error('Bot workspace is being released; retry after release completes.');
    }
    if (lease?.status === 'acquiring') {
      if (binding.remoteHostId) {
        try {
          const inspected = lease.worktreePath
            ? await inspectRemote({
                remoteHostId: binding.remoteHostId,
                worktreePath: lease.worktreePath,
                baseRepo: lease.baseRepo,
                branch: lease.branch,
              })
            : { exists: false };
          const meta = inspected.exists && lease.worktreePath
            ? {
                path: lease.worktreePath,
                baseRepo: lease.baseRepo,
                branch: inspected.branch || lease.branch || '',
                sourceBranch: lease.sourceBranch || 'HEAD',
              }
            : await createRemote({
                remoteHostId: binding.remoteHostId,
                baseRepo: lease.baseRepo,
                sourceBranch: lease.sourceBranch,
                leaseId: lease.id,
                generation: lease.generation,
              });
          const [activated] = await db
            .update(botWorkspaceLeases)
            .set({
              worktreePath: meta.path,
              baseRepo: meta.baseRepo,
              branch: meta.branch,
              sourceBranch: meta.sourceBranch,
              status: 'active',
              lastHeartbeatAt: now,
              updatedAt: now,
            })
            .where(
              and(
                eq(botWorkspaceLeases.id, lease.id),
                eq(botWorkspaceLeases.generation, lease.generation),
                eq(botWorkspaceLeases.status, 'acquiring'),
              ),
            )
            .returning();
          lease = activated ?? lease;
        } catch (error) {
          if (
            !isTransientRemoteWorkspaceError(error)
            && now - lease.updatedAt >= ACQUIRING_STALE_MS
          ) {
            await db
              .update(botWorkspaceLeases)
              .set({ status: 'error', updatedAt: now })
              .where(
                and(
                  eq(botWorkspaceLeases.id, lease.id),
                  eq(botWorkspaceLeases.generation, lease.generation),
                  eq(botWorkspaceLeases.status, 'acquiring'),
                ),
              );
          }
          throw error;
        }
      } else {
      const meta = lease.anchorSessionId ? getWorktreeForSession(lease.anchorSessionId) : null;
      if (meta && (!lease.worktreePath || meta.path === lease.worktreePath)) {
        const [activated] = await db
          .update(botWorkspaceLeases)
          .set({
            worktreePath: meta.path,
            baseRepo: meta.baseRepo,
            branch: meta.branch,
            sourceBranch: meta.sourceBranch,
            status: 'active',
            lastHeartbeatAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(botWorkspaceLeases.id, lease.id),
              eq(botWorkspaceLeases.generation, lease.generation),
              eq(botWorkspaceLeases.status, 'acquiring'),
            ),
          )
          .returning();
        lease = activated ?? lease;
      } else if (now - lease.updatedAt >= ACQUIRING_STALE_MS) {
        await db
          .update(botWorkspaceLeases)
          .set({ status: 'error', updatedAt: now })
          .where(
            and(
              eq(botWorkspaceLeases.id, lease.id),
              eq(botWorkspaceLeases.generation, lease.generation),
              eq(botWorkspaceLeases.status, 'acquiring'),
            ),
          );
        lease = undefined;
      } else {
        throw new Error('Bot workspace is still being acquired; retry shortly.');
      }
      }
    }

    if (lease?.status === 'active') {
      if (!lease.anchorSessionId || !lease.worktreePath) {
        throw new Error('Active Bot workspace lease is missing its anchor or path.');
      }
      if (binding.remoteHostId) {
        const remoteWorktreePath = lease.worktreePath;
        const inspected = await inspectRemote({
          remoteHostId: binding.remoteHostId,
          worktreePath: remoteWorktreePath,
          baseRepo: lease.baseRepo,
          branch: lease.branch,
        });
        if (!inspected.exists) {
          await db
            .update(botWorkspaceLeases)
            .set({ status: 'error', updatedAt: now })
            .where(
              and(
                eq(botWorkspaceLeases.id, lease.id),
                eq(botWorkspaceLeases.generation, lease.generation),
                eq(botWorkspaceLeases.status, 'active'),
              ),
            );
          throw new Error('Remote Bot workspace no longer exists.');
        }
        await attachSessionToLease({
          sessionId,
          lease,
          workingDir: remoteWorktreePath,
          now,
        });
        if (
          binding.workspacePolicy === 'reuse'
          && link.role === 'canonical'
          && lease.anchorSessionId !== sessionId
        ) {
          const [updated] = await db
            .update(botWorkspaceLeases)
            .set({ anchorSessionId: sessionId, lastHeartbeatAt: now, updatedAt: now })
            .where(
              and(
                eq(botWorkspaceLeases.id, lease.id),
                eq(botWorkspaceLeases.generation, lease.generation),
                eq(botWorkspaceLeases.status, 'active'),
              ),
            )
            .returning();
          if (!updated) throw new Error('Bot workspace lease changed while its anchor was being migrated.');
          lease = updated;
        }
        applyWorkspaceToCreateOpts(opts, {
          workingDir: remoteWorktreePath,
          remoteHostId: binding.remoteHostId,
          workspaceWritePaths: bindingWorkspaceWritePaths({
            bindingRoot: binding.workingDir,
            runtimeRoot: remoteWorktreePath,
            allowedPathsJson: binding.allowedPathsJson,
            remoteHostId: binding.remoteHostId,
          }),
        });
        return {
          botId: link.botId,
          projectBindingId: binding.id,
          workspacePolicy: binding.workspacePolicy,
          leaseId: lease.id,
          leaseKey,
          generation: lease.generation,
          workingDir: remoteWorktreePath,
          worktreePath: remoteWorktreePath,
        };
      }
      let meta = getWorktreeForSession(lease.anchorSessionId);
      if (!meta || meta.path !== lease.worktreePath) {
        const restored = await restoreWorktree(lease.anchorSessionId);
        if (!restored.ok) {
          const detail =
            'detail' in restored && typeof restored.detail === 'string'
              ? restored.detail
              : undefined;
          const reason =
            'reason' in restored && typeof restored.reason === 'string'
              ? restored.reason
              : undefined;
          const message =
            'message' in restored && typeof restored.message === 'string'
              ? restored.message
              : undefined;
          throw new Error(
            detail || reason || message || 'Bot workspace restore failed.',
          );
        }
        meta = getWorktreeForSession(lease.anchorSessionId);
      }
      if (!meta || meta.path !== lease.worktreePath) {
        throw new Error('Bot workspace ownership could not be restored.');
      }
      await attachSessionToLease({
        sessionId,
        lease,
        workingDir: meta.path,
        now,
      });
      if (
        binding.workspacePolicy === 'reuse'
        && link.role === 'canonical'
        && lease.anchorSessionId !== sessionId
      ) {
        lease = await migrateLeaseAnchor({
          lease,
          sessionId,
          meta,
          now,
          setWorktreeForSession,
          deleteWorktreeForSession,
        });
      }
      applyWorkspaceToCreateOpts(opts, {
        workingDir: meta.path,
        remoteHostId: null,
        workspaceWritePaths: bindingWorkspaceWritePaths({
          bindingRoot: binding.workingDir,
          runtimeRoot: meta.path,
          allowedPathsJson: binding.allowedPathsJson,
          remoteHostId: null,
        }),
      });
      return {
        botId: link.botId,
        projectBindingId: binding.id,
        workspacePolicy: binding.workspacePolicy,
        leaseId: lease.id,
        leaseKey,
        generation: lease.generation,
        workingDir: meta.path,
        worktreePath: meta.path,
      };
    }

    const previous = await db
      .select({ generation: botWorkspaceLeases.generation })
      .from(botWorkspaceLeases)
      .where(
        and(
          eq(botWorkspaceLeases.projectBindingId, binding.id),
          eq(botWorkspaceLeases.leaseKey, leaseKey),
        ),
      )
      .orderBy(desc(botWorkspaceLeases.generation))
      .limit(1);
    const generation = (previous[0]?.generation ?? 0) + 1;
    const leaseId = createId();
    await db.insert(botWorkspaceLeases).values({
      id: leaseId,
      botId: link.botId,
      projectBindingId: binding.id,
      leaseKey,
      anchorSessionId: sessionId,
      worktreePath: null,
      baseRepo: binding.workingDir,
      branch: null,
      sourceBranch: binding.defaultBranch,
      remoteHostId: binding.remoteHostId,
      generation,
      status: 'acquiring',
      lastHeartbeatAt: now,
      createdAt: now,
      updatedAt: now,
      releasedAt: null,
    });

    let created: Awaited<ReturnType<typeof createRemoteBotWorktree>> | CreateWorktreeResp;
    try {
      created = binding.remoteHostId
        ? await createRemote({
            remoteHostId: binding.remoteHostId,
            baseRepo: binding.workingDir,
            sourceBranch: binding.defaultBranch,
            leaseId,
            generation,
          })
        : await createWorktree({
            sessionId,
            baseRepo: binding.workingDir,
            name: '',
            sourceBranch: binding.defaultBranch || 'HEAD',
          });
    } catch (error) {
      if (!isTransientRemoteWorkspaceError(error)) {
        await db
          .update(botWorkspaceLeases)
          .set({ status: 'error', updatedAt: now })
          .where(
            and(
              eq(botWorkspaceLeases.id, leaseId),
              eq(botWorkspaceLeases.generation, generation),
              eq(botWorkspaceLeases.status, 'acquiring'),
            ),
          );
      }
      throw error;
    }
    if ('ok' in created && !created.ok) {
      await db
        .update(botWorkspaceLeases)
        .set({ status: 'error', updatedAt: now })
        .where(eq(botWorkspaceLeases.id, leaseId));
      throw new Error(created.error.message);
    }
    const [activeLease] = await db
      .update(botWorkspaceLeases)
      .set({
        worktreePath: 'meta' in created ? created.meta.path : created.path,
        baseRepo: 'meta' in created ? created.meta.baseRepo : created.baseRepo,
        branch: 'meta' in created ? created.meta.branch : created.branch,
        sourceBranch: 'meta' in created ? created.meta.sourceBranch : created.sourceBranch,
        status: 'active',
        lastHeartbeatAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(botWorkspaceLeases.id, leaseId),
          eq(botWorkspaceLeases.generation, generation),
          eq(botWorkspaceLeases.status, 'acquiring'),
        ),
      )
      .returning();
    if (!activeLease) {
      throw new Error('Bot workspace lease changed while the worktree was being created.');
    }
    await attachSessionToLease({
      sessionId,
      lease: activeLease,
      workingDir: activeLease.worktreePath!,
      now,
    });
    applyWorkspaceToCreateOpts(opts, {
      workingDir: activeLease.worktreePath!,
      remoteHostId: binding.remoteHostId,
      workspaceWritePaths: bindingWorkspaceWritePaths({
        bindingRoot: binding.workingDir,
        runtimeRoot: activeLease.worktreePath!,
        allowedPathsJson: binding.allowedPathsJson,
        remoteHostId: binding.remoteHostId,
      }),
    });
    return {
      botId: link.botId,
      projectBindingId: binding.id,
      workspacePolicy: binding.workspacePolicy,
      leaseId,
      leaseKey,
      generation,
      workingDir: activeLease.worktreePath!,
      worktreePath: activeLease.worktreePath!,
    };
  });
}

async function migrateLeaseAnchor(input: {
  lease: typeof botWorkspaceLeases.$inferSelect;
  sessionId: string;
  meta: WorktreeMeta;
  now: number;
  setWorktreeForSession: (sessionId: string, meta: WorktreeMeta) => Promise<void>;
  deleteWorktreeForSession: (sessionId: string) => void;
}): Promise<typeof botWorkspaceLeases.$inferSelect> {
  const previousAnchor = input.lease.anchorSessionId;
  if (previousAnchor === input.sessionId) return input.lease;

  const nextMeta: WorktreeMeta = { ...input.meta, sessionId: input.sessionId };
  await input.setWorktreeForSession(input.sessionId, nextMeta);
  const db = getDbClient().drizzle;
  const [updated] = await db
    .update(botWorkspaceLeases)
    .set({
      anchorSessionId: input.sessionId,
      lastHeartbeatAt: input.now,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(botWorkspaceLeases.id, input.lease.id),
        eq(botWorkspaceLeases.generation, input.lease.generation),
        eq(botWorkspaceLeases.status, 'active'),
      ),
    )
    .returning();
  if (!updated) {
    input.deleteWorktreeForSession(input.sessionId);
    throw new Error('Bot workspace lease changed while its anchor was being migrated.');
  }
  if (previousAnchor) input.deleteWorktreeForSession(previousAnchor);
  return updated;
}

async function attachSessionToLease(input: {
  sessionId: string;
  lease: typeof botWorkspaceLeases.$inferSelect;
  workingDir: string;
  now: number;
}): Promise<void> {
  const db = getDbClient().drizzle;
  await getDbClient().tx('bots.attachWorkspaceLease', {
    attachmentId: randomUUID(),
    leaseId: input.lease.id,
    sessionId: input.sessionId,
    generation: input.lease.generation,
    workingDir: input.workingDir,
    remoteHostId: input.lease.remoteHostId,
    now: input.now,
  });
}
