import { randomUUID } from 'node:crypto';

import { BrowserWindow, ipcMain } from 'electron';
import { and, eq } from 'drizzle-orm';
import type { Maker } from '@cindy/maker-core';

import type {
  BotLifecycleActionRequest,
  BotLifecycleActionResult,
} from '../../shared/botLifecycle.js';
import { getDbClient } from '../localDb/client/current.js';
import { deleteBotProfileAndDetachSessionsInDb } from '../localDb/ipc/sessions.js';
import {
  botAutomationLinks,
  botLifecycleEvents,
  botProfiles,
  botRoutes,
  botSessionLinks,
  sessions,
} from '../localDb/schema.js';
import { createLogger } from '../logger.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { requireObject, requireString, throwIpcError } from '../utils/ipcValidate.js';
import { MAKER_INVOKE, MAKER_PUSH } from './channels.js';
import { awaitReadyWithTimeout } from './schedule.js';
import type { BotDelegationService } from './botDelegationService.js';
import type { BotDeliveryOutboxService } from './botDeliveryOutboxService.js';
import {
  releaseAllBotWorkspaceLeases,
  retainBotWorkspaceLeases,
} from './botWorkspaceLeaseLifecycle.js';

const log = createLogger('maker-ipc:bot-lifecycle');

type RouteSuspendStatus = 'active' | 'offline' | 'recovering' | 'error';
type AutomationSuspendStatus = 'active' | 'error';

export interface BotLifecycleServiceDeps {
  maker: Maker;
  getDelegationService: () => BotDelegationService | null;
  getOutboxService: () => BotDeliveryOutboxService | null;
  pauseSchedule?: (scheduleId: string) => Promise<void>;
  resumeSchedule?: (scheduleId: string) => Promise<void>;
  retainWorktrees?: (botId: string) => Promise<number>;
  releaseWorktrees?: (botId: string) => Promise<number>;
  createCanonicalSession?: (input: {
    botId: string;
    expectedCanonicalSessionId: string | null;
    expectedProfileVersion: number;
  }) => Promise<{ canonicalSessionId: string }>;
  deleteProfileAndDetachSessions?: (
    botId: string,
    sessionIds: string[],
    keepTaskHistory: boolean,
  ) => Promise<void>;
  now?: () => number;
  /** Resume durable work owned by the Bot after lifecycle state is active. */
  onResumed?: (botId: string) => void | Promise<void>;
}

const lifecycleLocks = new Map<
  string,
  { action: BotLifecycleActionRequest['action']; promise: Promise<BotLifecycleActionResult> }
>();

function withBotLifecycleLock(
  botId: string,
  action: BotLifecycleActionRequest['action'],
  run: () => Promise<BotLifecycleActionResult>,
): Promise<BotLifecycleActionResult> {
  const current = lifecycleLocks.get(botId);
  if (current?.action === action) return current.promise;
  const start = current ? current.promise.catch(() => undefined).then(run) : run();
  const next = start.finally(() => {
    if (lifecycleLocks.get(botId)?.promise === next) lifecycleLocks.delete(botId);
  });
  lifecycleLocks.set(botId, { action, promise: next });
  return next;
}

function broadcastBotLifecycleChanged(payload: {
  botId: string;
  action: BotLifecycleActionRequest['action'];
}): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send(MAKER_PUSH.BOT_LIFECYCLE_CHANGED, payload);
    } catch (error) {
      log.warn('Bot lifecycle broadcast failed', { error: String(error) });
    }
  }
}

function lifecycleResult(
  botId: string,
  action: BotLifecycleActionRequest['action'],
  status: BotLifecycleActionResult['status'],
  affected: Partial<BotLifecycleActionResult['affected']>,
  warnings: string[] = [],
): BotLifecycleActionResult {
  return {
    botId,
    action,
    status,
    affected: {
      sessions: affected.sessions ?? 0,
      routes: affected.routes ?? 0,
      automations: affected.automations ?? 0,
      delegations: affected.delegations ?? 0,
      deliveries: affected.deliveries ?? 0,
      worktrees: affected.worktrees ?? 0,
    },
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

export function createBotLifecycleService(deps: BotLifecycleServiceDeps) {
  const now = deps.now ?? Date.now;
  const pauseSchedule = deps.pauseSchedule ?? (async (scheduleId: string) => {
    const { scheduler } = await awaitReadyWithTimeout();
    await scheduler.pause(scheduleId);
  });
  const resumeSchedule = deps.resumeSchedule ?? (async (scheduleId: string) => {
    const { scheduler } = await awaitReadyWithTimeout();
    await scheduler.resume(scheduleId);
  });
  const retainWorktrees = deps.retainWorktrees ?? retainBotWorkspaceLeases;
  const releaseWorktrees = deps.releaseWorktrees ?? releaseAllBotWorkspaceLeases;
  const createCanonicalSession = deps.createCanonicalSession ?? (async (input) => {
    const { createBotCanonicalSession } = await import('../localDb/ipc/bots.js');
    return createBotCanonicalSession(input);
  });
  const deleteProfileAndDetachSessions =
    deps.deleteProfileAndDetachSessions ?? deleteBotProfileAndDetachSessionsInDb;

  const readProfile = async (botId: string) => {
    const [profile] = await getDbClient()
      .drizzle.select()
      .from(botProfiles)
      .where(eq(botProfiles.id, botId))
      .limit(1);
    if (!profile) throwIpcError('NOT_FOUND', 'Bot 不存在');
    return profile;
  };

  const closeBotSessions = async (botId: string): Promise<{ count: number; warnings: string[] }> => {
    const links = await getDbClient()
      .drizzle.select({ sessionId: botSessionLinks.sessionId })
      .from(botSessionLinks)
      .where(eq(botSessionLinks.botId, botId));
    const ids = [...new Set(links.map((row) => row.sessionId))];
    const settled = await Promise.allSettled(ids.map((sessionId) => deps.maker.closeSession(sessionId)));
    const warnings = settled.flatMap((result, index) =>
      result.status === 'rejected'
        ? [`SESSION_CLOSE_FAILED:${ids[index]}:${String(result.reason)}`]
        : [],
    );
    return { count: ids.length, warnings };
  };

  const pause = async (botId: string): Promise<BotLifecycleActionResult> => {
    const profile = await readProfile(botId);
    if (profile.status === 'archived' || profile.status === 'deleting') {
      throwIpcError('PRECONDITION_FAILED', `Bot 当前状态为 ${profile.status}`);
    }
    const db = getDbClient().drizzle;
    const [routes, automations] = await Promise.all([
      db.select().from(botRoutes).where(eq(botRoutes.botId, botId)),
      db.select().from(botAutomationLinks).where(eq(botAutomationLinks.botId, botId)),
    ]);
    const schedulesToPause = automations
      .filter((row) => row.suspendedStatus === 'active' || row.status === 'active')
      .map((row) => row.scheduleId)
      .filter((value): value is string => !!value);
    const at = now();
    const paused = await getDbClient().tx<{ routes: number; automations: number }>(
      'bots.pauseLifecycle',
      {
        botId,
        canonicalSessionId: profile.canonicalSessionId,
        expectedProfileStatus: profile.status,
        at,
        eventId: randomUUID(),
      },
    );

    const warnings: string[] = [];
    const uniqueSchedulesToPause = [...new Set(schedulesToPause)];
    const scheduleResults = await Promise.allSettled(
      uniqueSchedulesToPause.map((scheduleId) => pauseSchedule(scheduleId)),
    );
    scheduleResults.forEach((result, index) => {
      if (result.status === 'rejected') {
        warnings.push(
          `SCHEDULE_PAUSE_FAILED:${uniqueSchedulesToPause[index]}:${String(result.reason)}`,
        );
      }
    });
    if (warnings.length > 0) {
      // Profile/routes/links are already paused, so no new run can be claimed. Do not
      // continue closing tasks, detaching worktrees or archiving the Bot until every
      // in-flight Scheduler run has acknowledged cancellation. A retry is idempotent:
      // suspendedStatus keeps the original active schedules discoverable.
      await db.insert(botLifecycleEvents).values({
        id: randomUUID(),
        botId,
        sessionId: profile.canonicalSessionId,
        eventType: 'pause-failed',
        payloadJson: JSON.stringify({ warnings }),
        createdAt: now(),
      });
      throwIpcError(
        'PRECONDITION_FAILED',
        '部分 Bot Automation 无法安全停止，Bot 已保持暂停；请重试后再归档或删除',
      );
    }
    const delegationService = deps.getDelegationService();
    const outboxService = deps.getOutboxService();
    const [delegations, deliveries, closed] = await Promise.all([
      delegationService?.cancelDelegationsForBot(
        botId,
        'The Bot was paused by the user.',
      ) ?? Promise.resolve(0),
      outboxService?.suspendForBot(botId) ?? Promise.resolve(0),
      closeBotSessions(botId),
    ]);
    warnings.push(...closed.warnings);
    const completedAt = now();
    await db.insert(botLifecycleEvents).values({
      id: randomUUID(),
      botId,
      sessionId: profile.canonicalSessionId,
      eventType: warnings.length > 0 ? 'paused-with-warnings' : 'paused',
      payloadJson: JSON.stringify({ warnings }),
      createdAt: completedAt,
    });
    const result = lifecycleResult(
      botId,
      'pause',
      'paused',
      {
        sessions: closed.count,
        routes: paused.routes,
        automations: paused.automations,
        delegations,
        deliveries,
      },
      warnings,
    );
    broadcastBotLifecycleChanged({ botId, action: 'pause' });
    return result;
  };

  const resume = async (botId: string): Promise<BotLifecycleActionResult> => {
    const profile = await readProfile(botId);
    if (profile.status === 'archived' || profile.status === 'deleting') {
      throwIpcError('PRECONDITION_FAILED', `Bot 当前状态为 ${profile.status}`);
    }
    const db = getDbClient().drizzle;
    const [routes, automations] = await Promise.all([
      db
        .select()
        .from(botRoutes)
        .where(and(eq(botRoutes.botId, botId), eq(botRoutes.status, 'paused'))),
      db
        .select()
        .from(botAutomationLinks)
        .where(and(eq(botAutomationLinks.botId, botId), eq(botAutomationLinks.status, 'paused'))),
    ]);
    const suspendedRoutes = routes.filter(
      (row): row is typeof row & { suspendedStatus: RouteSuspendStatus } =>
        row.suspendedStatus !== null,
    );
    const suspendedAutomations = automations.filter(
      (row): row is typeof row & { suspendedStatus: AutomationSuspendStatus } =>
        row.suspendedStatus !== null,
    );
    const schedulesToResume = suspendedAutomations
      .filter((row) => row.suspendedStatus === 'active' && row.scheduleId)
      .map((row) => row.scheduleId!);
    const uniqueSchedulesToResume = [...new Set(schedulesToResume)];
    const scheduleResults = await Promise.allSettled(
      uniqueSchedulesToResume.map((scheduleId) => resumeSchedule(scheduleId)),
    );
    const failures = scheduleResults.flatMap((result, index) =>
      result.status === 'rejected'
        ? [`SCHEDULE_RESUME_FAILED:${uniqueSchedulesToResume[index]}:${String(result.reason)}`]
        : [],
    );
    if (failures.length > 0) {
      await db.insert(botLifecycleEvents).values({
        id: randomUUID(),
        botId,
        sessionId: profile.canonicalSessionId,
        eventType: 'resume-failed',
        payloadJson: JSON.stringify({ warnings: failures }),
        createdAt: now(),
      });
      throwIpcError('PRECONDITION_FAILED', '部分 Bot Automation 无法恢复，Bot 仍保持暂停');
    }

    const at = now();
    const resumed = await getDbClient().tx<{ routes: number; automations: number }>(
      'bots.resumeLifecycle',
      {
        botId,
        canonicalSessionId: profile.canonicalSessionId,
        expectedProfileStatus: profile.status,
        at,
        eventId: randomUUID(),
      },
    );
    const deliveries = await (deps.getOutboxService()?.resumeForBot(botId) ?? Promise.resolve(0));
    const result = lifecycleResult(botId, 'resume', 'active', {
      routes: resumed.routes,
      automations: resumed.automations,
      deliveries,
    });
    broadcastBotLifecycleChanged({ botId, action: 'resume' });
    await deps.onResumed?.(botId);
    return result;
  };

  const archive = async (
    request: BotLifecycleActionRequest,
  ): Promise<BotLifecycleActionResult> => {
    let profile = await readProfile(request.botId);
    if (profile.status === 'deleting') {
      throwIpcError('PRECONDITION_FAILED', 'Bot 正在永久删除');
    }
    if (profile.status === 'archived') {
      return lifecycleResult(request.botId, 'archive', 'archived', {});
    }

    if (profile.status !== 'paused') {
      await pause(request.botId);
      profile = await readProfile(request.botId);
    }

    const db = getDbClient().drizzle;
    const [links, routes, automations] = await Promise.all([
      db
        .select({ sessionId: botSessionLinks.sessionId })
        .from(botSessionLinks)
        .where(eq(botSessionLinks.botId, request.botId)),
      db.select({ id: botRoutes.id }).from(botRoutes).where(eq(botRoutes.botId, request.botId)),
      db
        .select({ id: botAutomationLinks.id })
        .from(botAutomationLinks)
        .where(eq(botAutomationLinks.botId, request.botId)),
    ]);
    const sessionIds = [...new Set(links.map((row) => row.sessionId))];
    const at = now();
    const archived = await getDbClient().tx<{ sessions: number }>('bots.archiveLifecycle', {
      botId: request.botId,
      canonicalSessionId: profile.canonicalSessionId,
      expectedProfileStatus: profile.status,
      worktreeDisposition: request.worktreeDisposition ?? 'retain',
      at,
      eventId: randomUUID(),
    });

    const warnings: string[] = [];
    let deliveries = 0;
    try {
      deliveries = await (
        deps.getOutboxService()?.cancelForBot(request.botId, 'Bot archived')
        ?? Promise.resolve(0)
      );
    } catch (error) {
      warnings.push(`OUTBOX_CANCEL_FAILED:${String(error)}`);
    }
    let worktrees = 0;
    try {
      worktrees = request.worktreeDisposition === 'recycle'
        ? await releaseWorktrees(request.botId)
        : await retainWorktrees(request.botId);
    } catch (error) {
      warnings.push(`WORKTREE_DISPOSITION_FAILED:${String(error)}`);
    }
    const result = lifecycleResult(request.botId, 'archive', 'archived', {
      sessions: archived.sessions,
      routes: routes.length,
      automations: automations.length,
      deliveries,
      worktrees,
    }, warnings);
    broadcastBotLifecycleChanged({ botId: request.botId, action: 'archive' });
    return result;
  };

  const restore = async (botId: string): Promise<BotLifecycleActionResult> => {
    const profile = await readProfile(botId);
    if (profile.status !== 'archived') {
      throwIpcError('PRECONDITION_FAILED', `Bot 当前状态为 ${profile.status}`);
    }
    if (profile.canonicalSessionId) {
      throwIpcError('PRECONDITION_FAILED', '已归档 Bot 不应保留主任务指针');
    }
    const db = getDbClient().drizzle;
    const at = now();
    const [claimed] = await db
      .update(botProfiles)
      .set({ status: 'paused', updatedAt: at })
      .where(and(eq(botProfiles.id, botId), eq(botProfiles.status, 'archived')))
      .returning({ id: botProfiles.id });
    if (!claimed) throwIpcError('PRECONDITION_FAILED', 'Bot 生命周期已被另一处操作更新');

    let canonicalSessionId: string;
    try {
      const created = await createCanonicalSession({
        botId,
        expectedCanonicalSessionId: null,
        expectedProfileVersion: profile.currentVersion,
      });
      canonicalSessionId = created.canonicalSessionId;
    } catch (error) {
      await db
        .update(botProfiles)
        .set({ status: 'archived', canonicalSessionId: null, updatedAt: now() })
        .where(and(eq(botProfiles.id, botId), eq(botProfiles.status, 'paused')));
      throw error;
    }

    try {
      const resumed = await resume(botId);
      const completedAt = now();
      await db.insert(botLifecycleEvents).values({
        id: randomUUID(),
        botId,
        sessionId: canonicalSessionId,
        eventType: 'restored',
        payloadJson: JSON.stringify({ profileVersion: profile.currentVersion }),
        createdAt: completedAt,
      });
      const result = {
        ...resumed,
        action: 'restore' as const,
        canonicalSessionId,
        affected: { ...resumed.affected, sessions: 1 },
      };
      broadcastBotLifecycleChanged({ botId, action: 'restore' });
      return result;
    } catch (error) {
      // Resume is fail-closed and leaves the Bot paused. Keep the fresh
      // canonical task so the user can diagnose and retry Resume without
      // creating another task or reviving archived history.
      await db.insert(botLifecycleEvents).values({
        id: randomUUID(),
        botId,
        sessionId: canonicalSessionId,
        eventType: 'restore-paused',
        payloadJson: JSON.stringify({ error: String(error) }),
        createdAt: now(),
      });
      throw error;
    }
  };

  const remove = async (
    request: BotLifecycleActionRequest,
  ): Promise<BotLifecycleActionResult> => {
    let profile = await readProfile(request.botId);
    if (request.confirmName !== profile.displayName) {
      throwIpcError('INVALID_PARAMS', '请输入完整 Bot 名称以确认永久删除');
    }
    if (profile.status === 'deleting') {
      throwIpcError('PRECONDITION_FAILED', 'Bot 已在永久删除流程中');
    }
    if (profile.status !== 'archived') {
      await archive({
        ...request,
        action: 'archive',
        worktreeDisposition: request.worktreeDisposition ?? 'retain',
      });
      profile = await readProfile(request.botId);
    } else if (request.worktreeDisposition === 'recycle') {
      await releaseWorktrees(request.botId);
    } else {
      await retainWorktrees(request.botId);
    }

    const db = getDbClient().drizzle;
    const links = await db
      .select({ sessionId: botSessionLinks.sessionId })
      .from(botSessionLinks)
      .where(eq(botSessionLinks.botId, request.botId));
    const sessionIds = [...new Set(links.map((row) => row.sessionId))];
    const [delegations, deliveries, closed] = await Promise.all([
      deps.getDelegationService()?.cancelDelegationsForBot(
        request.botId,
        'The Bot was permanently deleted by the user.',
      ) ?? Promise.resolve(0),
      deps.getOutboxService()?.cancelForBot(request.botId, 'Bot permanently deleted')
        ?? Promise.resolve(0),
      closeBotSessions(request.botId),
    ]);

    await deleteProfileAndDetachSessions(
      request.botId,
      sessionIds,
      request.keepTaskHistory === true,
    );

    const result = lifecycleResult(request.botId, 'delete', 'deleted', {
      sessions: sessionIds.length,
      delegations,
      deliveries,
    }, closed.warnings);
    broadcastBotLifecycleChanged({ botId: request.botId, action: 'delete' });
    return result;
  };

  const run = (request: BotLifecycleActionRequest): Promise<BotLifecycleActionResult> =>
    withBotLifecycleLock(request.botId, request.action, async () => {
      if (request.action === 'pause') return pause(request.botId);
      if (request.action === 'resume') return resume(request.botId);
      if (request.action === 'archive') return archive(request);
      if (request.action === 'restore') return restore(request.botId);
      if (request.action === 'delete') return remove(request);
      throwIpcError('PRECONDITION_FAILED', `${request.action} 尚未接入 Bot 生命周期协调器`);
    });

  return { run };
}

export function registerBotLifecycleHandlers(deps: BotLifecycleServiceDeps): void {
  const service = createBotLifecycleService(deps);
  ipcMain.handle(MAKER_INVOKE.BOT_LIFECYCLE_ACTION, async (event, raw: unknown) => {
    assertTrustedAppRendererEvent(event);
    const body = requireObject(raw, 'request');
    const botId = requireString(body.botId, 'botId');
    const action = requireString(body.action, 'action');
    if (!['pause', 'resume', 'archive', 'restore', 'delete'].includes(action)) {
      throwIpcError('INVALID_PARAMS', '未知 Bot 生命周期操作');
    }
    return service.run({
      botId,
      action: action as BotLifecycleActionRequest['action'],
      confirmName: typeof body.confirmName === 'string' ? body.confirmName : undefined,
      worktreeDisposition:
        body.worktreeDisposition === 'retain' || body.worktreeDisposition === 'recycle'
          ? body.worktreeDisposition
          : undefined,
      keepTaskHistory: body.keepTaskHistory === true,
    });
  });
}
