import { randomUUID } from 'node:crypto';

import { app, BrowserWindow, ipcMain } from 'electron';
import { eq } from 'drizzle-orm';
import type { Maker } from '@cindy/maker-core';

import type {
  BotLifecycleActionRequest,
  BotLifecycleActionResult,
} from '../../shared/botLifecycle.js';
import { getDbClient } from '../localDb/client/current.js';
import { deleteBotProfileAndDetachSessionsInDb } from '../localDb/ipc/sessions.js';
import {
  botLifecycleEvents,
  botProfiles,
  botSessionLinks,
} from '../localDb/schema.js';
import { removeBotProfileFolder } from './botProfileFolder.js';
import { createLogger } from '../logger.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { requireObject, requireString, throwIpcError } from '../utils/ipcValidate.js';
import { MAKER_INVOKE, MAKER_PUSH } from './channels.js';
import type { BotDelegationService } from './botDelegationService.js';
import { resolveBotCanonicalSession } from './botCanonicalSessionRegistry.js';
import { broadcastBotRemoteResourceChanged } from './botRemoteResourceInvalidation.js';
import {
  activeOwnerScopeKey,
  isAppSessionBoundaryPending,
  ownerScopedUserDataPath,
} from '../appSessionState.js';

const log = createLogger('maker-ipc:bot-lifecycle');

export interface BotLifecycleServiceDeps {
  maker: Maker;
  getDelegationService: () => BotDelegationService | null;
  deleteProfileAndDetachSessions?: (
    botId: string,
    sessionIds: string[],
    keepTaskHistory: boolean,
  ) => Promise<void>;
  now?: () => number;
  /** Resume durable work owned by the Bot after lifecycle state is active. */
  onResumed?: (botId: string) => void | Promise<void>;
  /** Refresh hidden runtime services after any lifecycle ownership change. */
  onLifecycleChanged?: (botId: string) => void | Promise<void>;
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
  const deleteProfileAndDetachSessions =
    deps.deleteProfileAndDetachSessions ?? deleteBotProfileAndDetachSessionsInDb;
  const notifyLifecycleChanged = async (
    botId: string,
    action: BotLifecycleActionRequest['action'],
  ): Promise<void> => {
    broadcastBotLifecycleChanged({ botId, action });
    broadcastBotRemoteResourceChanged(botId);
    await deps.onLifecycleChanged?.(botId);
  };

  const readProfile = async (botId: string) => {
    const [profile] = await getDbClient()
      .drizzle.select()
      .from(botProfiles)
      .where(eq(botProfiles.id, botId))
      .limit(1);
    if (!profile) throwIpcError('NOT_FOUND', 'Bot 不存在');
    return profile;
  };

  const readCanonicalSessionId = async (botId: string): Promise<string | null> => {
    const canonical = await resolveBotCanonicalSession(botId);
    return canonical.status === 'resolved' ? canonical.sessionId : null;
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
    const canonicalSessionId = await readCanonicalSessionId(botId);
    if (profile.status === 'archived' || profile.status === 'deleting') {
      throwIpcError('PRECONDITION_FAILED', `Bot 当前状态为 ${profile.status}`);
    }
    const db = getDbClient().drizzle;
    const at = now();
    await getDbClient().tx('bots.pauseLifecycle', {
      botId,
      canonicalSessionId,
      expectedProfileStatus: profile.status,
      at,
      eventId: randomUUID(),
    });

    const delegationService = deps.getDelegationService();
    const [delegations, closed] = await Promise.all([
      delegationService?.cancelDelegationsForBot(
        botId,
        'The Bot was paused by the user.',
      ) ?? Promise.resolve(0),
      closeBotSessions(botId),
    ]);
    const warnings = [...closed.warnings];
    const completedAt = now();
    await db.insert(botLifecycleEvents).values({
      id: randomUUID(),
      botId,
      sessionId: canonicalSessionId,
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
        delegations,
      },
      warnings,
    );
    await notifyLifecycleChanged(botId, 'pause');
    return result;
  };

  const resume = async (botId: string): Promise<BotLifecycleActionResult> => {
    const profile = await readProfile(botId);
    const canonicalSessionId = await readCanonicalSessionId(botId);
    if (profile.status === 'archived' || profile.status === 'deleting') {
      throwIpcError('PRECONDITION_FAILED', `Bot 当前状态为 ${profile.status}`);
    }
    const at = now();
    await getDbClient().tx('bots.resumeLifecycle', {
      botId,
      canonicalSessionId,
      expectedProfileStatus: profile.status,
      at,
      eventId: randomUUID(),
    });
    const result = lifecycleResult(botId, 'resume', 'active', {});
    await notifyLifecycleChanged(botId, 'resume');
    await deps.onResumed?.(botId);
    return result;
  };

  /**
   * Permanent deletion still needs the existing fail-closed shutdown transaction.
   * This is deliberately private: v1 does not expose Bot archive/restore as a product lifecycle.
   */
  const prepareForDeletion = async (request: {
    botId: string;
    worktreeDisposition?: BotLifecycleActionRequest['worktreeDisposition'];
  }): Promise<{ warnings: string[] }> => {
    let profile = await readProfile(request.botId);
    if (profile.status === 'deleting') {
      throwIpcError('PRECONDITION_FAILED', 'Bot 正在永久删除');
    }
    if (profile.status === 'archived') {
      return { warnings: [] };
    }

    if (profile.status !== 'paused') {
      await pause(request.botId);
      profile = await readProfile(request.botId);
    }

    const canonicalSessionId = await readCanonicalSessionId(request.botId);
    const at = now();
    await getDbClient().tx<{ sessions: number }>('bots.archiveLifecycle', {
      botId: request.botId,
      canonicalSessionId,
      expectedProfileStatus: profile.status,
      worktreeDisposition: request.worktreeDisposition ?? 'retain',
      at,
      eventId: randomUUID(),
    });
    broadcastBotRemoteResourceChanged(request.botId);

    return { warnings: [] };
  };

  const remove = async (
    request: BotLifecycleActionRequest,
  ): Promise<BotLifecycleActionResult> => {
    const ownerScopeAtEntry = activeOwnerScopeKey();
    const ownerRootAtEntry = ownerScopedUserDataPath();
    const assertOwnerUnchanged = (): void => {
      if (isAppSessionBoundaryPending() || activeOwnerScopeKey() !== ownerScopeAtEntry) {
        throwIpcError('PRECONDITION_FAILED', '账号已切换，请重新发起删除');
      }
    };
    const profile = await readProfile(request.botId);
    assertOwnerUnchanged();
    if (request.confirmName !== profile.displayName) {
      throwIpcError('INVALID_PARAMS', '请输入完整 Bot 名称以确认永久删除');
    }
    if (profile.status === 'deleting') {
      throwIpcError('PRECONDITION_FAILED', 'Bot 已在永久删除流程中');
    }
    let preparationWarnings: string[] = [];
    if (profile.status !== 'archived') {
      const prepared = await prepareForDeletion({
        botId: request.botId,
        worktreeDisposition: request.worktreeDisposition ?? 'retain',
      });
      preparationWarnings = prepared.warnings;
    }

    const db = getDbClient().drizzle;
    const links = await db
      .select({ sessionId: botSessionLinks.sessionId })
      .from(botSessionLinks)
      .where(eq(botSessionLinks.botId, request.botId));
    const sessionIds = [...new Set(links.map((row) => row.sessionId))];
    const [delegations, closed] = await Promise.all([
      deps.getDelegationService()?.cancelDelegationsForBot(
        request.botId,
        'The Bot was permanently deleted by the user.',
      ) ?? Promise.resolve(0),
      closeBotSessions(request.botId),
    ]);

    assertOwnerUnchanged();
    await deleteProfileAndDetachSessions(
      request.botId,
      sessionIds,
      request.keepTaskHistory === true,
    );

    /*
      伙伴的家一起走 —— `<userData>/bots/<botId>/` 里躺着 SOUL.md、用户画像、
      技能正文,全是用户内容。数据库行删了却把它留在盘上,就是一份没人管得着、
      也没人看得见的残留。

      删失败不改变「已删除」这个结论(数据库那边已经是终态了),但要记一笔:
      沉默地留下用户内容是隐私问题,不是小事。
    */
    try {
      await removeBotProfileFolder(
        ownerRootAtEntry,
        request.botId,
        app.getPath('userData'),
      );
    } catch (cause) {
      log.warn('remove bot profile folder failed', {
        botId: request.botId,
        error: String(cause),
      });
    }

    const result = lifecycleResult(request.botId, 'delete', 'deleted', {
      sessions: sessionIds.length,
      delegations,
    }, [...preparationWarnings, ...closed.warnings]);
    await notifyLifecycleChanged(request.botId, 'delete');
    return result;
  };

  const run = (request: BotLifecycleActionRequest): Promise<BotLifecycleActionResult> =>
    withBotLifecycleLock(request.botId, request.action, async () => {
      if (request.action === 'pause') return pause(request.botId);
      if (request.action === 'resume') return resume(request.botId);
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
    if (!['pause', 'resume', 'delete'].includes(action)) {
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
