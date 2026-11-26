/**
 * Desktop runtime wiring for:
 *  1. One-time retirement of legacy per-teammate `teammate-memory-review` automations,
 *     automated review sessions, and redundant empty teammate `recentWorkdirs` entries.
 *  2. The unified, cadence-controlled Global Memory & Skill Tidy coordinator.
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { BrowserWindow } from 'electron';
import { and, eq, inArray, or } from 'drizzle-orm';
import { isTerminalAgentErrorEvent, type AgentEvent, type EngineKind } from '@cindy/maker-core';

import { activeOwnerScopeKey, getActiveDataOwnerPushStamp, ownerScopedUserDataPath } from '../appSessionState.js';
import { companionHomes } from '../companion-cloud/homes.js';
import { createSnapshotDetailed } from '../git-snapshot/gitSnapshotService.js';
import { getDbClient } from '../localDb/client/current.js';
import { readBotSettingsProfile } from '../localDb/ipc/bots.js';
import { removeRecentWorkdir } from '../localDb/ipc/recentWorkdirsCore.js';
import { broadcastSessionPatched } from '../localDb/ipc/sessions.js';
import { botProfiles, botSessionLinks, messages, scheduleRuns, schedules, sessions } from '../localDb/schema.js';
import { createLogger } from '../logger.js';
import { getMakerIfReady } from '../maker-host/index.js';
import { isTrustedAppRendererWindow } from '../security/trustedAppRenderer.js';
import { inspectAppDefaultModel } from './appDefaultModelControl.js';
import {
  retireLegacyTeammateMemoryReviews,
  type LegacyReviewRetirementSummary,
} from './botMemoryTidyMigration.js';
import { isTeammateProjectIgnoreReady } from './botProjectGitignore.js';
import { teammateWorkspaceDir } from './botProjectMemory.js';
import {
  createGlobalMemoryTidyCoordinator,
  type GlobalMemoryTidyCoordinator,
  type TidyTeammateInput,
} from './globalMemoryTidy.js';

const log = createLogger('maker-ipc:global-memory-tidy');

const LEGACY_REVIEW_CONFIG_ID = 'teammate-memory-review';
const PROTECTED_BOT_LINK_ROLES = new Set(['canonical', 'thread', 'group', 'channel']);
const AUTOMATED_ORIGINS = new Set(['scheduler', 'heartbeat', 'delegation', 'agent']);
const TIDY_TURN_TIMEOUT_MS = 6 * 60 * 1000;

function broadcastRecentWorkdirsChanged(workingDir: string): void {
  const owner = getActiveDataOwnerPushStamp();
  for (const win of BrowserWindow.getAllWindows()) {
    if (!isTrustedAppRendererWindow(win)) continue;
    try {
      win.webContents.send('local-db:recent-workdirs:changed', { path: workingDir }, owner);
    } catch (error) {
      log.warn('failed to broadcast recent-workdirs change', { error: String(error) });
    }
  }
}

function readMessageOriginKind(agentMeta: string | null): string | null {
  if (!agentMeta) return null;
  try {
    const parsed = JSON.parse(agentMeta) as { origin?: { kind?: unknown } };
    return typeof parsed?.origin?.kind === 'string' ? parsed.origin.kind : null;
  } catch {
    return null;
  }
}

function sameDir(a: string | null | undefined, b: string): boolean {
  if (!a) return false;
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/**
 * One-time startup cleanup of legacy per-teammate `teammate-memory-review` schedules,
 * pure automated review sessions, check scripts, and empty teammate `recentWorkdirs`.
 */
export async function runLegacyTeammateMemoryReviewCleanup(
  ownerRoot: string,
  assertCurrent: () => void,
): Promise<LegacyReviewRetirementSummary> {
  const { getProjectAutomationLoader, getSchedulerIfInitialized } = await import('../scheduler-host/index.desktop.js');
  const loader = getProjectAutomationLoader();

  return retireLegacyTeammateMemoryReviews({
    ownerRoot,
    assertCurrent,
    log,
    async listLocalTeammateWorkspaces(): Promise<string[]> {
      const rows = await getDbClient().drizzle
        .select({ id: botProfiles.id })
        .from(botProfiles)
        .where(inArray(botProfiles.status, ['active', 'paused']));
      const demoted = new Set(companionHomes.snapshot().demotedBotIds);
      return rows
        .filter((row) => !demoted.has(row.id))
        .map((row) => teammateWorkspaceDir(ownerRoot, row.id));
    },
    loadProjectSchedules: (workingDir) => loader.loadProjectSchedules(workingDir),
    removeProjectSchedule: async (workingDir, configId) => {
      await loader.removeSchedule(workingDir, configId);
    },
    async listLegacyReviewSchedules() {
      return getDbClient().drizzle
        .select({
          id: schedules.id,
          workingDir: schedules.workingDir,
          targetSessionId: schedules.targetSessionId,
          projectConfigId: schedules.projectConfigId,
        })
        .from(schedules)
        .where(eq(schedules.projectConfigId, LEGACY_REVIEW_CONFIG_ID));
    },
    async listRunSessionIds(scheduleId: string): Promise<string[]> {
      const rows = await getDbClient().drizzle
        .select({ sessionId: scheduleRuns.sessionId })
        .from(scheduleRuns)
        .where(eq(scheduleRuns.scheduleId, scheduleId));
      return rows.flatMap((row) => (row.sessionId ? [row.sessionId] : []));
    },
    async deleteSchedule(scheduleId: string): Promise<void> {
      const scheduler = getSchedulerIfInitialized();
      if (scheduler) {
        await scheduler.delete(scheduleId).catch(() => {});
        return;
      }
      await getDbClient().drizzle.delete(schedules).where(eq(schedules.id, scheduleId)).run();
    },
    async isSafeAutoReviewSession(sessionId: string): Promise<boolean> {
      const db = getDbClient().drizzle;
      const [sessionRow] = await db
        .select({ id: sessions.id, status: sessions.status })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1);
      if (!sessionRow || sessionRow.status !== 'active') return false;

      // Never archive canonical, thread, group, or IM channel sessions.
      const links = await db
        .select({ role: botSessionLinks.role })
        .from(botSessionLinks)
        .where(eq(botSessionLinks.sessionId, sessionId));
      if (links.some((link) => PROTECTED_BOT_LINK_ROLES.has(link.role))) return false;

      // Never archive if any human user message exists in this session.
      const userMsgs = await db
        .select({ agentMeta: messages.agentMeta })
        .from(messages)
        .where(and(eq(messages.sessionId, sessionId), eq(messages.role, 'user')));
      for (const msg of userMsgs) {
        const originKind = readMessageOriginKind(msg.agentMeta);
        if (!originKind || !AUTOMATED_ORIGINS.has(originKind)) return false;
      }
      return true;
    },
    async archiveSession(sessionId: string): Promise<boolean> {
      return archiveSessionInDb(sessionId);
    },
    async hasActiveProjectTasks(workingDir: string): Promise<boolean> {
      const activeRows = await getDbClient().drizzle
        .select({ workingDir: sessions.workingDir, projectDir: sessions.projectDir })
        .from(sessions)
        .where(
          and(
            eq(sessions.status, 'active'),
            or(eq(sessions.workingDir, workingDir), eq(sessions.projectDir, workingDir)),
          ),
        );
      if (activeRows.some((row) => sameDir(row.workingDir, workingDir) || sameDir(row.projectDir, workingDir))) {
        return true;
      }
      if (process.platform === 'win32') {
        const allActive = await getDbClient().drizzle
          .select({ workingDir: sessions.workingDir, projectDir: sessions.projectDir })
          .from(sessions)
          .where(eq(sessions.status, 'active'));
        return allActive.some((row) => sameDir(row.workingDir, workingDir) || sameDir(row.projectDir, workingDir));
      }
      return false;
    },
    async removeRecentWorkdir(workingDir: string): Promise<boolean> {
      const res = await removeRecentWorkdir(workingDir);
      return res.deleted;
    },
    notifyRecentWorkdirsChanged: broadcastRecentWorkdirsChanged,
  });
}

async function listLocalTeammatesForTidy(ownerRoot: string): Promise<TidyTeammateInput[]> {
  const rows = await getDbClient().drizzle
    .select({ id: botProfiles.id, displayName: botProfiles.displayName })
    .from(botProfiles)
    .where(inArray(botProfiles.status, ['active', 'paused']));
  const demoted = new Set(companionHomes.snapshot().demotedBotIds);
  const result: TidyTeammateInput[] = [];
  for (const row of rows) {
    if (demoted.has(row.id)) continue;
    let memoryEnabled = true;
    try {
      const profile = await readBotSettingsProfile(row.id);
      const capabilities = profile.capabilities as unknown as { memory?: unknown };
      if (capabilities?.memory === false) memoryEnabled = false;
    } catch {
      // Fall back to default enabled if profile version lookup fails transiently.
    }
    result.push({
      botId: row.id,
      displayName: row.displayName,
      workspace: teammateWorkspaceDir(ownerRoot, row.id),
      memoryEnabled,
    });
  }
  return result;
}

async function countHumanMessagesSince(botId: string, sinceMs: number): Promise<number> {
  const row = await getDbClient().queryOne<{ cnt: number }>(
    `SELECT COUNT(*) AS cnt
     FROM messages m
     JOIN bot_session_links l ON l.session_id = m.session_id
     WHERE l.bot_id = ?
       AND m.role = 'user'
       AND m.created_at > ?
       AND (m.agent_meta IS NULL
            OR json_extract(m.agent_meta, '$.origin.kind') IS NULL
            OR json_extract(m.agent_meta, '$.origin.kind') NOT IN ('scheduler', 'heartbeat', 'delegation', 'agent'))`,
    [botId, sinceMs],
  );
  return Number(row?.cnt ?? 0);
}

async function resolveTidyRoute(): Promise<{ agentKind: EngineKind; model: string; providerId?: string } | null> {
  const inspected = await inspectAppDefaultModel().catch(() => null);
  const route = inspected?.current ?? inspected?.available[0]?.route ?? null;
  if (!route) return null;
  const agentKind: EngineKind = route.harness === 'claude' ? 'claude-code' : route.harness;
  return {
    agentKind,
    model: route.model,
    ...(route.providerId ? { providerId: route.providerId } : {}),
  };
}

async function archiveSessionInDb(sessionId: string): Promise<boolean> {
  const now = Date.now();
  const result = (await getDbClient().drizzle
    .update(sessions)
    .set({ status: 'archived', updatedAt: now })
    .where(and(eq(sessions.id, sessionId), eq(sessions.status, 'active')))
    .run()) as { changes?: number } | undefined;
  if ((result?.changes ?? 0) > 0) {
    broadcastSessionPatched(sessionId, { status: 'archived', updatedAt: now });
    return true;
  }
  return false;
}

/**
 * Executes the unified tidy prompt in a stateless one-shot Maker session (`workspaceKind: 'dialogue'`,
 * auto-archived immediately on exit so it never lingers in the sidebar or attaches to a project).
 */
async function executeGlobalTidyPrompt(input: {
  prompt: string;
  workingDir: string;
  extraDirs: string[];
  writableDirs: string[];
}): Promise<{ ok: boolean; output: string; sessionId?: string }> {
  const maker = getMakerIfReady();
  if (!maker) {
    return { ok: false, output: 'Maker runtime is not ready' };
  }
  const route = await resolveTidyRoute();
  if (!route) {
    return { ok: false, output: 'No available model configured for memory tidy' };
  }

  const ephemeralId = `global-memory-tidy-${randomUUID()}`;
  const session = await maker.createSession({
    id: ephemeralId,
    agentKind: route.agentKind,
    model: route.model,
    providerId: route.providerId,
    workingDir: input.workingDir,
    workspaceKind: 'dialogue',
    extraDirs: input.extraDirs,
    writableDirs: input.writableDirs,
    permissionMode: 'auto',
    makerMemoryEnabled: false,
    makerMemorySwitchOwned: true,
    title: 'Global Memory & Skill Tidy',
  });

  let finalText = '';
  let streamedText = '';
  let terminalError: string | null = null;

  try {
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        resolve();
      };

      const timer = setTimeout(() => {
        terminalError = 'Global memory tidy timed out';
        void session.abort().catch(() => {});
        finish();
      }, TIDY_TURN_TIMEOUT_MS);

      const unsubscribe = session.onEvent((event: AgentEvent) => {
        if (event.type === 'text') {
          const data = event.data as { text?: string; isFinal?: boolean } | undefined;
          const chunk = typeof data?.text === 'string' ? data.text : '';
          if (data?.isFinal) {
            finalText = chunk;
          } else if (chunk) {
            streamedText += chunk;
          }
          return;
        }
        if (event.type === 'done') {
          finish();
          return;
        }
        if (event.type === 'error' && isTerminalAgentErrorEvent(event)) {
          const data = event.data as { message?: string } | undefined;
          terminalError = typeof data?.message === 'string' && data.message.trim()
            ? data.message.trim()
            : 'Tidy turn failed';
          finish();
        }
      });

      void session.send({ type: 'user', content: input.prompt }).catch((error) => {
        terminalError = error instanceof Error ? error.message : String(error);
        finish();
      });
    });

    if (terminalError) {
      return { ok: false, output: terminalError, sessionId: session.id };
    }
    return { ok: true, output: (finalText || streamedText).trim(), sessionId: session.id };
  } finally {
    await maker.closeSession(session.id).catch((error) => {
      log.warn('failed to close ephemeral global tidy session', { sessionId: session.id, error: String(error) });
    });
    await archiveSessionInDb(session.id).catch((error) => {
      log.warn('failed to auto-archive ephemeral global tidy session', { sessionId: session.id, error: String(error) });
    });
  }
}

let activeCoordinator: { scope: string; coordinator: GlobalMemoryTidyCoordinator } | null = null;

/** Returns the owner-scoped Global Memory & Skill Tidy coordinator singleton. */
export function getGlobalMemoryTidyCoordinator(): GlobalMemoryTidyCoordinator {
  const scope = activeOwnerScopeKey();
  if (activeCoordinator && activeCoordinator.scope === scope) {
    return activeCoordinator.coordinator;
  }
  activeCoordinator?.coordinator.stop();
  const coordinator = createGlobalMemoryTidyCoordinator({
    readOwnerRoot: () => ownerScopedUserDataPath(),
    assertCurrent: (expectedOwnerRoot: string) => {
      if (activeOwnerScopeKey() !== scope || ownerScopedUserDataPath() !== expectedOwnerRoot) {
        throw new Error('OWNER_CHANGED');
      }
    },
    listLocalTeammates: () => listLocalTeammatesForTidy(ownerScopedUserDataPath()),
    countHumanMessages: countHumanMessagesSince,
    executeTidyPrompt: executeGlobalTidyPrompt,
    async snapshotTeammate(botId: string, workspace: string, label: string): Promise<void> {
      if (!await isTeammateProjectIgnoreReady(workspace)) return;
      await createSnapshotDetailed(workspace, {
        label,
        meta: { sessionId: `bot-tidy-${botId}`, kind: 'manual' },
      });
    },
    log,
  });
  activeCoordinator = { scope, coordinator };
  return coordinator;
}

/** Starts the background periodic check for the current owner (idempotent). */
export function startGlobalMemoryTidy(): void {
  getGlobalMemoryTidyCoordinator().start();
}

/** Stops any active background tidy timer (called on logout / account switch). */
export function stopGlobalMemoryTidy(): void {
  activeCoordinator?.coordinator.stop();
  activeCoordinator = null;
}
